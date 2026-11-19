// An answer is read item by item before any of it is trusted: one entry of
// the wrong shape makes the whole answer unusable, the same failed read a body
// that is not JSON is, and what the page held stays. The answers the Go server
// really writes, nulls for empty lists included, are still taken.
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

// ------------------------------------------------------------------ status

test('a status poll whose fields are not what a status carries keeps the status the page holds', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  const held = get().status;
  for (const body of [
    { running: true, run_id: 5 },
    { running: true, run_id: { id: 'x' } },
    { running: false, budget_balance: 'lots' },
    { running: false, budget_balance: 1500, cooldown_until: 42 },
    { running: true, run_id: 'run-x', mode: ['functional'] },
    { running: true, run_id: 'run-x', started_at: {} },
  ]) {
    server.once('GET /api/status', { status: 200, body });
    await tick(t, 3000, 1000);
    assert.ok(get().status === held, `status kept over ${JSON.stringify(body)}`);
  }
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ catalog

test('a catalog with one request or endpoint of the wrong shape is a catalog that did not load, and Retry brings it back', async (t) => {
  const bad = [
    { collections: [{ id: 'x', name: 'X', requests: [null] }], endpoints: [] },
    { collections: [{ id: 'x', name: 'X', requests: [req(1), 42] }], endpoints: [] },
    { collections: [{ id: 'x', name: 'X', requests: [{ ...req(1), id: 7 }] }], endpoints: [] },
    { collections: [{ id: 'x', name: 'X', requests: [{ ...req(1), assertions: 'none' }] }], endpoints: [] },
    { collections: [{ id: 'x', requests: [req(1)] }], endpoints: [] },
    { collections: [{ id: 'x', name: 'X', requests: [req(1)] }], endpoints: [null] },
    { collections: [{ id: 'x', name: 'X', requests: [req(1)] }], endpoints: [{ id: 'search', params: 'q' }] },
    { collections: [{ id: 'x', name: 'X', requests: [req(1)] }], endpoints: 'none' },
  ];
  for (const body of bad) {
    fresh(t);
    const server = makeServer();
    await bootPage(t, server, { before: () => server.once('GET /api/collections', { status: 200, body }) });
    const tree = byId('collections-tree');
    assert.match(tree.textContent, /Could not load collections from the server\./, JSON.stringify(body));
    assert.equal(get().collections.length, 0, JSON.stringify(body));
    const retry = [...tree.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    retry.click();
    await flush();
    assert.match(tree.textContent, /Search basics/, JSON.stringify(body));
    assert.deepEqual(renderErrors, [], JSON.stringify(body));
    assert.deepEqual(listenerErrors, [], JSON.stringify(body));
  }
});

// ------------------------------------------------------------------ history

test('a history list with one entry that is not a run keeps the list the page holds', async (t) => {
  const server = makeServer();
  server.begin();
  server.end();
  await bootPage(t, server);
  const held = get().history;
  assert.equal(held.length, 1);
  const good = held[0];
  for (const runs of [[good, null], [good, { ...good, id: 9 }], [good, { ...good, status: undefined }], [{ ...good, summary: 3 }]]) {
    server.once('GET /api/runs', { status: 200, body: { runs } });
    await page.hooks.runner.refresh();
    await flush();
    assert.ok(get().history === held, `history kept over ${JSON.stringify(runs)}`);
    assert.equal(byId('history-list').querySelectorAll('button').length, 1);
  }
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});

test('a history entry whose report holds a row that is not a row says it could not be opened', async (t) => {
  for (const functional of [{ results: 'none' }, { results: [null] }, { results: [{ index: 0, assertions: 'x' }] }, 'x']) {
    fresh(t);
    const server = makeServer();
    const old = server.begin();
    server.end();
    await bootPage(t, server);
    server.once(`GET /api/runs/${old}`, { status: 200, body: { id: old, mode: 'functional', status: 'completed', entries: [], functional } });
    byId('history-list').querySelector('button').click();
    await flush();
    assert.equal(get().run, null, JSON.stringify(functional));
    assert.equal(byId('history-list').querySelector('.note').textContent, 'Could not open that run - Courier could not be reached.');
    assert.deepEqual(renderErrors, [], JSON.stringify(functional));
    assert.deepEqual(listenerErrors, [], JSON.stringify(functional));
  }
});

// ------------------------------------------------------------------ the finished report

test('a finished report whose status is not an ended state, or whose rows are not rows, reads as a report that could not be loaded', async (t) => {
  const bodies = (id) => [
    { id, mode: 'functional', status: 'done', entries: [], functional: { results: [] } },
    { id, mode: 'functional', status: 7, entries: [], functional: { results: [] } },
    { id, mode: 'functional', status: 'completed', entries: 'x', functional: { results: [] } },
    { id, mode: 'functional', status: 'completed', entries: [], functional: { results: [{ index: 0, assertions: 'x' }] } },
    { id, mode: 'functional', status: 'completed', entries: [], functional: { results: [42] } },
  ];
  for (let n = 0; n < bodies('').length; n += 1) {
    fresh(t);
    const server = makeServer();
    const id = server.begin();
    await bootPage(t, server);
    const body = bodies(id)[n];
    server.once(`GET /api/runs/${id}`, { status: 200, body });
    const stream = streamsFor(id)[0];
    stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));
    stream.emit('request_result', frame('request_result', id, row(id, 0)));
    server.end('completed');
    stream.emit('run_finished', frame('run_finished', id, { status: 'completed', duration_ms: 1200 }));
    await flush();
    assert.equal(get().report, null, JSON.stringify(body));
    assert.equal(pill().textContent, 'completed', JSON.stringify(body));
    assert.match(byId('results-summary').textContent, /The finished report could not be loaded/, JSON.stringify(body));
    assert.equal(byId('results-rows').querySelectorAll('.res-row').length, 1, 'the streamed row stays');
    assert.deepEqual(renderErrors, [], JSON.stringify(body));
    assert.deepEqual(listenerErrors, [], JSON.stringify(body));
  }
});

// ------------------------------------------------------------------ the polling fallback and the probe

test('the polling fallback skips a report whose rows are not rows and goes on polling', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  for (const results of ['x', [null], [{ index: 0, assertions: 'x' }]]) {
    server.once(`GET /api/runs/${id}`, { status: 200, body: { id, mode: 'functional', status: 'completed', entries: [], functional: { results } } });
  }
  server.once(`GET /api/runs/${id}`, { status: 200, body: { id, mode: 'functional', status: 'sideways', entries: [], functional: { results: [] } } });
  streamsFor(id)[0].fail();
  await tick(t, 2000, 500);
  assert.equal(get().transport, 'polling');
  assert.equal(get().outcome, null, 'nothing ended the run');
  assert.equal(get().results.length, 0, 'no row of the wrong shape was taken');
  server.reports.get(id).functional.results = [row(id, 0)];
  server.end('completed');
  await tick(t, 2000, 500);
  assert.equal(get().outcome.status, 'completed', 'the first real report is read');
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ Send

test('a Send result whose outcomes are not outcomes is the network outcome', async () => {
  for (const body of [
    { status: 200, passed: true, assertions: 'none' },
    { status: 200, passed: true, assertions: [null] },
    { status: 200, passed: 'yes', assertions: [] },
    { status: '200', passed: true, assertions: [] },
  ]) {
    fetchStub.respond('/api/send', { status: 200, body }, { method: 'POST' });
    const res = await api.send({ id: 'r1', endpoint: 'search' });
    assert.equal(res.ok, false, JSON.stringify(body));
    assert.equal(res.kind, 'network', JSON.stringify(body));
  }
});

// ------------------------------------------------------------------ what Courier really sends

test('the answers the Go server writes are still taken: no run, nulls for empty lists, a Send that got no response', async (t) => {
  fetchStub.respond('/api/send', { status: 200, body: {
    endpoint: 'search', query: '?q=x', status: 0, latency_ms: 0, size_bytes: 0, body: '', body_truncated: false,
    assertions: [{ assertion: { type: 'status', op: 'eq', value: 200 }, passed: false, expected: '200', actual: 'no response' }],
    passed: false, error: 'The target did not answer in time.', error_kind: 'timeout',
  } }, { method: 'POST' });
  const sent = await api.send({ id: 'r1', endpoint: 'search' });
  assert.equal(sent.ok, true);
  fetchStub.respond('/api/send', { status: 200, body: { status: 200, passed: true, assertions: null, body: '{}' } }, { method: 'POST' });
  assert.equal((await api.send({ id: 'r1', endpoint: 'search' })).ok, true, 'a Send with no assertions answers null for them');

  const server = makeServer();
  server.catalog.endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: null }];
  server.catalog.collections[0].description = 'Two searches';
  const old = server.begin();
  server.end('cancelled');
  server.status = { running: false, budget_balance: -12.5, cooldown_until: '2026-11-17T12:00:05Z' };
  await bootPage(t, server);
  assert.equal(get().collections.length, 1, 'catalog taken');
  assert.equal(get().status.budget_balance, -12.5, 'status taken');
  assert.equal(get().history.length, 1, 'history taken');
  server.once(`GET /api/runs/${old}`, { status: 200, body: {
    id: old, mode: 'functional', status: 'cancelled', started_at: '2026-11-17T12:00:00Z', duration_ms: 10, target: 'pokesearch',
    config: { stop_on_failure: false, delay_ms: 0, concurrency: 0, duration_secs: 0 }, entries: null, functional: { results: null, verdict: 'N/A' }, note: '',
  } });
  byId('history-list').querySelector('button').click();
  await flush();
  assert.equal(get().report && get().report.id, old, 'a report with null lists is opened');

  const id = server.begin();
  await tick(t, 3000);
  page.hooks.runner.watch();
  await flush();
  server.reports.get(id).functional.results = null;
  server.reports.get(id).entries = null;
  streamsFor(id)[0].fail();
  await tick(t, 1000, 500);
  assert.equal(get().run.id, id);
  server.end('completed');
  await tick(t, 1000, 500);
  assert.equal(get().report && get().report.id, id, 'a polled report with null lists is read and finishes the run');
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ focus on a history entry

test('focus on a history entry survives the status poll that rebuilds the list', async (t) => {
  const server = makeServer();
  const first = server.begin();
  server.end();
  const second = server.begin();
  server.end();
  await bootPage(t, server);
  const entry = (id) => [...byId('history-list').querySelectorAll('button')].find((b) => b.dataset.focusKey === `history:${id}`);
  assert.ok(entry(first) && entry(second), 'each entry carries its run id as its focus key');
  entry(first).focus();
  for (let i = 0; i < 3; i += 1) {
    server.status = { running: false, budget_balance: 1400 - i };
    await tick(t, 3000, 1000);
    await page.hooks.runner.refresh();
    await flush();
  }
  assert.ok(document.activeElement === entry(first), 'focus is on the same entry after the polls');
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ the stream

test('a streamed row that is not a row is dropped and the rows around it are drawn', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 3 }));
  stream.emit('request_result', frame('request_result', id, row(id, 0)));
  for (const data of [null, 42, { index: 1, assertions: 'x' }, { index: 1, status: '200' }]) {
    stream.emit('request_result', frame('request_result', id, data));
  }
  stream.emit('request_result', frame('request_result', id, row(id, 2)));
  await flush();
  assert.equal(get().results.length, 2);
  assert.equal(byId('results-rows').querySelectorAll('.res-row').length, 2);
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(listenerErrors, []);
});
