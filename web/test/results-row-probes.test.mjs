// Result rows probed across every kind of row and across a live run's many
// renders: each kind has the same head cells in the same order with nothing
// announced for an empty mark, renders that bring no new row rebuild nothing,
// and a row the visitor opened stays open whatever is delivered.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];

let unsubscribe = null;
let seq = 0;

beforeEach(() => {
  resetBrowser();
  resetState();
  unsubscribe = subscribe((state) => results.render(state));
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
});

const ok = { assertion: { type: 'status', op: 'eq', value: 200 }, passed: true, expected: '200', actual: '200' };
const row = (index, extra = {}) => ({
  index, name: `R${index}`, endpoint: 'search', query: '?q=a', status: 200, latency_ms: 4, size_bytes: 10, passed: true, skipped: false,
  assertions: [ok], ...extra,
});

function live(rows) {
  seq += 1;
  set({ endpoints, transport: 'sse', run: { id: `run-${seq}`, mode: 'functional', total: rows.length, started_at: '2026-11-18T10:00:00Z', config: {}, entries: [] }, report: null, results: rows });
}

const shown = () => [...byId('results-rows').querySelectorAll('.res-row')];
const heads = () => [...byId('results-rows').querySelectorAll('.res-head')];
const cellsOf = (head) => [...head.children].map((c) => c.className.split(' ')[0]);
const open = (i) => {
  const r = shown()[i];
  r.open = true;
  r.dispatchEvent(new Event('toggle'));
};

test('passed, failed, no-checks, skipped and no-response rows all have the same head cells in the same order', () => {
  live([
    row(0),
    row(1, { passed: false, status: 500, assertions: [{ ...ok, passed: false, actual: '500' }] }),
    row(2, { assertions: [] }),
    row(3, { status: 0, passed: false, skipped: true, assertions: [], latency_ms: 0, size_bytes: 0 }),
    row(4, { status: 0, passed: false, error: 'connection refused', error_kind: 'network', assertions: [] }),
  ]);
  const all = heads();
  assert.equal(all.length, 5);
  const marks = all.map((h) => h.children[1]);
  assert.deepEqual(marks.map((m) => m.textContent), ['PASS', 'FAIL', 'no checks', '', 'FAIL']);

  const normal = (h) => cellsOf(h).map((c, i) => (i === 1 ? 'mark' : c));
  const first = normal(all[0]);
  all.forEach((h, i) => assert.deepEqual(normal(h), first, `row ${i + 1}: ${cellsOf(h).join(', ')}`));
  assert.equal(cellsOf(all[3])[1], 'res-unmarked');

  // Only the skipped row's mark is empty, and nothing in it is announced.
  const empty = marks[3];
  assert.equal(empty.children.length, 0);
  assert.equal(empty.getAttribute('aria-hidden'), 'true');
  assert.equal(empty.getAttribute('role'), null);
  assert.equal(empty.getAttribute('aria-label'), null);
  marks.filter((_, i) => i !== 3).forEach((m) => assert.equal(m.getAttribute('aria-hidden'), null, 'a visible mark is hidden from assistive technology'));
  assert.deepEqual(listenerErrors, []);
});

test('the skipped filter shows the skipped row with its empty mark cell still in place', () => {
  live([row(0), row(1, { status: 0, passed: false, skipped: true, assertions: [] })]);
  const skipped = [...byId('results-filter').querySelectorAll('button')].find((b) => b.textContent.startsWith('skipped'));
  skipped.click();
  const only = heads();
  assert.equal(only.length, 1);
  assert.equal(cellsOf(only[0])[1], 'res-unmarked');
  assert.equal(only[0].children[2].textContent, 'skipped');
  assert.deepEqual(listenerErrors, []);
});

test('fifty progress renders during a live run rebuild no row and keep an open row open', () => {
  live([row(0), row(1), row(2)]);
  open(1);
  const before = shown();
  for (let i = 0; i < 50; i += 1) {
    set({ progress: { elapsed_ms: i * 100, requests: i, errors: 0, aborted: 0, rps: 1, avg_latency_ms: 3 } });
    set({ status: { running: true, run_id: get().run.id } });
  }
  const rebuilt = shown().filter((r, i) => r !== before[i]).length;
  assert.equal(rebuilt, 0, `${rebuilt} rows rebuilt by renders that brought no row`);
  assert.equal(shown()[1].open, true);
  assert.deepEqual(listenerErrors, []);
});

test('fifty rows arriving one by one, each in a new list holding the same earlier row objects, end with fifty rows in order and the opened one still open', () => {
  live([row(0)]);
  open(0);
  for (let i = 1; i < 50; i += 1) set({ results: [...get().results, row(i)] });
  const all = shown();
  assert.equal(all.length, 50);
  assert.deepEqual(all.map((r) => r.querySelector('.res-name').textContent), Array.from({ length: 50 }, (_, i) => `R${i}`));
  assert.equal(all[0].open, true, 'the opened row was closed by later rows');

  // A new list holding the very same row objects changes nothing shown.
  set({ results: get().results.slice() });
  assert.equal(shown().filter((r, i) => r !== all[i]).length, 0, 'an equal list of the same rows rebuilt them');
  assert.deepEqual(listenerErrors, []);
});

test('rows replaced by equal copies fifty times keep the opened row open and paint the same text each time', () => {
  live([row(0), row(1), row(2)]);
  open(2);
  const text = shown().map((r) => r.querySelector('.res-head').textContent);
  for (let i = 0; i < 50; i += 1) set({ results: get().results.map((r) => ({ ...r })) });
  const after = shown();
  assert.equal(after.length, 3, 'a row was duplicated or lost');
  assert.deepEqual(after.map((r) => r.querySelector('.res-head').textContent), text);
  assert.equal(after[2].open, true, 'the opened row was closed');
  assert.equal(after[0].open, false);
  assert.deepEqual(listenerErrors, []);
});
