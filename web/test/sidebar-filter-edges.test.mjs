// Edges of a sidebar part that cannot be drawn and of the results filter kept
// in place: a broken part repaired by its next input, two broken parts at
// once, focus walked over every filter button while fifty rows arrive, a press
// during arrivals, and the pressed state once a new run begins.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as sidebar from '../js/render-sidebar.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const req = (id, name) => ({ id, name, endpoint: 'search', params: { q: 'a' }, assertions: [] });
const run = (id) => ({ id, mode: 'functional', status: 'completed', started_at: '2026-11-16T14:03:22Z', duration_ms: 120, summary: '1 passed' });

let unsubscribe = null;
let errors = [];

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args); });
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
});

test('a curated collection that cannot be drawn is drawn once its next input is whole', () => {
  sidebar.init({});
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({ endpoints, collections: [{ id: 'c1', name: 'Broken', description: '', requests: 5 }], workspace: [], history: [], historyLoaded: true });
  assert.ok(errors.length > 0, 'the broken part did not throw; the case proves nothing');
  const thrown = errors.length;

  // A render that changes nothing it reads does not throw again and again
  // into the console, and does not paint the broken input.
  set({ status: { running: false } });
  set({ collections: [{ id: 'c1', name: 'Mended', description: '', requests: [req('c1-a', 'Mended request')] }] });
  assert.match(byId('collections-tree').textContent, /Mended/, 'the repaired collection is painted');
  assert.ok(errors.length >= thrown);
  assert.deepEqual(listenerErrors, []);
});

test('two parts that cannot be drawn leave the third to update', () => {
  sidebar.init({});
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({
    endpoints,
    collections: [{ id: 'c1', name: 'Broken', description: '', requests: 5 }],
    savedCollections: [{ id: 'sc-1', name: 'Broken saved', requests: 7 }],
    workspace: [],
    history: [],
    historyLoaded: true,
  });
  const parts = new Set(errors.map((args) => String(args[0])));
  assert.ok(parts.size >= 2, `two parts did not throw; the case proves nothing: ${[...parts]}`);
  set({ workspace: [req('ws-1', 'Still mine')] });
  assert.deepEqual([...byId('workspace-tree').querySelectorAll('.req-open')].map((b) => b.title), ['Still mine']);
  set({ history: [run('run-a')] });
  assert.equal(byId('history-list').querySelectorAll('.req-open').length, 1, 'history is painted');
  assert.deepEqual(listenerErrors, []);
});

// ---------------------------------------------------------------- results filter

const row = (index, passed = true) => ({
  index, name: `R${index}`, endpoint: 'search', query: '?q=a', status: 200, latency_ms: 4, size_bytes: 10, passed, skipped: false, assertions: [],
});
const filterButtons = () => [...byId('results-filter').querySelectorAll('button')];
const filterButton = (name) => filterButtons().find((b) => b.textContent.startsWith(`${name} `));
const liveRun = (id, rows) => ({ endpoints, transport: 'sse', run: { id, mode: 'functional', total: 60, started_at: '2026-11-18T10:00:00Z', config: {}, entries: [] }, report: null, results: rows });

test('focus walked over every filter button while fifty rows arrive stays on the button it was put on, and the counts follow', () => {
  unsubscribe = subscribe((state) => results.render(state));
  set(liveRun('walk-1', []));
  const nodes = filterButtons();
  assert.ok(nodes.length >= 4, 'the filter buttons are drawn');
  for (let i = 0; i < 50; i += 1) {
    const button = nodes[i % nodes.length];
    button.focus();
    set({ results: [...get().results, row(i, i % 5 !== 0)] });
    assert.ok(document.activeElement === button, `focus left button ${i % nodes.length} at row ${i}`);
  }
  filterButtons().forEach((b, i) => assert.ok(b === nodes[i], `button ${i} was replaced`));
  assert.equal(filterButton('all').textContent, 'all 50');
  assert.equal(filterButton('failed').textContent, 'failed 10');
  assert.equal(filterButton('passed').textContent, 'passed 40');
  assert.deepEqual(listenerErrors, []);
});

test('a press made between arrivals filters every row there is, including those that came after the button was drawn', () => {
  unsubscribe = subscribe((state) => results.render(state));
  set(liveRun('press-1', [row(0)]));
  for (let i = 1; i < 20; i += 1) set({ results: [...get().results, row(i, i % 4 !== 0)] });
  filterButton('failed').click();
  const shown = [...byId('results-rows').querySelectorAll('.res-row summary')].map((s) => s.dataset.focusKey);
  assert.deepEqual([...shown].sort(), ['res:12', 'res:16', 'res:4', 'res:8'], `the four failed rows are shown: ${shown}`);
  set({ results: [...get().results, row(20, false)] });
  assert.equal(byId('results-rows').querySelectorAll('.res-row').length, 5, 'a failed row arriving after the press is shown');
  assert.deepEqual(listenerErrors, []);
});

test('a new run puts the pressed state back on all, on the same buttons or new ones, with no stale count', () => {
  unsubscribe = subscribe((state) => results.render(state));
  set(liveRun('old-run', [row(0), row(1, false)]));
  filterButton('failed').click();
  assert.equal(filterButton('failed').getAttribute('aria-pressed'), 'true');

  set(liveRun('new-run', []));
  assert.equal(filterButton('all').getAttribute('aria-pressed'), 'true', 'all is pressed for the new run');
  assert.equal(filterButton('failed').getAttribute('aria-pressed'), 'false');
  assert.ok(!filterButton('failed').classList.contains('is-on'));
  assert.equal(filterButton('all').textContent, 'all 0');
  assert.equal(filterButton('failed').textContent, 'failed 0');
  set({ results: [row(0)] });
  assert.equal(byId('results-rows').querySelectorAll('.res-row').length, 1, 'the new run\'s row is shown under all');
  assert.deepEqual(listenerErrors, []);
});
