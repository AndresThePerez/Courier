// The My Workspace heading row and the note a queued copy leaves, probed at
// their edges: the heading row holds the heading and Reset and nothing else,
// the confirm and the workspace note keep their place after it, Cancel and a
// refused reset behave as before, and the copy note is shown only while it is
// true.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe, renderAll } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const req = (id, name, q = 'a') => ({ id, name, endpoint: 'search', params: { q }, assertions: [] });

let unsubscribe = null;

function boot(saved, queued = []) {
  localStorage.setItem(SETUP, JSON.stringify({ version: 1, mode: 'functional', options: {}, sequence: queued.map((request) => ({ enabled: true, request })) }));
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: saved }));
  const showTab = (name) => set({ activeTab: name });
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  runner.init({ edit: (key) => editor.editQueued(key, showTab) });
  sidebar.init({
    select: (request) => { editor.onSelect(); sidebar.selectRequest(request); showTab('editor'); },
    add: (request) => runner.add(request),
    addAll: (collection) => runner.addAll(collection),
  });
  unsubscribe = subscribe((state) => renderAll([sidebar.render, editor.render, runner.render], state));
  set({ endpoints });
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  localStorage.heal();
  workspace.stop();
});

const confirmButton = (text) => [...byId('reset-confirm').querySelectorAll('button')].find((b) => b.textContent === text);
const note = () => (byId('editor-note').hidden ? '' : byId('editor-note').textContent);
const editOf = (i) => [...[...byId('sequence-list').querySelectorAll('.seq-row')][i].querySelectorAll('button')].find((b) => b.textContent === 'Edit');

test('the heading row holds the heading then Reset and nothing else, followed by the confirm, the note and the tree in that order', () => {
  const reset = byId('reset-workspace');
  const row = reset.parentNode;
  assert.deepEqual([...row.children].map((c) => c.localName), ['h2', 'button']);
  const h = row.children[0];
  const label = h.getAttribute('aria-labelledby');
  assert.ok(label, 'the heading is not named by its first line');
  assert.equal(document.querySelectorAll(`[id="${label}"]`).length, 1, 'the heading\'s name is not one element');
  assert.ok(h.contains(byId(label)), 'the heading is named by something outside it');
  assert.equal(byId(label).textContent.trim(), 'My Workspace');
  assert.equal(document.querySelectorAll('#reset-workspace').length, 1);

  const section = [...row.parentNode.children];
  const after = section.slice(section.indexOf(row) + 1).map((n) => n.id);
  assert.deepEqual(after.slice(0, 3), ['reset-confirm', 'workspace-note', 'workspace-tree']);
});

test('Reset then Cancel keeps every saved request, hides the confirm, and a second Reset opens one confirm with two choices', () => {
  boot([req('ws-a', 'Find'), req('ws-b', 'Look')]);
  byId('reset-workspace').click();
  assert.equal(byId('reset-confirm').hidden, false);
  confirmButton('Cancel').click();
  assert.equal(byId('reset-confirm').hidden, true);
  assert.equal(get().workspace.length, 2);
  assert.equal(JSON.parse(localStorage.peek(WORKSPACE)).requests.length, 2);

  byId('reset-workspace').click();
  byId('reset-workspace').click();
  assert.deepEqual([...byId('reset-confirm').querySelectorAll('button')].map((b) => b.textContent), ['Reset workspace', 'Cancel']);
  assert.deepEqual(listenerErrors, []);
});

test('a reset the browser refuses says so in the workspace note and keeps the requests', () => {
  boot([req('ws-a', 'Find')]);
  localStorage.failOn('setItem');
  localStorage.failOn('removeItem');
  byId('reset-workspace').click();
  confirmButton('Reset workspace').click();
  assert.equal(byId('reset-confirm').hidden, true);
  assert.equal(byId('workspace-note').hidden, false);
  assert.equal(byId('workspace-note').textContent, workspace.RESET_REFUSED);
  assert.equal(get().workspace.length, 1);
  assert.deepEqual(listenerErrors, []);
});

test('the copy note is not shown when Edit opens an unchanged saved request, gives way to the saved note on Save, and goes when another request is opened', () => {
  boot([req('ws-a', 'Changed since'), req('ws-b', 'Other')], [req('ws-a', 'Find'), req('ws-b', 'Other')]);
  editOf(1).click();
  assert.equal(get().draft.id, 'ws-b', 'an unchanged request was copied');
  assert.equal(note(), '');

  set({ activeTab: 'runner' });
  editOf(0).click();
  const copied = get().draft.name;
  assert.equal(note(), `Copied to My Workspace as "${copied}". Save puts your changes into the run.`);
  assert.doesNotMatch(note(), / - /, 'a dash-joined afterthought');

  typeInto(byId('editor-name'), 'Typed');
  byId('save-request').click();
  assert.equal(note(), 'Saved "Typed" to My Workspace and to request 1 in the run.');

  set({ activeTab: 'runner' });
  editOf(0).click();
  assert.equal(note(), 'Saved "Typed" to My Workspace and to request 1 in the run.', 'reopening the open entry dropped its note');
  const other = [...document.querySelectorAll('#workspace-tree .req-open')].find((b) => b.title === 'Other');
  other.click();
  assert.equal(note(), '');
  assert.deepEqual(listenerErrors, []);
});
