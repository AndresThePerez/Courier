// A storage event is queued after the shared value has already changed, so by
// the time it arrives its newValue can be older than what is stored: this
// tab's own writes may have landed in between, and two events can describe
// the store in an order that is no longer current. These tests deliver such
// late events, and check that an undo or a reset the browser could not carry
// out says so instead of failing silently.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage, StorageEvent, localStorage, listenerErrors } from './shim.mjs';
import { resetState, get } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';

const KEY = 'courier.workspace.v1';
const REFUSED = 'Could not save - this browser refused the write (storage full or disabled). The change stays on this page until you reload.';

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
const storedIds = () => (JSON.parse(shared.peek(KEY))?.requests || []).map((r) => r.id).sort();
const ids = (list) => list.map((r) => r.id).sort();

// ---------------------------------------------------------------- late events

test('an event written before this tab forked arrives after it: the fork stays listed and open', () => {
  seed([req('ws-y', 'Y')]);
  const a = tab();
  const b = tab();

  b.ws.save({ ...req('ws-y'), name: 'Y edited in B' });
  const beforeFork = shared.peek(KEY);
  const forked = a.ws.fork(curated).request;
  a.open(forked.id);
  a.receive(beforeFork);

  assert.deepEqual(ids(a.state.workspace), ids([forked, req('ws-y')]));
  assert.equal(a.state.draft?.id, forked.id, 'the fork is not closed');
  assert.equal(a.state.editorNotice, '', 'no claim that another tab deleted it');
});

test('two events delivered in reverse order leave the list as it is stored now', () => {
  seed([req('ws-x', 'X')]);
  const a = tab();
  const b = tab();

  b.ws.save(req('ws-y', 'Y'));
  const first = shared.peek(KEY);
  b.ws.remove('ws-x');
  const second = shared.peek(KEY);
  a.receive(second);
  a.receive(first);

  assert.deepEqual(ids(a.state.workspace), ['ws-y']);
  assert.deepEqual(storedIds(), ['ws-y']);
});

test('a late event read while storage refuses reads cannot turn this tab\'s delete into a delete elsewhere', () => {
  seed([req('ws-x', 'X'), req('ws-y', 'Y')]);
  const a = tab();
  const b = tab();

  b.ws.save({ ...req('ws-y'), name: 'Y edited in B' });
  const beforeDelete = shared.peek(KEY);
  const gone = a.ws.remove('ws-x');
  shared.failOn('getItem');
  a.receive(beforeDelete);
  shared.heal();

  assert.ok(!a.state.workspace.some((r) => r.id === 'ws-x'), 'the deleted request is not listed again');
  const undo = a.ws.save(gone.request);
  assert.deepEqual({ ok: undo.ok, deleted: undo.deleted }, { ok: true, deleted: false });
  assert.deepEqual(storedIds(), ['ws-x', 'ws-y']);
});

test('unreadable values another tab stores never throw and keep only well-formed requests', () => {
  seed([req('ws-x', 'X')]);
  const a = tab();
  const values = [
    JSON.stringify({ version: 2, requests: [req('ws-x')] }),
    'not json',
    null,
    JSON.stringify({ version: 1 }),
    'x'.repeat(5 * 1024 * 1024),
    JSON.stringify({ version: 1, requests: [null, 5, 'ws-q', [], { name: 'no id', endpoint: 'search' }, req('ws-ok', 'ok')] }),
  ];
  for (const v of values) {
    if (v === null) shared.removeItem(KEY);
    else shared.setItem(KEY, v);
    a.receive(v);
  }
  assert.deepEqual(listenerErrors, []);
  assert.deepEqual(ids(a.state.workspace), ['ws-ok']);
});

// ---------------------------------------------------------------- refused writes queue

test('edits the browser refuses queue one change per request, however many keystrokes', (t) => {
  t.mock.method(console, 'warn', () => {});
  const a = tab();
  shared.failOn('setItem');

  for (let i = 0; i < 200; i += 1) a.ws.save({ ...req('ws-x'), name: `X ${i}` });
  a.ws.save(req('ws-y', 'Y'));
  assert.equal(a.ws.queued(), 2);

  shared.heal();
  a.ws.save({ ...req('ws-y'), name: 'Y saved' });
  assert.equal(a.ws.queued(), 0);
  const stored = JSON.parse(shared.peek(KEY)).requests;
  assert.deepEqual(stored.map((r) => r.name).sort(), ['X 199', 'Y saved']);
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

test('an undo the browser refuses to write keeps the note up and says so', (t) => {
  t.mock.method(console, 'warn', () => {});
  openPage([req('ws-1', 'one'), req('ws-2', 'two')]);
  deleteButton('one').click();
  paint();

  localStorage.failOn('setItem');
  undoButton().click();

  assert.equal(workspaceNote().hidden, false);
  assert.equal(workspaceNote().textContent, REFUSED);
});

test('an undo refused because another tab has since deleted the request says it could not restore it', () => {
  openPage([req('ws-1', 'one'), req('ws-2', 'two')]);
  deleteButton('one').click();
  paint();

  // Another tab stores the request again, then deletes it, before Undo.
  const withOne = JSON.stringify({ version: 1, requests: [req('ws-1', 'one'), req('ws-2', 'two')] });
  localStorage.writeFromAnotherTab(KEY, withOne);
  localStorage.writeFromAnotherTab(KEY, JSON.stringify({ version: 1, requests: [req('ws-2', 'two')] }));
  undoButton().click();

  assert.equal(workspaceNote().hidden, false);
  assert.equal(workspaceNote().textContent, 'Could not restore "one".');
});

test('a reset the browser refuses says so and leaves the list as stored', (t) => {
  t.mock.method(console, 'warn', () => {});
  openPage([req('ws-1', 'one'), req('ws-2', 'two')]);
  localStorage.failOn('removeItem');

  document.getElementById('reset-workspace').click();
  document.getElementById('reset-confirm').querySelector('.btn-danger').click();
  paint();

  assert.equal(workspaceNote().hidden, false);
  assert.equal(workspaceNote().textContent, REFUSED);
  assert.deepEqual(ids(get().workspace), ['ws-1', 'ws-2']);

  localStorage.heal();
  workspace.save({ ...req('ws-2'), name: 'two edited' });
  assert.deepEqual(ids(get().workspace), ['ws-1', 'ws-2']);
  assert.deepEqual(JSON.parse(localStorage.peek(KEY)).requests.map((r) => r.id).sort(), ['ws-1', 'ws-2']);
});
