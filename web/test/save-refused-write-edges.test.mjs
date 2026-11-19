// The editor's sentence after Save and after each keystroke while this
// browser's storage refuses writes, starts refusing part-way, and recovers:
// "Kept in this browser" is said only while what is stored is the draft on
// screen, and the refused write stays said until a write is accepted.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const invalid = { id: 'ws-r', name: 'Refused', endpoint: 'search', params: { q: 'x' }, assertions: [{ type: 'json', path: '', op: 'exists' }] };

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: [invalid] }));
  workspace.init();
  editor.init();
  unsubscribe = subscribe((state) => editor.render(state));
  set({ endpoints });
  editor.onSelect();
  sidebar.selectRequest(workspace.find('ws-r'));
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  localStorage.heal();
  workspace.stop();
});

const note = () => (byId('editor-note').hidden ? '' : byId('editor-note').textContent);
const path = () => byId('assertion-rows').querySelector('.assert-path');
const storedDraft = () => JSON.parse(localStorage.peek(WORKSPACE)).requests.find((r) => r.id === get().draft.id) || null;
const Kept = 'Kept in this browser, but not ready to run - Assertion 1: JSON path is required';
const Both = `${workspace.WRITE_REFUSED} Not ready to run either - Assertion 1: JSON path is required`;

// truthful: a sentence that says the draft was kept is said only while the
// stored request is the draft on screen.
function truthful(step) {
  if (/Kept in this browser/.test(note())) {
    assert.deepEqual(storedDraft(), get().draft, `${step}: "kept" is said, but the stored request is not the draft`);
  }
}

test('storage refusing from the start: a Save before any keystroke may say kept (the stored request is the draft), and every refused keystroke after it is said', () => {
  localStorage.failOn('setItem');
  byId('save-request').click();
  assert.equal(note(), Kept);
  truthful('a Save before any keystroke');

  typeInto(path(), '$');
  typeInto(path(), '');
  assert.equal(note(), workspace.WRITE_REFUSED);
  byId('save-request').click();
  assert.equal(note(), Both);
  truthful('a Save after refused keystrokes');
  byId('save-request').click();
  assert.equal(note(), Both, 'a second Save changed the sentence');
  assert.deepEqual(listenerErrors, []);
});

test('storage that starts refusing part-way and recovers: at each keystroke and Save the sentence is true', () => {
  typeInto(path(), '$');
  typeInto(path(), '');
  assert.equal(note(), '');
  byId('save-request').click();
  assert.equal(note(), Kept);
  truthful('accepted');

  localStorage.failOn('setItem');
  typeInto(path(), ' ');
  typeInto(path(), '');
  assert.equal(note(), workspace.WRITE_REFUSED);
  localStorage.heal();
  // Recovered, but nothing written since the refusal: the draft on screen is not what is stored.
  byId('save-request').click();
  assert.equal(note(), Both, 'a Save after a refused keystroke, with no write since, said the draft was kept');
  truthful('recovered, nothing written yet');

  typeInto(path(), '$');
  typeInto(path(), '');
  assert.equal(note(), '', 'an accepted write still says it was refused');
  byId('save-request').click();
  assert.equal(note(), Kept);
  truthful('recovered and written');

  // A valid draft: a refused Save says the write was refused, an accepted one says saved.
  localStorage.failOn('setItem');
  typeInto(path(), '$.a');
  byId('save-request').click();
  assert.equal(note(), workspace.WRITE_REFUSED);
  localStorage.heal();
  byId('save-request').click();
  assert.equal(note(), 'Saved "Refused" to My Workspace.');
  assert.deepEqual(storedDraft(), get().draft);
  assert.deepEqual(listenerErrors, []);
});

test('opening another request forgets the refusal of the last one only as far as it is true', () => {
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: [invalid, { ...invalid, id: 'ws-s', name: 'Second' }] }));
  workspace.stop();
  workspace.init();
  localStorage.failOn('setItem');
  typeInto(path(), '$');
  assert.equal(note(), workspace.WRITE_REFUSED);
  editor.onSelect();
  sidebar.selectRequest(workspace.find('ws-s'));
  assert.equal(note(), '');
  byId('save-request').click();
  // The second request was not written since it was stored, so it is kept as shown.
  assert.equal(note(), Kept);
  truthful('the second request');
  assert.deepEqual(listenerErrors, []);
});
