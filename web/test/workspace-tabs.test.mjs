// Two open tabs of the page share one localStorage. Each "tab" here is its own
// workspace instance with its own state and its own window (event target),
// over one shared fake storage, so a write in one is invisible to the other
// until it re-reads storage or receives a storage event, as in a browser.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage, StorageEvent, localStorage } from './shim.mjs';
import * as workspace from '../js/workspace.js';

const KEY = 'courier.workspace.v1';

const curated = {
  id: 'search-pikachu',
  name: 'Search pikachu',
  endpoint: 'search',
  params: { q: 'pikachu' },
  assertions: [{ type: 'status', op: 'eq', value: 200 }],
};

const req = (id, name = id) => ({ id, name, endpoint: 'search', params: {}, assertions: [] });

let shared;

beforeEach(() => {
  resetBrowser();
  shared = new FakeStorage();
});

// tab opens one page over the shared storage.
function tab(storage = shared) {
  let state = { workspace: [], draft: null, selectedId: null };
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
    target,
    get state() { return state; },
    // receive delivers the storage event a browser fires in this tab when
    // another tab has written.
    receive(key = KEY, newValue = storage.peek(KEY)) {
      target.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: storage }));
    },
  };
}

function stored() {
  const raw = shared.peek(KEY);
  return raw === null ? null : JSON.parse(raw);
}

const storedIds = () => (stored()?.requests || []).map((r) => r.id).sort();

// ---------------------------------------------------------------- no lost writes

test('two tabs that never reload both keep what they saved', () => {
  const a = tab();
  const b = tab();
  a.ws.save(req('ws-x', 'X'));
  b.ws.save(req('ws-y', 'Y'));

  assert.deepEqual(storedIds(), ['ws-x', 'ws-y']);
  assert.equal(stored().version, 1);
});

test('a delete in one tab and an edit of another request in the second both stick', () => {
  shared.setItem(KEY, JSON.stringify({ version: 1, requests: [req('ws-x', 'X'), req('ws-y', 'Y')] }));
  const a = tab();
  const b = tab();

  a.ws.remove('ws-x');
  b.ws.save({ ...req('ws-y'), name: 'Y edited in B' });

  assert.deepEqual(storedIds(), ['ws-y']);
  assert.equal(stored().requests[0].name, 'Y edited in B');
  assert.deepEqual(b.state.workspace.map((r) => r.id), ['ws-y'], 'B now shows what is stored');
});

test('a write merges into what is stored now, not into the list the tab loaded', () => {
  const a = tab();
  shared.setItem(KEY, JSON.stringify({ version: 1, requests: [req('ws-z', 'Z')] }));
  a.ws.save(req('ws-x', 'X'));
  assert.deepEqual(storedIds(), ['ws-x', 'ws-z']);
});

test('both tabs editing the same request: the later write wins and nothing is duplicated', () => {
  const a = tab();
  const b = tab();
  a.ws.save(req('ws-x', 'from A'));
  b.ws.save(req('ws-x', 'from B'));

  assert.equal(stored().requests.length, 1);
  assert.equal(stored().requests[0].name, 'from B');
});

test('an edit of a request another tab deleted does not bring it back', () => {
  shared.setItem(KEY, JSON.stringify({ version: 1, requests: [req('ws-x', 'X'), req('ws-y', 'Y')] }));
  const a = tab();
  const b = tab();

  a.ws.remove('ws-x');
  const out = b.ws.save({ ...req('ws-x'), name: 'late edit' });

  assert.deepEqual(storedIds(), ['ws-y']);
  assert.equal(out.ok, false);
  assert.equal(out.deleted, true);
  assert.deepEqual(b.state.workspace.map((r) => r.id), ['ws-y']);
});

test('a tab can bring back a request it deleted itself', () => {
  shared.setItem(KEY, JSON.stringify({ version: 1, requests: [req('ws-x', 'X')] }));
  const a = tab();
  const gone = a.ws.remove('ws-x');
  a.ws.save(gone.request);
  assert.deepEqual(storedIds(), ['ws-x']);
});

// ---------------------------------------------------------------- ids

test('two tabs forking the same built-in request get different random ws- ids', () => {
  const a = tab();
  const b = tab();
  const fa = a.ws.fork(curated).request;
  const fb = b.ws.fork(curated).request;

  assert.notEqual(fa.id, fb.id);
  for (const id of [fa.id, fb.id]) {
    assert.ok(workspace.isWorkspaceId(id), id);
    assert.doesNotMatch(id, /^ws-\d+$/, 'not a counter');
  }
  assert.deepEqual(storedIds(), [fa.id, fb.id].sort());
});

test('a saved value from an older build with ws-1, ws-2 ids still loads and keeps its counter', () => {
  const old = { version: 1, counter: 3, requests: [req('ws-1', 'one'), req('ws-3', 'three')] };
  shared.setItem(KEY, JSON.stringify(old));
  const a = tab();

  assert.deepEqual(a.state.workspace, old.requests);
  assert.ok(workspace.isWorkspaceId('ws-1'));

  const forked = a.ws.fork(curated).request;
  assert.deepEqual(storedIds(), ['ws-1', 'ws-3', forked.id].sort());
  assert.ok(stored().counter >= 3, 'an older page still open elsewhere numbers past what exists');
});

// ---------------------------------------------------------------- live sync

test('a storage event from another tab updates this tab without a reload', () => {
  const a = tab();
  const b = tab();
  a.ws.save(req('ws-x', 'X'));
  assert.deepEqual(b.state.workspace, []);

  b.receive();
  assert.deepEqual(b.state.workspace.map((r) => r.id), ['ws-x']);
});

test('a storage event that removed the key empties the workspace', () => {
  shared.setItem(KEY, JSON.stringify({ version: 1, requests: [req('ws-x', 'X')] }));
  const b = tab();
  assert.equal(b.state.workspace.length, 1);
  shared.removeItem(KEY);
  b.receive(KEY, null);
  assert.deepEqual(b.state.workspace, []);
});

test('a storage event carrying garbage empties the workspace without throwing', () => {
  shared.setItem(KEY, JSON.stringify({ version: 1, requests: [req('ws-x', 'X')] }));
  const b = tab();
  assert.equal(b.state.workspace.length, 1);
  shared.setItem(KEY, '{nope');
  assert.doesNotThrow(() => b.receive(KEY, '{nope'));
  assert.deepEqual(b.state.workspace, []);
});

test('a storage event for another key leaves the workspace alone', () => {
  shared.setItem(KEY, JSON.stringify({ version: 1, requests: [req('ws-x', 'X')] }));
  const b = tab();
  b.receive('something.else', 'null');
  assert.deepEqual(b.state.workspace.map((r) => r.id), ['ws-x']);
});

test('the default page instance follows storage events on window', () => {
  // The module-level functions are the page's own instance, wired to the
  // shim's localStorage, window and store.
  workspace.init();
  localStorage.writeFromAnotherTab(KEY, JSON.stringify({ version: 1, requests: [req('ws-x', 'X')] }));
  assert.deepEqual(workspace.find('ws-x'), req('ws-x', 'X'));
  workspace.stop();
});

// ---------------------------------------------------------------- unreadable values

for (const [label, value] of [
  ['a newer version', JSON.stringify({ version: 2, requests: [req('ws-x')] })],
  ['garbage', '{nope'],
  ['the JSON null', 'null'],
  ['requests that is not a list', JSON.stringify({ version: 1, requests: 'ws-x' })],
]) {
  test(`${label} loads as an empty workspace`, () => {
    shared.setItem(KEY, value);
    let a;
    assert.doesNotThrow(() => { a = tab(); });
    assert.deepEqual(a.state.workspace, []);
  });
}

test('a localStorage whose getItem throws loads an empty workspace without throwing', () => {
  shared.failOn('getItem');
  let a;
  assert.doesNotThrow(() => { a = tab(); });
  assert.deepEqual(a.state.workspace, []);
  assert.deepEqual(a.ws.load(), { requests: [] });
});
