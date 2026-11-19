// The functional verdict and the row marks under unusual reports: the page
// must reach the verdict the PDF of the same run prints, never show PASS for
// a run that failed or checked nothing, and never re-announce a summary that
// did not change.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, set, get, subscribe } from '../js/store.js';
import * as results from '../js/render-results.js';
import { isReport } from '../js/api.js';

const byId = (id) => document.getElementById(id);
const summary = () => byId('results-summary');
const verdictNode = () => summary().querySelector('.run-verdict');
const tones = (node) => ['is-pass', 'is-fail', 'is-warn', 'is-live', 'is-muted', 'pass', 'fail'].filter((c) => node.classList.contains(c));

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
const bad = { assertion: { type: 'status', op: 'eq', value: 201 }, passed: false, expected: '201', actual: '200' };
const base = (index, extra) => ({ index, name: `R${index}`, endpoint: 'search', query: '', status: 200, latency_ms: 3, size_bytes: 9, passed: true, skipped: false, assertions: [ok], ...extra });

// The row sets the server can send in functional.results (each passes isRow).
const RowSets = {
  none: [],
  allPassed: [base(0), base(1)],
  oneFailed: [base(0), base(1, { passed: false, assertions: [bad] })],
  allSkipped: [base(0, { skipped: true, passed: false, status: 0, assertions: [] }), base(1, { skipped: true, passed: false, status: 0, assertions: null })],
  noAssertions: [base(0, { assertions: [] }), base(1, { assertions: null })],
  noResponse: [base(0, { status: 0, passed: false, error: 'connection refused', error_kind: 'transport', assertions: [{ ...ok, passed: false, actual: 'no response' }] })],
  passedMissing: [base(0), (() => { const r = base(1); delete r.passed; return r; })()],
  skippedThenFailed: [base(0, { skipped: true, passed: false, assertions: [] }), base(1, { passed: false, assertions: [bad] })],
  someAsserted: [base(0), base(1, { assertions: [] })],
  unassertedThenSkipped: [base(0, { assertions: [] }), base(1, { skipped: true, passed: false, status: 0, assertions: [] })],
  noResponseUnasserted: [base(0, { assertions: [] }), base(1, { status: 0, passed: false, error: 'connection refused', error_kind: 'transport', assertions: [] })],
};

// pdfVerdict is internal/pdf/report.go verdictOf for a functional report,
// with internal/report.FunctionalVerdict inlined: a cancelled or expired run
// is "N/A - partial data"; a report with no functional block is N/A; else any
// row neither skipped nor passed is FAIL, at least one passed row carrying an
// assertion is PASS, and anything else (rows that only answered, skipped
// rows, no rows) is "N/A - nothing was asserted". A missing JSON bool decodes
// as false. The PDF ignores functional.verdict and judges the rows itself.
function pdfVerdict(status, functional) {
  if (status === 'cancelled' || status === 'expired') return { text: 'N/A - partial data', tone: null };
  if (!functional) return { text: 'N/A', tone: null };
  let asserted = false;
  for (const r of functional.results || []) {
    if (r.skipped === true) continue;
    if (r.passed !== true) return { text: 'FAIL', tone: 'is-fail' };
    if (Array.isArray(r.assertions) && r.assertions.length > 0) asserted = true;
  }
  return asserted ? { text: 'PASS', tone: 'is-pass' } : { text: 'N/A - nothing was asserted', tone: null };
}

// serverVerdict is what the server writes into functional.verdict at the
// end of a run (manager.go: FunctionalVerdict over the same rows).
const serverVerdict = (status, functional) => {
  const v = pdfVerdict(status, functional).text;
  return v.startsWith('N/A') ? 'N/A' : v;
};

function showReport(status, functional) {
  seq += 1;
  const id = `run-${seq}`;
  const report = { id, mode: 'functional', status, started_at: '2026-11-18T10:00:00Z', duration_ms: 10, config: {}, entries: [], functional };
  set({
    run: { id, mode: 'functional', total: 0, started_at: report.started_at, config: {}, entries: [] },
    report,
    results: (functional && functional.results) || [],
    outcome: null,
    spectator: false,
  });
  return report;
}

test('for every status, verdict field the server can write and row set, the page and the PDF reach the same verdict', () => {
  // A verdict field is either absent (a report from before the field), the
  // one the server computed from the same rows, or a value it never sends.
  const fields = ['consistent', undefined, 'pass', 'Fail', ' PASS ', '', null, 0, true, { v: 'PASS' }];
  let checked = 0;
  for (const status of ['completed', 'cancelled', 'expired']) {
    for (const [name, rows] of Object.entries(RowSets)) {
      for (const field of fields) {
        const functional = { results: rows };
        if (field === 'consistent') functional.verdict = serverVerdict(status, functional);
        else if (field !== undefined) functional.verdict = field;
        showReport(status, functional);
        const want = pdfVerdict(status, functional);
        const where = `${status} / ${name} / verdict ${JSON.stringify(field)}`;
        const node = verdictNode();
        assert.ok(node !== null, `${where}: a verdict is shown`);
        assert.equal(node.textContent, want.text, where);
        assert.deepEqual(tones(node), want.tone ? [want.tone] : [], where);
        if (node.textContent === 'PASS') {
          assert.ok(rows.some((r) => !r.skipped && r.passed === true), `${where}: PASS needs a passed row`);
          assert.ok(!rows.some((r) => !r.skipped && r.passed !== true), `${where}: PASS with a failed row`);
          assert.ok(rows.some((r) => !r.skipped && Array.isArray(r.assertions) && r.assertions.length > 0), `${where}: PASS with nothing asserted`);
        }
        checked += 1;
      }
    }
  }
  assert.equal(checked, 3 * Object.keys(RowSets).length * fields.length);
  assert.deepEqual(listenerErrors, []);
});

test('a functional report the shape check accepts with no functional block is judged N/A, never PASS or FAIL', () => {
  for (const functional of [null, undefined]) {
    const rep = showReport('completed', functional);
    assert.ok(isReport(JSON.parse(JSON.stringify(rep))), 'the report is one the page reads');
    const node = verdictNode();
    assert.ok(node !== null);
    assert.match(node.textContent, /^N\/A/);
    assert.deepEqual(tones(node), []);
  }
});

test('no verdict while running or for a lost run, whatever rows or terminal verdict are held', () => {
  const id = 'live-1';
  set({ run: { id, mode: 'functional', total: 2, started_at: '', config: {}, entries: [] }, report: null, results: RowSets.oneFailed, outcome: null });
  assert.ok(verdictNode() === null, 'first paint while running');
  set({ results: RowSets.allPassed });
  assert.ok(verdictNode() === null, 'rows arriving while running');
  set({ outcome: { run_id: 'another-run', status: 'completed', duration_ms: 5, verdict: 'PASS' } });
  assert.ok(verdictNode() === null, 'another run\'s terminal event is not this run\'s end');
  set({ outcome: { run_id: id, status: 'unavailable', duration_ms: null, verdict: '' } });
  assert.ok(verdictNode() === null, 'a run the server lost is not judged');
  set({ outcome: { run_id: id, status: 'completed', duration_ms: 5, verdict: 'FAIL' } });
  assert.equal(verdictNode().textContent, 'FAIL', 'the terminal event judges a run with no report');
  set({ outcome: { run_id: id, status: 'finished', duration_ms: 5, verdict: '' }, results: RowSets.oneFailed });
  assert.equal(verdictNode().textContent, 'FAIL', 'an ended run with no verdict word is judged from its rows');
  set({ outcome: { run_id: id, status: 'finished', duration_ms: 5, verdict: '' }, results: RowSets.noAssertions });
  assert.equal(verdictNode().textContent, 'N/A - nothing was asserted', 'rows that only answered asserted nothing, as the PDF rule has it');
  assert.deepEqual(listenerErrors, []);
});

test('a finished FAIL, then a new run attached, running and finishing PASS: no stale verdict at any running step', () => {
  showReport('completed', { results: RowSets.oneFailed, verdict: 'FAIL' });
  assert.equal(verdictNode().textContent, 'FAIL');
  const id = 'next-run';
  set({ run: { id, mode: 'functional', total: 0, started_at: '', config: {}, entries: [] }, report: null, results: [], outcome: null });
  assert.ok(verdictNode() === null, 'attached, total 0');
  set({ run: { ...get().run, total: 2, started_at: '2026-11-18T11:00:00Z' } });
  assert.ok(verdictNode() === null, 'after run_started');
  set({ results: [base(0)] });
  assert.ok(verdictNode() === null, 'after one row');
  set({ results: RowSets.allPassed, outcome: { run_id: id, status: 'completed', duration_ms: 9, verdict: 'PASS' } });
  assert.equal(verdictNode().textContent, 'PASS');
  assert.equal(summary().querySelectorAll('.run-verdict').length, 1);
  // A performance run after it gets no functional verdict.
  set({ run: { id: 'perf-x', mode: 'performance', total: 1, started_at: '', config: {}, entries: [] }, report: null, results: [], outcome: { run_id: 'perf-x', status: 'completed', duration_ms: 9, verdict: 'FAIL' } });
  assert.ok(verdictNode() === null, 'no functional verdict on a performance run');
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ row marks

const rowHeads = () => [...byId('functional-results').querySelectorAll('.res-head')];

test('a row\'s mark says what its row did and its status-code pill is never coloured by assertions', () => {
  const cases = [
    // [row, mark text or null, mark class or null, pill text]
    [base(0, { status: 400 }), 'PASS', 'pass', '400'],
    [base(0, { status: 200, passed: false, assertions: [bad] }), 'FAIL', 'fail', '200'],
    [base(0, { status: 301, assertions: [] }), 'no checks', null, '301'],
    [base(0, { status: 599, assertions: null }), 'no checks', null, '599'],
    [(() => { const r = base(0, { status: 204 }); delete r.assertions; return r; })(), 'no checks', null, '204'],
    [base(0, { status: 0, passed: false, error: 'timed out', error_kind: 'timeout', assertions: [{ ...ok, passed: false, actual: 'no response' }] }), 'FAIL', 'fail', 'no response'],
    [base(0, { status: 0, passed: false, assertions: [] }), 'FAIL', 'fail', 'no response'],
    [(() => { const r = base(0); delete r.passed; return r; })(), 'FAIL', 'fail', '200'],
    [(() => { const r = base(0); delete r.status; return r; })(), 'PASS', 'pass', 'no response'],
    [base(0, { skipped: true, passed: false, status: 0, assertions: [] }), null, null, 'skipped'],
    [base(0, { skipped: true, passed: false, status: 200, assertions: [ok] }), null, null, 'skipped'],
    [base(0, { status: 500, passed: false, error: 'upstream said no', assertions: [bad] }), 'FAIL', 'fail', '500'],
  ];
  for (const [r, markText, markClass, pillText] of cases) {
    showReport('completed', { results: [r] });
    const where = JSON.stringify(r);
    const heads = rowHeads();
    assert.equal(heads.length, 1, where);
    const head = heads[0];
    const mark = head.querySelector('.res-mark');
    if (markText === null) {
      assert.ok(mark === null, `${where}: no mark`);
    } else {
      assert.ok(mark !== null, `${where}: a mark`);
      assert.equal(mark.textContent, markText, where);
      assert.deepEqual(tones(mark), markClass ? [markClass] : [], where);
    }
    const pill = head.querySelector('.pill');
    assert.equal(pill.textContent, pillText, where);
    for (const c of ['pass', 'fail', 'is-pass', 'is-fail', 'is-warn']) {
      assert.ok(!pill.classList.contains(c), `${where}: the status pill carries ${c}`);
    }
    // A green PASS needs a response-independent assertion outcome that held.
    if (mark && mark.textContent === 'PASS') {
      assert.ok(Array.isArray(r.assertions) && r.assertions.length > 0, `${where}: PASS with nothing checked`);
    }
  }
  assert.deepEqual(listenerErrors, []);
});

test('row text from the server is rendered as text, not markup', () => {
  const hostile = '<img src=x onerror=alert(1)><b>bold</b>';
  showReport('completed', { results: [base(0, { name: hostile, passed: false, error: hostile, error_kind: '<i>k</i>', body_preview: hostile, assertions: [{ ...bad, actual: hostile }] })] });
  const list = byId('functional-results');
  assert.equal(list.querySelectorAll('img').length, 0);
  assert.equal(list.querySelectorAll('b').length, 0);
  assert.equal(list.querySelectorAll('i').length, 0);
  assert.ok(list.textContent.includes(hostile), 'the name and error read literally');
});

// ------------------------------------------------------------------ live region

test('repeated renders of a finished run leave the summary and verdict nodes alone, and real changes redraw them', () => {
  showReport('completed', { results: RowSets.oneFailed, verdict: 'FAIL' });
  const first = verdictNode();
  const firstText = first.firstChild;
  const meta = summary().querySelector('.results-meta');
  for (let i = 0; i < 10; i += 1) {
    set({ activeTab: i % 2 ? 'results' : 'runner', history: [], notice: null });
    results.render(get());
  }
  assert.ok(verdictNode() === first, 'the verdict element is the same object');
  assert.ok(verdictNode().firstChild === firstText, 'the verdict text node is the same object');
  assert.ok(summary().querySelector('.results-meta') === meta, 'the summary meta is the same object');

  // Another report opened: the summary is redrawn.
  showReport('completed', { results: RowSets.allPassed, verdict: 'PASS' });
  assert.ok(verdictNode() !== first, 'another report redraws the summary');
  assert.equal(verdictNode().textContent, 'PASS');
  assert.deepEqual(listenerErrors, []);
});

test('the summary of a running functional run changes when a row arrives and when the run ends', () => {
  const id = 'live-2';
  set({ run: { id, mode: 'functional', total: 2, started_at: '2026-11-18T10:00:00Z', config: {}, entries: [] }, report: null, results: [], outcome: null });
  const before = summary().textContent;
  set({ results: [base(0)] });
  const afterRow = summary().textContent;
  assert.notEqual(afterRow, before, 'a new row is in the summary');
  assert.match(afterRow, /1 passed \/ 0 failed \/ 0 skipped of 1/);
  set({ results: [base(0), base(1, { passed: false, assertions: [bad] })], outcome: { run_id: id, status: 'completed', duration_ms: 50, verdict: 'FAIL' } });
  assert.notEqual(summary().textContent, afterRow, 'the end is in the summary');
  assert.equal(verdictNode().textContent, 'FAIL');
});

test('rendering verdicts writes nothing to localStorage', () => {
  const before = localStorage.length;
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) keys.push(localStorage.key(i));
  showReport('completed', { results: RowSets.oneFailed, verdict: 'FAIL' });
  showReport('cancelled', { results: RowSets.allPassed });
  assert.equal(localStorage.length, before);
  for (let i = 0; i < localStorage.length; i += 1) assert.equal(localStorage.key(i), keys[i]);
});
