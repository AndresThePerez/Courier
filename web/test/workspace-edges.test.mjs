// Edge cases for the saved workspace shared by several open tabs: three tabs,
// storage that refuses reads or writes part-way through, values this build
// cannot read, and requests deleted while they are open. Each "tab" is its
// own workspace instance with its own state and window over one fake storage.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage, StorageEvent, localStorage, fetchStub, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';

const KEY = 'courier.workspace.v1';
const REFUSED = 'Could not save - this browser refused the write (storage full or disabled). The change stays on this page until you reload.';
const DELETED_ELSEWHERE = 'This request was deleted in another tab.';

const req = (id, name = id) => ({ id, name, endpoint: 'search', params: {}, assertions: [] });
const curated = { id: 'search-pikachu', name: 'Search pikachu', endpoint: 'search', params: { q: 'pikachu' }, assertions: [] };

let shared;

beforeEach(() => {
  resetBrowser();
  resetState();
  shared = new FakeStorage();
});

function tab(storage = shared) {
  let state = { workspace: [], draft: null, selectedId: null, editorNotice: '' };
  const target = new EventTarget();
  const ws = workspace.createWorkspace({
    storage,
    get: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
    target,
  });
  ws.init();
  return {
    ws,
    get state() { return state; },
    open(id) { state = { ...state, draft: structuredClone(ws.find(id)), selectedId: id }; },
    receive(newValue = storage.peek(KEY), key = KEY) {
      target.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: storage }));
    },
  };
}

const seed = (requests) => shared.setItem(KEY, JSON.stringify({ version: 1, requests }));
const stored = () => JSON.parse(shared.peek(KEY));
const storedById = () => Object.fromEntries((stored()?.requests || []).map((r) => [r.id, r]));
const ids = (list) => list.map((r) => r.id).sort();

// ---------------------------------------------------------------- three tabs

test('three tabs saving, editing, deleting and forking with stale lists keep every undeleted request', () => {
  seed([req('ws-a', 'A'), req('ws-b', 'B'), req('ws-c', 'C')]);
  const one = tab();
  const two = tab();
  const three = tab();

  one.ws.save({ ...req('ws-a'), name: 'A edited in one' });
  two.ws.remove('ws-b');
  three.ws.save({ ...req('ws-c'), name: 'C edited in three' });
  const forked = two.ws.fork(curated).request;
  one.ws.save(req('ws-new', 'new in one'));
  const late = three.ws.save({ ...req('ws-b'), name: 'B edited after its delete' });

  const now = storedById();
  assert.deepEqual(Object.keys(now).sort(), ['ws-a', 'ws-c', 'ws-new', forked.id].sort());
  assert.equal(now['ws-a'].name, 'A edited in one');
  assert.equal(now['ws-c'].name, 'C edited in three');
  assert.equal(late.deleted, true, 'the late edit is told it lost to the delete');
  assert.deepEqual(ids(three.state.workspace), Object.keys(now).sort());
});

// ---------------------------------------------------------------- refused storage

test('a change queued while writes are refused survives another tab saving and lands when storage heals', (t) => {
  t.mock.method(console, 'warn', () => {});
  seed([req('ws-x', 'X')]);
  const a = tab();
  const b = tab();

  shared.failOn('setItem');
  const queued = a.ws.save({ ...req('ws-x'), name: 'X edited while full' });
  assert.equal(queued.ok, false);
  assert.equal(stored().requests[0].name, 'X', 'nothing was written while full');

  shared.heal('setItem');
  b.ws.save(req('ws-y', 'Y from B'));
  a.receive();
  assert.equal(a.ws.find('ws-x').name, 'X edited while full', 'the page still shows the queued change');

  assert.equal(a.ws.save(req('ws-z', 'Z from A')).ok, true);
  const now = storedById();
  assert.deepEqual(Object.keys(now).sort(), ['ws-x', 'ws-y', 'ws-z']);
  assert.equal(now['ws-x'].name, 'X edited while full');
  assert.deepEqual(listenerErrors, []);
});

test('a queued edit replayed after another tab deleted that request does not bring it back, and the open draft is told', (t) => {
  t.mock.method(console, 'warn', () => {});
  seed([req('ws-x', 'X'), req('ws-y', 'Y')]);
  const a = tab();
  const b = tab();
  a.open('ws-x');

  shared.failOn('setItem');
  a.ws.save({ ...req('ws-x'), name: 'X queued' });
  shared.heal('setItem');
  b.ws.remove('ws-x');

  // The storage event has not reached A yet; A's next write replays its queue.
  a.ws.save(req('ws-z', 'Z'));
  assert.deepEqual(Object.keys(storedById()).sort(), ['ws-y', 'ws-z']);
  assert.equal(a.state.draft, null);
  assert.equal(a.state.editorNotice, DELETED_ELSEWHERE);
});

test('a storage that answers writes but refuses reads is never written', () => {
  seed([req('ws-x', 'X')]);
  const a = tab();
  const before = shared.peek(KEY);
  shared.failOn('getItem');

  let out;
  assert.doesNotThrow(() => { out = a.ws.save(req('ws-y', 'Y')); });
  assert.equal(out.ok, false);
  assert.doesNotThrow(() => a.ws.remove('ws-x'));
  assert.doesNotThrow(() => a.ws.fork(curated));
  assert.equal(shared.peek(KEY), before);
});

test('reset in one tab drops another tab\'s queued edit of a request it had, and that tab is told', (t) => {
  t.mock.method(console, 'warn', () => {});
  seed([req('ws-x', 'X')]);
  const a = tab();
  const b = tab();
  b.open('ws-x');

  shared.failOn('setItem');
  b.ws.save({ ...req('ws-x'), name: 'X queued in B' });
  shared.heal('setItem');
  a.ws.reset();
  b.receive(null);

  assert.equal(b.state.draft, null);
  assert.equal(b.state.editorNotice, DELETED_ELSEWHERE);
  b.ws.save(req('ws-y', 'Y'));
  assert.deepEqual(Object.keys(storedById()), ['ws-y']);
});

// ---------------------------------------------------------------- values this build cannot read

test('each unreadable value another tab stores empties the list on arrival, never throws, and well-formed requests come back', () => {
  seed([req('ws-x', 'X')]);
  const a = tab();
  // A browser fires the event only once the value is in the shared store, so
  // each value is stored first and then delivered; the list must follow it
  // step by step, not only end up right.
  const steps = [
    [JSON.stringify({ version: 2, requests: [req('ws-x')] }), []],
    [JSON.stringify({ version: 1, requests: [req('ws-x', 'X')] }), ['ws-x']],
    ['not json', []],
    [null, []],
    [JSON.stringify({ version: 1 }), []],
    ['x'.repeat(5 * 1024 * 1024), []],
    [JSON.stringify({ version: 1, requests: [null, 5, 'ws-q', [], { name: 'no id', endpoint: 'search' }, req('ws-ok', 'ok')] }), ['ws-ok']],
  ];
  for (const [v, want] of steps) {
    if (v === null) shared.removeItem(KEY);
    else shared.setItem(KEY, v);
    a.receive(v);
    assert.deepEqual(ids(a.state.workspace), want, `after ${String(v).slice(0, 40)}`);
  }
  assert.deepEqual(listenerErrors, []);
});

test('a garbage value seen briefly does not make a later save of a live request look deleted', () => {
  seed([req('ws-x', 'X')]);
  const a = tab();
  a.receive('{garbage');
  seed([req('ws-x', 'X')]);
  a.receive();

  const out = a.ws.save({ ...req('ws-x'), name: 'X edited' });
  assert.equal(out.ok, true);
  assert.equal(out.deleted, false);
  assert.equal(storedById()['ws-x'].name, 'X edited');
});

// ---------------------------------------------------------------- deleted while open

test('undo of a delete still restores the request when a storage event written before the delete arrives after it', () => {
  seed([req('ws-x', 'X'), req('ws-y', 'Y')]);
  const a = tab();
  const b = tab();

  // B writes; A's storage already holds that value, but the event for it is
  // still queued when A's delete runs.
  b.ws.save({ ...req('ws-y'), name: 'Y edited in B' });
  const beforeDelete = shared.peek(KEY);
  const gone = a.ws.remove('ws-x');
  a.receive(beforeDelete);

  assert.ok(!a.state.workspace.some((r) => r.id === 'ws-x'), 'the request this tab deleted is not listed again');
  const undo = a.ws.save(gone.request);
  assert.equal(undo.ok, true, 'Undo is not refused as deleted elsewhere');
  assert.deepEqual(Object.keys(storedById()).sort(), ['ws-x', 'ws-y']);
});

function openPage(requests) {
  localStorage.setItem(KEY, JSON.stringify({ version: 1, requests }));
  workspace.init();
  editor.init();
  sidebar.init({ select: (r) => { editor.onSelect(); sidebar.selectRequest(r); } });
  sidebar.selectRequest(workspace.find(requests[0].id));
  paint();
}

function paint() {
  sidebar.render(get());
  editor.render(get());
}

function deleteButton(name) {
  for (const row of document.getElementById('workspace-tree').querySelectorAll('.req-row')) {
    if (row.querySelector('.req-open').title === name) return row.querySelector('[title="Delete this saved request"]');
  }
  return null;
}

test('a second delete replaces the first undo, and a keystroke queued behind a delete does not recreate it', async () => {
  openPage([req('ws-1', 'one'), req('ws-2', 'two'), req('ws-3', 'three')]);
  const name = document.getElementById('editor-name');

  deleteButton('one').click();
  const pending = new Promise((resolve) => setImmediate(() => { typeInto(name, 'queued keystroke'); resolve(); }));
  paint();
  await pending;
  paint();
  assert.ok(!JSON.parse(localStorage.peek(KEY)).requests.some((r) => r.id === 'ws-1'));

  deleteButton('two').click();
  paint();
  const note = document.getElementById('workspace-note');
  assert.equal(note.textContent, 'Deleted "two". Undo');
  note.querySelector('button').click();
  paint();

  assert.deepEqual(ids(JSON.parse(localStorage.peek(KEY)).requests), ['ws-2', 'ws-3']);
  assert.deepEqual(listenerErrors, []);
  workspace.stop();
});

test('Save with storage refusing reads shows the refused message, never "Saved"', () => {
  openPage([req('ws-1', 'one')]);
  localStorage.failOn('getItem');
  document.getElementById('save-request').click();
  paint();
  const note = document.getElementById('editor-note');
  assert.equal(note.textContent, REFUSED);
  assert.doesNotMatch(note.textContent, /Saved/);
  workspace.stop();
});

// ---------------------------------------------------------------- ids and names

test('thousands of forks get unique ws- ids, also without crypto.randomUUID', (t) => {
  const a = tab(new FakeStorage());
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) seen.add(a.ws.fork(curated).request.id);
  const c = globalThis.crypto;
  t.after(() => Object.defineProperty(globalThis, 'crypto', { value: c, configurable: true, writable: true }));
  Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: c.getRandomValues.bind(c) }, configurable: true, writable: true });
  for (let i = 0; i < 500; i += 1) seen.add(a.ws.fork(curated).request.id);
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  for (let i = 0; i < 500; i += 1) seen.add(a.ws.fork(curated).request.id);
  assert.equal(seen.size, 3000);
  for (const id of seen) {
    assert.ok(workspace.isWorkspaceId(id));
    assert.doesNotMatch(id, /^ws-\d+$/);
  }
});

test('copy names fill gaps, survive regex characters and number copies of copies', () => {
  const a = tab();
  const odd = { ...curated, name: 'a.*(b)+ [c]' };
  assert.equal(a.ws.fork(odd).request.name, 'a.*(b)+ [c] (copy)');
  assert.equal(a.ws.fork(odd).request.name, 'a.*(b)+ [c] (copy 2)');
  a.ws.save(req('ws-gap', 'Gap (copy)'));
  a.ws.save(req('ws-gap3', 'Gap (copy 3)'));
  assert.equal(a.ws.fork({ ...curated, name: 'Gap' }).request.name, 'Gap (copy 2)');
  assert.equal(a.ws.fork({ ...curated, name: 'Gap' }).request.name, 'Gap (copy 4)');
  assert.equal(a.ws.fork({ ...curated, name: 'Gap (copy 2)' }).request.name, 'Gap (copy 2) (copy)');
});

// ---------------------------------------------------------------- regression

test('editing a built-in request writes only the copy, never the built-in, and fetches nothing', () => {
  openPage([req('ws-1', 'one')]);
  sidebar.selectRequest(curated);
  paint();
  typeInto(document.getElementById('editor-name'), 'renamed');
  paint();
  const list = JSON.parse(localStorage.peek(KEY)).requests;
  assert.ok(!list.some((r) => r.id === curated.id));
  assert.equal(list.filter((r) => r.name === 'renamed').length, 1);
  assert.equal(fetchStub.calls.length, 0);
  workspace.stop();
});
