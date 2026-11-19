// The performance dashboard under unusual SLO blocks: a ladder rung is never
// coloured against its own goal and always says in words how it did, the
// Apdex heading and note never state a number the report did not send, and
// nothing throws.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
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

function shownPerf({ slo, sla = {}, histogram = [], apdex = {} }) {
  seq += 1;
  const id = `perf-${seq}`;
  const performance = { verdict: 'PASS', verdict_reasons: [], overall: { sla, histogram, apdex }, per_request: [] };
  if (slo !== undefined) performance.slo = slo;
  set({
    run: { id, mode: 'performance', total: 1, started_at: '', config: {}, entries: [] },
    report: { id, mode: 'performance', status: 'completed', entries: [], performance },
    results: [],
    outcome: null,
  });
}

const rungs = () => [...byId('sla-ladder').querySelectorAll('.bar-row')].map((r) => {
  const fill = r.querySelector('.bar-fill');
  return {
    label: r.querySelector('.bar-label').textContent,
    fill,
    goal: r.querySelector('.bar-goal') ? r.querySelector('.bar-goal').textContent : '',
    aria: r.getAttribute('aria-label') || '',
    text: r.textContent,
  };
});

const Shares = [95, 94.999, 95.0001, 0, 100, 101, -1, '98', null, undefined];
const Ladders = [
  [50, 150, 300], [150], [10, 50, 150, 300], [300, 50, 150], [50, 50, 150, 300],
  [0, 50, 150], [-5, 150], ['50', '150'], [50, 1e9], [], 'not a list', undefined, null,
];
const Gates = [150, 50, 300, 100, 10, 1000, 0, undefined, '150', -1];

test('across shares, ladders and gates, a rung that met its goal is never red and one that missed is never green', () => {
  let rendered = 0;
  for (const share of Shares) {
    for (const ladder of Ladders) {
      for (const gate of Gates) {
        const sla = {};
        for (const k of [10, 50, 150, 300, 1000000000]) if (share !== undefined) sla[`under_${k}`] = share;
        const slo = {};
        if (ladder !== undefined) slo.ladder_ms = ladder;
        if (gate !== undefined) slo.p95_ms = gate;
        shownPerf({ slo, sla });
        const where = `share ${JSON.stringify(share)} ladder ${JSON.stringify(ladder)} gate ${JSON.stringify(gate)}`;
        const drawn = rungs();
        assert.ok(drawn.length >= 1, `${where}: at least one rung`);
        const numeric = typeof share === 'number' && Number.isFinite(share);
        for (const r of drawn) {
          assert.doesNotMatch(r.text, untrue, where);
          assert.doesNotMatch(r.aria, untrue, where);
          assert.match(r.label, /^under \d+(\.\d+)?ms$/, where);
          const width = Number.parseFloat(r.fill.style.width);
          assert.ok(width >= 0 && width <= 100, `${where}: width ${r.fill.style.width}`);
          const isPass = r.fill.classList.contains('is-pass');
          const isFail = r.fill.classList.contains('is-fail');
          assert.ok(!(isPass && isFail), where);
          if (!numeric) {
            assert.equal(r.goal, 'no share recorded', where);
            assert.ok(!isPass && !isFail, `${where}: a rung with no share is not judged`);
          } else if (share >= 95) {
            assert.equal(r.goal, 'goal met', where);
            assert.ok(isPass && !isFail, `${where}: a met rung is green`);
          } else {
            assert.equal(r.goal, 'goal missed', where);
            assert.ok(!isPass, `${where}: a missed rung is never green`);
          }
          assert.ok(r.aria.includes(r.goal) || (r.goal === 'no share recorded' && r.aria.includes('no share')), `${where}: the aria-label carries the goal`);
          assert.ok(r.aria.startsWith(`${r.label}:`), `${where}: the aria-label names its rung`);
        }
        rendered += 1;
      }
    }
  }
  assert.equal(rendered, Shares.length * Ladders.length * Gates.length);
  assert.deepEqual(listenerErrors, []);
});

test('a stated ladder draws exactly its rungs, sorted and deduped, and a missed rung at or past the gate is red, below it plain', () => {
  shownPerf({ slo: { ladder_ms: [300, 150, 50, 150], p95_ms: 100 }, sla: { under_50: 90, under_150: 90, under_300: 99 } });
  const drawn = rungs();
  assert.deepEqual(drawn.map((r) => r.label), ['under 50ms', 'under 150ms', 'under 300ms']);
  assert.deepEqual(drawn.map((r) => r.fill.className), ['bar-fill', 'bar-fill is-fail', 'bar-fill is-pass']);
  // A gate exactly at a rung makes that rung the gate rung.
  shownPerf({ slo: { ladder_ms: [50, 150, 300], p95_ms: 50 }, sla: { under_50: 94.9, under_150: 94.9, under_300: 94.9 } });
  assert.deepEqual(rungs().map((r) => r.fill.className), ['bar-fill is-fail', 'bar-fill is-fail', 'bar-fill is-fail']);
  // A gate past every rung leaves every missed rung plain, still saying it missed.
  shownPerf({ slo: { ladder_ms: [50, 150, 300], p95_ms: 1000 }, sla: { under_50: 1, under_150: 1, under_300: 1 } });
  assert.deepEqual(rungs().map((r) => [r.fill.className, r.goal]), [['bar-fill', 'goal missed'], ['bar-fill', 'goal missed'], ['bar-fill', 'goal missed']]);
});

test('shares keyed for rungs the ladder does not list are not drawn, and listed rungs without a share say so', () => {
  shownPerf({ slo: { ladder_ms: [50, 150], p95_ms: 150 }, sla: { under_50: 99, under_300: 10, under_1000: 5 } });
  const drawn = rungs();
  assert.deepEqual(drawn.map((r) => r.label), ['under 50ms', 'under 150ms']);
  assert.deepEqual(drawn.map((r) => r.goal), ['goal met', 'no share recorded']);
  assert.equal(drawn[1].text.includes('-'), true);
});

test('the histogram\'s gate follows p95_ms for buckets at, straddling and past it', () => {
  const histogram = [
    { label: '0-50', from: 0, to: 50, count: 3 },
    { label: '50-100', from: 50, to: 100, count: 3 },
    { label: '100-200', from: 100, to: 200, count: 3 },
    { label: '200+', from: 200, to: 0, count: 3 },
  ];
  const tonesFor = () => [...byId('histogram').querySelectorAll('.bar-fill')].map((f) => f.className);
  shownPerf({ slo: { p95_ms: 100 }, histogram });
  assert.deepEqual(tonesFor(), ['bar-fill', 'bar-fill', 'bar-fill is-fail', 'bar-fill is-fail']);
  shownPerf({ slo: { p95_ms: 75 }, histogram });
  assert.deepEqual(tonesFor(), ['bar-fill', 'bar-fill is-warn', 'bar-fill is-fail', 'bar-fill is-fail']);
  shownPerf({ slo: { p95_ms: 0 }, histogram });
  assert.deepEqual(tonesFor(), ['bar-fill', 'bar-fill', 'bar-fill is-warn', 'bar-fill is-fail'], 'a zero gate falls back to 150');
});

// ------------------------------------------------------------------ Apdex

const heading = () => byId('apdex-heading');
const apdexNote = () => [...byId('apdex-block').querySelectorAll('.note')].map((n) => n.textContent).join(' | ');

test('the Apdex heading and note state only the T the report sent, or none', () => {
  const stated = [[50, '50', '200'], [25, '25', '100'], [37.5, '37.5', '150'], [0.001, '0.001', '0.004'], [1e6, '1000000', '4000000'], [12.25, '12.25', '49']];
  for (const [t, shown, four] of stated) {
    shownPerf({ slo: { apdex_t_ms: t } });
    assert.equal(heading().textContent, `Apdex - T = ${shown}ms`, `T ${t}`);
    assert.ok(apdexNote().includes(`Satisfied at or under ${shown}ms, tolerating at or under ${four}ms. `), `T ${t}: ${apdexNote()}`);
  }
  const withheld = [{ apdex_t_ms: 0 }, { apdex_t_ms: -5 }, { apdex_t_ms: '50' }, { apdex_t_ms: NaN }, { apdex_t_ms: Infinity }, { apdex_t_ms: null }, {}, null, [50], 'T=50', undefined];
  for (const slo of withheld) {
    shownPerf({ slo });
    const where = `slo ${String(JSON.stringify(slo))}`;
    assert.equal(heading().textContent, 'Apdex', where);
    assert.doesNotMatch(apdexNote(), /Satisfied at or under|\d+ms/, where);
    assert.doesNotMatch(apdexNote(), untrue, where);
  }
  assert.deepEqual(listenerErrors, []);
});

test('the heading follows a report that changes T, and keeps its text node while T is unchanged', () => {
  shownPerf({ slo: { apdex_t_ms: 50 } });
  assert.equal(heading().textContent, 'Apdex - T = 50ms');
  const node = heading().firstChild;
  shownPerf({ slo: { apdex_t_ms: 50 } });
  assert.ok(heading().firstChild === node, 'an unchanged heading keeps its text node');
  shownPerf({ slo: { apdex_t_ms: 25 } });
  assert.equal(heading().textContent, 'Apdex - T = 25ms');
  shownPerf({ slo: {} });
  assert.equal(heading().textContent, 'Apdex');
  // A functional report after it: the dashboard is hidden and no stale T shows.
  set({
    run: { id: 'fn-1', mode: 'functional', total: 0, started_at: '', config: {}, entries: [] },
    report: { id: 'fn-1', mode: 'functional', status: 'completed', entries: [], functional: { results: [] } },
    results: [],
    outcome: null,
  });
  assert.equal(byId('perf-dashboard').hidden, true);
  assert.doesNotMatch(heading().textContent, /25|50/);
});
