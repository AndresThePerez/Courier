// The note shown when a queued row's Edit copies its request into My
// Workspace says what is true when it is shown: the copy exists, and what is
// typed into it reaches the run on Save, not before. Both ways a copy is made
// say it in the same words.

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

function boot(saved, queued) {
  localStorage.setItem(SETUP, JSON.stringify({ version: 1, mode: 'functional', options: {}, sequence: queued.map((request) => ({ enabled: true, request })) }));
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: saved }));
  const showTab = (name) => set({ activeTab: name });
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  runner.init({ edit: (key) => editor.editQueued(key, showTab) });
  sidebar.init({});
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
  workspace.stop();
});

const note = () => (byId('editor-note').hidden ? '' : byId('editor-note').textContent);
const editOf = (i) => [...byId('sequence-list').querySelectorAll('.seq-row')][i].querySelectorAll('button')[0];
const saidFor = (name) => `Copied to My Workspace as "${name}". Save puts your changes into the run.`;

test('Edit on a row whose saved request changed since it was queued says the copy is made and Save is what reaches the run', () => {
  boot([req('ws-a', 'Changed since')], [req('ws-a', 'Find')]);
  editOf(0).click();
  const { id, name } = get().draft;
  assert.notEqual(id, 'ws-a');
  assert.equal(note(), saidFor(name));

  typeInto(byId('editor-name'), 'Typed');
  assert.equal(get().sequence[0].request.name, name, 'what was typed is in the run before Save');
  byId('save-request').click();
  assert.equal(get().sequence[0].request.name, 'Typed', 'Save did not do what the note said');
  assert.deepEqual(listenerErrors, []);
});

test('a copy made because the saved request changed elsewhere while open says the same', () => {
  boot([req('ws-a', 'Find')], [req('ws-a', 'Find')]);
  editOf(0).click();
  assert.equal(get().draft.id, 'ws-a');
  localStorage.writeFromAnotherTab(WORKSPACE, JSON.stringify({ version: 1, requests: [req('ws-a', 'Elsewhere')] }));
  typeInto(byId('editor-name'), 'Typed');
  const copy = get().sequence[0].request;
  assert.notEqual(copy.id, 'ws-a');
  assert.equal(note(), saidFor(copy.name));
  assert.notEqual(copy.name, 'Typed', 'what was typed is in the run before Save');
  const row = byId('sequence-list').querySelectorAll('.seq-row')[0];
  assert.equal(row.querySelector('.seq-name').textContent, copy.name, 'the queued row does not show the copy the entry now holds');
  assert.deepEqual(listenerErrors, []);
});
