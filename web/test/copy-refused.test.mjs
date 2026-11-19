// A copy into My Workspace is said to be made only when this browser stored
// it. With writes refused, the first keystroke on a built-in request and the
// Edit that copies a queued request say the write was refused, in the words
// every refused write uses, and what was typed stays on the page.

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
const builtIn = req('pokemon-search', 'Find a Pokemon');

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
  localStorage.heal();
  workspace.stop();
});

const note = () => (byId('editor-note').hidden ? '' : byId('editor-note').textContent);
const editOf = (i) => [...byId('sequence-list').querySelectorAll('.seq-row')][i].querySelectorAll('button')[0];
const stored = () => JSON.parse(localStorage.getItem(WORKSPACE)).requests;

test('the first keystroke on a built-in request, with writes refused from the start, says the write was refused and keeps the typing', () => {
  boot([], []);
  sidebar.selectRequest(builtIn);
  localStorage.failOn('setItem');
  typeInto(byId('editor-name'), 'Typed');
  assert.equal(note(), workspace.WRITE_REFUSED);
  assert.doesNotMatch(note(), /Copied to My Workspace/);
  assert.equal(get().draft.name, 'Typed', 'what was typed is lost from the page');
  assert.equal(byId('editor-name').value, 'Typed');
  assert.deepEqual(stored(), [], 'something was stored after all');

  typeInto(byId('editor-name'), 'Typed more');
  assert.equal(note(), workspace.WRITE_REFUSED);
  assert.equal(get().draft.name, 'Typed more');
  assert.deepEqual(listenerErrors, []);
});

test('the first keystroke on a built-in request, with writes taken, says the copy was made; once writes are refused mid-edit it says so', () => {
  boot([], []);
  sidebar.selectRequest(builtIn);
  typeInto(byId('editor-name'), 'Typed');
  assert.match(note(), /^Copied to My Workspace as "/);
  assert.equal(stored().length, 1);

  localStorage.failOn('setItem');
  typeInto(byId('editor-name'), 'Typed more');
  assert.equal(note(), workspace.WRITE_REFUSED);
  assert.equal(get().draft.name, 'Typed more');
  assert.equal(stored()[0].name, 'Typed', 'the refused write changed what is stored');

  localStorage.heal();
  typeInto(byId('editor-name'), 'Typed again');
  assert.doesNotMatch(note(), /Could not save/);
  assert.equal(stored()[0].name, 'Typed again');
  assert.deepEqual(listenerErrors, []);
});

test('Edit on a queued request that has to be copied, with writes refused from the start, says the write was refused and keeps the typing', () => {
  boot([], [req('pokemon-search', 'Find')]);
  localStorage.failOn('setItem');
  editOf(0).click();
  assert.equal(note(), workspace.WRITE_REFUSED);
  assert.doesNotMatch(note(), /Copied to My Workspace/);

  typeInto(byId('editor-name'), 'Typed');
  assert.equal(note(), workspace.WRITE_REFUSED);
  assert.doesNotMatch(note(), /Copied to My Workspace/);
  assert.equal(get().draft.name, 'Typed', 'what was typed is lost from the page');
  assert.deepEqual(listenerErrors, []);
});

test('a queued request copied while writes are taken says so; refused mid-edit, the next keystroke says the write was refused', () => {
  boot([], [req('pokemon-search', 'Find')]);
  editOf(0).click();
  assert.match(note(), /^Copied to My Workspace as "/);

  localStorage.failOn('setItem');
  typeInto(byId('editor-name'), 'Typed');
  assert.equal(note(), workspace.WRITE_REFUSED);
  assert.equal(get().draft.name, 'Typed');
  assert.deepEqual(listenerErrors, []);
});
