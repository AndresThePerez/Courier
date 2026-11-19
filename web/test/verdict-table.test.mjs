// The page's own verdict for a functional run, worked out from the rows when
// the report carries none, row by row of the server's table
// (internal/report.FunctionalVerdict): a run that asserted nothing reads N/A,
// and its rows still say they carried no checks.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const verdict = () => byId('results-summary').querySelector('.run-verdict');
const ok = { assertion: { type: 'status', op: 'eq', value: 200 }, passed: true, expected: '200', actual: '200' };
const bad = { ...ok, passed: false, expected: '201' };
const row = (index, extra = {}) => ({ index, name: `R${index}`, endpoint: 'search', query: '', status: 200, latency_ms: 3, size_bytes: 9, passed: true, skipped: false, assertions: [ok], ...extra });
const answered = (index) => row(index, { assertions: [] });
const skipped = (index) => row(index, { skipped: true, passed: false, status: 0, assertions: [] });
const unanswered = (index) => row(index, { status: 0, passed: false, error: 'connection refused', error_kind: 'transport', assertions: [] });

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

function show(status, rows) {
  seq += 1;
  const id = `table-${seq}`;
  set({
    run: { id, mode: 'functional', total: rows.length, started_at: '2026-11-19T10:00:00Z', config: {}, entries: [] },
    report: { id, mode: 'functional', status, started_at: '2026-11-19T10:00:00Z', duration_ms: 10, config: {}, entries: [], functional: { results: rows } },
    results: rows,
    outcome: null,
  });
  return verdict().textContent;
}

const Table = [
  ['completed, every request asserted and passed', 'completed', [row(0), row(1)], 'PASS'],
  ['completed, an assertion failed', 'completed', [row(0), row(1, { passed: false, assertions: [bad] })], 'FAIL'],
  ['completed, no assertion anywhere and every request answered', 'completed', [answered(0), answered(1)], 'N/A - nothing was asserted'],
  ['completed, no assertion anywhere and a request got no response', 'completed', [answered(0), unanswered(1)], 'FAIL'],
  ['completed, some asserted and passed, some without, all answered', 'completed', [row(0), answered(1)], 'PASS'],
  ['completed, unasserted answered requests with the rest skipped', 'completed', [answered(0), skipped(1)], 'N/A - nothing was asserted'],
  ['completed, every entry skipped', 'completed', [skipped(0), skipped(1)], 'N/A - nothing was asserted'],
  ['completed, no entries', 'completed', [], 'N/A - nothing was asserted'],
  ['cancelled', 'cancelled', [row(0)], 'N/A - partial data'],
  ['expired', 'expired', [row(0), answered(1)], 'N/A - partial data'],
];

for (const [rule, status, rows, want] of Table) {
  test(`the page's verdict: ${rule} reads ${want}`, () => {
    assert.equal(show(status, rows), want);
    assert.deepEqual(listenerErrors, []);
  });
}

test('the rows of a run that asserted nothing keep their no checks marks', () => {
  assert.equal(show('completed', [answered(0), answered(1)]), 'N/A - nothing was asserted');
  const marks = [...byId('results-rows').querySelectorAll('.res-mark')].map((m) => m.textContent);
  assert.deepEqual(marks, ['no checks', 'no checks']);
});
