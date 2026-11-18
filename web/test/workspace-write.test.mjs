import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, typeInto, listenerErrors, FakeStorage, StorageEvent } from './shim.mjs';
import { resetState, get } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';

const KEY = 'courier.workspace.v1';
const REFUSED = 'Could not save - this browser refused the write (storage full or disabled). The change stays on this page until you reload.';

const saved = {
  id: 'ws-1',
  name: 'Search pikachu',
  endpoint: 'search',
  params: { q: 'pikachu' },
  assertions: [],
};
const curated = { ...saved, id: 'search-pikachu' };
const req = (id, name = id) => ({ id, name, endpoint: 'search', params: {}, assertions: [] });

beforeEach(() => {
  resetBrowser();
  resetState();
});

function paint() {
  sidebar.render(get());
  editor.render(get());
}

function open(request) {
  localStorage.setItem(KEY, JSON.stringify({ version: 1, requests: [saved] }));
  workspace.init();
  editor.init();
  editor.onSelect();
  sidebar.selectRequest(request);
  paint();
}

const note = () => document.getElementById('editor-note');

// ---------------------------------------------------------------- the page

test('Save says the browser refused the write instead of claiming success', (t) => {
  t.mock.method(console, 'warn', () => {});
  open(saved);
  localStorage.failOn('setItem'); // QuotaExceededError, as a full store throws

  document.getElementById('save-request').click();
  paint();

  assert.equal(note().hidden, false);
  assert.equal(note().textContent, REFUSED);
  assert.doesNotMatch(note().textContent, /Saved/);
});

test('editing keeps working on the page while the browser refuses every write', (t) => {
  t.mock.method(console, 'warn', () => {});
  open(saved);
  localStorage.failOn('setItem');

  assert.doesNotThrow(() => typeInto(document.getElementById('editor-name'), 'Renamed'));
  paint();

  assert.equal(get().draft.name, 'Renamed');
  assert.equal(workspace.find('ws-1').name, 'Renamed', 'the sidebar shows the change');
  assert.equal(JSON.parse(localStorage.peek(KEY)).requests[0].name, 'Search pikachu');
  assert.equal(note().textContent, REFUSED);
  assert.deepEqual(listenerErrors, []);
});

test('a built-in request edited while storage is disabled is still copied on the page', (t) => {
  t.mock.method(console, 'warn', () => {});
  open(curated);
  localStorage.failOn('setItem', new DOMException('The operation is insecure.', 'SecurityError'));

  typeInto(document.getElementById('editor-name'), 'My pikachu');
  paint();

  assert.ok(workspace.isWorkspaceId(get().draft.id));
  assert.ok(workspace.find(get().draft.id));
  assert.match(note().textContent, /^Could not save - /);
});

test('Save reports success again once the browser accepts the write', (t) => {
  t.mock.method(console, 'warn', () => {});
  open(saved);
  localStorage.failOn('setItem');
  document.getElementById('save-request').click();
  localStorage.heal();
  document.getElementById('save-request').click();
  paint();
  assert.equal(note().textContent, 'Saved "Search pikachu" to My Workspace.');
});

// ---------------------------------------------------------------- the instance

function tab(storage) {
  let state = { workspace: [], draft: null, selectedId: null };
  const target = new EventTarget();
  const ws = workspace.createWorkspace({
    storage,
    get: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
    target,
  });
  ws.init();
  return { ws, target, get state() { return state; } };
}

test('a change the browser refused is written with the next write it accepts', (t) => {
  t.mock.method(console, 'warn', () => {});
  const shared = new FakeStorage();
  const a = tab(shared);
  shared.failOn('setItem');
  assert.equal(a.ws.save(req('ws-x', 'X')).ok, false);
  shared.heal();
  assert.equal(a.ws.save(req('ws-y', 'Y')).ok, true);

  const ids = JSON.parse(shared.peek(KEY)).requests.map((r) => r.id).sort();
  assert.deepEqual(ids, ['ws-x', 'ws-y']);
});

test('a refused delete is retried too, and does not come back on the next write', (t) => {
  t.mock.method(console, 'warn', () => {});
  const shared = new FakeStorage();
  shared.setItem(KEY, JSON.stringify({ version: 1, requests: [req('ws-x', 'X')] }));
  const a = tab(shared);
  shared.failOn('setItem');
  a.ws.remove('ws-x');
  shared.heal();
  a.ws.save(req('ws-y', 'Y'));
  assert.deepEqual(JSON.parse(shared.peek(KEY)).requests.map((r) => r.id), ['ws-y']);
});

test('a storage event from another tab keeps the changes this tab could not store', (t) => {
  t.mock.method(console, 'warn', () => {});
  const shared = new FakeStorage();
  const a = tab(shared);
  shared.failOn('setItem');
  a.ws.save(req('ws-x', 'X'));
  shared.heal();

  const other = JSON.stringify({ version: 1, requests: [req('ws-z', 'Z')] });
  shared.setItem(KEY, other);
  a.target.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: other, storageArea: shared }));

  assert.deepEqual(a.state.workspace.map((r) => r.id).sort(), ['ws-x', 'ws-z']);
});

test('a storage that cannot be read is never written blind over another tab', () => {
  const shared = new FakeStorage();
  const theirs = JSON.stringify({ version: 1, requests: [req('ws-z', 'Z')] });
  shared.setItem(KEY, theirs);
  const a = tab(shared);
  shared.failOn('getItem');

  const out = a.ws.save(req('ws-x', 'X'));

  assert.equal(out.ok, false);
  assert.equal(shared.peek(KEY), theirs);
  assert.deepEqual(a.state.workspace.map((r) => r.id).sort(), ['ws-x', 'ws-z']);
});

test('a delete the browser refused to store says so beside its undo', (t) => {
  t.mock.method(console, 'warn', () => {});
  open(saved);
  sidebar.init({});
  paint();
  localStorage.failOn('setItem');
  document.getElementById('workspace-tree').querySelector('[title="Delete this saved request"]').click();

  const note = document.getElementById('workspace-note');
  assert.equal(note.textContent, `Deleted "Search pikachu". Undo ${REFUSED}`);
  assert.equal(workspace.find('ws-1'), null);
});
