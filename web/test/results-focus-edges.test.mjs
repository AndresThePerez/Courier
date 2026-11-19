// A result row a keyboard visitor is in, at the edges of a live run: the row
// delivered again while it is open and focused, the final report seeding
// every row anew, a row arriving ahead of the focused one, and a filter
// hiding then showing it again. The row keeps its open state and its summary
// keeps or takes back focus; what the row says is what the newest delivery
// says.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];

let unsubscribe = null;
let seq = 0;
let runId = '';

const row = (index, extra = {}) => ({
  index, name: `R${index}`, endpoint: 'search', query: '?q=a', status: 200, latency_ms: 4, size_bytes: 10, passed: true, skipped: false,
  assertions: [], ...extra,
});

function live(rows) {
  unsubscribe = subscribe((state) => results.render(state));
  seq += 1;
  runId = `edge-run-${seq}`;
  set({ endpoints, transport: 'sse', run: { id: runId, mode: 'functional', total: 6, started_at: '2026-11-18T10:00:00Z', config: {}, entries: [] }, report: null, results: rows });
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
});

const shown = () => [...byId('results-rows').querySelectorAll('.res-row')];
const summaryOf = (index) => shown().find((r) => r.querySelector('summary').dataset.focusKey === `res:${index}`);
const openRow = (node) => {
  node.open = true;
  node.dispatchEvent(new Event('toggle'));
};

test('a row delivered again while it is open and its summary focused stays open, takes focus back, and shows the new delivery', () => {
  live([row(0), row(1)]);
  openRow(summaryOf(1));
  summaryOf(1).querySelector('summary').focus();
  const rows = get().results.slice();
  rows[1] = row(1, { status: 503, passed: false });
  set({ results: rows });
  const now = summaryOf(1);
  assert.equal(now.open, true, 'the row delivered again was closed');
  assert.ok(document.activeElement === now.querySelector('summary'), 'focus dropped to the page when its row was drawn again');
  assert.match(now.querySelector('summary').textContent, /503/, 'the row still shows the first delivery');
  assert.deepEqual(listenerErrors, []);
});

test('the final report seeding every row anew keeps the open row open and gives its summary the focus back', () => {
  live([row(0), row(1, { body_preview: '{"a":1}' }), row(2)]);
  openRow(summaryOf(1));
  summaryOf(1).querySelector('summary').focus();
  const finalRows = [row(0), row(1, { body_preview: '{"a":1}', body: '{"a":1,"b":2}' }), row(2)];
  set({
    report: { id: runId, mode: 'functional', status: 'completed', started_at: '2026-11-18T10:00:00Z', config: {}, functional: { verdict: 'PASS' } },
    results: finalRows,
  });
  assert.equal(shown().length, 3);
  const now = summaryOf(1);
  assert.ok(now.isConnected);
  assert.equal(now.open, true, 'the report closed the open row');
  assert.ok(document.activeElement === now.querySelector('summary'), 'focus dropped to the page when the report arrived');
  assert.deepEqual(listenerErrors, []);
});

test('a row arriving ahead of the focused one, out of order, leaves the focused node in the page and focused', () => {
  live([row(2), row(3)]);
  const summary = summaryOf(3).querySelector('summary');
  summary.focus();
  set({ results: [row(0), ...get().results] });
  set({ results: [...get().results.slice(0, 1), row(1), ...get().results.slice(1)] });
  assert.deepEqual(shown().map((r) => r.querySelector('summary').dataset.focusKey), ['res:0', 'res:1', 'res:2', 'res:3']);
  assert.ok(summary.isConnected, 'the focused row was taken out and put back');
  assert.ok(document.activeElement === summary, 'focus left the row as rows arrived ahead of it');
  assert.deepEqual(listenerErrors, []);
});

test('a filter that hides a row and shows it again draws the row as the state holds it, open state kept', () => {
  live([row(0), row(1, { passed: false, status: 500 })]);
  openRow(summaryOf(1));
  const filterButton = (name) => [...byId('results-filter').querySelectorAll('button')].find((b) => b.textContent.startsWith(`${name} `));
  filterButton('passed').click();
  assert.deepEqual(shown().map((r) => r.querySelector('summary').dataset.focusKey), ['res:0']);
  filterButton('all').click();
  assert.deepEqual(shown().map((r) => r.querySelector('summary').dataset.focusKey), ['res:0', 'res:1']);
  assert.equal(summaryOf(1).open, true, 'the hidden row came back closed');
  // Ten notifies with nothing new: the rows stay the very nodes they were.
  const nodes = shown();
  for (let i = 0; i < 10; i += 1) set({ status: { running: true, run_id: runId } });
  shown().forEach((n, i) => assert.ok(n === nodes[i], `row ${i} was rebuilt by a notify that changed nothing`));
  assert.deepEqual(listenerErrors, []);
});

test('a new run with rows at the same indexes draws its own rows, not the last run\'s nodes', () => {
  live([row(0, { name: 'first run' })]);
  const old = shown()[0];
  unsubscribe();
  live([row(0, { name: 'second run' })]);
  assert.ok(shown()[0] !== old, 'the last run\'s row node was reused');
  assert.match(shown()[0].querySelector('.res-name').textContent, /second run/);
});

test('the final report over the very same row objects redraws them as finished, the focused one keeping focus', () => {
  live([row(0), row(1)]);
  openRow(summaryOf(0));
  summaryOf(0).querySelector('summary').focus();
  assert.match(summaryOf(0).textContent, /arrives with the finished report/, 'the live note is not shown; the case proves nothing');
  set({ report: { id: runId, mode: 'functional', status: 'completed', started_at: '2026-11-18T10:00:00Z', config: {}, functional: { verdict: 'PASS' } } });
  assert.match(summaryOf(0).textContent, /No response body was captured/, 'the row still says the body is on its way');
  assert.equal(summaryOf(0).open, true);
  assert.ok(document.activeElement === summaryOf(0).querySelector('summary'), 'focus dropped to the page when the report arrived');
  assert.deepEqual(listenerErrors, []);
});

test('the catalog arriving mid-run repaints the method badge of rows already drawn', () => {
  unsubscribe = subscribe((state) => results.render(state));
  seq += 1;
  runId = `edge-run-${seq}`;
  set({ endpoints: [], transport: 'sse', run: { id: runId, mode: 'functional', total: 2, started_at: '2026-11-18T10:00:00Z', config: {}, entries: [] }, report: null, results: [row(0)] });
  assert.equal(shown()[0].querySelector('.method').textContent, '---');
  set({ endpoints });
  assert.equal(shown()[0].querySelector('.method').textContent, 'GET');
});
