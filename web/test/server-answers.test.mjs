// Every form the Go server can write for an answer is read as that answer:
// omitempty fields absent, nil slices and maps as null, zero times omitted,
// negative and fractional numbers. Each is written by hand from the Go types
// (internal/runner Status, internal/api historyEntry and sendResult,
// internal/report Report, internal/sandbox and internal/collections) and must
// pass the page's shape checks and render without a throw. Run ids holding
// characters a selector would choke on are keys like any other.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as api from '../js/api.js';
import { isStatus, isHistory, isCatalog, isReport, isRow } from '../js/api.js';
import { createLive } from '../js/live.js';
import * as sidebar from '../js/render-sidebar.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const wire = (v) => JSON.parse(JSON.stringify(v));

let unsubscribe = null;
let page = null;
let renderErrors = [];

function fresh(t) {
  if (t) t.mock.timers.reset();
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  if (page) page.stop();
  page = null;
  resetBrowser();
  resetState();
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  renderErrors = [];
  t.mock.method(console, 'error', (...args) => { renderErrors.push(args.map(String).join(' ')); });
  fresh();
});

afterEach(() => {
  fresh();
  api.onRunStarted(() => {});
});

const outcome = (passed, actual = '200') => ({ assertion: { type: 'status', op: 'eq', value: 200 }, passed, expected: '200', actual });
const outcomeNoValue = { assertion: { type: 'json', path: 'items', op: 'exists' }, passed: true, expected: 'exists', actual: 'present' };

const Statuses = {
  idle: { running: false, budget_balance: 1500 },
  idleZero: { running: false, budget_balance: 0 },
  negativeFractional: { running: false, budget_balance: -0.125 },
  cooling: { running: false, cooldown_until: '2026-11-18T10:00:05.123456789Z', budget_balance: -3.75 },
  runningBare: { running: true, run_id: 'abc', mode: 'functional', started_at: '2026-11-18T10:00:00Z', budget_balance: 12.5 },
};

const History = {
  empty: { runs: [] },
  perfCancelled: { runs: [{ id: 'p1', mode: 'performance', status: 'cancelled', started_at: '2026-11-18T10:00:00Z', duration_ms: 0, verdict: 'N/A', summary: '1 requests, p95 0.0ms, N/A' }] },
  functionalNoVerdict: { runs: [{ id: 'f1', mode: 'functional', status: 'completed', started_at: '2026-11-18T10:00:00Z', duration_ms: 12, summary: '1 passed, 0 failed, 0 skipped' }] },
  functionalVerdict: { runs: [{ id: 'f2', mode: 'functional', status: 'expired', started_at: '0001-01-01T00:00:00Z', duration_ms: 300000, verdict: 'N/A', summary: '' }] },
};

const Catalogs = {
  real: {
    collections: [
      { id: 'c1', name: 'One', description: '', requests: [] },
      { id: 'c2', name: 'Two', description: 'd', requests: [{ id: 'r1', name: '', endpoint: 'search', params: null, assertions: null }, { id: 'r2', name: 'n', endpoint: 'detail', params: {}, assertions: [] }] },
    ],
    endpoints: [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: null }, { id: 'detail', label: '', method: 'GET', path: '/x', params: [] }],
    target: '',
  },
  noCollections: { collections: [], endpoints: [], target: 'example' },
};

const row = (extra = {}) => ({ index: 0, name: 'R', endpoint: 'search', query: '', status: 200, latency_ms: 1.5, size_bytes: 0, assertions: [outcome(true)], passed: true, skipped: false, body_truncated: false, ...extra });

const reportBase = { id: 'rep-1', mode: 'functional', status: 'completed', started_at: '2026-11-18T10:00:00Z', finished_at: '2026-11-18T10:00:01Z', duration_ms: 1000, target: 'example', config: { stop_on_failure: false, delay_ms: 0, concurrency: 0, duration_secs: 0 }, entries: [{ index: 0, name: 'R', endpoint: 'search', path: '/search', query: '' }], note: '' };

const Reports = {
  functionalNullLists: { ...reportBase, entries: null, functional: { results: null } },
  functionalErrorRow: { ...reportBase, functional: { verdict: 'FAIL', results: [row({ status: 0, passed: false, error: 'The target did not answer in time.', error_kind: 'timeout', assertions: [outcome(false, 'no response')] })] } },
  functionalNullAssertions: { ...reportBase, functional: { verdict: 'PASS', results: [row({ assertions: null }), row({ index: 1, assertions: [outcomeNoValue] })] } },
  functionalAbsent: { ...reportBase },
  performanceRunning: (() => {
    const r = { ...reportBase, id: 'perf-1', mode: 'performance', status: 'running', duration_ms: 0 };
    delete r.finished_at;
    r.performance = {
      verdict: 'N/A', verdict_reasons: null,
      slo: { p95_ms: 150, max_error_rate: 0.01, ladder_ms: null, apdex_t_ms: 50, calibration_sequence: '', calibration_date: '' },
      overall: { index: -1, name: '', requests: 0, ok: 0, errors: 0, aborted: 0, success_ratio: 0, requests_per_sec: 0, bytes: 0, latency: { min: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 }, sla: { under_50: 0, under_150: 0, under_300: 0 }, apdex: { score: 0, rating: '', satisfied: 0, tolerating: 0, frustrated: 0 }, histogram: null, status_counts: null, error_kinds: null, percentile_samples: 0 },
      per_request: null, overrun_ms: 0,
    };
    return r;
  })(),
  performanceCancelled: (() => {
    const r = { ...reportBase, id: 'perf-2', mode: 'performance', status: 'cancelled', entries: null };
    r.performance = {
      verdict: 'N/A', verdict_reasons: ['partial data'],
      slo: { p95_ms: 150, max_error_rate: 0.01, ladder_ms: [50, 150, 300], apdex_t_ms: 50, calibration_sequence: 'search-basics', calibration_date: '2026-08-22' },
      overall: { index: -1, name: '', requests: 1, ok: 1, errors: 0, aborted: 0, success_ratio: 1, requests_per_sec: 1, bytes: 10, latency: { min: 1, avg: 1, p50: 1, p90: 1, p95: 1, p99: 1, max: 1 }, sla: { under_50: 100, under_150: 100, under_300: 100 }, apdex: { score: 1, rating: 'Excellent', satisfied: 1, tolerating: 0, frustrated: 0 }, histogram: [{ label: '0-25', from: 0, to: 25, count: 1 }], status_counts: { 200: 1 }, error_kinds: {}, percentile_samples: 1 },
      per_request: [], overrun_ms: 0,
    };
    return r;
  })(),
};

test('every status, history, catalog and report form the Go server can write passes the page\'s shape checks', () => {
  for (const [name, body] of Object.entries(Statuses)) assert.ok(isStatus(wire(body)), `status ${name}`);
  for (const [name, body] of Object.entries(History)) assert.ok(isHistory(wire(body)), `history ${name}`);
  for (const [name, body] of Object.entries(Catalogs)) assert.ok(isCatalog(wire(body)), `catalog ${name}`);
  for (const [name, body] of Object.entries(Reports)) {
    assert.ok(isReport(wire(body)), `report ${name}`);
    for (const r of (body.functional && body.functional.results) || []) assert.ok(isRow(wire(r)), `row of ${name}`);
  }
  // A streamed request_result is a row too.
  assert.ok(isRow(wire(row({ assertions: null, status: 0, passed: false, error: 'x' }))));
});

test('every report form the Go server can write renders on the results pane without a throw or an untrue word', () => {
  set({ activeTab: 'results' });
  const unsub = subscribe((state) => results.render(state));
  try {
    for (const [name, body] of Object.entries(Reports)) {
      const rep = wire(body);
      set({ run: { id: rep.id, mode: rep.mode, total: 0, started_at: rep.started_at, config: rep.config, entries: rep.entries || [] }, report: rep, results: (rep.functional && rep.functional.results) || [], outcome: null });
      const text = byId('results-pane') ? byId('results-pane').textContent : document.body.textContent;
      assert.doesNotMatch(byId('results-summary').textContent, /undefined|NaN|\[object Object\]/, name);
      assert.ok(text.length > 0, name);
    }
  } finally {
    unsub();
  }
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ the wired page

function serve({ history, catalog = Catalogs.real, status = Statuses.idle, reports = new Map() }) {
  const server = { status, history, reports };
  fetchStub.serve('/api/collections', () => ({ status: 200, body: wire(catalog) }), { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: wire(server.status) }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => ({ status: 200, body: wire({ runs: server.history }) }), { method: 'GET' });
  fetchStub.serve(/^\/api\/runs\/[^/]+$/, (call) => {
    const id = decodeURIComponent(new URL(call.url, location.origin).pathname.split('/')[3]);
    const rep = server.reports.get(id);
    return rep ? { status: 200, body: wire(rep) } : { status: 404, body: { error: 'no run' } };
  }, { method: 'GET' });
  return server;
}

async function bootPage(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const showTab = (name) => set({ activeTab: name });
  page = createLive({ api, get, set, showTab });
  editor.init();
  runner.init(page.hooks.runner);
  sidebar.init({
    select: (request) => {
      editor.onSelect();
      sidebar.selectRequest(request);
      showTab('editor');
    },
    add: (request) => runner.add(request),
    addAll: (collection) => runner.addAll(collection),
    ...page.hooks.sidebar,
  });
  unsubscribe = subscribe((state) => {
    sidebar.render(state);
    editor.render(state);
    runner.render(state);
    results.render(state);
    page.scheduleSync();
  });
  set({ activeTab: 'runner' });
  await page.boot();
  await flush();
}

const tick = async (t, ms, by = 500) => {
  for (let left = ms; left > 0; left -= by) {
    t.mock.timers.tick(Math.min(by, left));
    await flush(2);
  }
};

// The sidebar lists the five most recent runs.
const Awkward = ['q"uote', 'back\\slash', 'a" i], [data-focus-key="', 'new\nline', 'x'.repeat(200)];

test('history entries whose run ids hold quotes, backslashes, brackets, newlines or 200 characters keep focus through polls and open', async (t) => {
  const entry = (id) => ({ id, mode: 'functional', status: 'completed', started_at: '2026-11-18T10:00:00Z', duration_ms: 5, verdict: 'FAIL', summary: '0 passed, 1 failed, 0 skipped' });
  const reports = new Map(Awkward.map((id) => [id, { ...reportBase, id, functional: { verdict: 'FAIL', results: [row({ passed: false, assertions: [outcome(false, '500')], status: 500 })] } }]));
  const server = serve({ history: Awkward.map(entry), reports });
  await bootPage(t);
  const button = (id) => [...byId('history-list').querySelectorAll('button')].find((b) => b.dataset.focusKey === `history:${id}`);
  for (const id of Awkward) {
    const b = button(id);
    assert.ok(b, `entry ${JSON.stringify(id)} carries its key`);
    b.focus();
    for (let i = 0; i < 2; i += 1) {
      server.status = { running: false, budget_balance: 1000 - i };
      await tick(t, 3000, 1000);
      await page.hooks.runner.refresh();
      await flush();
    }
    assert.ok(document.activeElement === button(id), `focus kept on ${JSON.stringify(id)}`);
    button(id).click();
    await flush();
    assert.equal(get().report && get().report.id, id, `${JSON.stringify(id)} opens`);
    const v = byId('results-summary').querySelector('.run-verdict');
    assert.ok(v !== null && v.textContent === 'FAIL', `${JSON.stringify(id)}: the opened run says FAIL`);
  }
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});

test('a history list carrying every real entry form is taken and drawn, and one entry of the wrong type keeps the list held', async (t) => {
  const real = [...History.perfCancelled.runs, ...History.functionalNoVerdict.runs, ...History.functionalVerdict.runs];
  const server = serve({ history: real });
  await bootPage(t);
  assert.equal(get().history.length, 3, 'every real entry is taken');
  assert.equal(byId('history-list').querySelectorAll('button').length >= 3, true);
  for (const wrong of [{ duration_ms: '12' }, { id: 5 }, { status: null }, { summary: {} }, { verdict: 0 }]) {
    server.history = [...real, { ...real[0], id: 'odd', ...wrong }];
    await page.hooks.runner.refresh();
    await flush();
    assert.equal(get().history.length, 3, `held list kept for ${JSON.stringify(wrong)}`);
  }
  server.history = real.slice(0, 1);
  await page.hooks.runner.refresh();
  await flush();
  assert.equal(get().history.length, 1, 'the next good answer is taken');
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});
