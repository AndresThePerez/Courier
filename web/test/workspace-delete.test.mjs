import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, typeInto, listenerErrors } from './shim.mjs';
import { resetState, get } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';

const KEY = 'courier.workspace.v1';
const DELETED_ELSEWHERE = 'This request was deleted in another tab.';

const pikachu = {
  id: 'ws-1',
  name: 'Search pikachu',
  endpoint: 'search',
  params: { q: 'pikachu' },
  assertions: [{ type: 'status', op: 'eq', value: 200 }],
};
const eevee = { ...pikachu, id: 'ws-2', name: 'Search eevee', params: { q: 'eevee' } };

function storedIds() {
  const raw = localStorage.peek(KEY);
  return raw === null ? [] : JSON.parse(raw).requests.map((r) => r.id);
}

function paint() {
  sidebar.render(get());
  editor.render(get());
}

// open boots the parts of the page this needs, with the given requests saved,
// and opens the first one in the editor.
function open(requests = [pikachu, eevee]) {
  localStorage.setItem(KEY, JSON.stringify({ version: 1, requests }));
  workspace.init();
  editor.init();
  sidebar.init({
    select: (r) => {
      editor.onSelect();
      sidebar.selectRequest(r);
    },
  });
  sidebar.selectRequest(workspace.find(requests[0].id));
  paint();
}

function deleteButton(id) {
  const rows = document.getElementById('workspace-tree').querySelectorAll('.req-row');
  for (const row of rows) {
    const opener = row.querySelector('.req-open');
    if (opener.title === workspace.find(id).name) return row.querySelector('[title="Delete this saved request"]');
  }
  return null;
}

beforeEach(() => {
  resetBrowser();
  resetState();
  globalThis.confirm = () => assert.fail('window.confirm is never used');
});

// ---------------------------------------------------------------- this tab

test('deleting the open request closes it and the next keystroke does not bring it back', () => {
  open();
  const name = document.getElementById('editor-name');

  deleteButton('ws-1').click();
  paint();

  assert.equal(get().draft, null);
  assert.equal(get().selectedId, null);
  assert.equal(document.getElementById('editor-form').hidden, true);

  typeInto(name, 'typed after the delete');
  paint();

  assert.deepEqual(storedIds(), ['ws-2']);
  assert.deepEqual(get().workspace.map((r) => r.id), ['ws-2']);
  assert.deepEqual(listenerErrors, []);
});

test('deleting a request that is not open leaves the open one alone', () => {
  open();
  deleteButton('ws-2').click();
  paint();
  assert.equal(get().draft.id, 'ws-1');
  assert.equal(get().selectedId, 'ws-1');
  assert.deepEqual(storedIds(), ['ws-1']);
});

test('a delete offers an undo that restores the request under the same id', () => {
  open();
  deleteButton('ws-1').click();
  paint();

  const note = document.getElementById('workspace-note');
  assert.ok(note, 'the sidebar has a note for the undo');
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'Deleted "Search pikachu". Undo');

  note.querySelector('button').click();
  paint();

  assert.deepEqual(storedIds().sort(), ['ws-1', 'ws-2']);
  assert.deepEqual(workspace.find('ws-1'), pikachu);
  assert.equal(note.hidden, true);
});

// ---------------------------------------------------------------- another tab

test('the open request deleted in another tab closes here and says so', () => {
  open();
  localStorage.writeFromAnotherTab(KEY, JSON.stringify({ version: 1, requests: [eevee] }));
  paint();

  assert.equal(get().draft, null);
  assert.equal(get().selectedId, null);
  const notice = document.getElementById('editor-notice');
  assert.ok(notice, 'the editor has a notice line');
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, DELETED_ELSEWHERE);
});

test('a keystroke that races a delete from another tab closes the request instead of resurrecting it', () => {
  open();
  // The other tab's write has landed but its storage event has not arrived.
  localStorage.setItem(KEY, JSON.stringify({ version: 1, requests: [eevee] }));

  typeInto(document.getElementById('editor-name'), 'late keystroke');
  paint();

  assert.deepEqual(storedIds(), ['ws-2']);
  assert.equal(get().draft, null);
  assert.equal(document.getElementById('editor-notice').textContent, DELETED_ELSEWHERE);
});

test('another tab deleting a different request leaves the open one and shows no notice', () => {
  open();
  localStorage.writeFromAnotherTab(KEY, JSON.stringify({ version: 1, requests: [pikachu] }));
  paint();
  assert.equal(get().draft.id, 'ws-1');
  assert.equal(document.getElementById('editor-notice').hidden, true);
});

test('opening another request clears the deleted-elsewhere notice', () => {
  open();
  localStorage.writeFromAnotherTab(KEY, JSON.stringify({ version: 1, requests: [eevee] }));
  paint();
  sidebar.selectRequest(workspace.find('ws-2'));
  paint();
  assert.equal(document.getElementById('editor-notice').hidden, true);
});

test('the whole workspace reset in another tab closes the open request', () => {
  open();
  localStorage.writeFromAnotherTab(KEY, null);
  paint();
  assert.equal(get().draft, null);
  assert.deepEqual(get().workspace, []);
  assert.equal(document.getElementById('editor-notice').textContent, DELETED_ELSEWHERE);
});
