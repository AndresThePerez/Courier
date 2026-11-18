// More late storage events: several writes behind one event, a removed key
// that was stored again, events arriving while this tab's own changes wait for
// the browser to accept a write, and stale values read while reads are
// refused. Every ordering here is one a browser can produce: the shared value
// changes first, its event is delivered later, and this tab may act in
// between.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage, StorageEvent, localStorage, listenerErrors } from './shim.mjs';
import { resetState, get } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';

const KEY = 'courier.workspace.v1';
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
    receive(newValue, key = KEY) {
      target.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: storage }));
    },
  };
}

const seed = (requests) => shared.setItem(KEY, JSON.stringify({ version: 1, requests }));
const storedById = () => Object.fromEntries((JSON.parse(shared.peek(KEY))?.requests || []).map((r) => [r.id, r]));
const ids = (list) => list.map((r) => r.id).sort();

// ---------------------------------------------------------------- re-read

test('one event delivered after two writes from another tab shows both writes', () => {
  const a = tab();
  const b = tab();
  b.ws.save(req('ws-y', 'Y'));
  const firstEvent = shared.peek(KEY);
  b.ws.save(req('ws-z', 'Z'));
  a.receive(firstEvent);

  assert.deepEqual(ids(a.state.workspace), ['ws-y', 'ws-z']);
});

test('a removal event for a key that has since been stored again shows what is stored', () => {
  seed([req('ws-x', 'X')]);
  const a = tab();
  const b = tab();
  b.ws.reset();
  b.ws.save(req('ws-w', 'W'));
  a.receive(null);
  a.receive(null, null);

  assert.deepEqual(ids(a.state.workspace), ['ws-w']);
  assert.deepEqual(listenerErrors, []);
});

test('an event arriving while this tab has refused changes queued neither drops nor duplicates them', (t) => {
  t.mock.method(console, 'warn', () => {});
  seed([req('ws-x', 'X')]);
  const a = tab();
  shared.failOn('setItem');
  a.ws.save({ ...req('ws-x'), name: 'X edited in A' });
  a.ws.save(req('ws-n', 'N'));
  assert.equal(a.ws.queued(), 2);

  // Another tab (whose small write fits) adds a request.
  const value = JSON.stringify({ version: 1, requests: [req('ws-x', 'X'), req('ws-y', 'Y')] });
  shared.heal();
  shared.setItem(KEY, value);
  shared.failOn('setItem');
  a.receive(value);
  a.receive(value);

  assert.equal(a.ws.queued(), 2);
  assert.deepEqual(ids(a.state.workspace), ['ws-n', 'ws-x', 'ws-y']);
  assert.equal(a.state.workspace.find((r) => r.id === 'ws-x').name, 'X edited in A');

  shared.heal();
  a.ws.save({ ...req('ws-n'), name: 'N again' });
  assert.equal(a.ws.queued(), 0);
  const stored = JSON.parse(shared.peek(KEY)).requests;
  assert.deepEqual(stored.map((r) => r.id).sort(), ['ws-n', 'ws-x', 'ws-y']);
  assert.equal(storedById()['ws-x'].name, 'X edited in A');
  assert.equal(storedById()['ws-n'].name, 'N again');
});

// ---------------------------------------------------------------- refused delete, then an event

test('a delete the browser refused, then any event, then the write landing: this tab can still undo its own delete', (t) => {
  t.mock.method(console, 'warn', () => {});
  seed([req('ws-x', 'X'), req('ws-y', 'Y')]);
  const a = tab();
  // A large edit fills the store; the delete rides along with it and is
  // refused too.
  shared.failOn('setItem');
  a.ws.save({ ...req('ws-big', 'Big'), params: { q: 'x'.repeat(4096) } });
  const gone = a.ws.remove('ws-x');
  assert.equal(gone.ok, false);
  assert.equal(a.ws.queued(), 2);

  // Another tab's small save still fits; its value still lists ws-x because
  // this tab's delete never reached storage.
  const value = JSON.stringify({ version: 1, requests: [req('ws-x', 'X'), req('ws-y', 'Y'), req('ws-z', 'Z')] });
  shared.heal();
  shared.setItem(KEY, value);
  a.receive(value);
  assert.ok(!a.state.workspace.some((r) => r.id === 'ws-x'), 'the queued delete still hides it');

  // Room frees up; the next write carries the queued edit and the delete.
  a.ws.save({ ...req('ws-y'), name: 'Y edited' });
  assert.ok(!('ws-x' in storedById()), 'the delete landed');
  assert.ok('ws-big' in storedById(), 'the queued edit landed');

  const undo = a.ws.save(gone.request);
  assert.deepEqual({ ok: undo.ok, deleted: undo.deleted }, { ok: true, deleted: false });
  assert.ok('ws-x' in storedById(), 'undo restored the request with the same id');
});

// ---------------------------------------------------------------- fallback (read refused)

test('a stale event read while reads are refused does not close this tab\'s own new fork as deleted elsewhere', () => {
  seed([req('ws-y', 'Y')]);
  const a = tab();
  const b = tab();
  b.ws.save({ ...req('ws-y'), name: 'Y edited in B' });
  const beforeFork = shared.peek(KEY);
  const forked = a.ws.fork(curated).request;
  a.open(forked.id);

  shared.failOn('getItem');
  a.receive(beforeFork);
  shared.heal();

  assert.notEqual(a.state.editorNotice, DELETED_ELSEWHERE, 'nothing deleted the fork');
  assert.equal(a.state.draft?.id, forked.id, 'the fork stays open');
  assert.ok(forked.id in storedById(), 'and it is still stored');
});

test('a stale fallback value does not make a later legitimate save of a request look deleted elsewhere', (t) => {
  t.mock.method(console, 'warn', () => {});
  seed([req('ws-x', 'X')]);
  const a = tab();
  const gone = a.ws.remove('ws-x');
  const undo = a.ws.save(gone.request);
  assert.equal(undo.ok, true);
  a.ws.remove('ws-x');

  // An old value, read while reads are refused, still lists ws-x.
  shared.failOn('getItem');
  a.receive(JSON.stringify({ version: 1, requests: [req('ws-x', 'X')] }));
  shared.heal();
  assert.ok(!a.state.workspace.some((r) => r.id === 'ws-x'));

  const again = a.ws.save(gone.request);
  assert.deepEqual({ ok: again.ok, deleted: again.deleted }, { ok: true, deleted: false });
  assert.ok('ws-x' in storedById());
});

test('a request this tab deleted shows again once another tab stores it and a current read sees it', () => {
  seed([req('ws-x', 'X')]);
  const a = tab();
  a.ws.remove('ws-x');
  shared.failOn('getItem');
  const value = JSON.stringify({ version: 1, requests: [req('ws-x', 'X from elsewhere')] });
  shared.heal();
  shared.setItem(KEY, value);
  a.receive(value);

  assert.equal(a.state.workspace.find((r) => r.id === 'ws-x')?.name, 'X from elsewhere');
});

// ---------------------------------------------------------------- module API

test('the page module does not export the queue accessor, and the accessor only counts', () => {
  assert.equal('queued' in workspace, false);
  const a = tab();
  const n = a.ws.queued();
  assert.equal(typeof n, 'number');
  assert.equal(n, 0);
});

// ---------------------------------------------------------------- the page

function openPage(requests) {
  localStorage.setItem(KEY, JSON.stringify({ version: 1, requests }));
  workspace.init();
  editor.init();
  sidebar.init({});
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

const workspaceNote = () => document.getElementById('workspace-note');
const undoButton = () => workspaceNote().querySelector('button');
const storedIds = () => (JSON.parse(localStorage.peek(KEY))?.requests || []).map((r) => r.id).sort();

test('a second delete while the first note shows: Undo restores the second, the first stays deleted', () => {
  openPage([req('ws-1', 'one'), req('ws-2', 'two'), req('ws-3', 'three')]);
  deleteButton('one').click();
  paint();
  deleteButton('two').click();
  paint();
  assert.match(workspaceNote().textContent, /Deleted "two"/);

  undoButton().click();
  paint();
  assert.equal(workspaceNote().hidden, true);
  assert.deepEqual(storedIds(), ['ws-2', 'ws-3']);
  assert.deepEqual(ids(get().workspace), ['ws-2', 'ws-3']);
});

test('an undo the browser refused is written once storage accepts writes again', (t) => {
  t.mock.method(console, 'warn', () => {});
  openPage([req('ws-1', 'one'), req('ws-2', 'two')]);
  deleteButton('one').click();
  paint();
  localStorage.failOn('setItem');
  undoButton().click();
  paint();
  assert.ok(get().workspace.some((r) => r.id === 'ws-1'), 'the request is back on the page');

  localStorage.heal();
  workspace.save({ ...req('ws-2'), name: 'two edited' });
  assert.deepEqual(storedIds(), ['ws-1', 'ws-2']);
});

test('a refused reset leaves the open request open and editable, and throws nothing', (t) => {
  t.mock.method(console, 'warn', () => {});
  openPage([req('ws-1', 'one'), req('ws-2', 'two')]);
  sidebar.selectRequest(get().workspace.find((r) => r.id === 'ws-1'));
  paint();
  localStorage.failOn('removeItem');
  document.getElementById('reset-workspace').click();
  document.getElementById('reset-confirm').querySelector('.btn-danger').click();
  paint();

  assert.equal(get().draft?.id, 'ws-1');
  assert.deepEqual(storedIds(), ['ws-1', 'ws-2']);
  assert.deepEqual(listenerErrors, []);
});
