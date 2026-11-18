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
    scripted: new Map(), // 'GET /api/status' -> answers to give first, each a function of nothing
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
      const first = server.scripted.get(key);
      if (first && first.length > 0) return first.shift()();
      return answer(call);
    }, { method });
  };
  const idOf = (call) => decodeURIComponent(call.url.split('/')[3]);

  // later scripts one answer to a route that the test settles when it likes,
  // with whatever body it likes: an answer written before the server changed.
  server.later = (key) => {
    let settle;
    const answer = new Promise((resolve) => { settle = resolve; });
    if (!server.scripted.has(key)) server.scripted.set(key, []);
    server.scripted.get(key).push(() => answer);
    return settle;
  };

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

// ------------------------------------------------------------------ whose run this tab shows

const BANNER_ID = 'run-status-banner';
const LIVE_ELSEWHERE = 'A run is live - Watch to follow it.';
const pill = () => byId('results-summary').querySelector('.pill');
const badge = () => byId('results-summary').querySelector('.badge');
const resultRow = (id, index) => ({ index, name: `${id}#${index}`, endpoint: 'search', status: 200, passed: true, assertions: [] });

// runToTheEnd starts a run from this tab and delivers it whole: the tab ends
// up showing its own finished report.
async function runToTheEnd(server, status = 'completed') {
  runner.add(req(1));
  byId('start-run').click();
  await flush();
  const id = server.status.run_id;
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));
  stream.emit('request_result', frame('request_result', id, resultRow(id, 0)));
  server.reports.get(id).functional.results.push(resultRow(id, 0));
  server.end(status);
  stream.emit('run_finished', frame('run_finished', id, { status, duration_ms: 1200, verdict: 'PASS' }));
  await flush();
  return id;
}

test('a tab showing its own finished report keeps it when another visitor starts a run, and Watch is the way in', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  const mine = await runToTheEnd(server);
  const { report, run } = get();
  assert.equal(report.id, mine);
  assert.equal(pill().textContent, 'completed');

  const theirs = server.begin('performance');
  t.mock.timers.tick(3000);
  await flush();
  t.mock.timers.tick(3000);
  await flush();

  assert.equal(get().status.run_id, theirs, 'the tab knows a run is live');
  assert.equal(get().report, report, 'the report is the same object');
  assert.equal(get().run, run, 'and so is the run');
  assert.equal(streamsFor(theirs).length, 0, 'nothing attached by itself');
  assert.equal(byId(BANNER_ID).hidden, false);
  assert.equal(byId(BANNER_ID).textContent, LIVE_ELSEWHERE);
  assert.equal(byId('watch-run').hidden, false);

  byId('watch-run').click();
  await flush();
  assert.equal(streamsFor(theirs).length, 1);
  assert.equal(get().report, null, 'Watch clears the old report');
  assert.equal(get().run.id, theirs);
  assert.equal(get().spectator, true);
  assert.equal(get().activeTab, 'results');
  assert.notEqual(byId(BANNER_ID).textContent, LIVE_ELSEWHERE, 'this tab is following it now');
  assert.match(byId(BANNER_ID).textContent, /^A performance run is in progress\./);
  assert.deepEqual(listenerErrors, []);
});

test('a tab showing a report reopened from history keeps it when another visitor starts a run', async (t) => {
  const server = makeServer();
  const old = server.begin();
  server.end();
  await bootPage(t, server);
  byId('history-list').querySelector('button').click();
  await flush();
  const { report, run } = get();
  assert.equal(report.id, old);

  const theirs = server.begin();
  for (let i = 0; i < 4; i += 1) {
    t.mock.timers.tick(3000);
    await flush();
  }
  assert.equal(get().report, report);
  assert.equal(get().run, run);
  assert.equal(eventSources.opened, 0);
  assert.equal(byId(BANNER_ID).textContent, LIVE_ELSEWHERE);
  assert.equal(streamsFor(theirs).length, 0);
});

test('a tab showing nothing still attaches by itself, and its banner says the run is in progress', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  assert.equal(eventSources.opened, 0);

  const theirs = server.begin();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(streamsFor(theirs).length, 1);
  assert.equal(get().run.id, theirs);
  assert.equal(get().spectator, false);
  assert.match(byId(BANNER_ID).textContent, /^A functional run is in progress\./);
  assert.equal(get().activeTab, 'runner');
});

test('Start from a tab showing an old report replaces it at once and follows the new run', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  const first = await runToTheEnd(server);
  assert.equal(get().report.id, first);

  byId('start-run').click();
  await flush();
  const second = server.status.run_id;
  assert.notEqual(second, first);
  assert.equal(get().report, null);
  assert.equal(get().run.id, second);
  assert.deepEqual(get().results, []);
  assert.equal(streamsFor(second).length, 1);
  assert.equal(get().activeTab, 'results');
});

test('the spectating badge goes when the watched run ends, when history is opened, and when this tab starts a run', async (t) => {
  const server = makeServer();
  const first = server.begin();
  await bootPage(t, server);
  byId('watch-run').click();
  await flush();
  assert.equal(get().spectator, true);
  assert.equal(badge().textContent, 'spectating');

  // The watched run ends.
  server.end();
  streamsFor(first)[0].emit('run_finished', frame('run_finished', first, { status: 'completed', duration_ms: 1200 }));
  await flush();
  assert.equal(get().spectator, false);
  assert.equal(badge(), null);
  assert.equal(get().report.id, first);

  // Watching another, then opening history.
  const second = server.begin();
  t.mock.timers.tick(3000);
  await flush();
  byId('watch-run').click();
  await flush();
  assert.equal(get().spectator, true);
  byId('history-list').querySelector('button').click();
  await flush();
  assert.equal(get().report.id, first);
  assert.equal(get().spectator, false);
  assert.equal(eventSources.live().length, 0, 'opening history stopped following the live run');

  // Watching again, the run ends, and this tab starts its own.
  byId('watch-run').click();
  await flush();
  assert.equal(get().spectator, true);
  assert.equal(get().run.id, second);
  server.end();
  streamsFor(second).at(-1).emit('run_finished', frame('run_finished', second, { status: 'completed', duration_ms: 1200 }));
  await flush();
  runner.add(req(1));
  byId('start-run').click();
  await flush();
  assert.equal(get().run.id, server.status.run_id);
  assert.equal(get().spectator, false);
  assert.equal(badge(), null);
  assert.deepEqual(listenerErrors, []);
});

test('when the finished report cannot be fetched, the summary shows how the run ended, not "running"', async (t) => {
  for (const status of ['completed', 'cancelled', 'expired']) {
    resetBrowser();
    resetState();
    if (unsubscribe) unsubscribe();
    const server = makeServer();
    const id = server.begin();
    await bootPage(t, server);
    const stream = streamsFor(id)[0];
    stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));
    stream.emit('request_result', frame('request_result', id, resultRow(id, 0)));
    assert.equal(pill().textContent, 'running');

    server.down.add(`GET /api/runs/${id}`);
    server.end(status);
    stream.emit('run_finished', frame('run_finished', id, { status, duration_ms: 1200, verdict: 'N/A' }));
    await flush();

    assert.equal(get().report, null, status);
    assert.equal(pill().textContent, status);
    assert.doesNotMatch(byId('results-summary').textContent, /running/, status);
    assert.match(byId('results-summary').textContent, /The finished report could not be loaded - open it from History\./);
    assert.equal(get().results.length, 1, 'the rows that arrived stay');
    assert.equal(get().transport, 'idle');
    assert.equal(get().status.running, false);
    assert.deepEqual(listenerErrors, []);
    t.mock.timers.reset();
  }
});

test('a row before run_started is kept, a late run_started does not wipe it, and another run\'s frames are ignored', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];

  stream.emit('request_result', frame('request_result', id, resultRow(id, 0)));
  assert.equal(get().results.length, 1);
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 3 }));
  assert.equal(get().results.length, 1, 'run_started did not wipe the row');
  assert.equal(get().run.total, 3);

  stream.emit('run_started', frame('run_started', 'run-other', { mode: 'performance', total: 9 }));
  stream.emit('request_result', frame('request_result', 'run-other', resultRow('run-other', 1)));
  stream.emit('progress', frame('progress', 'run-other', { requests: 5 }));
  assert.equal(get().run.id, id);
  assert.equal(get().run.mode, 'functional');
  assert.deepEqual(get().results.map((r) => r.name), [`${id}#0`]);
  assert.equal(get().progress, null);

  // The other run finishing is not this run finishing.
  stream.emit('run_finished', frame('run_finished', 'run-other', { status: 'completed' }));
  await flush();
  assert.equal(get().transport, 'sse');
  assert.equal(callsTo(`/api/runs/${id}`).length, 0);
  assert.equal(pill().textContent, 'running');
});

test('run_finished from the stream and from the poll together fetch the report once', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));
  server.end();
  const done = frame('run_finished', id, { status: 'completed', duration_ms: 1200 });
  stream.emit('run_finished', done);
  stream.emit('run_finished', done);
  await flush();
  assert.equal(callsTo(`/api/runs/${id}`).length, 1);
  assert.equal(get().report.id, id);
});

// ------------------------------------------------------------------ a run that no longer exists

const tick = async (t, ms, step = 500) => {
  for (let left = ms; left > 0; left -= step) {
    t.mock.timers.tick(Math.min(step, left));
    await flush(2);
  }
};

test('a watched run that vanishes is not followed in a loop: one stream, one status read after the 404, and it is not shown as running', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  byId('watch-run').click();
  await flush();
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 2 }));
  stream.emit('request_result', frame('request_result', id, resultRow(id, 0)));

  // The server restarts: the stream drops, the run is unknown, nothing is live.
  server.reports.clear();
  server.status = { running: false, budget_balance: 1500 };
  const statusBefore = callsTo('/api/status').length;
  stream.fail();
  await flush();

  assert.equal(callsTo(`/api/runs/${id}`).length, 1, 'one poll, which answered 404');
  assert.equal(callsTo('/api/status').length, statusBefore + 1, 'status is read once right after the 404');
  assert.equal(get().transport, 'idle');
  assert.equal(pill().textContent, 'unavailable');
  assert.match(byId('results-summary').textContent, /This run is no longer on the server\./);
  assert.equal(get().results.length, 1, 'what arrived stays');
  assert.equal(get().spectator, false);

  await tick(t, 10000);
  assert.ok(streamsFor(id).length <= 2, `${streamsFor(id).length} streams opened for the vanished run`);
  assert.equal(streamsFor(id).length, 1);
  assert.equal(callsTo(`/api/runs/${id}`).length, 1, 'the vanished run is not asked for again');
  assert.equal(callsTo('/api/status').length, statusBefore + 1 + 3, 'only the 3s status poll since');
  assert.deepEqual(listenerErrors, []);
});

test('a vanished run that status goes on reporting is not attached again until status moves on', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  assert.equal(streamsFor(id).length, 1);

  // The run is unknown to the report route while status still names it.
  server.reports.delete(id);
  const before = fetchStub.calls.length;
  streamsFor(id)[0].fail();
  await flush();
  await tick(t, 30000);

  assert.equal(eventSources.opened, 1, 'no second stream in 30s');
  assert.equal(callsTo(`/api/runs/${id}`).length, 1);
  assert.ok(fetchStub.calls.length - before <= 13, `${fetchStub.calls.length - before} requests in 30s`);
  assert.equal(get().run, null, 'nothing had arrived, so nothing is shown');
  assert.equal(get().status.run_id, id);

  // Watch does not reopen it either.
  byId('watch-run').click();
  await flush();
  assert.equal(eventSources.opened, 1);

  // Status reports no run, then a different one: this tab follows that.
  server.status = { running: false, budget_balance: 1500 };
  await tick(t, 3000);
  const next = server.begin();
  await tick(t, 3000);
  assert.equal(streamsFor(next).length, 1);
  assert.equal(get().run.id, next);
  assert.deepEqual(listenerErrors, []);
});

test('Cancel on a run whose stream went quiet learns it ended from one read of the run', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));

  // The run ended on the server and the stream never said so.
  server.end('expired');
  byId('cancel-run').click();
  await flush();

  assert.equal(callsTo(`/api/runs/${id}`, 'DELETE').length, 1);
  assert.equal(get().report.id, id, 'the status that followed the cancel led to the report');
  assert.equal(pill().textContent, 'expired');
  assert.equal(get().transport, 'idle');
  assert.equal(stream.readyState, EventSource.CLOSED);
  assert.doesNotMatch(byId('start-note').textContent, /Could not/, 'a cancel that found nothing to stop is not a failure');
});

// ------------------------------------------------------------------ one status request at a time

test('while a status request is out, the 3s poll does not start another', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  const before = callsTo('/api/status').length;
  const answer = server.later('GET /api/status');

  t.mock.timers.tick(3000);
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(callsTo('/api/status').length, before + 1, 'two ticks, one request');

  answer({ status: 200, body: { running: false, budget_balance: 7 } });
  await flush();
  assert.equal(get().status.budget_balance, 7);
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(callsTo('/api/status').length, before + 2, 'the poll carries on once the slow one is in');
});

test('a status request that is never answered is given up after 10s, and the poll asks again', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  const before = callsTo('/api/status').length;
  server.later('GET /api/status');

  // The poll goes out at 3s and is given up at 13s; the ticks at 6, 9 and 12s
  // find it still out, and the one at 15s asks again.
  await tick(t, 12000, 1000);
  assert.equal(callsTo('/api/status').length, before + 1);
  await tick(t, 3000, 1000);
  assert.equal(callsTo('/api/status').length, before + 2, 'asked again after the timeout');
  assert.equal(get().status.running, false, 'what the page knew stays until an answer arrives');
  assert.deepEqual(listenerErrors, []);
});

test('a status answer written before this tab\'s run started does not undo the run', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.add(req(1));
  const stale = server.later('GET /api/status');
  t.mock.timers.tick(3000);
  await flush();
  const out = callsTo('/api/status').length;

  byId('start-run').click();
  await flush();
  const id = server.status.run_id;
  assert.equal(get().status.run_id, id);
  assert.equal(callsTo('/api/status').length, out, 'the read after Start waits for the one already out');

  // The old answer lands now: it says nothing is running.
  stale({ status: 200, body: { running: false, budget_balance: 1500 } });
  await flush();
  assert.equal(get().status.running, true, 'the stale answer was not applied');
  assert.equal(get().status.run_id, id);
  assert.equal(byId('start-run').disabled, true);
  assert.equal(callsTo('/api/status').length, out + 1, 'and status was read again, once');
  assert.equal(callsTo(`/api/runs/${id}`).length, 0, 'nothing made the tab doubt its own run');
  assert.equal(get().transport, 'sse');
});

test('a history answer written before a run ended does not hide that run', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));

  // Cancel reads history while the run is still going; the answer is slow.
  const stale = server.later('GET /api/runs');
  byId('cancel-run').click();
  await flush();
  server.end('cancelled');
  stream.emit('run_finished', frame('run_finished', id, { status: 'cancelled', duration_ms: 1200 }));
  await flush();
  stale({ status: 200, body: { runs: [] } });
  await flush();

  assert.deepEqual(get().history.map((h) => h.id), [id]);
  assert.equal(callsTo('/api/runs').length, 3, 'boot, the slow one, and the read that replaced it');
});
