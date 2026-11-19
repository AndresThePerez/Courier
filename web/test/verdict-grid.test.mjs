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

// The rows and the cases shared with the server: web/verdict_table_test.go
// reads this block and runs every case through report.FunctionalVerdict, so
// the server's rule and the page's are held to the same table. Each row is
// written as the server writes such a row; each case is a run's status, its
// rows, and the verdict the server stores for it.
// table:begin
const TABLE = {
  "rows": {
    "answeredUnasserted": {"status":200,"passed":true,"assertions":[]},
    "answeredPassed": {"status":200,"passed":true,"assertions":[{"assertion":{"type":"status","op":"eq","value":200},"passed":true,"expected":"200","actual":"200"}]},
    "answeredFailed": {"status":200,"passed":false,"assertions":[{"assertion":{"type":"status","op":"eq","value":200},"passed":true,"expected":"200","actual":"200"},{"assertion":{"type":"status","op":"eq","value":200},"passed":false,"expected":"201","actual":"200"}]},
    "noConnection": {"status":0,"passed":false,"error":"connection refused","error_kind":"transport","assertions":[]},
    "noConnectionAsserted": {"status":0,"passed":false,"error":"connection refused","error_kind":"transport","assertions":[{"assertion":{"type":"status","op":"eq","value":200},"passed":false,"expected":"200","actual":"no response"}]},
    "cutOff": {"status":200,"passed":false,"error":"response body cut off","error_kind":"truncated","assertions":[]},
    "cutOffAsserted": {"status":200,"passed":false,"error":"response body cut off","error_kind":"truncated","assertions":[{"assertion":{"type":"status","op":"eq","value":200},"passed":false,"expected":"200","actual":"no response"}]},
    "skipped": {"status":0,"passed":false,"skipped":true,"assertions":[]},
    "skippedAsserted": {"status":0,"passed":false,"skipped":true,"assertions":null}
  },
  "cases": [
    ["completed",[],"N/A"],
    ["completed",["answeredUnasserted"],"N/A"],
    ["completed",["answeredPassed"],"PASS"],
    ["completed",["answeredFailed"],"FAIL"],
    ["completed",["noConnection"],"FAIL"],
    ["completed",["noConnectionAsserted"],"FAIL"],
    ["completed",["cutOff"],"FAIL"],
    ["completed",["cutOffAsserted"],"FAIL"],
    ["completed",["skipped"],"N/A"],
    ["completed",["skippedAsserted"],"N/A"],
    ["completed",["answeredUnasserted","answeredUnasserted"],"N/A"],
    ["completed",["answeredUnasserted","answeredPassed"],"PASS"],
    ["completed",["answeredUnasserted","answeredFailed"],"FAIL"],
    ["completed",["answeredUnasserted","noConnection"],"FAIL"],
    ["completed",["answeredUnasserted","noConnectionAsserted"],"FAIL"],
    ["completed",["answeredUnasserted","cutOff"],"FAIL"],
    ["completed",["answeredUnasserted","cutOffAsserted"],"FAIL"],
    ["completed",["answeredUnasserted","skipped"],"N/A"],
    ["completed",["answeredUnasserted","skippedAsserted"],"N/A"],
    ["completed",["answeredPassed","answeredUnasserted"],"PASS"],
    ["completed",["answeredPassed","answeredPassed"],"PASS"],
    ["completed",["answeredPassed","answeredFailed"],"FAIL"],
    ["completed",["answeredPassed","noConnection"],"FAIL"],
    ["completed",["answeredPassed","noConnectionAsserted"],"FAIL"],
    ["completed",["answeredPassed","cutOff"],"FAIL"],
    ["completed",["answeredPassed","cutOffAsserted"],"FAIL"],
    ["completed",["answeredPassed","skipped"],"PASS"],
    ["completed",["answeredPassed","skippedAsserted"],"PASS"],
    ["completed",["answeredFailed","answeredUnasserted"],"FAIL"],
    ["completed",["answeredFailed","answeredPassed"],"FAIL"],
    ["completed",["answeredFailed","answeredFailed"],"FAIL"],
    ["completed",["answeredFailed","noConnection"],"FAIL"],
    ["completed",["answeredFailed","noConnectionAsserted"],"FAIL"],
    ["completed",["answeredFailed","cutOff"],"FAIL"],
    ["completed",["answeredFailed","cutOffAsserted"],"FAIL"],
    ["completed",["answeredFailed","skipped"],"FAIL"],
    ["completed",["answeredFailed","skippedAsserted"],"FAIL"],
    ["completed",["noConnection","answeredUnasserted"],"FAIL"],
    ["completed",["noConnection","answeredPassed"],"FAIL"],
    ["completed",["noConnection","answeredFailed"],"FAIL"],
    ["completed",["noConnection","noConnection"],"FAIL"],
    ["completed",["noConnection","noConnectionAsserted"],"FAIL"],
    ["completed",["noConnection","cutOff"],"FAIL"],
    ["completed",["noConnection","cutOffAsserted"],"FAIL"],
    ["completed",["noConnection","skipped"],"FAIL"],
    ["completed",["noConnection","skippedAsserted"],"FAIL"],
    ["completed",["noConnectionAsserted","answeredUnasserted"],"FAIL"],
    ["completed",["noConnectionAsserted","answeredPassed"],"FAIL"],
    ["completed",["noConnectionAsserted","answeredFailed"],"FAIL"],
    ["completed",["noConnectionAsserted","noConnection"],"FAIL"],
    ["completed",["noConnectionAsserted","noConnectionAsserted"],"FAIL"],
    ["completed",["noConnectionAsserted","cutOff"],"FAIL"],
    ["completed",["noConnectionAsserted","cutOffAsserted"],"FAIL"],
    ["completed",["noConnectionAsserted","skipped"],"FAIL"],
    ["completed",["noConnectionAsserted","skippedAsserted"],"FAIL"],
    ["completed",["cutOff","answeredUnasserted"],"FAIL"],
    ["completed",["cutOff","answeredPassed"],"FAIL"],
    ["completed",["cutOff","answeredFailed"],"FAIL"],
    ["completed",["cutOff","noConnection"],"FAIL"],
    ["completed",["cutOff","noConnectionAsserted"],"FAIL"],
    ["completed",["cutOff","cutOff"],"FAIL"],
    ["completed",["cutOff","cutOffAsserted"],"FAIL"],
    ["completed",["cutOff","skipped"],"FAIL"],
    ["completed",["cutOff","skippedAsserted"],"FAIL"],
    ["completed",["cutOffAsserted","answeredUnasserted"],"FAIL"],
    ["completed",["cutOffAsserted","answeredPassed"],"FAIL"],
    ["completed",["cutOffAsserted","answeredFailed"],"FAIL"],
    ["completed",["cutOffAsserted","noConnection"],"FAIL"],
    ["completed",["cutOffAsserted","noConnectionAsserted"],"FAIL"],
    ["completed",["cutOffAsserted","cutOff"],"FAIL"],
    ["completed",["cutOffAsserted","cutOffAsserted"],"FAIL"],
    ["completed",["cutOffAsserted","skipped"],"FAIL"],
    ["completed",["cutOffAsserted","skippedAsserted"],"FAIL"],
    ["completed",["skipped","answeredUnasserted"],"N/A"],
    ["completed",["skipped","answeredPassed"],"PASS"],
    ["completed",["skipped","answeredFailed"],"FAIL"],
    ["completed",["skipped","noConnection"],"FAIL"],
    ["completed",["skipped","noConnectionAsserted"],"FAIL"],
    ["completed",["skipped","cutOff"],"FAIL"],
    ["completed",["skipped","cutOffAsserted"],"FAIL"],
    ["completed",["skipped","skipped"],"N/A"],
    ["completed",["skipped","skippedAsserted"],"N/A"],
    ["completed",["skippedAsserted","answeredUnasserted"],"N/A"],
    ["completed",["skippedAsserted","answeredPassed"],"PASS"],
    ["completed",["skippedAsserted","answeredFailed"],"FAIL"],
    ["completed",["skippedAsserted","noConnection"],"FAIL"],
    ["completed",["skippedAsserted","noConnectionAsserted"],"FAIL"],
    ["completed",["skippedAsserted","cutOff"],"FAIL"],
    ["completed",["skippedAsserted","cutOffAsserted"],"FAIL"],
    ["completed",["skippedAsserted","skipped"],"N/A"],
    ["completed",["skippedAsserted","skippedAsserted"],"N/A"],
    ["cancelled",[],"N/A"],
    ["cancelled",["answeredUnasserted"],"N/A"],
    ["cancelled",["answeredPassed"],"N/A"],
    ["cancelled",["answeredFailed"],"N/A"],
    ["cancelled",["noConnection"],"N/A"],
    ["cancelled",["noConnectionAsserted"],"N/A"],
    ["cancelled",["cutOff"],"N/A"],
    ["cancelled",["cutOffAsserted"],"N/A"],
    ["cancelled",["skipped"],"N/A"],
    ["cancelled",["skippedAsserted"],"N/A"],
    ["expired",[],"N/A"],
    ["expired",["answeredUnasserted"],"N/A"],
    ["expired",["answeredPassed"],"N/A"],
    ["expired",["answeredFailed"],"N/A"],
    ["expired",["noConnection"],"N/A"],
    ["expired",["noConnectionAsserted"],"N/A"],
    ["expired",["cutOff"],"N/A"],
    ["expired",["cutOffAsserted"],"N/A"],
    ["expired",["skipped"],"N/A"],
    ["expired",["skippedAsserted"],"N/A"]
  ]
};
// table:end

// Each kind: its row, and what the table reads it as.
const Kinds = {
  answeredUnasserted: { row: TABLE.rows.answeredUnasserted, dispatched: true, passed: true, asserted: false },
  answeredPassed: { row: TABLE.rows.answeredPassed, dispatched: true, passed: true, asserted: true },
  answeredFailed: { row: TABLE.rows.answeredFailed, dispatched: true, passed: false, asserted: true },
  noConnection: { row: TABLE.rows.noConnection, dispatched: true, passed: false, asserted: false },
  noConnectionAsserted: { row: TABLE.rows.noConnectionAsserted, dispatched: true, passed: false, asserted: true },
  cutOff: { row: TABLE.rows.cutOff, dispatched: true, passed: false, asserted: false },
  cutOffAsserted: { row: TABLE.rows.cutOffAsserted, dispatched: true, passed: false, asserted: true },
  skipped: { row: TABLE.rows.skipped, dispatched: false },
  skippedAsserted: { row: TABLE.rows.skippedAsserted, dispatched: false },
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

// shown is how the page words the verdict the server stores for a run.
const shown = (status, verdict) => {
  if (verdict !== 'N/A') return verdict;
  return status === 'completed' ? 'N/A - nothing was asserted' : 'N/A - partial data';
};

test('every case shared with the server gets the server\'s verdict on the page, from a report and from a last event', () => {
  assert.ok(TABLE.cases.length >= 100, `${TABLE.cases.length} cases`);
  assert.deepEqual(Object.keys(TABLE.rows), names, 'the shared rows are not the grid\'s kinds');
  const wrong = [];
  for (const [status, kinds, verdict] of TABLE.cases) {
    const want = shown(status, verdict);
    const page = fromReport(status, rowsOf(kinds));
    const last = fromLastEvent(status, rowsOf(kinds));
    if (page !== want || last !== want) wrong.push(`${status} [${kinds.join(', ')}]: report ${page}, last event ${last}, server ${want}`);
  }
  assert.deepEqual(wrong.slice(0, 8), [], `${wrong.length} disagreements`);
  assert.deepEqual(listenerErrors, []);
});

test('the grid\'s own reading of the rule agrees with every case shared with the server', () => {
  const wrong = TABLE.cases
    .filter(([status, kinds, verdict]) => tableVerdict(status, kinds) !== shown(status, verdict))
    .map(([status, kinds, verdict]) => `${status} [${kinds.join(', ')}]: grid ${tableVerdict(status, kinds)}, server ${verdict}`);
  assert.deepEqual(wrong, []);
});
