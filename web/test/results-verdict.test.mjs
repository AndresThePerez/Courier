// A functional run's verdict, beside how it ended, judged by the same rule as
// the PDF of the same run; a result row's status code kept apart from whether
// its assertions held; the Apdex threshold and the SLA ladder read from the
// report rather than restated by the page.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const title = () => byId('results-summary').querySelector('.results-title');
const statusPill = () => title().children[1];
const verdict = () => byId('results-summary').querySelector('.run-verdict');
const tones = (node) => ['is-pass', 'is-fail', 'is-warn', 'is-live'].filter((c) => node.classList.contains(c));
const untrue = /undefined|null|NaN|\[object Object\]|Infinity/;

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

const row = (index, extra = {}) => ({ index, name: `R${index}`, endpoint: 'search', query: '', status: 200, latency_ms: 4, size_bytes: 10, passed: true, skipped: false, assertions: [{ assertion: { type: 'status', op: 'eq', value: 200 }, passed: true, expected: '200', actual: '200' }], ...extra });
const failed = (index, extra = {}) => row(index, { passed: false, assertions: [{ assertion: { type: 'status', op: 'eq', value: 201 }, passed: false, expected: '201', actual: '200' }], ...extra });
const skipped = (index) => row(index, { status: 0, passed: false, skipped: true, assertions: [] });

// shownFinished puts a finished functional report on screen the way the live
// state holds one: the report, its rows, and the run it describes.
function shownFinished({ status = 'completed', verdict: v, rows = [] } = {}) {
  seq += 1;
  const id = `run-${seq}`;
  const functional = { results: rows };
  if (v !== undefined) functional.verdict = v;
  const report = { id, mode: 'functional', status, started_at: '2026-11-18T10:00:00Z', duration_ms: 900, config: {}, entries: [], functional };
  set({ run: { id, mode: 'functional', total: rows.length, started_at: report.started_at, config: {}, entries: [] }, report, results: rows, outcome: null });
  return id;
}

// ------------------------------------------------------------------ the verdict

test('a finished functional report says FAIL, PASS or N/A beside its status, from functional.verdict', () => {
  const cases = [
    ['FAIL', 'completed', 'FAIL', 'is-fail'],
    ['PASS', 'completed', 'PASS', 'is-pass'],
    ['N/A', 'completed', 'N/A - nothing was asserted', null],
    ['N/A', 'cancelled', 'N/A - partial data', null],
    ['N/A', 'expired', 'N/A - partial data', null],
  ];
  for (const [given, status, text, tone] of cases) {
    shownFinished({ status, verdict: given, rows: [row(0)] });
    const where = `${given} on a ${status} run`;
    assert.equal(statusPill().textContent, status, where);
    assert.ok(title().children[2] === verdict(), `${where}: the verdict sits right after the status pill`);
    assert.equal(verdict().textContent, text, where);
    assert.deepEqual(tones(verdict()), tone ? [tone] : [], where);
  }
  assert.deepEqual(listenerErrors, []);
});

test('a verdict the report does not carry, or carries in a form it never sends, is worked out from the rows as the PDF does', () => {
  for (const given of [undefined, 'fail', 'pass', 42, null, '', 'MAYBE']) {
    const cases = [
      ['completed', [row(0), failed(1)], 'FAIL', 'is-fail'],
      ['completed', [row(0), skipped(1)], 'PASS', 'is-pass'],
      ['completed', [skipped(0), skipped(1)], 'N/A - nothing was asserted', null],
      ['completed', [], 'N/A - nothing was asserted', null],
      ['cancelled', [row(0), failed(1)], 'N/A - partial data', null],
      ['expired', [row(0)], 'N/A - partial data', null],
    ];
    for (const [status, rows, text, tone] of cases) {
      shownFinished({ status, verdict: given, rows });
      const where = `${JSON.stringify(given)} on a ${status} run of ${rows.length}`;
      assert.equal(verdict().textContent, text, where);
      assert.deepEqual(tones(verdict()), tone ? [tone] : [], where);
    }
  }
});

test('a cancelled or expired run is never judged, whatever verdict it carries', () => {
  for (const status of ['cancelled', 'expired']) {
    for (const given of ['PASS', 'FAIL']) {
      shownFinished({ status, verdict: given, rows: [row(0)] });
      assert.equal(verdict().textContent, 'N/A - partial data', `${given} on ${status}`);
      assert.deepEqual(tones(verdict()), []);
    }
  }
});

test('no verdict is shown while a run is running, from the first paint after attaching to the last row', () => {
  set({ run: { id: 'run-live', mode: 'functional', total: 0, started_at: '', config: {}, entries: [] }, report: null, results: [], outcome: null });
  assert.equal(statusPill().textContent, 'running');
  assert.ok(verdict() === null, 'first paint');
  set({ results: [row(0), failed(1)] });
  assert.ok(verdict() === null, 'a failed row while running');
  set({ report: { id: 'run-live', mode: 'functional', status: 'running', entries: [], functional: { results: [row(0), failed(1)] } } });
  assert.ok(verdict() === null, 'a partial report while running');
});

test('a run whose report could not be loaded is judged from its terminal event, or from its rows', () => {
  const run = { id: 'run-end', mode: 'functional', total: 2, started_at: '', config: {}, entries: [] };
  set({ run, report: null, results: [row(0), row(1)], outcome: { run_id: 'run-end', status: 'completed', duration_ms: 10, verdict: 'FAIL', report: 'failed' } });
  assert.equal(verdict().textContent, 'FAIL', 'the terminal event said so');
  set({ outcome: { run_id: 'run-end', status: 'completed', duration_ms: 10, verdict: '' } });
  assert.equal(verdict().textContent, 'PASS', 'no verdict on the event: the rows decide');
  set({ outcome: { run_id: 'run-end', status: 'unavailable', duration_ms: null, verdict: '' } });
  assert.ok(verdict() === null, 'a run the server lost has no verdict to show');
});

test('the completed status pill is neutral, not a pass', () => {
  shownFinished({ status: 'completed', verdict: 'FAIL', rows: [failed(0)] });
  assert.equal(statusPill().textContent, 'completed');
  assert.deepEqual(tones(statusPill()), []);
  assert.equal(statusPill().className, 'pill');
});

test('a performance report keeps its own verdict and gets no functional one in the summary', () => {
  set({
    run: { id: 'run-perf', mode: 'performance', total: 1, started_at: '', config: {}, entries: [] },
    report: { id: 'run-perf', mode: 'performance', status: 'completed', entries: [], performance: { verdict: 'PASS', verdict_reasons: ['p95 within budget'], slo: { p95_ms: 150, max_error_rate: 0.01, ladder_ms: [50, 150, 300], apdex_t_ms: 50, calibration_sequence: 's', calibration_date: '2026-08-22' }, overall: { sla: { under_50: 90, under_150: 99, under_300: 100 } } } },
    results: [],
    outcome: null,
  });
  assert.ok(verdict() === null);
  assert.equal(byId('verdict-badge').className, 'verdict is-pass');
  assert.equal(byId('verdict-badge').querySelector('.verdict-badge').textContent, 'PASS');
});

test('the verdict is not redrawn by a render that changes nothing it shows', () => {
  shownFinished({ status: 'completed', verdict: 'FAIL', rows: [failed(0)] });
  const node = verdict();
  const text = node.firstChild;
  set({ status: { running: false, budget_balance: 10 } });
  set({ history: [] });
  assert.ok(verdict() === node, 'the same element');
  assert.ok(verdict().firstChild === text, 'the same text node: nothing is announced again');
});

// ------------------------------------------------------------------ the row marks

const marks = () => [...byId('results-rows').querySelectorAll('.res-head')].map((head) => {
  const pill = head.querySelector('.pill');
  const mark = head.querySelector('.res-mark');
  return {
    code: pill.textContent,
    codeTones: tones(pill),
    mark: mark ? mark.textContent : null,
    markTone: mark ? ['pass', 'fail'].filter((c) => mark.classList.contains(c)) : null,
  };
});

test('a row\'s status code is neutral and a separate mark says whether its assertions held', () => {
  shownFinished({
    status: 'completed',
    verdict: 'FAIL',
    rows: [
      row(0, { status: 400, assertions: [{ assertion: { type: 'status', op: 'eq', value: 400 }, passed: true, expected: '400', actual: '400' }] }),
      failed(1, { status: 200 }),
      row(2, { status: 301 }),
      failed(3, { status: 500 }),
    ],
  });
  assert.deepEqual(marks(), [
    { code: '400', codeTones: [], mark: 'PASS', markTone: ['pass'] },
    { code: '200', codeTones: [], mark: 'FAIL', markTone: ['fail'] },
    { code: '301', codeTones: [], mark: 'PASS', markTone: ['pass'] },
    { code: '500', codeTones: [], mark: 'FAIL', markTone: ['fail'] },
  ]);
});

test('a row nothing checked never shows a green PASS: no assertions, skipped, no response', () => {
  shownFinished({
    status: 'completed',
    rows: [
      row(0, { status: 200, assertions: [] }),
      row(1, { status: 500, assertions: null }),
      skipped(2),
      failed(3, { status: 0, error: 'The target did not answer in time.', error_kind: 'timeout', assertions: [{ assertion: { type: 'status', op: 'eq', value: 200 }, passed: false, expected: '200', actual: 'no response' }] }),
      row(4, { status: 0, passed: false, error: 'The target refused the connection.', error_kind: 'connection', assertions: [] }),
    ],
  });
  assert.deepEqual(marks(), [
    { code: '200', codeTones: [], mark: 'no checks', markTone: [] },
    { code: '500', codeTones: [], mark: 'no checks', markTone: [] },
    { code: 'skipped', codeTones: [], mark: null, markTone: null },
    { code: 'no response', codeTones: [], mark: 'FAIL', markTone: ['fail'] },
    { code: 'no response', codeTones: [], mark: 'FAIL', markTone: ['fail'] },
  ]);
  for (const head of byId('results-rows').querySelectorAll('.res-head')) {
    assert.doesNotMatch(head.textContent, untrue);
  }
});

test('the method badge still sits between the status pill and the request, with the mark before them', () => {
  shownFinished({ status: 'completed', rows: [failed(0)] });
  const head = byId('results-rows').querySelector('.res-head');
  const order = [...head.children].map((c) => c.className.split(' ')[0]);
  assert.deepEqual(order.slice(0, 5), ['res-index', 'res-mark', 'pill', 'method', 'res-body']);
});
