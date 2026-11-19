// The editor's catalog-drawn parts are repainted when the catalog object is
// replaced, even by an equal copy. Typing must survive that: a visitor typing
// into a parameter, an assertion value or the name while the catalog is read
// again between keystrokes keeps the field, the text and the caret, and what
// they typed is what the request holds.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe, renderAll } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const catalog = () => [
  { id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] },
  { id: 'lookup', label: 'Lookup', method: 'POST', path: '/lookup', params: ['id'] },
];

let unsubscribe = null;

function boot() {
  localStorage.setItem(WORKSPACE, JSON.stringify({
    version: 1,
    requests: [{
      id: 'ws-a', name: 'Find', endpoint: 'search', params: { q: '' },
      assertions: [{ type: 'json', path: '$.total', op: 'eq', value: 1 }],
    }],
  }));
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  runner.init({});
  sidebar.init({ select: (request) => { editor.onSelect(); sidebar.selectRequest(request); } });
  unsubscribe = subscribe((state) => renderAll([sidebar.render, editor.render, runner.render, results.render], state));
  set({ endpoints: catalog() });
  editor.onSelect();
  sidebar.selectRequest(workspace.find('ws-a'));
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

// typeKey types one character at the caret of whatever field has focus, as a
// keystroke does: the value changes, the caret moves past the character, and
// input fires.
function typeKey(ch) {
  const node = document.activeElement;
  const at = node.selectionStart ?? node.value.length;
  const text = node.value.slice(0, at) + ch + node.value.slice(node.selectionEnd ?? at);
  node.value = text;
  node.setSelectionRange(at + 1, at + 1);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}

const focusKey = () => document.activeElement && document.activeElement.dataset && document.activeElement.dataset.focusKey;

test('typing into a parameter while the catalog is replaced by an equal copy between keystrokes keeps the field, every character and the caret', () => {
  boot();
  const field = byId('param-rows').querySelector('.param-value');
  field.focus();
  const word = 'charizard';
  for (const ch of word) {
    typeKey(ch);
    set({ endpoints: catalog() });
    set({ status: { running: false } });
  }
  assert.equal(focusKey(), 'param-value:0', 'focus left the parameter');
  assert.equal(document.activeElement.value, word);
  assert.equal(document.activeElement.selectionStart, word.length);
  assert.equal(get().draft.params.q, word);
  assert.equal(workspace.find('ws-a').params.q, word);
  assert.deepEqual(listenerErrors, []);
});

test('a caret in the middle of a parameter stays where it was across a catalog refresh, and the next keystroke lands there', () => {
  boot();
  const field = byId('param-rows').querySelector('.param-value');
  field.focus();
  for (const ch of 'pkachu') typeKey(ch);
  document.activeElement.setSelectionRange(1, 1);
  typeKey('i');
  const typedIn = document.activeElement;
  set({ endpoints: catalog() });
  assert.ok(document.activeElement !== typedIn, 'the table was not rebuilt: the case proves nothing');
  assert.equal(focusKey(), 'param-value:0');
  assert.equal(document.activeElement.selectionStart, 2, 'the caret moved');
  typeKey('!');
  set({ endpoints: catalog() });
  assert.equal(get().draft.params.q, 'pi!kachu');
  assert.equal(document.activeElement.value, 'pi!kachu');
  assert.deepEqual(listenerErrors, []);
});

test('typing into an assertion\'s path and value across catalog refreshes keeps each field and what was typed', () => {
  boot();
  const path = byId('assertion-rows').querySelector('.assert-path');
  path.focus();
  document.activeElement.setSelectionRange(path.value.length, path.value.length);
  for (const ch of '.x') {
    typeKey(ch);
    set({ endpoints: catalog() });
  }
  assert.equal(focusKey(), 'assert-path:0');
  assert.equal(get().draft.assertions[0].path, '$.total.x');

  byId('assertion-rows').querySelector('.assert-value').focus();
  document.activeElement.value = '';
  for (const ch of '42') {
    typeKey(ch);
    set({ endpoints: catalog() });
  }
  assert.equal(focusKey(), 'assert-value:0');
  assert.equal(document.activeElement.value, '42');
  assert.equal(get().draft.assertions[0].value, 42);
  assert.deepEqual(listenerErrors, []);
});

test('typing the name across catalog refreshes keeps the name field and its text, and the endpoint picker keeps its choice', () => {
  boot();
  const name = byId('editor-name');
  name.focus();
  name.setSelectionRange(name.value.length, name.value.length);
  for (const ch of ' cards') {
    typeKey(ch);
    set({ endpoints: catalog() });
  }
  assert.ok(document.activeElement === name, 'focus left the name');
  assert.equal(name.value, 'Find cards');
  assert.equal(get().draft.name, 'Find cards');

  const select = byId('endpoint-select');
  select.focus();
  set({ endpoints: catalog() });
  assert.ok(document.activeElement === select, 'focus left the endpoint picker');
  assert.equal(select.value, 'search');
  assert.equal(select.querySelectorAll('option').length, 2, 'options were duplicated');
  assert.deepEqual(listenerErrors, []);
});
