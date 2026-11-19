// What the SLA ladder says about its rungs is true of the report: the 95%
// mark is this page's convention, "under" counts responses at or under a rung,
// only the gate's rung is the verdict's, and a share is never printed as more
// than it was.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);

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

function shownPerf({ slo, sla }) {
  seq += 1;
  const id = `perf-${seq}`;
  const performance = { verdict: 'PASS', verdict_reasons: [], overall: { sla, histogram: [], apdex: {} } };
  if (slo !== undefined) performance.slo = slo;
  set({
    run: { id, mode: 'performance', total: 1, started_at: '', config: {}, entries: [] },
    report: { id, mode: 'performance', status: 'completed', entries: [], performance },
    results: [],
    outcome: null,
  });
}

const SLO = { p95_ms: 150, max_error_rate: 0.01, ladder_ms: [50, 150, 300], apdex_t_ms: 50, calibration_sequence: 'search-basics', calibration_date: '2026-08-22' };
const note = () => byId('sla-ladder').querySelector('.note').textContent;
const rungs = () => [...byId('sla-ladder').querySelectorAll('.bar-row')].map((r) => ({
  label: r.querySelector('.bar-label').textContent,
  value: r.querySelector('.bar-value').textContent,
  goal: r.querySelector('.bar-goal').textContent,
  aria: r.getAttribute('aria-label'),
}));

test('the ladder note says the 95% mark is the page\'s, counts responses at or under a rung, and ties only the gate\'s rung to the verdict', () => {
  shownPerf({ slo: SLO, sla: { under_50: 10, under_150: 80, under_300: 99 } });
  const text = note();
  assert.match(text, /at least 95% of responses took that long or less/);
  assert.match(text, /Only the 150ms rung corresponds to the verdict's p95 gate/);
  assert.match(text, /at or above it that misses its goal is drawn as a failure/);
  assert.doesNotMatch(text, /goal is 95% of responses under it/, 'no rung has a goal of the server\'s');
  assert.deepEqual(rungs().map((r) => r.label), ['under 50ms', 'under 150ms', 'under 300ms']);
  assert.deepEqual(rungs().map((r) => r.goal), ['goal missed', 'goal missed', 'goal met']);
});

test('a report that states no gate gets a note that names no gate number', () => {
  shownPerf({ sla: { under_50: 10, under_150: 80, under_300: 99 } });
  const text = note();
  assert.match(text, /at least 95% of responses took that long or less/);
  assert.doesNotMatch(text, /150ms/, 'the report sent no gate');
  assert.match(text, /verdict's p95 gate/);
});

test('a share is rounded down to one decimal, so one under the goal never reads as the goal and one under 100 never reads as 100', () => {
  const cases = [
    [94.96, '94.9%', 'goal missed'],
    [94.999, '94.9%', 'goal missed'],
    [99.99, '99.9%', 'goal met'],
    [95, '95.0%', 'goal met'],
    [100, '100.0%', 'goal met'],
    [0.04, '0.0%', 'goal missed'],
  ];
  for (const [share, shown, goal] of cases) {
    shownPerf({ slo: { ...SLO, ladder_ms: [150] }, sla: { under_150: share } });
    const [rung] = rungs();
    assert.equal(rung.value, shown, `${share}`);
    assert.equal(rung.goal, goal, `${share}`);
    assert.equal(rung.aria, `under 150ms: ${shown}, ${goal}`, `${share}`);
  }
  assert.deepEqual(listenerErrors, []);
});
