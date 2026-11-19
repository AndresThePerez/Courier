// A queued row paints the request its entry holds, whichever way that request
// was replaced under the same key: Save after the row's Edit, the copy Edit
// makes of a request that changed since it was queued. The page is wired the
// way main.js wires it, one guarded render of every pane per change, and the
// rows are read as painted, not from state.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe, renderAll } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [
  { id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page', 'size'] },
  { id: 'lookup', label: 'Lookup', method: 'POST', path: '/lookup', params: ['id'] },
];

const req = (id, n = 1, extra = {}) => ({
  id, name: `Req ${n}`, endpoint: 'search', params: { q: `q${n}` },
  assertions: [{ type: 'status', op: 'eq', value: 200 }], ...extra,
});
const setupOf = (requests) => ({
  version: 1, mode: 'functional', options: {}, sequence: requests.map((request) => ({ enabled: true, request })),
});

let unsubscribe = null;

function boot({ setup, saved } = {}) {
  if (setup) localStorage.setItem(SETUP, JSON.stringify(setup));
  if (saved) localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: saved }));
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
  unsubscribe = subscribe((state) => renderAll([sidebar.render, editor.render, runner.render, results.render], state));
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

const rows = () => [...byId('sequence-list').querySelectorAll('.seq-row')];
const editOf = (i) => [...rows()[i].querySelectorAll('button')].find((b) => b.textContent === 'Edit');
const painted = (row) => ({
  index: row.querySelector('.seq-index').textContent,
  method: row.querySelector('.method').textContent,
  name: row.querySelector('.seq-name').textContent,
  target: row.querySelector('.seq-target').textContent,
  edit: [...row.querySelectorAll('button')].find((b) => b.textContent === 'Edit').getAttribute('aria-label'),
});
const paintedAll = () => rows().map(painted);
const save = () => byId('save-request').click();
const paramValue = (j) => byId('param-rows').querySelectorAll('.param-value')[j];
const stored = () => JSON.parse(localStorage.peek(WORKSPACE)).requests;

// expected is what a row must paint for what an entry holds now.
const expected = (i, r, method = 'GET') => {
  const query = Object.entries(r.params || {}).map(([k, v]) => `${k}=${v}`).join('&');
  const name = r.name || r.id;
  return { index: String(i + 1), method, name, target: `${r.endpoint}${query ? `?${query}` : ''}`, edit: `Edit ${name}` };
};
const fromState = () => get().sequence.map((e, i) => expected(i, e.request, endpoints.find((x) => x.id === e.request.endpoint).method));

test('Save after a queued row\'s Edit paints the new name and target on that row at once, and leaves the others as they were', () => {
  boot({ saved: [req('ws-a', 1), req('ws-b', 2)], setup: setupOf([req('ws-a', 1), req('ws-b', 2)]) });
  const before = paintedAll();
  editOf(0).click();
  typeInto(byId('editor-name'), 'Renamed');
  typeInto(paramValue(0), 'pikachu');
  save();

  assert.match(byId('editor-note').textContent, /to request 1 in the run/);
  const after = paintedAll();
  assert.equal(after.length, 2, 'a row was added or lost');
  assert.deepEqual(after[0], { index: '1', method: 'GET', name: 'Renamed', target: 'search?q=pikachu', edit: 'Edit Renamed' });
  assert.deepEqual(after[1], before[1], 'the other row changed');
  assert.deepEqual(after, fromState());
  assert.deepEqual(listenerErrors, []);
});

test('Save of an endpoint change paints the row\'s method badge and target from what the entry now holds', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1)]) });
  editOf(0).click();
  const select = byId('endpoint-select');
  select.value = 'lookup';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  save();

  assert.deepEqual(paintedAll(), [{ index: '1', method: 'POST', name: 'Req 1', target: 'lookup', edit: 'Edit Req 1' }]);
  assert.deepEqual(paintedAll(), fromState());
  assert.deepEqual(listenerErrors, []);
});

test('Edit on a row whose saved request changed since it was queued paints the copy the entry now holds', () => {
  const queued = req('ws-a', 1);
  boot({ saved: [{ ...queued, name: 'Changed since' }], setup: setupOf([queued, req('ws-b', 2)]) });
  editOf(0).click();

  assert.match(byId('editor-note').textContent, /Copied to My Workspace/);
  const entry = get().sequence[0].request;
  assert.notEqual(entry.id, 'ws-a', 'no copy was made');
  assert.notEqual(entry.name, 'Req 1', 'the copy kept the queued name; the case proves nothing');
  assert.deepEqual(paintedAll(), fromState());
  assert.equal(painted(rows()[0]).name, entry.name);
  assert.deepEqual(listenerErrors, []);
});

test('two rows queued from one saved request each paint their own entry after Edit and Save on one of them', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1), req('ws-a', 1)]) });
  editOf(1).click();
  typeInto(byId('editor-name'), 'Second only');
  typeInto(paramValue(0), 'mew');
  save();

  assert.match(byId('editor-note').textContent, /to request 2 in the run/);
  assert.deepEqual(paintedAll(), [
    expected(0, req('ws-a', 1)),
    { index: '2', method: 'GET', name: 'Second only', target: 'search?q=mew', edit: 'Edit Second only' },
  ]);
  assert.deepEqual(paintedAll(), fromState());
  assert.equal(stored().length, 1, 'a copy was made');
  assert.deepEqual(listenerErrors, []);
});

test('a status poll after a Save leaves the very same row nodes in place and keeps focus on a row\'s control', () => {
  boot({ saved: [req('ws-a', 1), req('ws-b', 2)], setup: setupOf([req('ws-a', 1), req('ws-b', 2)]) });
  editOf(0).click();
  typeInto(byId('editor-name'), 'Renamed');
  save();
  set({ activeTab: 'runner' });

  const before = rows();
  const edit = editOf(1);
  edit.focus();
  set({ status: { running: false, budget_balance: 1200 } });
  set({ status: { running: false, budget_balance: 1205 } });

  const after = rows();
  assert.equal(after.length, before.length);
  after.forEach((row, i) => assert.ok(row === before[i], `row ${i + 1} was rebuilt by a poll`));
  assert.ok(document.activeElement === edit, 'focus left the row\'s Edit');
  assert.deepEqual(paintedAll(), fromState());
  assert.deepEqual(listenerErrors, []);
});

const chips = (row) => [...row.querySelectorAll('.chip')].map((c) => c.textContent);
const focusKeyOf = () => document.activeElement && document.activeElement.dataset && document.activeElement.dataset.focusKey;

test('a request replaced under its key with its params in another order, or with only an unpainted key changed, paints what the entry holds and keeps focus', () => {
  boot({ setup: setupOf([req('ws-a', 1, { params: { q: 'x', page: '2' } }), req('ws-b', 2)]) });
  set({ activeTab: 'runner' });
  const key = get().sequence[0].key;
  editOf(1).focus();
  const focused = focusKeyOf();

  runner.repoint(key, req('ws-a', 1, { params: { page: '2', q: 'x' } }));
  assert.equal(painted(rows()[0]).target, 'search?page=2&q=x', 'the target follows the order the entry holds');
  assert.deepEqual(paintedAll(), fromState());
  assert.equal(focusKeyOf(), focused, 'focus left the row\'s control');

  runner.repoint(key, { ...get().sequence[0].request, note: 'never painted' });
  assert.deepEqual(paintedAll(), fromState());
  assert.equal(focusKeyOf(), focused, 'focus left the row\'s control');

  runner.repoint(key, { ...get().sequence[0].request, assertions: [{ type: 'status', op: 'eq', value: 201 }] });
  assert.deepEqual(chips(rows()[0]), ['status = 201'], 'the chip kept the old value');
  assert.equal(focusKeyOf(), focused, 'focus left the row\'s control');
  assert.deepEqual(listenerErrors, []);
});

test('a queued request holding a value JSON cannot encode is still shown, and repainted when it is replaced', () => {
  boot();
  const big = (name) => ({ id: 'big', name, endpoint: 'search', params: {}, assertions: [{ type: 'status', op: 'eq', value: 10n }] });
  set({ sequence: [{ key: 'q1', enabled: true, request: big('First') }] });
  assert.equal(painted(rows()[0]).name, 'First');
  set({ sequence: [{ key: 'q1', enabled: true, request: big('Second') }] });
  assert.equal(painted(rows()[0]).name, 'Second');
  const before = rows()[0];
  set({ status: { running: false } });
  assert.ok(rows()[0] === before, 'a poll rebuilt the row');
  assert.deepEqual(listenerErrors, []);
});
