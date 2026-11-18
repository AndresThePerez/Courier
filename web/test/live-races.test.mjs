// The live view under the orderings a random walk rarely lines up: another
// visitor's run at every moment of this tab's own, a run that vanishes and
// stays named, every call failing in every way, a stream handing over to the
// poll, and visitor actions that race each other.
//
// The page is built the way main.js builds it (see live-page.test.mjs), over a
// Courier that is a function of one object.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, eventSources, flush, listenerErrors, localStorage } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as api from '../js/api.js';
import { createLive } from '../js/live.js';
import * as sidebar from '../js/render-sidebar.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as results from '../js/render-results.js';

const SETUP_KEY = 'courier.runner.v1';
const LIVE_ELSEWHERE = 'A run is live - Watch to follow it.';
const UNREACHABLE = {
  send: 'Could not reach Courier - check the connection and try again.',
  start: 'Could not reach Courier - the run was not started.',
  cancel: 'Could not reach Courier - the run was not cancelled.',
  catalog: 'Could not load collections from the server.',
};

const byId = (id) => document.getElementById(id);
const req = (n) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [{ type: 'status', op: 'eq', value: 200 }] });
const streamOf = (id) => `${location.origin}/api/runs/${id}/stream`;
const streamsFor = (id) => eventSources.instances.filter((s) => s.url === streamOf(id));
const callsTo = (url, method = 'GET') => fetchStub.calls.filter((c) => c.url === url && c.method === method);
const frame = (type, id, data = {}) => ({ type, run_id: id, data });
const row = (id, index) => ({ index, name: `${id}#${index}`, run: id, endpoint: 'search', status: 200, passed: true, assertions: [] });
const pill = () => byId('results-summary').querySelector('.pill');
const badge = () => byId('results-summary').querySelector('.badge');
const banner = () => byId('run-status-banner');

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
    down: new Set(),
    scripted: new Map(),
    next: 1,
    begin(mode = 'functional') {
      const id = `run-${server.next}`;
      server.next += 1;
      const started = '2026-11-17T12:00:00Z';
      server.reports.set(id, {
        id, mode, status: 'running', started_at: started, config: {}, entries: [{ index: 0, name: 'Request 1' }],
        ...(mode === 'functional' ? { functional: { total: 1, results: [] } } : { performance: { verdict: 'N/A', overall: { requests: 0 }, per_request: [] } }),
      });
      server.status = { ...server.status, running: true, run_id: id, mode, started_at: started };
      return id;
    },
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
    // once scripts the next answer to one route.
    once(key, spec) {
      if (!server.scripted.has(key)) server.scripted.set(key, []);
      server.scripted.get(key).push(typeof spec === 'function' ? spec : () => spec);
    },
    // later scripts an answer the test settles when it likes.
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
      if (server.down.has('*') || server.down.has(key)) throw new TypeError('Failed to fetch');
      const first = server.scripted.get(key);
      if (first && first.length > 0) return first.shift()(call);
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
    return rep ? { status: 200, body: JSON.parse(JSON.stringify(rep)) } : { status: 404, body: { error: `no run "${idOf(call)}"` } };
  });
  route(/^\/api\/runs\/[^/]+$/, 'DELETE', (call) => {
    if (!server.status.running || server.status.run_id !== idOf(call)) return { status: 404, body: { error: 'not running' } };
    return { status: 204 };
  });
  route('/api/send', 'POST', (call) => ({ status: 200, body: { status: 200, passed: true, latency_ms: 12, size_bytes: 2, body: call.json().id, assertions: [] } }));
  return server;
}

let unsubscribe = null;
let page = null;

async function bootPage(t, server, { before, wait = true } = {}) {
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
  const booted = page.boot();
  if (wait) await booted;
  await flush();
  return server;
}

const tick = async (t, ms, step = 500) => {
  for (let left = ms; left > 0; left -= step) {
    t.mock.timers.tick(Math.min(step, left));
    await flush(2);
  }
};

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  if (page) page.stop();
  page = null;
  api.onRunStarted(() => {});
});

// deliverWhole sends a running run's frames and its end over its stream.
async function deliverWhole(server, id, status = 'completed') {
  const stream = streamsFor(id).at(-1);
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));
  stream.emit('request_result', frame('request_result', id, row(id, 0)));
  server.reports.get(id).functional.results.push(row(id, 0));
  server.end(status);
  stream.emit('run_finished', frame('run_finished', id, { status, duration_ms: 1200, verdict: 'PASS' }));
  await flush();
}

function openRequest(n = 0) {
  [...byId('collections-tree').querySelectorAll('button')].filter((b) => b.classList.contains('req-open'))[n].click();
}

// ------------------------------------------------------------------ another visitor's run

test('a spectator whose run ends keeps its end on screen when another visitor starts the next run at once, until Watch', async (t) => {
  const server = makeServer();
  const a = server.begin();
  await bootPage(t, server);
  byId('watch-run').click();
  await flush();
  assert.equal(get().spectator, true);
  await deliverWhole(server, a);
  assert.equal(get().report.id, a);
  assert.equal(get().spectator, false, 'the badge goes with the run');
  const { report, run, results: rows } = get();

  // Another visitor starts B in the same second; the poll sees it.
  const b = server.begin('performance');
  await tick(t, 9000);
  assert.equal(streamsFor(b).length, 0, 'nothing of B is followed without the visitor');
  assert.equal(get().report, report);
  assert.equal(get().run, run);
  assert.equal(get().results, rows);
  assert.equal(get().spectator, false);
  assert.equal(badge(), null, 'no spectating badge on a report nobody is watching');
  assert.equal(pill().textContent, 'completed');
  assert.equal(banner().textContent, LIVE_ELSEWHERE);
  assert.equal(byId('watch-run').hidden, false);

  byId('watch-run').click();
  await flush();
  assert.equal(streamsFor(b).length, 1);
  assert.equal(get().report, null);
  assert.equal(get().run.id, b);
  assert.equal(get().spectator, true);
  assert.notEqual(banner().textContent, LIVE_ELSEWHERE);
  assert.deepEqual(listenerErrors, []);
});

test('a tab showing the end of a run whose report could not be loaded keeps it when another visitor starts a run', async (t) => {
  const server = makeServer();
  const a = server.begin();
  await bootPage(t, server);
  server.down.add(`GET /api/runs/${a}`);
  await deliverWhole(server, a, 'cancelled');
  assert.equal(get().report, null);
  assert.equal(pill().textContent, 'cancelled');
  const { run, outcome } = get();

  server.down.clear();
  const b = server.begin();
  await tick(t, 9000);
  assert.equal(streamsFor(b).length, 0);
  assert.equal(get().run, run);
  assert.equal(get().outcome, outcome);
  assert.equal(pill().textContent, 'cancelled', 'not running, and not the other run');
  assert.equal(banner().textContent, LIVE_ELSEWHERE);
  assert.deepEqual(listenerErrors, []);
});

test('Start answered 409 for another visitor\'s run: a tab showing nothing follows it as rule 2 says, without a badge or a failure note', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.add(req(1));
  // The run starts between this tab's last poll and its Start.
  const other = server.begin();
  byId('start-run').click();
  await flush();

  assert.equal(streamsFor(other).length, 1, 'the run status reports is followed once');
  assert.equal(get().run.id, other);
  assert.equal(get().spectator, false);
  assert.equal(byId('start-run').textContent, 'Start run');
  assert.equal(byId('start-run').disabled, true, 'a run is live');
  assert.doesNotMatch(byId('start-note').textContent, /Could not/);
  assert.equal(byId('cancel-run').textContent, 'Cancel this run', 'Cancel says it is somebody else\'s');
  assert.deepEqual(listenerErrors, []);
});

test('Start answered 409 while a finished report is shown leaves the report and offers Watch', async (t) => {
  const server = makeServer();
  const a = server.begin();
  await bootPage(t, server);
  await deliverWhole(server, a);
  const { report } = get();
  runner.add(req(1));
  const other = server.begin();
  byId('start-run').click();
  await flush();

  assert.equal(get().report, report);
  assert.equal(streamsFor(other).length, 0);
  assert.equal(banner().textContent, LIVE_ELSEWHERE);
  assert.equal(byId('watch-run').hidden, false);
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ a run that vanished

test('a vanished run that status names for a whole minute costs one stream and one report read', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 2 }));
  stream.emit('request_result', frame('request_result', id, row(id, 0)));

  server.reports.delete(id);
  const statusBefore = callsTo('/api/status').length;
  stream.fail();
  await flush();
  await tick(t, 60000, 1000);

  assert.equal(streamsFor(id).length, 1, 'one stream in 60s');
  assert.equal(callsTo(`/api/runs/${id}`).length, 1, 'one report read in 60s');
  const polls = callsTo('/api/status').length - statusBefore;
  assert.ok(polls <= 22, `${polls} status reads in 60s`);
  assert.equal(pill().textContent, 'unavailable');
  assert.equal(get().results.length, 1);
  assert.equal(get().transport, 'idle');
  assert.deepEqual(listenerErrors, []);
});

test('a report read that answers 404 while the stream is still open ends the attachment and closes the stream', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));

  // Status moves on while the stream is quiet, and the run is unknown.
  server.reports.delete(id);
  server.status = { running: false, budget_balance: 1500 };
  set({ status: { ...server.status } });
  await flush();

  assert.equal(callsTo(`/api/runs/${id}`).length, 1, 'read once');
  assert.equal(stream.readyState, EventSource.CLOSED);
  assert.equal(get().transport, 'idle');
  assert.equal(get().run, null, 'nothing had arrived, so nothing is kept');
  assert.equal(eventSources.live().length, 0);

  // The quiet stream's late frames reach nothing.
  assert.equal(stream.emit('request_result', frame('request_result', id, row(id, 0))), false);
  assert.equal(get().results.length, 0);

  // A tab showing nothing follows the next run.
  const next = server.begin();
  await tick(t, 3000);
  assert.equal(streamsFor(next).length, 1);
  assert.deepEqual(listenerErrors, []);
});

test('a tab showing a run as unavailable does not follow the next run by itself, and Watch does', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];
  stream.emit('request_result', frame('request_result', id, row(id, 0)));
  server.reports.clear();
  server.status = { running: false, budget_balance: 1500 };
  stream.fail();
  await flush();
  assert.equal(pill().textContent, 'unavailable');

  const next = server.begin();
  await tick(t, 6000);
  assert.equal(streamsFor(next).length, 0);
  assert.equal(get().run.id, id);
  assert.equal(banner().textContent, LIVE_ELSEWHERE);

  byId('watch-run').click();
  await flush();
  assert.equal(streamsFor(next).length, 1);
  assert.equal(get().run.id, next);
  assert.equal(get().outcome, null);
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ every call failing every way

// FAILURES are the ways an answer can fail to be one.
const FAILURES = {
  rejected: { arm: (server, key) => server.once(key, () => { throw new TypeError('Failed to fetch'); }) },
  html500: { arm: (server, key) => server.once(key, { status: 500, statusText: 'Internal Server Error', body: '<html><body>Bad gateway</body></html>' }) },
  timedOut: { arm: (server, key) => server.later(key), ms: 20500 },
};

// READ_FAILURES add, for the JSON reads, an answer that is not JSON at all: a
// body cut short, or a page some proxy on the way put there. It is no more an
// answer of Courier's than a refused connection is.
const READ_FAILURES = {
  ...FAILURES,
  notJson200: { arm: (server, key) => server.once(key, { status: 200, body: '<html><body>One moment...</body></html>' }) },
  truncated200: { arm: (server, key) => server.once(key, { status: 200, body: '{"collections":[{"id":"sea' }) },
};

test('the catalog fails every way, says so with a Retry, and Retry brings it back', async (t) => {
  for (const [how, failure] of Object.entries(READ_FAILURES)) {
    resetBrowser();
    resetState();
    if (unsubscribe) unsubscribe();
    if (page) page.stop();
    t.mock.timers.reset();
    const server = makeServer();
    await bootPage(t, server, { before: () => failure.arm(server, 'GET /api/collections'), wait: !failure.ms });
    if (failure.ms) await tick(t, failure.ms, 1000);
    const tree = byId('collections-tree');
    assert.match(tree.textContent, /Could not load collections from the server\./, how);
    assert.doesNotMatch(tree.textContent, /Loading collections/, how);
    const retry = [...tree.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    assert.ok(retry, how);
    retry.click();
    await flush();
    assert.match(tree.textContent, /Search basics/, `${how}: Retry loaded the catalog`);
    assert.deepEqual(listenerErrors, [], how);
  }
});

test('Send fails every way, comes back each time, and the next Send lands', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  openRequest();
  for (const [how, failure] of Object.entries(FAILURES)) {
    failure.arm(server, 'POST /api/send');
    byId('send-request').click();
    await flush();
    if (failure.ms) await tick(t, failure.ms, 1000);
    assert.equal(byId('send-request').disabled, false, how);
    assert.notEqual(byId('send-status').textContent, 'Sending...', how);
    if (how !== 'html500') assert.equal(byId('send-status').textContent, UNREACHABLE.send, how);
    else assert.match(byId('send-status').textContent, /500/, how);
  }
  byId('send-request').click();
  await flush();
  assert.match(byId('send-status').textContent, /^200 - /);
  assert.deepEqual(listenerErrors, []);
});

test('Start fails every way, comes back each time, never shows a run, and the next Start runs', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.add(req(1));
  for (const [how, failure] of Object.entries(FAILURES)) {
    failure.arm(server, 'POST /api/runs');
    byId('start-run').click();
    await flush();
    if (failure.ms) await tick(t, failure.ms, 1000);
    assert.equal(byId('start-run').textContent, 'Start run', how);
    assert.equal(byId('start-run').disabled, false, how);
    if (how !== 'html500') assert.equal(byId('start-note').textContent, UNREACHABLE.start, how);
    else assert.match(byId('start-note').textContent, /^Could not start the run - 500/, how);
    assert.equal(eventSources.opened, 0, how);
    assert.equal(get().run, null, how);
  }
  byId('start-run').click();
  await flush();
  assert.equal(streamsFor(server.status.run_id).length, 1);
  assert.equal(byId('start-note').textContent, '');
  assert.deepEqual(listenerErrors, []);
});

test('Cancel fails every way: the run is never shown as cancelled, Cancel comes back, and the next Cancel lands', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  streamsFor(id)[0].emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));
  for (const [how, failure] of Object.entries(FAILURES)) {
    failure.arm(server, `DELETE /api/runs/${id}`);
    byId('cancel-run').click();
    await flush();
    if (failure.ms) await tick(t, Math.min(failure.ms, 10500), 500);
    assert.equal(byId('cancel-run').disabled, false, how);
    assert.equal(byId('cancel-run').hidden, false, how);
    assert.equal(pill().textContent, 'running', `${how}: still running`);
    assert.equal(get().outcome, null, how);
    if (how !== 'html500') assert.equal(byId('start-note').textContent, UNREACHABLE.cancel, how);
    else assert.match(byId('start-note').textContent, /^Could not cancel - /, how);
  }
  byId('cancel-run').click();
  await flush();
  assert.equal(callsTo(`/api/runs/${id}`, 'DELETE').length, 4);
  assert.equal(byId('start-note').textContent, '');
  assert.deepEqual(listenerErrors, []);
});

test('a history entry that fails every way says so, keeps the view, and leaves the tab free to follow the next run', async (t) => {
  const server = makeServer();
  const old = server.begin();
  server.end();
  await bootPage(t, server);
  const entry = () => byId('history-list').querySelector('button');
  for (const [how, failure] of Object.entries(READ_FAILURES)) {
    failure.arm(server, `GET /api/runs/${old}`);
    entry().click();
    await flush();
    if (failure.ms) await tick(t, Math.min(failure.ms, 10500), 500);
    assert.match(byId('history-list').textContent, /Could not open that run/, how);
    assert.equal(get().run, null, how);
  }
  // Nothing is shown and nothing is awaited: the next run is followed.
  const next = server.begin();
  await tick(t, 3000);
  assert.equal(streamsFor(next).length, 1);
  assert.deepEqual(listenerErrors, []);
});

test('a history entry answered with a body that is not JSON does not leave the tab waiting for it, so the next run is still followed', async (t) => {
  const server = makeServer();
  const old = server.begin();
  server.end();
  await bootPage(t, server);
  server.once(`GET /api/runs/${old}`, { status: 200, body: '<html><body>One moment...</body></html>' });
  byId('history-list').querySelector('button').click();
  await flush();
  assert.equal(get().run, null, 'nothing was shown');

  // Nothing is on screen, so rule 2 says the next live run is followed by itself.
  const next = server.begin();
  await tick(t, 9000);
  assert.equal(streamsFor(next).length, 1, 'the tab still follows a live run by itself');
  assert.equal(get().run && get().run.id, next);
  assert.deepEqual(listenerErrors, []);
});

test('the status poll fails every way, nothing is believed from it, and the page catches up when it answers', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  for (const [how, failure] of Object.entries(READ_FAILURES)) {
    failure.arm(server, 'GET /api/status');
    await tick(t, (failure.ms || 0) + 3000, 1000);
    assert.notEqual((get().status || {}).running, true, how);
    assert.equal(byId('start-run').textContent, 'Start run', how);
  }
  const id = server.begin();
  await tick(t, 3000, 1000);
  assert.equal(streamsFor(id).length, 1, 'the next answer is acted on');
  // The history read beside the finished report fails; the report still lands.
  server.once('GET /api/runs', () => { throw new TypeError('Failed to fetch'); });
  await deliverWhole(server, id);
  assert.equal(get().report.id, id);
  assert.equal(get().status.running, false);
  assert.deepEqual(listenerErrors, []);
});

test('Start whose answer is lost after the run began: the tab follows the run status reports, and Start comes back', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.add(req(1));
  // The server starts the run; the answer never reaches this tab.
  server.once('POST /api/runs', () => {
    server.begin();
    throw new TypeError('Failed to fetch');
  });
  byId('start-run').click();
  await flush();
  const id = server.status.run_id;
  assert.equal(byId('start-run').textContent, 'Start run');
  // The refresh after the failure finds the run.
  await tick(t, 3000);
  assert.equal(streamsFor(id).length, 1, 'followed once');
  assert.equal(get().run.id, id);
  assert.equal(pill().textContent, 'running');
  assert.equal(byId('start-run').disabled, true, 'a run is live');
  assert.deepEqual(listenerErrors, []);
});

test('the finished report fails every way: the run shows how it ended, says the report is missing, and is never shown as running', async (t) => {
  for (const [how, failure] of Object.entries(READ_FAILURES)) {
    resetBrowser();
    resetState();
    if (unsubscribe) unsubscribe();
    if (page) page.stop();
    t.mock.timers.reset();
    const server = makeServer();
    const id = server.begin();
    await bootPage(t, server);
    failure.arm(server, `GET /api/runs/${id}`);
    await deliverWhole(server, id, 'expired');
    if (failure.ms) await tick(t, 10500, 500);
    assert.equal(get().report, null, how);
    assert.equal(pill().textContent, 'expired', how);
    assert.match(byId('results-summary').textContent, /The finished report could not be loaded - open it from History\./, how);
    assert.equal(get().transport, 'idle', how);
    assert.deepEqual(listenerErrors, [], how);
  }
});

test('frames with no data, an index out of range, a body that is not JSON, or an older event id do not throw or end the run', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 2 }));
  stream.emit('request_result', frame('request_result', id, row(id, 0)), { lastEventId: 3 });
  stream.emit('request_result', { type: 'request_result', run_id: id }, { lastEventId: 4 });
  stream.emit('request_result', frame('request_result', id, null), { lastEventId: 5 });
  stream.emit('request_result', frame('request_result', id, row(id, 99)), { lastEventId: 6 });
  stream.emit('request_result', frame('request_result', id, row(id, -1)), { lastEventId: 7 });
  stream.emit('progress', 'not json at all', { lastEventId: 8 });
  stream.emit('progress', 'null', { lastEventId: 9 });
  stream.emit('run_finished', '{"type":"run_finished"', { lastEventId: 10 });
  // An event id going backwards: the same row again, as a replay would send it.
  stream.emit('request_result', frame('request_result', id, row(id, 0)), { lastEventId: 2 });
  assert.deepEqual(listenerErrors, []);
  assert.equal(get().transport, 'sse');
  assert.equal(get().results.filter((r) => r && r.index === 0).length, 1, 'row 0 once');
  assert.equal(pill().textContent, 'running');

  stream.emit('request_result', frame('request_result', id, row(id, 1)), { lastEventId: 11 });
  server.end();
  stream.emit('run_finished', frame('run_finished', id, { status: 'completed', duration_ms: 1200 }), { lastEventId: 12 });
  await flush();
  assert.equal(get().report.id, id);
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ nothing left running after a detach

// trackTimers records every timer the page arms and has not cleared or seen
// fire, by the delay it asked for.
function trackTimers(t) {
  const live = new Map();
  const real = { st: globalThis.setTimeout, ct: globalThis.clearTimeout, si: globalThis.setInterval, ci: globalThis.clearInterval };
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = real.st((...a) => { live.delete(handle); fn(...a); }, ms, ...rest);
    live.set(handle, `timeout ${ms}`);
    return handle;
  };
  globalThis.clearTimeout = (h) => { live.delete(h); return real.ct(h); };
  globalThis.setInterval = (fn, ms, ...rest) => {
    const handle = real.si(fn, ms, ...rest);
    live.set(handle, `interval ${ms}`);
    return handle;
  };
  globalThis.clearInterval = (h) => { live.delete(h); return real.ci(h); };
  t.after(() => Object.assign(globalThis, { setTimeout: real.st, clearTimeout: real.ct, setInterval: real.si, clearInterval: real.ci }));
  return () => [...live.values()].sort();
}

test('a stream left before its first frame, and a poll left for a history entry, leave no timer behind', async (t) => {
  const server = makeServer();
  const old = server.begin();
  server.end();
  const id = server.begin();
  let armed;
  await bootPage(t, server, { before: () => { armed = trackTimers(t); } });
  assert.equal(streamsFor(id).length, 1);
  assert.deepEqual(armed(), ['interval 3000', 'timeout 5000'], 'the status poll and the stream\'s first-frame deadline');

  // The visitor opens a history entry before the stream says anything.
  byId('history-list').querySelector('button').click();
  await flush();
  assert.equal(get().report.id, old);
  assert.deepEqual(armed(), ['interval 3000'], 'only the status poll is left');

  // Watch the live run, let the stream fail over to polling, then leave it the same way.
  byId('watch-run').click();
  await flush();
  streamsFor(id).at(-1).fail();
  await flush();
  assert.equal(get().transport, 'polling');
  assert.ok(armed().includes('interval 500'));
  byId('history-list').querySelector('button').click();
  await flush();
  assert.equal(get().transport, 'idle');
  assert.deepEqual(armed(), ['interval 3000'], 'the 500ms poll went with the attachment');
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ the transport handing over

test('a stream that never speaks is polled after 5s, and its late frames are not applied twice', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];
  server.reports.get(id).functional.results.push(row(id, 0));
  await tick(t, 5000);
  assert.equal(get().transport, 'polling');
  assert.equal(stream.readyState, EventSource.CLOSED);
  assert.equal(get().results.length, 1);

  assert.equal(stream.emit('request_result', frame('request_result', id, row(id, 0))), false);
  assert.equal(get().results.length, 1);

  server.end();
  await tick(t, 1000);
  assert.equal(get().report.id, id);
  assert.equal(get().transport, 'idle');
  assert.equal(eventSources.opened, 1);
  const reads = callsTo(`/api/runs/${id}`).length;
  await tick(t, 5000);
  assert.equal(callsTo(`/api/runs/${id}`).length, reads, 'polling stopped with the run');
  assert.deepEqual(listenerErrors, []);
});

test('a stream ended by a restart without its terminal event is noticed at once, not after the browser\'s minute', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];
  stream.emit('run_started', frame('run_started', id, { mode: 'functional', total: 1 }));
  server.reports.clear();
  server.status = { running: false, budget_balance: 1500 };
  stream.fail();
  await flush();
  assert.equal(callsTo(`/api/runs/${id}`).length, 1, 'read at once');
  assert.equal(get().transport, 'idle');
  assert.equal(stream.readyState, EventSource.CLOSED, 'the browser is not left to reconnect');
  await tick(t, 61000, 1000);
  assert.equal(eventSources.opened, 1);
  assert.deepEqual(listenerErrors, []);
});

test('an error after the terminal event neither polls nor opens a stream', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  const stream = streamsFor(id)[0];
  await deliverWhole(server, id);
  const reads = callsTo(`/api/runs/${id}`).length;
  assert.equal(stream.fail(), false, 'the stream was closed on run_finished');
  await tick(t, 5000);
  assert.equal(callsTo(`/api/runs/${id}`).length, reads);
  assert.equal(eventSources.opened, 1);
  assert.equal(get().transport, 'idle');
});

// ------------------------------------------------------------------ visitor actions racing

test('Watch pressed twice opens one stream and keeps what arrived', async (t) => {
  const server = makeServer();
  const id = server.begin();
  await bootPage(t, server);
  // This tab is following already; Watch twice only says it is a spectator.
  streamsFor(id)[0].emit('request_result', frame('request_result', id, row(id, 0)));
  byId('watch-run').click();
  byId('watch-run').click();
  await flush();
  assert.equal(streamsFor(id).length, 1);
  assert.equal(get().results.length, 1);
  assert.equal(get().spectator, true);
});

test('history entry A then B: A\'s answer arriving first is dropped, B is shown', async (t) => {
  const server = makeServer();
  const a = server.begin();
  server.end();
  const b = server.begin();
  server.end();
  await bootPage(t, server);
  const entry = (id) => [...byId('history-list').querySelectorAll('button')].find((x) => x.title.includes(id) || x.textContent.includes(id));
  const answerA = server.later(`GET /api/runs/${a}`);
  const answerB = server.later(`GET /api/runs/${b}`);
  entry(a).click();
  entry(b).click();
  await flush();
  answerA({ status: 200, body: server.reports.get(a) });
  await flush();
  assert.equal(get().report, null, 'A was asked for before B: its answer is not shown');
  answerB({ status: 200, body: server.reports.get(b) });
  await flush();
  assert.equal(get().report.id, b);
  assert.deepEqual(listenerErrors, []);
});

test('Watch then a history entry at once: the stream closes, the badge goes, the entry is shown', async (t) => {
  const server = makeServer();
  const old = server.begin();
  server.end();
  const live = server.begin();
  await bootPage(t, server);
  byId('watch-run').click();
  byId('history-list').querySelector('button').click();
  await flush();
  assert.equal(get().report.id, old);
  assert.equal(get().spectator, false);
  assert.equal(badge(), null);
  assert.equal(eventSources.live().length, 0);
  assert.equal(get().transport, 'idle');
  assert.equal(streamsFor(live).length, 1);
  assert.deepEqual(listenerErrors, []);
});

test('Send, then delete the request being sent: the answer lands nowhere and Send is not left waiting', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  openRequest();
  const answer = server.later('POST /api/send');
  byId('send-request').click();
  await flush();
  set({ draft: null });
  answer({ status: 200, body: { status: 200, passed: true, latency_ms: 1, size_bytes: 2, body: 'r1', assertions: [] } });
  await flush();
  assert.equal(get().send, null);
  openRequest(1);
  assert.equal(byId('send-request').disabled, false);
  assert.deepEqual(listenerErrors, []);
});

test('a page hidden for a minute fires every missed tick at once and still has one status request out', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  const before = callsTo('/api/status').length;
  server.later('GET /api/status');
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(callsTo('/api/status').length, before + 1);
});

// ------------------------------------------------------------------ the visitor's own data

test('a long session of other visitors\' runs never writes the run setup or changes what is queued', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.add(req(1));
  runner.add(req(2));
  byId('mode-functional').click();
  const queued = JSON.stringify(get().sequence);
  const { mode, options } = get();
  let writes = 0;
  const realSet = localStorage.setItem.bind(localStorage);
  t.mock.method(localStorage, 'setItem', (key, value) => {
    if (key === SETUP_KEY) writes += 1;
    return realSet(key, value);
  });

  for (let i = 0; i < 4; i += 1) {
    const id = server.begin(i % 2 ? 'functional' : 'performance');
    await tick(t, 3000);
    if (i === 1) {
      byId('watch-run').click();
      await flush();
    }
    if (server.status.mode === 'performance') {
      server.reports.get(id).performance.overall.requests = 50;
    }
    const s = streamsFor(id).at(-1);
    if (s) {
      s.emit('run_started', frame('run_started', id, { mode: server.status.mode, total: 1, config: { concurrency: 50, duration_secs: 30 } }));
      s.emit('progress', frame('progress', id, { requests: 5 }));
    }
    server.end();
    if (s) s.emit('run_finished', frame('run_finished', id, { status: 'completed', duration_ms: 1200 }));
    await tick(t, 3000);
  }
  assert.equal(writes, 0, 'the run setup was written');
  assert.equal(JSON.stringify(get().sequence), queued);
  assert.equal(get().mode, mode);
  assert.deepEqual(get().options, options);
  assert.equal(byId('mode-functional').checked, true);
  assert.deepEqual(listenerErrors, []);
});
