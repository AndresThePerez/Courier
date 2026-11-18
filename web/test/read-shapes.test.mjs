// A 2xx answer is not an answer unless its body is the JSON the reader needs.
// A proxy's holding page, a body cut short that the browser reports as
// complete, a JSON null or an object of the wrong shape: each must read as a
// read that failed, so the notices, Retry and recovery paths that already
// exist for a refused connection apply, and no state is left waiting on an
// answer that has in fact arrived.
//
// The page is built the way main.js builds it (see live-page.test.mjs).

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

// ------------------------------------------------------------------ api.js

test('every read answered 2xx with a body that is not a JSON object is the network outcome, decided in api.js', async () => {
  const reads = {
    '/api/collections': api.getCollections,
    '/api/status': api.getStatus,
    '/api/runs': api.getHistory,
    '/api/runs/r1': () => api.getRun('r1'),
  };
  for (const [url, read] of Object.entries(reads)) {
    for (const [how, body] of Object.entries(SHAPES)) {
      fetchStub.respond(url, { status: 200, body });
      const res = await read();
      assert.equal(res.ok, false, `${url} ${how}`);
      assert.equal(res.kind, 'network', `${url} ${how}`);
      assert.equal(res.error, 'Could not reach Courier', `${url} ${how}`);
    }
    fetchStub.respond(url, { status: 200, body: { runs: [] } });
    assert.equal((await read()).ok, true, `${url}: an object is an answer`);
  }
});

test('Send answered 2xx with a body that is not a JSON object is the network outcome, not an empty result', async () => {
  for (const [how, body] of [...Object.entries(SHAPES), ['no status', {}], ['text status', { status: '200' }]]) {
    fetchStub.respond('/api/send', { status: 200, body }, { method: 'POST' });
    const res = await api.send({ id: 'r1', endpoint: 'search' });
    assert.equal(res.ok, false, how);
    assert.equal(res.kind, 'network', how);
  }
  fetchStub.respond('/api/send', { status: 200, body: { status: 0, error: 'connection refused' } }, { method: 'POST' });
  assert.equal((await api.send({ id: 'r1', endpoint: 'search' })).ok, true, 'status 0 is the target not answering, and is an answer');
});

test('a 202 to Start whose body names no run is the network outcome; Cancel\'s empty 204 is still a cancel', async () => {
  for (const body of [...Object.values(SHAPES), {}, { run_id: '' }, { run_id: 7 }]) {
    fetchStub.respond('/api/runs', { status: 202, body }, { method: 'POST' });
    const res = await api.startRun({ mode: 'functional', sequence: [], options: {} });
    assert.equal(res.ok, false, JSON.stringify(body));
    assert.equal(res.kind, 'network', JSON.stringify(body));
  }
  fetchStub.respond('/api/runs/r1', { status: 204 }, { method: 'DELETE' });
  assert.deepEqual(await api.cancelRun('r1'), { ok: true });
});

// ------------------------------------------------------------------ each reader

test('a status poll answered with anything but a status keeps the status the page holds', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  const held = get().status;
  assert.equal(held.budget_balance, 1500);
  for (const body of [...Object.values(SHAPES), ...WRONG.status]) {
    server.once('GET /api/status', { status: 200, body });
    await tick(t, 3000, 1000);
    assert.equal(get().status, held, `status kept over ${JSON.stringify(body)}`);
    assert.equal(byId('ledger-value').textContent, '1500 w-s', JSON.stringify(body));
  }
  const id = server.begin();
  await tick(t, 3000, 1000);
  assert.equal(streamsFor(id).length, 1, 'the next real status is acted on');
  assert.deepEqual(listenerErrors, []);
});

test('a history list answered with anything but a list of runs keeps the list on screen', async (t) => {
  const server = makeServer();
  server.begin();
  server.end();
  await bootPage(t, server);
  assert.equal(get().history.length, 1);
  for (const body of [...Object.values(SHAPES), ...WRONG.history]) {
    server.once('GET /api/runs', { status: 200, body });
    server.once('GET /api/status', { status: 200, body: server.status });
    await page.hooks.runner.refresh();
    await flush();
    assert.equal(get().history.length, 1, `history kept over ${JSON.stringify(body)}`);
    assert.equal(byId('history-list').querySelectorAll('button').length, 1);
  }
  assert.deepEqual(listenerErrors, []);
});

test('a catalog answered with JSON that is not a catalog says so with a Retry, and Retry brings it back', async (t) => {
  for (const body of [...Object.values(SHAPES), ...WRONG.catalog]) {
    fresh(t);
    const server = makeServer();
    await bootPage(t, server, { before: () => server.once('GET /api/collections', { status: 200, body }) });
    const tree = byId('collections-tree');
    assert.match(tree.textContent, /Could not load collections from the server\./, JSON.stringify(body));
    assert.equal(get().catalogLoading, false);
    const retry = [...tree.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    retry.click();
    await flush();
    assert.match(tree.textContent, /Search basics/, JSON.stringify(body));
    assert.deepEqual(listenerErrors, [], JSON.stringify(body));
  }
});

test('a history entry answered with JSON that is not that run\'s report says so and leaves the tab free to follow the next run', async (t) => {
  for (const body of [...Object.values(SHAPES), {}, { id: 'someone-else', status: 'completed' }, { id: 42 }]) {
    fresh(t);
    const server = makeServer();
    const old = server.begin();
    server.end();
    await bootPage(t, server);
    server.once(`GET /api/runs/${old}`, { status: 200, body });
    byId('history-list').querySelector('button').click();
    await flush();
    assert.equal(get().run, null, JSON.stringify(body));
    assert.equal(byId('history-list').querySelector('.note').textContent, 'Could not open that run - Courier could not be reached.', JSON.stringify(body));
    const next = server.begin();
    await tick(t, 3000);
    assert.equal(streamsFor(next).length, 1, `the next run is followed after ${JSON.stringify(body)}`);
    assert.deepEqual(listenerErrors, [], JSON.stringify(body));
  }
});

test('a finished report answered with JSON that is not that run\'s finished report reads as a report that could not be loaded', async (t) => {
  for (const body of [...Object.values(SHAPES), {}, { id: 'someone-else', status: 'completed' }, { status: 'completed' }]) {
    fresh(t);
    const server = makeServer();
    const id = server.begin();
    await bootPage(t, server);
    server.once(`GET /api/runs/${id}`, { status: 200, body });
    const stream = streamsFor(id)[0];
    stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));
    stream.emit('request_result', frame('request_result', id, row(id, 0)));
    server.end('completed');
    stream.emit('run_finished', frame('run_finished', id, { status: 'completed', duration_ms: 1200 }));
    await flush();
    assert.equal(get().report, null, JSON.stringify(body));
    assert.equal(pill().textContent, 'completed');
    assert.match(byId('results-summary').textContent, /The finished report could not be loaded - open it from History\./, JSON.stringify(body));
    assert.deepEqual(listenerErrors, [], JSON.stringify(body));
  }
});

test('the polling fallback skips an answer that is not this run\'s report and goes on polling', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  for (const body of ['null', '[]', '{}', { id: 'someone-else', status: 'completed' }]) {
    server.once(`GET /api/runs/${id}`, { status: 200, body });
  }
  streamsFor(id)[0].fail();
  await tick(t, 4000, 500);
  assert.equal(get().transport, 'polling');
  assert.equal(get().run.id, id);
  assert.equal(get().outcome, null, 'nothing ended the run');
  assert.equal(get().run.entries.length, 1, 'the real report, once read, says what the run is');
  assert.deepEqual(listenerErrors, []);
});

// The pure rules hold on their own as well: an entry the visitor asked for
// is not left awaited when what arrived for it is not its report.
test('the rules settle an opened entry that carries no usable report', () => {
  for (const rep of [null, undefined, [], 'x', 42, {}, { id: 'b' }]) {
    const opening = { ...initialLive(), opening: 'a' };
    const opened = step(opening, { type: 'opened', run_id: 'a', report: rep }).live;
    assert.equal(opened.opening, '', `opening cleared over ${JSON.stringify(rep)}`);
    assert.equal(opened.run, null);
    assert.equal(opened.report, null);
  }
});

// ------------------------------------------------------------------ Start and Cancel notes

test('a Start answer read after this tab saw that run end never shows the run as in progress, even for a moment', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.add(req(1));
  const answer = server.later('POST /api/runs');
  byId('start-run').click();
  await flush();
  const id = server.begin();
  await tick(t, 3000, 1000);
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));
  server.reports.get(id).functional.results.push(row(id, 0));
  server.end('completed');
  stream.emit('run_finished', frame('run_finished', id, { status: 'completed', duration_ms: 1200 }));
  await flush();
  assert.equal(get().report.id, id);

  const seen = [];
  const stop = subscribe((state) => seen.push(Boolean(state.status && state.status.running)));
  answer({ status: 202, body: { run_id: id } });
  for (let i = 0; i < 8; i += 1) await flush(1);
  stop();
  assert.deepEqual([...new Set(seen)], [false], 'no render ever saw the finished run as running');
  assert.equal(byId('run-status-banner').hidden, true);
  assert.deepEqual(listenerErrors, []);
});

test('a failed Start\'s sentence goes when a run goes live, so a later failed Cancel says one thing', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.add(req(1));
  server.once('POST /api/runs', () => { throw new TypeError('Failed to fetch'); });
  server.once('GET /api/status', () => { throw new TypeError('Failed to fetch'); });
  byId('start-run').click();
  await flush();
  assert.equal(byId('start-note').textContent, 'Could not reach Courier - the run was not started.');

  // Another visitor's run goes live; the poll reports it.
  const id = server.begin();
  await tick(t, 3000, 1000);
  assert.equal(get().status.run_id, id);
  assert.equal(byId('start-note').textContent, '', 'the Start failure is about a run that did not start, and a run is now live');

  server.once(`DELETE /api/runs/${id}`, () => { throw new TypeError('Failed to fetch'); });
  byId('cancel-run').click();
  await flush();
  assert.equal(byId('start-note').textContent, 'Could not reach Courier - the run was not cancelled.');
  assert.deepEqual(listenerErrors, []);
});

test('a history entry that cannot be reached says so in one sentence', async (t) => {
  const server = makeServer();
  const old = server.begin();
  server.end();
  await bootPage(t, server);
  server.once(`GET /api/runs/${old}`, () => { throw new TypeError('Failed to fetch'); });
  byId('history-list').querySelector('button').click();
  await flush();
  assert.equal(byId('history-list').querySelector('.note').textContent, 'Could not open that run - Courier could not be reached.');
});
