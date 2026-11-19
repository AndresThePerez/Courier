// A functional run ends with the same verdict however the tab followed it:
// over the stream, over the polling fallback, or opened from history; and a
// new run shows none of the last one's.
//
// The page is built the way main.js builds it (see live-page.test.mjs).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, eventSources, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as api from '../js/api.js';
import { createLive } from '../js/live.js';
import * as sidebar from '../js/render-sidebar.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const req = (n) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [] });
const streamOf = (id) => `${location.origin}/api/runs/${id}/stream`;
const streamsFor = (id) => eventSources.instances.filter((s) => s.url === streamOf(id));
const frame = (type, id, data = {}) => ({ type, run_id: id, data });
const row = (id, index) => ({ index, name: `${id}#${index}`, endpoint: 'search', status: 200, passed: true, assertions: [] });
const pill = () => byId('results-summary').querySelector('.pill');

function makeServer() {
  const server = {
    status: { running: false, budget_balance: 1500 },
    history: [],
    reports: new Map(),
    catalog: {
      collections: [{ id: 'search-basics', name: 'Search basics', requests: [req(1), req(2)] }],
      endpoints: [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }],
      target: 'pokesearch',
    },
    scripted: new Map(),
    next: 1,
    begin(mode = 'functional') {
      const id = `run-${server.next}`;
      server.next += 1;
      server.reports.set(id, {
        id, mode, status: 'running', started_at: '2026-11-17T12:00:00Z', config: {}, entries: [{ index: 0, name: 'Request 1' }],
        functional: { total: 1, results: [] },
      });
      server.status = { ...server.status, running: true, run_id: id, mode, started_at: '2026-11-17T12:00:00Z' };
      return id;
    },
    end(status = 'completed') {
      const id = server.status.run_id;
      const rep = server.reports.get(id);
      rep.status = status;
      rep.duration_ms = 1200;
      server.history.unshift({ id, mode: rep.mode, status, started_at: rep.started_at, duration_ms: 1200, summary: 'done' });
      server.status = { running: false, budget_balance: server.status.budget_balance };
      return id;
    },
    once(key, spec) {
      if (!server.scripted.has(key)) server.scripted.set(key, []);
      server.scripted.get(key).push(typeof spec === 'function' ? spec : () => spec);
    },
    later(key) {
      let settle;
      const answer = new Promise((resolve) => { settle = resolve; });
      server.once(key, () => answer);
      return settle;
    },
  };
  const route = (url, method, answer) => {
    fetchStub.serve(url, async (call) => {
      const key = `${method} ${typeof url === 'string' ? url : call.url}`;
      const first = server.scripted.get(key);
      if (first && first.length > 0) return first.shift()(call);
      return answer(call);
    }, { method });
  };
  const idOf = (call) => decodeURIComponent(call.url.split('/')[3]);
  route('/api/collections', 'GET', () => ({ status: 200, body: server.catalog }));
  route('/api/status', 'GET', () => ({ status: 200, body: server.status }));
  route('/api/runs', 'GET', () => ({ status: 200, body: { runs: server.history } }));
  route('/api/runs', 'POST', () => {
    if (server.status.running) return { status: 409, body: { error: 'busy', run_id: server.status.run_id } };
    return { status: 202, body: { run_id: server.begin() } };
  });
  route(/^\/api\/runs\/[^/]+$/, 'GET', (call) => {
    const rep = server.reports.get(idOf(call));
    return rep ? { status: 200, body: JSON.parse(JSON.stringify(rep)) } : { status: 404, body: { error: 'no run' } };
  });
  route(/^\/api\/runs\/[^/]+$/, 'DELETE', (call) => {
    if (!server.status.running || server.status.run_id !== idOf(call)) return { status: 404, body: { error: 'not running' } };
    return { status: 204 };
  });
  route('/api/send', 'POST', () => ({ status: 200, body: { status: 200, passed: true, latency_ms: 1, size_bytes: 2, body: '{}', assertions: [] } }));
  return server;
}

let unsubscribe = null;
let page = null;

async function bootPage(t, server, { before } = {}) {
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
  if (before) before();
  await page.boot();
  await flush();
  return server;
}

const tick = async (t, ms, by = 500) => {
  for (let left = ms; left > 0; left -= by) {
    t.mock.timers.tick(Math.min(by, left));
    await flush(2);
  }
};

function fresh(t) {
  if (t) t.mock.timers.reset();
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  if (page) page.stop();
  page = null;
  resetBrowser();
  resetState();
}

let renderErrors = [];

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  renderErrors = [];
  // The store logs a render module that threw and carries on; that is a
  // broken page all the same.
  t.mock.method(console, 'error', (...args) => { renderErrors.push(args.map(String).join(' ')); });
  fresh();
});

afterEach(() => {
  fresh();
  api.onRunStarted(() => {});
});

const words = (node) => node.textContent;
const untrue = /undefined|null|NaN|\[object Object\]/;

const verdict = () => byId('results-summary').querySelector('.run-verdict');
const failedRow = (id, index) => ({ ...row(id, index), passed: false, assertions: [{ assertion: { type: 'status', op: 'eq', value: 201 }, passed: false, expected: '201', actual: '200' }] });

// finishWith ends the server's live run with these rows and that verdict on
// its report.
function finishWith(server, rows, verdictWord) {
  const id = server.status.run_id;
  const rep = server.reports.get(id);
  rep.functional.results = rows;
  if (verdictWord) rep.functional.verdict = verdictWord;
  server.end('completed');
  return id;
}

test('a failing functional run says FAIL whether it was streamed, polled or opened from history', async (t) => {
  // Streamed.
  let server = makeServer();
  let id = server.begin();
  await bootPage(t, server);
  let stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 2 }));
  stream.emit('request_result', frame('request_result', id, row(id, 0)));
  assert.ok(verdict() === null, 'nothing while running');
  stream.emit('request_result', frame('request_result', id, failedRow(id, 1)));
  finishWith(server, [row(id, 0), failedRow(id, 1)], 'FAIL');
  stream.emit('run_finished', frame('run_finished', id, { status: 'completed', duration_ms: 1200, verdict: 'FAIL' }));
  await flush();
  assert.equal(verdict().textContent, 'FAIL', 'streamed');

  // Polled: the stream fails before it delivers anything.
  fresh(t);
  server = makeServer();
  id = server.begin();
  await bootPage(t, server);
  streamsFor(id)[0].fail();
  await tick(t, 1000, 500);
  assert.equal(get().transport, 'polling');
  assert.ok(verdict() === null, 'nothing while polling a running run');
  finishWith(server, [row(id, 0), failedRow(id, 1)], 'FAIL');
  await tick(t, 1000, 500);
  assert.equal(get().outcome.verdict, 'FAIL', 'the polled terminal event carries the functional verdict');
  assert.equal(verdict().textContent, 'FAIL', 'polled');

  // Polled, and the finished report then fails to load: the event's verdict stands.
  fresh(t);
  server = makeServer();
  id = server.begin();
  await bootPage(t, server);
  streamsFor(id)[0].fail();
  await tick(t, 1000, 500);
  finishWith(server, [row(id, 0), failedRow(id, 1)], 'FAIL');
  server.once(`GET /api/runs/${id}`, (call) => ({ status: 200, body: JSON.parse(JSON.stringify(server.reports.get(id))) }));
  server.once(`GET /api/runs/${id}`, { status: 503, body: { error: 'later' } });
  await tick(t, 1000, 500);
  assert.equal(get().report, null);
  assert.equal(verdict().textContent, 'FAIL', 'polled, report lost');

  // Opened from history.
  fresh(t);
  server = makeServer();
  id = server.begin();
  finishWith(server, [row(id, 0), failedRow(id, 1)], 'FAIL');
  await bootPage(t, server);
  byId('history-list').querySelector('button').click();
  await flush();
  assert.equal(get().report.id, id);
  assert.equal(verdict().textContent, 'FAIL', 'opened from history');
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});

test('a new run shows no verdict, not even the last run\'s, until it ends', async (t) => {
  const server = makeServer();
  const first = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(first)[0];
  stream.emit('run_started', frame('run_started', first, { mode: 'functional', total: 1 }));
  stream.emit('request_result', frame('request_result', first, failedRow(first, 0)));
  finishWith(server, [failedRow(first, 0)], 'FAIL');
  stream.emit('run_finished', frame('run_finished', first, { status: 'completed', duration_ms: 1200, verdict: 'FAIL' }));
  await flush();
  assert.equal(verdict().textContent, 'FAIL');

  runner.add(req(1));
  byId('start-run').click();
  await flush();
  const second = server.status.run_id;
  assert.notEqual(second, first);
  assert.equal(get().run.id, second);
  assert.ok(verdict() === null, 'the first paint of the new run');
  const next = streamsFor(second)[0];
  next.emit('run_started', frame('run_started', second, { mode: 'functional', total: 1 }));
  next.emit('request_result', frame('request_result', second, row(second, 0)));
  assert.ok(verdict() === null, 'its rows');
  finishWith(server, [row(second, 0)], 'PASS');
  next.emit('run_finished', frame('run_finished', second, { status: 'completed', duration_ms: 1200, verdict: 'PASS' }));
  await flush();
  assert.equal(verdict().textContent, 'PASS');
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});
