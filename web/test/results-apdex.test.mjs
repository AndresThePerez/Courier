// The Apdex threshold is read from the report the dashboard draws: the page
// states no number of its own, so it cannot disagree with the server.

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

test('the Apdex heading and its note read T from the report', () => {
  shownPerf({ slo: SLO, sla: {} });
  assert.equal(byId('apdex-heading').textContent, 'Apdex - T = 50ms');
  assert.match(byId('apdex-block').textContent, /Satisfied at or under 50ms, tolerating at or under 200ms\./);
  shownPerf({ slo: { ...SLO, apdex_t_ms: 25 }, sla: {} });
  assert.equal(byId('apdex-heading').textContent, 'Apdex - T = 25ms');
  assert.match(byId('apdex-block').textContent, /Satisfied at or under 25ms, tolerating at or under 100ms\./);
  shownPerf({ slo: { ...SLO, apdex_t_ms: 37.5 }, sla: {} });
  assert.equal(byId('apdex-heading').textContent, 'Apdex - T = 37.5ms');
  assert.match(byId('apdex-block').textContent, /Satisfied at or under 37\.5ms, tolerating at or under 150ms\./);
});

test('without a usable T the heading is plain Apdex and the note names no threshold', () => {
  for (const slo of [undefined, null, {}, { ...SLO, apdex_t_ms: 0 }, { ...SLO, apdex_t_ms: -5 }, { ...SLO, apdex_t_ms: '50' }, { ...SLO, apdex_t_ms: null }, 'x']) {
    shownPerf({ slo, sla: {} });
    const where = JSON.stringify(slo);
    assert.equal(byId('apdex-heading').textContent, 'Apdex', where);
    assert.doesNotMatch(byId('apdex-block').textContent, /Satisfied at or under/, where);
    assert.doesNotMatch(byId('perf-dashboard').textContent, untrue, where);
  }
});

test('the page itself states no Apdex threshold, and the heading is a required id', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<h3 id="apdex-heading" class="block-heading">Apdex<\/h3>/);
  assert.doesNotMatch(html, /T = \d/);
  const embed = readFileSync(new URL('../embed_test.go', import.meta.url), 'utf8');
  assert.match(embed, /"apdex-heading"/);
  const src = readFileSync(new URL('../js/render-results.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /at or under 50ms/, 'the note is not a fixed sentence');
});
