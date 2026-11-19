// "Kept in this browser" is said only when this browser kept the draft. Once
// the browser has refused a write, a Save refused for an invalid draft keeps
// saying the write was refused, and adds why the draft is not ready to run.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors, typeInto } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const saved = { id: 'ws-w', name: 'Write', endpoint: 'search', params: { q: 'x' }, assertions: [{ type: 'json', path: '$.a', op: 'exists' }] };

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: [saved] }));
  workspace.init();
  editor.init();
  unsubscribe = subscribe((state) => editor.render(state));
  set({ endpoints });
  sidebar.selectRequest(workspace.find('ws-w'));
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  localStorage.heal();
  workspace.stop();
});

const note = () => (byId('editor-note').hidden ? '' : byId('editor-note').textContent);
const path = () => byId('assertion-rows').querySelector('.assert-path');

test('with writes refused, a Save refused for an invalid draft keeps the refused-write sentence and never says the draft was kept', () => {
  localStorage.failOn('setItem');
  typeInto(path(), '');
  assert.equal(note(), workspace.WRITE_REFUSED, 'the refused write is not said; the case proves nothing');
  byId('save-request').click();
  assert.doesNotMatch(note(), /Kept in this browser/);
  assert.equal(note(), `${workspace.WRITE_REFUSED} Not ready to run either - Assertion 1: JSON path is required`);
  assert.equal(path().getAttribute('aria-invalid'), 'true', 'the field is still marked');

  // The next keystroke, still refused, says the refused write again.
  typeInto(path(), '$');
  assert.equal(note(), workspace.WRITE_REFUSED);
  assert.deepEqual(listenerErrors, []);
});

test('with writes accepted again, a refused Save says the draft is kept', () => {
  localStorage.failOn('setItem');
  typeInto(path(), '$.b');
  localStorage.heal();
  typeInto(path(), '');
  assert.equal(note(), '', 'an accepted write still says it was refused');
  byId('save-request').click();
  assert.equal(note(), 'Kept in this browser, but not ready to run - Assertion 1: JSON path is required');
});
