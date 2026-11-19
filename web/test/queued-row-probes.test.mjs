// Queued rows probed at their edges: requests replaced under the same key by
// every writer the page has, with hostile and maximal text, together with a
// change of the checked state or of a refusal; and renders that change nothing
// a row paints, which must leave the rows, the focus, the sidebar markers and
// the Runner tab count exactly as they were. Rows are read as painted.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
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
const setupOf = (requests, enabled = true) => ({
  version: 1, mode: 'functional', options: {}, sequence: requests.map((request) => ({ enabled, request })),
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
const buttonOf = (row, text) => [...row.querySelectorAll('button')].find((b) => b.textContent === text);
const editOf = (i) => buttonOf(rows()[i], 'Edit');
const painted = (row) => ({
  index: row.querySelector('.seq-index').textContent,
  method: row.querySelector('.method').textContent,
  name: row.querySelector('.seq-name').textContent,
  target: row.querySelector('.seq-target').textContent,
  checked: row.querySelector('.seq-check').checked,
  off: row.classList.contains('is-off'),
  invalid: row.classList.contains('is-invalid'),
  error: row.querySelector('.seq-error') ? row.querySelector('.seq-error').textContent : '',
});
const paintedAll = () => rows().map(painted);
const fromState = () => get().sequence.map((e, i) => {
  const r = e.request;
  const query = Object.entries(r.params || {}).map(([k, v]) => `${k}=${v}`).join('&');
  return {
    index: String(i + 1),
    method: endpoints.find((x) => x.id === r.endpoint).method,
    name: r.name || r.id,
    target: `${r.endpoint}${query ? `?${query}` : ''}`,
  };
});
const shownCore = () => paintedAll().map(({ index, method, name, target }) => ({ index, method, name, target }));
const save = () => byId('save-request').click();
const paramValue = (j) => byId('param-rows').querySelectorAll('.param-value')[j];
const poll = (n) => set({ status: { running: false, budget_balance: 1000 + n } });
const markers = () => [...document.querySelectorAll('#workspace-tree .req-row')].map((r) => {
  const name = r.querySelector('.req-open').title;
  const mark = r.querySelector('.in-run');
  return `${name}:${mark ? mark.textContent : '-'}`;
});

test('a name of 120 characters holding quotes and angle brackets and a 500-character parameter value, saved through a row\'s Edit, are painted on that row as text', () => {
  boot({ saved: [req('ws-a', 1), req('ws-b', 2)], setup: setupOf([req('ws-a', 1), req('ws-b', 2)]) });
  const name = `"<img src=x onerror=1>" & '<b>bold</b>'`.padEnd(120, '<');
  const value = '"><script>x</script>'.padEnd(500, '"');
  assert.equal(name.length, 120);
  assert.equal(value.length, 500);

  editOf(0).click();
  typeInto(byId('editor-name'), name);
  typeInto(paramValue(0), value);
  save();

  assert.match(byId('editor-note').textContent, /to request 1 in the run/);
  const row = rows()[0];
  assert.equal(painted(row).name, name);
  assert.equal(painted(row).target, `search?q=${value}`);
  assert.equal(row.querySelectorAll('img, b, script').length, 0, 'text from the request became markup');
  assert.equal(buttonOf(row, 'Edit').getAttribute('aria-label'), `Edit ${name}`);
  assert.equal(rows().length, 2, 'a row was added or lost');
  assert.deepEqual(shownCore(), fromState());
  assert.deepEqual(listenerErrors, []);
});

test('a second Edit and Save on the same row paints the second change, and the sidebar marker and Runner count stay true', () => {
  boot({ saved: [req('ws-a', 1), req('ws-b', 2)], setup: setupOf([req('ws-a', 1), req('ws-b', 2)]) });
  editOf(0).click();
  typeInto(byId('editor-name'), 'First pass');
  save();
  assert.equal(painted(rows()[0]).name, 'First pass');

  set({ activeTab: 'runner' });
  editOf(0).click();
  typeInto(byId('editor-name'), 'Second pass');
  typeInto(paramValue(0), 'eevee');
  save();

  assert.match(byId('editor-note').textContent, /to request 1 in the run/);
  assert.equal(painted(rows()[0]).name, 'Second pass');
  assert.equal(painted(rows()[0]).target, 'search?q=eevee');
  assert.deepEqual(shownCore(), fromState());
  assert.equal(byId('tab-runner').textContent, 'Runner (2)');
  assert.deepEqual(markers().sort(), ['Req 2:in run', 'Second pass:in run']);
  assert.deepEqual(listenerErrors, []);
});

test('Edit opened on a row that is then moved saves into the row at its new position', () => {
  boot({ saved: [req('ws-a', 1), req('ws-b', 2)], setup: setupOf([req('ws-a', 1), req('ws-b', 2)]) });
  editOf(0).click();
  typeInto(byId('editor-name'), 'Moved then saved');
  set({ activeTab: 'runner' });
  buttonOf(rows()[0], '↓').click();
  assert.deepEqual(paintedAll().map((r) => r.name), ['Req 2', 'Req 1'], 'the move was not painted');

  save();
  assert.match(byId('editor-note').textContent, /to request 2 in the run/);
  assert.deepEqual(paintedAll().map((r) => r.name), ['Req 2', 'Moved then saved']);
  assert.deepEqual(shownCore(), fromState());
  assert.deepEqual(listenerErrors, []);
});

test('a write that changes the checked state and the request of one entry together paints both on that row', () => {
  boot({ setup: setupOf([req('ws-a', 1), req('ws-b', 2)]) });
  const key = get().sequence[0].key;
  set({
    sequence: get().sequence.map((e) => (e.key === key
      ? { ...e, enabled: false, request: { ...e.request, name: 'Off and renamed', endpoint: 'lookup', params: { id: '7' } } }
      : e)),
  });
  assert.deepEqual(painted(rows()[0]), {
    index: '1', method: 'POST', name: 'Off and renamed', target: 'lookup?id=7', checked: false, off: true, invalid: false, error: '',
  });
  assert.equal(painted(rows()[1]).name, 'Req 2');
  assert.match(byId('sequence-count').textContent, /1 selected/);

  set({ sequence: get().sequence.map((e) => (e.key === key ? { ...e, enabled: true, request: { ...e.request, name: 'On again' } } : e)) });
  assert.deepEqual(painted(rows()[0]), {
    index: '1', method: 'POST', name: 'On again', target: 'lookup?id=7', checked: true, off: false, invalid: false, error: '',
  });
  assert.deepEqual(listenerErrors, []);
});

test('a refused row renamed and saved through its Edit drops the refusal and paints the new name in the same write', async () => {
  boot({ saved: [req('ws-a', 1), req('ws-b', 2)], setup: setupOf([req('ws-a', 1), req('ws-b', 2)]) });
  fetchStub.respond('/api/runs', {
    status: 400,
    body: { error: 'a status assertion needs a whole number from 100 to 599, got 200', field: 'sequence[1].assertions[0]' },
  }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  assert.equal(painted(rows()[1]).invalid, true, 'the case starts with a refused row');
  assert.notEqual(painted(rows()[1]).error, '');

  editOf(1).click();
  typeInto(byId('editor-name'), 'Fixed and renamed');
  save();

  const row = rows()[1];
  assert.equal(painted(row).name, 'Fixed and renamed');
  assert.equal(painted(row).invalid, false, 'the refusal stayed after the fix');
  assert.equal(painted(row).error, '');
  assert.equal(row.querySelector('.seq-check').getAttribute('aria-describedby'), null, 'the checkbox still points at a gone error');
  assert.deepEqual(shownCore(), fromState());
  assert.deepEqual(listenerErrors, []);
});

test('a restore from a stored setup that differs only in its requests paints the stored requests', () => {
  boot({ setup: setupOf([req('ws-a', 1), req('ws-b', 2)]) });
  assert.deepEqual(paintedAll().map((r) => r.name), ['Req 1', 'Req 2']);
  localStorage.setItem(SETUP, JSON.stringify(setupOf([
    req('ws-a', 1, { name: 'Restored one', params: { q: 'r1' } }),
    req('ws-b', 2, { name: 'Restored two', endpoint: 'lookup', params: { id: '9' } }),
  ])));
  runner.restore();
  assert.deepEqual(shownCore(), [
    { index: '1', method: 'GET', name: 'Restored one', target: 'search?q=r1' },
    { index: '2', method: 'POST', name: 'Restored two', target: 'lookup?id=9' },
  ]);
  assert.deepEqual(listenerErrors, []);
});

test('ten polls leave every row node in place, keep focus on a row\'s checkbox, Edit and remove control, and change no marker or count', () => {
  boot({ saved: [req('ws-a', 1), req('ws-b', 2)], setup: setupOf([req('ws-a', 1), req('ws-b', 2), req('ws-a', 1)]) });
  set({ activeTab: 'runner' });
  const before = rows();
  const tab = byId('tab-runner').textContent;
  const marks = markers();
  const controls = [
    rows()[1].querySelector('.seq-check'),
    editOf(1),
    buttonOf(rows()[2], 'x'),
  ];
  let n = 0;
  for (const control of controls) {
    control.focus();
    for (let i = 0; i < 10; i += 1) poll((n += 1));
    assert.ok(document.activeElement === control, `focus left ${control.getAttribute('aria-label')}`);
  }
  const after = rows();
  assert.equal(after.length, 3);
  after.forEach((row, i) => assert.ok(row === before[i], `row ${i + 1} was rebuilt by a poll`));
  assert.equal(byId('tab-runner').textContent, tab);
  assert.deepEqual(markers(), marks);
  assert.deepEqual(marks.sort(), ['Req 1:in run x2', 'Req 2:in run']);
  assert.deepEqual(listenerErrors, []);
});

test('fifty rows with long parameters are not rebuilt by fifty polls, and one Save repaints only what changed in what is shown', () => {
  const long = (n) => `${n}-`.padEnd(500, 'z');
  const queued = Array.from({ length: 50 }, (_, i) => req(`ws-${i}`, i, { params: { q: long(i), page: String(i), size: '9' } }));
  boot({ saved: queued, setup: setupOf(queued) });
  set({ activeTab: 'runner' });
  assert.equal(rows().length, 50);

  const before = rows();
  for (let i = 0; i < 50; i += 1) poll(i);
  const rebuilt = rows().filter((row, i) => row !== before[i]).length;
  assert.equal(rebuilt, 0, `${rebuilt} rows rebuilt across fifty polls`);

  const shown = paintedAll();
  editOf(25).click();
  typeInto(byId('editor-name'), 'Middle one');
  save();
  const after = paintedAll();
  assert.equal(after.length, 50, 'a row was added or lost');
  after.forEach((row, i) => {
    if (i === 25) assert.equal(row.name, 'Middle one');
    else assert.deepEqual(row, shown[i], `row ${i + 1} changed`);
  });
  assert.equal(new Set(rows()).size, 50, 'a row node is shown twice');
  assert.deepEqual(shownCore(), fromState());

  const settled = rows();
  for (let i = 0; i < 50; i += 1) poll(100 + i);
  assert.equal(rows().filter((row, i) => row !== settled[i]).length, 0, 'polls after the Save rebuild rows');
  assert.deepEqual(listenerErrors, []);
});

test('Edit that copies a changed request moves the sidebar marker to the copy and paints the copy on the row', () => {
  const queued = req('ws-a', 1);
  boot({ saved: [{ ...queued, name: 'Changed since' }], setup: setupOf([queued]) });
  assert.deepEqual(markers(), ['Changed since:in run']);
  editOf(0).click();
  const copy = get().sequence[0].request;
  assert.notEqual(copy.id, 'ws-a');
  assert.equal(painted(rows()[0]).name, copy.name);
  assert.deepEqual(markers().sort(), [`${copy.name}:in run`, 'Changed since:-'].sort());
  assert.equal(byId('tab-runner').textContent, 'Runner (1)');
  assert.deepEqual(listenerErrors, []);
});
