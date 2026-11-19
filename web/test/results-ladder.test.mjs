// The SLA ladder is coloured by whether each rung met its goal, read from the
// report's own ladder and gate, and says so in words as well as in colour.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// ------------------------------------------------------------------ the dashboard

const ladderRungs = () => [...byId('sla-ladder').querySelectorAll('.bar-row')].map((r) => ({
  label: r.querySelector('.bar-label').textContent,
  tone: r.querySelector('.bar-fill').className.replace('bar-fill', '').trim(),
  goal: `${r.textContent} ${r.getAttribute('aria-label') || ''}`,
}));

function shownPerf({ slo, sla, histogram = [], apdex = {} }) {
  seq += 1;
  const id = `perf-${seq}`;
  const performance = { verdict: 'PASS', verdict_reasons: [], overall: { sla, histogram, apdex } };
  if (slo !== undefined) performance.slo = slo;
  set({
    run: { id, mode: 'performance', total: 1, started_at: '', config: {}, entries: [] },
    report: { id, mode: 'performance', status: 'completed', entries: [], performance },
    results: [],
    outcome: null,
  });
}

const SLO = { p95_ms: 150, max_error_rate: 0.01, ladder_ms: [50, 150, 300], apdex_t_ms: 50, calibration_sequence: 'search-basics', calibration_date: '2026-08-22' };

test('ladder rungs are coloured by whether each met its goal', () => {
  shownPerf({ slo: SLO, sla: { under_50: 60, under_150: 98, under_300: 100 } });
  assert.deepEqual(ladderRungs().map((r) => r.label), ['under 50ms', 'under 150ms', 'under 300ms']);
  assert.deepEqual(ladderRungs().map((r) => r.tone), ['', 'is-pass', 'is-pass']);
  shownPerf({ slo: SLO, sla: { under_50: 10, under_150: 80, under_300: 99 } });
  assert.deepEqual(ladderRungs().map((r) => r.tone), ['', 'is-fail', 'is-pass']);
});

test('every rung says in words whether it met its goal', () => {
  shownPerf({ slo: SLO, sla: { under_50: 10, under_150: 80, under_300: 99 } });
  const said = ladderRungs().map((r) => (/goal missed/.test(r.goal) ? 'missed' : /goal met/.test(r.goal) ? 'met' : 'nothing'));
  assert.deepEqual(said, ['missed', 'missed', 'met']);
  shownPerf({ slo: SLO, sla: { under_50: 95, under_150: 99, under_300: 100 } });
  assert.ok(ladderRungs().every((r) => /goal met/.test(r.goal)));
});

test('the goal is 95%, met at exactly 95 and missed just under it', () => {
  shownPerf({ slo: SLO, sla: { under_50: 95, under_150: 94.99, under_300: 0 } });
  assert.deepEqual(ladderRungs().map((r) => r.tone), ['is-pass', 'is-fail', 'is-fail']);
  shownPerf({ slo: SLO, sla: { under_50: 100, under_150: 100, under_300: 100 } });
  assert.deepEqual(ladderRungs().map((r) => r.tone), ['is-pass', 'is-pass', 'is-pass']);
});

test('the rungs and the gate come from the report: another ladder, a gate that matches no rung, rungs out of order', () => {
  shownPerf({ slo: { ...SLO, ladder_ms: [300, 25, 100], p95_ms: 90 }, sla: { under_25: 10, under_100: 50, under_300: 96 } });
  assert.deepEqual(ladderRungs().map((r) => r.label), ['under 25ms', 'under 100ms', 'under 300ms']);
  assert.deepEqual(ladderRungs().map((r) => r.tone), ['', 'is-fail', 'is-pass']);
  shownPerf({ slo: { ...SLO, ladder_ms: [150] }, sla: { under_150: 50 } });
  assert.deepEqual(ladderRungs().map((r) => [r.label, r.tone]), [['under 150ms', 'is-fail']]);
});

test('a report with no ladder, or one that is not a list of numbers, draws the rungs its shares name, with the default gate', () => {
  for (const slo of [undefined, null, {}, { ...SLO, ladder_ms: 'x' }, { ...SLO, ladder_ms: [50, 'a', 300] }, { ...SLO, ladder_ms: [] }, { ...SLO, p95_ms: 'fast' }]) {
    const where = JSON.stringify(slo);
    shownPerf({ slo, sla: { under_50: 10, under_150: 80, under_300: 99 } });
    assert.deepEqual(ladderRungs().map((r) => r.label), ['under 50ms', 'under 150ms', 'under 300ms'], where);
    assert.deepEqual(ladderRungs().map((r) => r.tone), ['', 'is-fail', 'is-pass'], where);
    assert.doesNotMatch(byId('perf-dashboard').textContent, untrue, where);
  }
});

test('a rung with no share says so instead of drawing a number it does not have', () => {
  for (const sla of [{}, { under_50: 'x', under_150: null }, null]) {
    shownPerf({ slo: SLO, sla });
    const where = JSON.stringify(sla);
    assert.equal(ladderRungs().length, 3, where);
    assert.doesNotMatch(byId('sla-ladder').textContent, untrue, where);
    for (const rung of byId('sla-ladder').querySelectorAll('.bar-row')) {
      assert.equal(rung.querySelector('.bar-fill').style.width, '0%', where);
      assert.equal(rung.querySelector('.bar-value').textContent, '-', where);
    }
  }
});

test('the histogram\'s gate is the report\'s p95 goal, 150ms when it carries none', () => {
  const histogram = [
    { label: '0-50', from: 0, to: 50, count: 1 },
    { label: '50-100', from: 50, to: 100, count: 1 },
    { label: '100-200', from: 100, to: 200, count: 1 },
    { label: '200+', from: 200, to: 0, count: 1 },
  ];
  const histTones = () => [...byId('histogram').querySelectorAll('.bar-fill')].map((f) => f.className.replace('bar-fill', '').trim());
  shownPerf({ slo: { ...SLO, p95_ms: 75 }, sla: {}, histogram });
  assert.deepEqual(histTones(), ['', 'is-warn', 'is-fail', 'is-fail']);
  shownPerf({ slo: undefined, sla: {}, histogram });
  assert.deepEqual(histTones(), ['', '', 'is-warn', 'is-fail']);
});
