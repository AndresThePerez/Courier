// The page as main.js wires it, against a Courier that is a function: which
// run a tab follows, what it shows, and what it asks the server for.
//
// main.js boots on import, so no test loads it. These tests build the page
// from the same parts in the same order: live.js's createLive, the hooks it
// hands the render modules, and a render that asks it to sync.

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
const req = (n) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [{ type: 'status', op: 'eq', value: 200 }] });
const streamOf = (id) => `${location.origin}/api/runs/${id}/stream`;
const streamsFor = (id) => eventSources.instances.filter((s) => s.url === streamOf(id));
const callsTo = (url, method = 'GET') => fetchStub.calls.filter((c) => c.url === url && c.method === method);

// makeServer stands for Courier: every route answers from this object as it
// is when the request arrives, so a test changes the server by changing it.
function makeServer() {
  const server = {
    status: { running: false, budget_balance: 1500 },
    history: [],
    reports: new Map(),
    catalog: {
      collections: [{ id: 'search-basics', name: 'Search basics', requests: [req(1), req(2)] }],
      endpoints: [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] }],
      target: 'pokesearch',
    },
    down: new Set(), // 'GET /api/status', ... or '*': the request fails as the network does
    held: new Map(), // 'GET /api/status' -> a promise the next answer waits for
    next: 1,
    // hold makes the next answer to one route wait until release() is called.
    hold(key) {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      server.held.set(key, gate);
      return release;
    },
    // begin starts a run on the server, as any visitor's Start would.
    begin(mode = 'functional') {
      const id = `run-${server.next}`;
      server.next += 1;
      const started = '2026-11-17T12:00:00Z';
      server.reports.set(id, {
        id, mode, status: 'running', started_at: started, config: {}, entries: [{ index: 0, name: 'Request 1' }],
        ...(mode === 'functional' ? { functional: { total: 1, results: [] } } : { performance: { verdict: 'N/A', per_request: [] } }),
      });
      server.status = { ...server.status, running: true, run_id: id, mode, started_at: started };
      return id;
    },
    // end finishes the live run on the server; the stream's frames are the
    // test's to deliver.
    end(status = 'completed') {
      const id = server.status.run_id;
      const rep = server.reports.get(id);
      rep.status = status;
      rep.duration_ms = 1200;
      rep.finished_at = '2026-11-17T12:00:02Z';
      if (rep.functional) rep.functional.verdict = status === 'completed' ? 'PASS' : 'N/A';
      server.history.unshift({ id, mode: rep.mode, status, started_at: rep.started_at, duration_ms: 1200, summary: 'done' });
      server.status = { running: false, budget_balance: server.status.budget_balance };
      return id;
    },
  };

  const route = (url, method, answer) => {
    fetchStub.serve(url, async (call) => {
      const key = `${method} ${typeof url === 'string' ? url : call.url}`;
      const gate = server.held.get(key);
      if (gate) {
        server.held.delete(key);
        await gate;
      }
      if (server.down.has('*') || server.down.has(key)) throw new TypeError('Failed to fetch');
      return answer(call);
    }, { method });
  };
  const idOf = (call) => decodeURIComponent(call.url.split('/')[3]);

  route('/api/collections', 'GET', () => ({ status: 200, body: server.catalog }));
  route('/api/status', 'GET', () => ({ status: 200, body: server.status }));
  route('/api/runs', 'GET', () => ({ status: 200, body: { runs: server.history } }));
  route('/api/runs', 'POST', (call) => {
    if (server.status.running) return { status: 409, body: { error: 'busy', run_id: server.status.run_id } };
    return { status: 202, body: { run_id: server.begin(call.json().mode) } };
  });
  route(/^\/api\/runs\/[^/]+$/, 'GET', (call) => {
    const rep = server.reports.get(idOf(call));
    return rep ? { status: 200, body: rep } : { status: 404, body: { error: `no run "${idOf(call)}"` } };
  });
  route(/^\/api\/runs\/[^/]+$/, 'DELETE', (call) => {
    if (!server.status.running || server.status.run_id !== idOf(call)) return { status: 404, body: { error: 'not running' } };
    return { status: 204 };
  });
  route('/api/send', 'POST', () => ({ status: 200, body: { status: 200, passed: true, latency_ms: 12, size_bytes: 2, body: '{}', assertions: [] } }));
  return server;
}

let unsubscribe = null;

// bootPage builds the page the way main.js does, minus the tab strip, and
// boots it against server.
async function bootPage(t, server) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const showTab = (name) => set({ activeTab: name });
  const page = createLive({ api, get, set, showTab });
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
  return { page, server };
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  api.onRunStarted(() => {});
});

const frame = (type, id, data = {}) => ({ type, run_id: id, data });

test('a tab that loads while a run is live attaches to it by itself', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);

  assert.equal(streamsFor(id).length, 1);
  assert.equal(get().transport, 'sse');
  streamsFor(id)[0].emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));
  assert.equal(get().run.id, id);
  assert.equal(get().activeTab, 'runner', 'nobody else\'s run moves this tab');
  assert.deepEqual(listenerErrors, []);
});

test('the tab that pressed Start attaches to its run and moves to the Results tab', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.add(req(1));

  byId('start-run').click();
  await flush();

  const id = server.status.run_id;
  assert.ok(id, 'the server started a run');
  assert.equal(streamsFor(id).length, 1);
  assert.equal(get().activeTab, 'results');
  assert.equal(byId('start-run').textContent, 'Start run');
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ Courier cannot be reached

const UNREACHABLE = {
  send: 'Could not reach Courier - check the connection and try again.',
  start: 'Could not reach Courier - the run was not started.',
  cancel: 'Could not reach Courier - the run was not cancelled.',
  catalog: 'Could not load collections from the server.',
};

function openRequest() {
  [...byId('collections-tree').querySelectorAll('button')].find((b) => b.classList.contains('req-open')).click();
}

test('a Send that cannot reach Courier says so and gives Send back', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  openRequest();
  server.down.add('POST /api/send');

  byId('send-request').click();
  assert.equal(byId('send-request').disabled, true, 'busy while the request is out');
  await flush();

  assert.equal(byId('send-request').disabled, false);
  assert.equal(byId('send-status').textContent, UNREACHABLE.send);
  assert.deepEqual(listenerErrors, []);

  // And the next Send goes out.
  server.down.clear();
  byId('send-request').click();
  await flush();
  assert.equal(callsTo('/api/send', 'POST').length, 2);
  assert.match(byId('send-status').textContent, /^200 - /);
});

test('a Start that cannot reach Courier says so and gives Start back', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.add(req(1));
  server.down.add('*');

  byId('start-run').click();
  assert.equal(byId('start-run').textContent, 'Starting...');
  await flush();

  assert.equal(byId('start-run').textContent, 'Start run');
  assert.equal(byId('start-run').disabled, false);
  assert.equal(byId('start-note').hidden, false);
  assert.equal(byId('start-note').textContent, UNREACHABLE.start);
  assert.equal(eventSources.opened, 0, 'no run, so nothing to follow');
  assert.deepEqual(listenerErrors, []);

  server.down.clear();
  byId('start-run').click();
  await flush();
  assert.equal(streamsFor(server.status.run_id).length, 1, 'the next Start starts a run');
  assert.equal(byId('start-note').textContent, '');
});

test('a Cancel that cannot reach Courier says so and gives Cancel back', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  assert.equal(byId('cancel-run').hidden, false);
  server.down.add(`DELETE /api/runs/${id}`);

  byId('cancel-run').click();
  assert.equal(byId('cancel-run').disabled, true);
  await flush();

  assert.equal(byId('cancel-run').hidden, false);
  assert.equal(byId('cancel-run').disabled, false);
  assert.equal(byId('start-note').hidden, false);
  assert.equal(byId('start-note').textContent, UNREACHABLE.cancel);
  assert.deepEqual(listenerErrors, []);

  server.down.clear();
  byId('cancel-run').click();
  await flush();
  assert.equal(callsTo(`/api/runs/${id}`, 'DELETE').length, 2);
  assert.equal(byId('start-note').textContent, '', 'a cancel that landed leaves no note');
});

test('Cancel pressed while Start is out: each control comes back with its own outcome', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  runner.add(req(1));
  // This tab still believes nothing is running, so Start is live; the server knows better.
  set({ status: { running: false, budget_balance: 1500 } });
  const releaseStart = server.hold('POST /api/runs');
  byId('start-run').click();
  await flush();
  assert.equal(byId('start-run').textContent, 'Starting...');

  set({ status: { ...server.status } });
  server.down.add(`DELETE /api/runs/${id}`);
  byId('cancel-run').click();
  await flush();
  assert.equal(byId('cancel-run').disabled, false);
  assert.match(byId('start-note').textContent, /Could not reach Courier - the run was not cancelled\./);
  assert.equal(byId('start-run').textContent, 'Starting...', 'Start is still out');

  releaseStart();
  await flush();
  assert.equal(byId('start-run').textContent, 'Start run');
  assert.deepEqual(listenerErrors, []);
});

test('a catalog that cannot be loaded says so with a Retry, and never claims to be loading', async (t) => {
  const server = makeServer();
  server.down.add('GET /api/collections');
  await bootPage(t, server);

  const tree = byId('collections-tree');
  const retry = () => [...tree.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
  assert.match(tree.textContent, /Could not load collections from the server\./);
  assert.doesNotMatch(tree.textContent, /Loading collections/);
  assert.ok(retry(), 'a Retry button is offered');

  // A second failure: same notice, still no "Loading".
  retry().click();
  assert.doesNotMatch(tree.textContent, /Loading collections/, 'not while the retry is out either');
  await flush();
  assert.match(tree.textContent, /Could not load collections from the server\./);
  assert.equal(retry().disabled, false);
  assert.equal(callsTo('/api/collections').length, 2);

  // The notice survives the renders a status poll causes.
  t.mock.timers.tick(3000);
  await flush();
  assert.match(tree.textContent, /Could not load collections from the server\./);
  assert.ok(retry());

  server.down.clear();
  retry().click();
  await flush();
  assert.equal(callsTo('/api/collections').length, 3);
  assert.doesNotMatch(tree.textContent, /Could not load/);
  assert.equal(tree.querySelectorAll('details').length, 1, 'the collections are listed');
  assert.equal(get().notice, null);
  assert.deepEqual(listenerErrors, []);
});

test('the catalog notice and Retry are drawn whatever the saved collections are', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  const tree = byId('collections-tree');
  assert.equal(tree.querySelectorAll('details').length, 1);

  // Only the notice changes: the saved list, which the sidebar redraws only
  // when it changes, is the same array throughout.
  const saved = get().savedCollections;
  set({ collections: [], notice: UNREACHABLE.catalog });
  assert.equal(get().savedCollections, saved);
  assert.match(tree.textContent, /Could not load collections from the server\./);
  assert.ok([...tree.querySelectorAll('button')].some((b) => b.textContent === 'Retry'));
  set({ notice: null });
  assert.equal(tree.textContent, 'Loading collections...');
});

test('a page that cannot reach Courier at load still boots, and catches up when it can', async (t) => {
  const server = makeServer();
  server.down.add('*');
  await bootPage(t, server);
  assert.equal(get().status, null);
  assert.deepEqual(get().history, []);
  assert.deepEqual(listenerErrors, []);

  server.down.clear();
  const id = server.begin();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(get().status.run_id, id);
  assert.equal(streamsFor(id).length, 1);
});

test('a history entry that cannot be fetched says so and leaves the view as it was', async (t) => {
  const server = makeServer();
  const id = server.begin();
  server.end();
  await bootPage(t, server);
  const row = () => byId('history-list').querySelector('button');

  server.down.add(`GET /api/runs/${id}`);
  row().click();
  await flush();
  assert.equal(get().report, null);
  assert.equal(get().run, null);
  assert.match(byId('history-list').textContent, /Could not open that run - Could not reach Courier\./);
  assert.deepEqual(listenerErrors, []);

  server.down.clear();
  row().click();
  await flush();
  assert.equal(get().report.id, id);
  assert.doesNotMatch(byId('history-list').textContent, /Could not open/);

  // A run the server no longer stores says that instead.
  server.reports.delete(id);
  row().click();
  await flush();
  assert.match(byId('history-list').textContent, /That run is no longer stored on the server\./);
  assert.equal(get().report.id, id, 'the report already open stays');
});
