// The page's own functional verdict over every row set of up to three rows
// (and a sample of four), each row answered, failed to connect, cut off or
// skipped, with or without assertions, passed or failed, under every status,
// from a finished report and from a run's last event alike. The expectation
// is internal/report.FunctionalVerdict's table as its comment states it, not
// the page's code: cancelled or expired N/A; completed with any dispatched
// request not passed FAIL; none failed and at least one asserted PASS; none
// failed and none asserted (answered only, all skipped, or none) N/A. A run
// still going, or one the server lost, is given no verdict. A verdict the
// report carries is the one shown.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const verdictText = () => {
  const node = byId('results-summary').querySelector('.run-verdict');
  return node ? node.textContent : null;
};

const ok = { assertion: { type: 'status', op: 'eq', value: 200 }, passed: true, expected: '200', actual: '200' };
const bad = { ...ok, passed: false, expected: '201' };
const lost = { ...ok, passed: false, actual: 'no response' };

// Each kind: how the server writes such a row, and what the table reads it as.
const Kinds = {
  answeredUnasserted: { row: { status: 200, passed: true, assertions: [] }, dispatched: true, passed: true, asserted: false },
  answeredPassed: { row: { status: 200, passed: true, assertions: [ok] }, dispatched: true, passed: true, asserted: true },
  answeredFailed: { row: { status: 200, passed: false, assertions: [ok, bad] }, dispatched: true, passed: false, asserted: true },
  noConnection: { row: { status: 0, passed: false, error: 'connection refused', error_kind: 'transport', assertions: [] }, dispatched: true, passed: false, asserted: false },
  noConnectionAsserted: { row: { status: 0, passed: false, error: 'connection refused', error_kind: 'transport', assertions: [lost] }, dispatched: true, passed: false, asserted: true },
  cutOff: { row: { status: 200, passed: false, error: 'response body cut off', error_kind: 'truncated', assertions: [] }, dispatched: true, passed: false, asserted: false },
  cutOffAsserted: { row: { status: 200, passed: false, error: 'response body cut off', error_kind: 'truncated', assertions: [lost] }, dispatched: true, passed: false, asserted: true },
  skipped: { row: { status: 0, passed: false, skipped: true, assertions: [] }, dispatched: false },
  skippedAsserted: { row: { status: 0, passed: false, skipped: true, assertions: null }, dispatched: false },
};
const names = Object.keys(Kinds);

function tableVerdict(status, kinds) {
  if (status === 'running' || status === 'unavailable') return null;
  if (status === 'cancelled' || status === 'expired') return 'N/A - partial data';
  const dispatched = kinds.map((k) => Kinds[k]).filter((k) => k.dispatched);
  if (dispatched.some((k) => !k.passed)) return 'FAIL';
  if (dispatched.some((k) => k.asserted)) return 'PASS';
  return 'N/A - nothing was asserted';
}

const rowsOf = (kinds) => kinds.map((k, index) => ({
  index, name: `R${index}`, endpoint: 'search', query: '', latency_ms: 3, size_bytes: 9, skipped: false, ...Kinds[k].row,
}));

function combos(max) {
  const out = [[]];
  let layer = [[]];
  for (let n = 1; n <= max; n += 1) {
    layer = layer.flatMap((c) => names.map((k) => [...c, k]));
    out.push(...layer);
  }
  return out;
}

function sampleOfFour(count) {
  let seed = 11;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  return Array.from({ length: count }, () => Array.from({ length: 4 }, () => names[next() % names.length]));
}

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

function fromReport(status, rows, verdict) {
  seq += 1;
  const id = `grid-${seq}`;
  const functional = verdict === undefined ? { results: rows } : { verdict, results: rows };
  set({
    run: { id, mode: 'functional', total: rows.length, started_at: '2026-11-19T10:00:00Z', config: {}, entries: [] },
    report: { id, mode: 'functional', status, started_at: '2026-11-19T10:00:00Z', duration_ms: 10, config: {}, entries: [], functional },
    results: rows,
    outcome: null,
  });
  return verdictText();
}

function fromLastEvent(status, rows) {
  seq += 1;
  const id = `grid-${seq}`;
  set({
    run: { id, mode: 'functional', total: rows.length, started_at: '2026-11-19T10:00:00Z', config: {}, entries: [] },
    report: null,
    results: rows,
    outcome: status === 'running' ? null : { run_id: id, status, duration_ms: 10 },
  });
  return verdictText();
}

const sets = [...combos(3), ...sampleOfFour(400)];

test('from a finished report, every row set under every status gets the server table\'s verdict', () => {
  const wrong = [];
  for (const status of ['completed', 'cancelled', 'expired', 'running']) {
    for (const kinds of sets) {
      const got = fromReport(status, rowsOf(kinds));
      const want = tableVerdict(status, kinds);
      if (got !== want) wrong.push(`${status} [${kinds.join(', ')}]: page ${got}, table ${want}`);
    }
  }
  assert.deepEqual(wrong.slice(0, 8), [], `${wrong.length} disagreements`);
  assert.deepEqual(listenerErrors, []);
});

test('from a run\'s last event with no report, every row set under every status gets the server table\'s verdict', () => {
  const wrong = [];
  for (const status of ['completed', 'cancelled', 'expired', 'running', 'unavailable']) {
    for (const kinds of sets) {
      const got = fromLastEvent(status, rowsOf(kinds));
      const want = tableVerdict(status, kinds);
      if (got !== want) wrong.push(`${status} [${kinds.join(', ')}]: page ${got}, table ${want}`);
    }
  }
  assert.deepEqual(wrong.slice(0, 8), [], `${wrong.length} disagreements`);
  assert.deepEqual(listenerErrors, []);
});

test('a completed report that carries a verdict is shown with that verdict, whatever its rows say', () => {
  const said = { PASS: 'PASS', FAIL: 'FAIL', 'N/A': 'N/A - nothing was asserted' };
  for (const carried of Object.keys(said)) {
    for (const kinds of [[], ['answeredUnasserted'], ['answeredPassed'], ['answeredFailed'], ['skipped', 'noConnection']]) {
      assert.equal(fromReport('completed', rowsOf(kinds), carried), said[carried], `${carried} over [${kinds.join(', ')}]`);
    }
  }
  // A verdict in a form the server never sends is not taken: the rows decide.
  for (const odd of ['pass', 'n/a', '', 0, null, { v: 'PASS' }]) {
    assert.equal(fromReport('completed', rowsOf(['answeredUnasserted']), odd), 'N/A - nothing was asserted', JSON.stringify(odd));
    assert.equal(fromReport('completed', rowsOf(['answeredFailed']), odd), 'FAIL', JSON.stringify(odd));
  }
  // A cancelled or expired run reads as partial data even under a carried PASS.
  assert.equal(fromReport('cancelled', rowsOf(['answeredPassed']), 'PASS'), 'N/A - partial data');
  assert.equal(fromReport('expired', rowsOf(['answeredPassed']), 'N/A'), 'N/A - partial data');
});
