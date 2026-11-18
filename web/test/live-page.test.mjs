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
