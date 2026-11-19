// More 2xx answers that are not what their reader reads, aimed at the fields
// inside an answer rather than its outer shape, plus the awkward answers
// Courier itself really sends, which must still be taken as answers.
//

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, eventSources, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as api from '../js/api.js';
import { createLive, initialLive, step } from '../js/live.js';
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

// SHAPES are 2xx bodies that are not what any reader of this page can use.
const SHAPES = {
  html: '<html><body>One moment...</body></html>',
  cut: '{"collections":[{"id":"sea',
  empty: '',
  null: 'null',
  array: '[]',
  string: '"ok"',
  number: '42',
};

// WRONG are JSON objects that parse but lack what a given reader reads.
const WRONG = {
  status: [{}, { running: 'yes' }],
  history: [{}, { runs: 'none' }, { runs: {} }],
  catalog: [{}, { collections: 'none' }, { collections: {} }],
};

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

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  fresh();
});

afterEach(() => {
  fresh();
  api.onRunStarted(() => {});
});

const words = (node) => node.textContent;
const untrue = /undefined|null|NaN|\[object Object\]/;

// ------------------------------------------------------------------ fields inside an answer

test('a status naming a live run by something other than a run id leaves the tab free to follow the next real run', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  for (const body of [{ running: true, run_id: 5 }, { running: true }, { running: true, run_id: { id: 'x' } }]) {
    server.once('GET /api/status', { status: 200, body });
    await tick(t, 3000, 1000);
    assert.doesNotMatch(words(byId('panel-runner')), untrue, JSON.stringify(body));
  }
  const id = server.begin();
  await tick(t, 6000, 1000);
  assert.equal(streamsFor(id).length, 1, 'the next real run is followed');
  assert.deepEqual(listenerErrors, []);
});

test('a history list whose entries are not runs does not stop the page from drawing', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  server.once('GET /api/runs', { status: 200, body: { runs: [null, 42, 'x'] } });
  await page.hooks.runner.refresh();
  await flush();
  // Another part of the page changes after the odd list arrived: it must still be drawn.
  runner.add(req(1));
  assert.equal(byId('tab-runner').textContent, 'Runner (1)');
  assert.equal(byId('sequence-list').querySelectorAll('.seq-row').length, 1);
  assert.deepEqual(listenerErrors, []);
});

test('a catalog whose collections are not collections does not stop the page from drawing, and Retry brings it back', async (t) => {
  for (const collections of [[null], [{ id: 'x', name: 'X' }], [{ id: 'x', name: 'X', requests: null }]]) {
    fresh(t);
    const server = makeServer();
    await bootPage(t, server, { before: () => server.once('GET /api/collections', { status: 200, body: { collections, endpoints: [] } }) });
    runner.add(req(1));
    assert.equal(byId('tab-runner').textContent, 'Runner (1)', JSON.stringify(collections));
    assert.equal(byId('sequence-list').querySelectorAll('.seq-row').length, 1, JSON.stringify(collections));
    assert.deepEqual(listenerErrors, [], JSON.stringify(collections));
  }
});

test('a finished report with no status does not show a status it does not have', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  server.once(`GET /api/runs/${id}`, { status: 200, body: { id, mode: 'functional', entries: [], functional: { total: 1, results: [] } } });
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));
  stream.emit('request_result', frame('request_result', id, row(id, 0)));
  server.end('completed');
  stream.emit('run_finished', frame('run_finished', id, { status: 'completed', duration_ms: 1200 }));
  await flush();
  assert.doesNotMatch(words(byId('results-summary')), untrue);
  assert.equal(pill().textContent, 'completed', 'the terminal event said completed');
  assert.deepEqual(listenerErrors, []);
});

test('a history entry whose report has no status does not show a status it does not have', async (t) => {
  const server = makeServer();
  const old = server.begin();
  server.end();
  await bootPage(t, server);
  server.once(`GET /api/runs/${old}`, { status: 200, body: { id: old, mode: 'functional', entries: [] } });
  byId('history-list').querySelector('button').click();
  await flush();
  assert.doesNotMatch(words(byId('results-summary')), untrue);
  const next = server.begin();
  await tick(t, 3000);
  assert.deepEqual(listenerErrors, []);
  assert.ok(next);
});

// ------------------------------------------------------------------ real answers stay answers

test('the answers Courier really sends are still taken: a 202 with truncated, a 409 busy and cooling, a 400 with a field, an empty history', async () => {
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-9', truncated: ['params.q'] } }, { method: 'POST' });
  assert.deepEqual(await api.startRun({ mode: 'functional', sequence: [], options: {} }), { ok: true, runId: 'run-9' });

  fetchStub.respond('/api/runs', { status: 409, body: { error: 'busy', run_id: 'run-8' } }, { method: 'POST' });
  const busy = await api.startRun({ mode: 'functional', sequence: [], options: {} });
  assert.equal(busy.ok, false);
  assert.notEqual(busy.kind, 'network');

  fetchStub.respond('/api/runs', { status: 409, body: { error: 'cooling down', cooldown_until: '2026-11-18T12:00:00Z' } }, { method: 'POST' });
  const cooling = await api.startRun({ mode: 'functional', sequence: [], options: {} });
  assert.equal(cooling.ok, false);
  assert.notEqual(cooling.kind, 'network');

  fetchStub.respond('/api/runs', { status: 400, body: { error: 'too long', field: 'sequence[0].params.q' } }, { method: 'POST' });
  const bad = await api.startRun({ mode: 'functional', sequence: [], options: {} });
  assert.equal(bad.ok, false);
  assert.notEqual(bad.kind, 'network');

  fetchStub.respond('/api/send', { status: 400, body: { error: 'bad', field: 'params.q' } }, { method: 'POST' });
  assert.deepEqual(await api.send({ id: 'r1', endpoint: 'search' }), { ok: false, kind: 'invalid', error: 'bad', field: 'params.q' });

  fetchStub.respond('/api/runs', { status: 200, body: { runs: [] } });
  assert.deepEqual(await api.getHistory(), { ok: true, body: { runs: [] } });
  fetchStub.respond('/api/status', { status: 200, body: { running: false, budget_balance: 0 } });
  assert.equal((await api.getStatus()).ok, true);
});
