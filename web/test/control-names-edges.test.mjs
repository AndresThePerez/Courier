// Form control names at their edges: a full sequence of fifty, requests named
// like markup or like an object's own properties, and the names holding still
// across renders. A name comes from a stable key the page made, never from
// what a visitor typed, and no two controls on the page share one.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe, renderAll } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] }];
const req = (id, name, extra = {}) => ({ id, name, endpoint: 'search', params: { q: 'a' }, assertions: [], ...extra });
const HOSTILE = ['"><img src=x>', '__proto__', 'constructor', 'seq-check-seq-1', ' ', 'a b'];

let unsubscribe = null;

function boot({ saved = [], queued = [] } = {}) {
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
  set({ endpoints, collections: [{ id: 'c1', name: 'Basics', description: '', requests: [req('b1', 'Find')] }] });
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

const controls = () => [...document.querySelectorAll('input, select, textarea')];
const named = () => controls().map((c) => c.getAttribute('name') || c.getAttribute('id') || '');

test('fifty queued entries of requests named like markup and like object properties each get a name of their own, none from their text', () => {
  const queued = Array.from({ length: 50 }, (_, i) => req(`ws-${i % HOSTILE.length}`, HOSTILE[i % HOSTILE.length]));
  boot({ queued });
  const checks = [...byId('sequence-list').querySelectorAll('input[type="checkbox"]')];
  assert.equal(checks.length, 50, 'the sequence did not hold fifty; the case proves nothing');
  const names = checks.map((c) => c.getAttribute('name'));
  assert.equal(new Set(names).size, 50, 'two queued entries share a name');
  for (const name of names) {
    assert.ok(name && !/[<>"\s]|__proto__|constructor/.test(name), `"${name}" is built from a request's name`);
  }
  const all = named();
  assert.ok(all.every(Boolean), 'a form control has neither a name nor an id');
  const ids = controls().map((c) => c.getAttribute('id')).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'two form controls share an id');
  assert.deepEqual(listenerErrors, []);
});

test('the names of queued checkboxes hold still across renders and a reorder moves each name with its entry', () => {
  boot({ queued: [req('ws-1', 'One'), req('ws-2', 'Two'), req('ws-3', 'Three')] });
  const pairs = () => [...byId('sequence-list').querySelectorAll('.seq-row')].map((row) => [row.querySelector('.seq-name').textContent, row.querySelector('.seq-check').getAttribute('name')]);
  const before = pairs();
  for (let i = 0; i < 5; i += 1) set({ status: { running: false, n: i } });
  assert.deepEqual(pairs(), before, 'a render changed a name');
  const first = [...byId('sequence-list').querySelectorAll('.seq-row')][0];
  const move = [...first.querySelectorAll('button')].find((b) => b.dataset.focusKey && b.dataset.focusKey.startsWith('seq-down:'));
  assert.ok(move, 'there is no move-down control; the case proves nothing');
  move.click();
  assert.deepEqual(pairs().map(([name]) => name), ['Two', 'One', 'Three'], 'the move did not happen; the case proves nothing');
  const after = Object.fromEntries(pairs());
  for (const [name, control] of before) assert.equal(after[name], control, `${name} lost its name when moved`);
});

test('an open request named like markup gets parameter and assertion control names from their positions only', () => {
  boot({ saved: [req('ws-x', '"><img src=x>', { params: { q: '"><b>', page: '__proto__' }, assertions: [{ type: 'json', path: '$["<x>"]', op: 'eq', value: '__proto__' }, { type: 'status', op: 'eq', value: 200 }] })] });
  [...byId('workspace-tree').querySelectorAll('.req-open')][0].click();
  const drawn = [...byId('param-rows').querySelectorAll('input, select'), ...byId('assertion-rows').querySelectorAll('input, select')];
  assert.ok(drawn.length >= 6, 'the editor did not draw the rows; the case proves nothing');
  const names = drawn.map((c) => c.getAttribute('name'));
  for (const name of names) assert.match(name, /^(param-key|param-value|assert-type|assert-op|assert-path|assert-value)-\d+$/);
  assert.equal(new Set(names).size, names.length, `two controls share a name: ${names.join(', ')}`);
  assert.deepEqual(listenerErrors, []);
});
