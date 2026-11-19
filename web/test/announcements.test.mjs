// What a screen reader is told and what each control is called: the notes a
// press answers are status regions, every + says which request it adds, the
// results summary is said again only when what it says changed, and every
// form control the page draws has a name.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe, renderAll } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [
  { id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] },
  { id: 'healthz', label: 'Health', method: 'GET', path: '/healthz', params: [] },
];
const req = (id, name, extra = {}) => ({ id, name, endpoint: 'search', params: { q: 'a' }, assertions: [], ...extra });
const collections = [
  { id: 'c1', name: 'Basics', description: '', requests: [req('b1', 'Find'), req('b2', 'Look')] },
  { id: 'c2', name: 'More', description: '', requests: [req('b3', 'Find')] },
];

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
  unsubscribe = subscribe((state) => renderAll([sidebar.render, editor.render, runner.render, results.render], state));
  set({ endpoints, collections });
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

// ---------------------------------------------------------------- status regions

test('the send status, the start note and the editor note are status regions', () => {
  for (const id of ['send-status', 'start-note', 'editor-note']) {
    assert.equal(byId(id).getAttribute('role'), 'status', `#${id} is not announced`);
  }
});

// ---------------------------------------------------------------- the + buttons

test('every + in the sidebar is named for the request it adds', () => {
  boot({ saved: [req('ws-1', 'Mine'), req('ws-2', '')] });
  const pluses = [...byId('panel-sidebar').querySelectorAll('button')].filter((b) => b.textContent === '+');
  assert.equal(pluses.length, 5, 'the case does not reach every list');
  const named = pluses.map((b) => {
    const row = b.closest('.req-row');
    return [b.getAttribute('aria-label'), row.querySelector('.req-open').title];
  });
  for (const [label, name] of named) assert.equal(label, `Add ${name} to the run`);
  assert.deepEqual(named.map(([label]) => label), [
    'Add Find to the run', 'Add Look to the run', 'Add Find to the run', 'Add Mine to the run', 'Add ws-2 to the run',
  ]);
});

// ---------------------------------------------------------------- results summary

const run = (startedAt) => ({ id: 'run-1', mode: 'functional', total: 1, started_at: startedAt, config: {}, entries: [] });
const resultRow = { index: 0, name: 'R', endpoint: 'search', query: '', status: 200, latency_ms: 4, size_bytes: 10, passed: true, skipped: false, assertions: [] };

test('a render that draws the results summary exactly as it stands leaves its nodes in place', () => {
  boot();
  set({ transport: 'sse', run: run('2026-11-16T14:03:22Z'), results: [resultRow] });
  const before = [...byId('results-summary').childNodes];
  assert.ok(before.length > 0, 'no summary was drawn; the case proves nothing');
  const text = byId('results-summary').textContent;

  set({ status: { running: true, run_id: 'run-1' } });
  set({ run: run('2026-11-16T14:03:22.000Z') });
  assert.equal(byId('results-summary').textContent, text, 'the summary says something else; the case proves nothing');
  const after = [...byId('results-summary').childNodes];
  assert.equal(after.length, before.length);
  after.forEach((node, i) => assert.ok(node === before[i], `summary child ${i} was replaced with the same text`));

  set({ results: [resultRow, { ...resultRow, index: 1, passed: false }] });
  assert.notEqual(byId('results-summary').textContent, text, 'a summary that changed was not drawn again');
  assert.deepEqual(listenerErrors, []);
});

// ---------------------------------------------------------------- names

// unnamed lists every form control the page holds without an id or a name.
const controls = () => [...document.querySelectorAll('input, select, textarea')];
const unnamed = () => controls().filter((c) => !c.getAttribute('id') && !c.getAttribute('name')).map((c) => c.className || c.localName);

test('every form control the page draws has an id or a name, in the main states of the page', () => {
  boot({
    saved: [req('ws-1', 'Mine', {
      params: { q: 'a', page: '2' },
      assertions: [
        { type: 'status', op: 'eq', value: 200 },
        { type: 'json', path: '$.total', op: 'gt', value: 0 },
        { type: 'json', path: '$.x', op: 'exists' },
      ],
    })],
    queued: [req('b1', 'Find'), req('b2', 'Look')],
  });
  assert.deepEqual(unnamed(), [], 'on the runner with a queued sequence');

  const open = [...byId('workspace-tree').querySelectorAll('.req-open')].find((b) => b.title === 'Mine');
  open.click();
  assert.ok(byId('param-rows').querySelectorAll('select').length === 2, 'the editor did not draw the params; the case proves nothing');
  assert.ok(byId('assertion-rows').querySelectorAll('input').length >= 3, 'the editor did not draw the assertions; the case proves nothing');
  assert.deepEqual(unnamed(), [], 'with a request open in the editor');

  set({ transport: 'sse', run: run('2026-11-16T14:03:22Z'), results: [resultRow] });
  assert.deepEqual(unnamed(), [], 'with a run on the results tab');
  assert.deepEqual(listenerErrors, []);
});

test('the names of the controls drawn per row are stable keys, one per control, never the visitor\'s text', () => {
  boot({
    saved: [req('ws-1', '<b>typed</b>', { params: { q: 'typed', page: '2' }, assertions: [{ type: 'json', path: '$.typed', op: 'eq', value: 'typed' }] })],
    queued: [req('b1', 'typed name'), req('b2', 'typed name')],
  });
  [...byId('workspace-tree').querySelectorAll('.req-open')][0].click();
  const drawn = [
    ...byId('param-rows').querySelectorAll('input, select'),
    ...byId('assertion-rows').querySelectorAll('input, select'),
    ...byId('sequence-list').querySelectorAll('input'),
  ];
  assert.ok(drawn.length >= 8, 'the case does not reach every per-row control');
  const names = drawn.map((c) => c.getAttribute('name'));
  for (const name of names) {
    assert.ok(name, 'a control drawn per row has no name');
    assert.doesNotMatch(name, /typed|<b>|Mine/, `${name} is built from what the visitor typed`);
  }
  assert.equal(new Set(names).size, names.length, `two controls share a name: ${names.join(', ')}`);
});
