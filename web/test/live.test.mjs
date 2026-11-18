import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, eventSources, flush } from './shim.mjs';
import { openLive } from '../js/api.js';

const running = { id: 'r1', mode: 'functional', status: 'running', started_at: '2026-11-17T12:00:00Z', entries: [] };

beforeEach(() => {
  resetBrowser();
});

// watch opens a live attachment with mocked timers and records everything it
// says. The fallback poll is scripted to answer "still running", so the
// polling path stays put instead of finishing.
function watch(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(console, 'warn', () => {});
  fetchStub.respond('/api/runs/r1', { status: 200, body: running }, { times: Infinity });
  const events = [];
  const transports = [];
  const stop = openLive('r1', {
    event: (e) => events.push(e),
    transport: (k) => transports.push(k),
  });
  t.after(() => stop());
  return { events, transports, stop, source: eventSources.latest() };
}

test('a run_started frame reaches the handler over sse', (t) => {
  const { events, transports, source } = watch(t);

  assert.equal(eventSources.opened, 1);
  assert.equal(source.url, `${location.origin}/api/runs/r1/stream`);
  assert.deepEqual(transports, ['sse']);

  const frame = { type: 'run_started', run_id: 'r1', data: { mode: 'functional', total: 1 } };
  source.emit('run_started', frame);

  assert.deepEqual(events, [frame]);
  assert.deepEqual(transports, ['sse']);
});

test('no frame within 5000ms falls back to polling and closes the stream', async (t) => {
  const { transports, source } = watch(t);

  t.mock.timers.tick(4999);
  assert.deepEqual(transports, ['sse']);
  assert.equal(eventSources.closed, 0);

  t.mock.timers.tick(1);
  assert.deepEqual(transports, ['sse', 'polling']);
  assert.equal(eventSources.closed, 1);
  assert.equal(source.readyState, EventSource.CLOSED);

  await flush();
  assert.ok(fetchStub.calls.some((c) => c.url === '/api/runs/r1'), 'the first poll goes out at once');
});

test('a frame before the deadline disarms the watchdog for good', (t) => {
  const { transports, source } = watch(t);
  source.emit('run_started', { type: 'run_started', run_id: 'r1', data: {} });
  t.mock.timers.tick(60000);
  assert.deepEqual(transports, ['sse']);
  assert.equal(eventSources.closed, 0);
});

test('a stream error falls back to polling', (t) => {
  const { transports, source } = watch(t);
  source.fail();
  assert.deepEqual(transports, ['sse', 'polling']);
  assert.equal(source.readyState, EventSource.CLOSED);
  assert.equal(eventSources.closed, 1);
});

test('run_finished reaches the handler, closes the stream and goes idle', (t) => {
  const { events, transports, source } = watch(t);
  source.emit('run_started', { type: 'run_started', run_id: 'r1', data: {} });
  const done = { type: 'run_finished', run_id: 'r1', data: { status: 'completed' } };
  source.emit('run_finished', done);

  assert.deepEqual(events.at(-1), done);
  assert.deepEqual(transports, ['sse', 'idle']);
  assert.equal(source.readyState, EventSource.CLOSED);
  assert.equal(eventSources.closed, 1);
  assert.equal(eventSources.live().length, 0);
});

test('frames of another run are not this run\'s: nothing is handed on, and its run_finished does not end the stream', (t) => {
  const { events, transports, source } = watch(t);
  source.emit('run_started', { type: 'run_started', run_id: 'r1', data: {} });
  source.emit('request_result', { type: 'request_result', run_id: 'r2', data: { index: 0 } });
  source.emit('progress', { type: 'progress', run_id: 'r2', data: { requests: 1 } });
  source.emit('run_finished', { type: 'run_finished', run_id: 'r2', data: { status: 'completed' } });
  source.emit('run_finished', { type: 'run_finished', data: { status: 'completed' } });

  assert.deepEqual(events.map((e) => [e.type, e.run_id]), [['run_started', 'r1']]);
  assert.deepEqual(transports, ['sse']);
  assert.equal(source.readyState, EventSource.OPEN);
});

// ------------------------------------------------------------------ a run that is gone, and the end of a stream

// follow is watch() with the poll answers left to the test.
function follow(t, handlers = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(console, 'warn', () => {});
  const seen = { events: [], transports: [], gone: 0 };
  const stop = openLive('r1', {
    event: (e) => seen.events.push(e),
    transport: (k) => seen.transports.push(k),
    gone: () => { seen.gone += 1; },
    ...handlers,
  });
  t.after(() => stop());
  return { ...seen, seen, stop, source: eventSources.latest() };
}

const pollsOf = () => fetchStub.calls.filter((c) => c.url === '/api/runs/r1').length;

test('a polled run that answers 404 is reported gone once, and nothing is asked for again', async (t) => {
  fetchStub.respond('/api/runs/r1', { status: 404, body: { error: 'no run "r1"' } }, { times: Infinity });
  const { seen, transports, source } = follow(t);
  source.emit('run_started', { type: 'run_started', run_id: 'r1', data: {} });
  source.fail();
  await flush();

  assert.equal(seen.gone, 1);
  assert.deepEqual(transports, ['sse', 'polling', 'idle']);
  assert.equal(pollsOf(), 1);

  t.mock.timers.tick(10000);
  await flush();
  assert.equal(pollsOf(), 1, 'no poll after the run was reported gone');
  assert.equal(eventSources.opened, 1, 'and no second stream');
  assert.equal(seen.gone, 1);
});

test('a stream refused before any frame (the 503 over the subscriber cap) is polled instead, with no second stream', async (t) => {
  fetchStub.respond('/api/runs/r1', { status: 200, body: running }, { times: Infinity });
  const { transports, source } = follow(t);
  source.fail({ fatal: true });
  await flush();
  assert.deepEqual(transports, ['sse', 'polling']);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(eventSources.opened, 1);
  assert.ok(pollsOf() >= 2, 'polling carries on at its own cadence');
});

test('the stream ending after run_finished is the end of the stream: no poll, no second stream', async (t) => {
  const { transports, source } = follow(t);
  source.emit('run_started', { type: 'run_started', run_id: 'r1', data: {} });
  source.emit('run_finished', { type: 'run_finished', run_id: 'r1', data: { status: 'completed' } });
  source.fail();
  t.mock.timers.tick(70000);
  await flush();
  assert.deepEqual(transports, ['sse', 'idle']);
  assert.equal(fetchStub.calls.length, 0);
  assert.equal(eventSources.opened, 1);
});

test('a stream that ends before run_finished is polled at once, and the poll delivers the end', async (t) => {
  const done = { id: 'r1', mode: 'functional', status: 'expired', started_at: '2026-11-17T12:00:00Z', duration_ms: 800, entries: [], functional: { verdict: 'N/A', results: [{ index: 0 }] } };
  fetchStub.respond('/api/runs/r1', { status: 200, body: done });
  const { events, transports, source } = follow(t);
  source.emit('run_started', { type: 'run_started', run_id: 'r1', data: {} });
  source.fail();
  await flush();
  assert.deepEqual(events.map((e) => e.type), ['run_started', 'request_result', 'run_finished']);
  assert.deepEqual(transports, ['sse', 'polling', 'idle']);
});

test('the polled end of a run carries its verdict, functional or performance, and no cooldown of its own', async (t) => {
  for (const [rep, verdict] of [
    [{ id: 'r1', mode: 'functional', status: 'completed', duration_ms: 5, entries: [], functional: { verdict: 'FAIL', results: [] } }, 'FAIL'],
    [{ id: 'r1', mode: 'performance', status: 'completed', duration_ms: 5, entries: [], performance: { verdict: 'PASS', overall: { requests: 3 } } }, 'PASS'],
    [{ id: 'r1', mode: 'functional', status: 'cancelled', duration_ms: 5, entries: [], functional: { verdict: 'N/A', results: [] } }, 'N/A'],
  ]) {
    resetBrowser();
    fetchStub.respond('/api/runs/r1', { status: 200, body: rep });
    const { events, source } = follow(t);
    source.fail();
    await flush();
    const end = events.at(-1);
    assert.equal(end.type, 'run_finished', rep.mode);
    assert.equal(end.data.verdict, verdict, rep.mode);
    assert.equal(end.data.status, rep.status);
    assert.ok(!end.data.cooldown_until, 'the status the page reads next carries the cooldown');
    t.mock.timers.reset();
  }
});

test('a poll delivers the rows the stream did not, even when the stream delivered one twice', async (t) => {
  const rows = [0, 1, 2].map((index) => ({ index, name: `row ${index}` }));
  fetchStub.respond('/api/runs/r1', { status: 200, body: { ...running, functional: { results: rows } } }, { times: Infinity });
  const { events, source } = follow(t);
  const first = { type: 'request_result', run_id: 'r1', data: rows[0] };
  source.emit('run_started', { type: 'run_started', run_id: 'r1', data: {} });
  source.emit('request_result', first);
  source.emit('request_result', first);
  source.fail();
  await flush();
  const polled = events.slice(3).filter((e) => e.type === 'request_result').map((e) => e.data.index);
  assert.deepEqual(polled, [1, 2]);
});

test('probe reads the run once without leaving the stream, and ends the attachment if the run is over', async (t) => {
  fetchStub.respond('/api/runs/r1', { status: 200, body: running });
  const { events, transports, source, stop } = follow(t);
  source.emit('run_started', { type: 'run_started', run_id: 'r1', data: {} });
  assert.equal(typeof stop.probe, 'function');

  stop.probe();
  stop.probe();
  await flush();
  assert.equal(pollsOf(), 1, 'one read at a time');
  assert.deepEqual(transports, ['sse'], 'still streaming');
  assert.equal(source.readyState, EventSource.OPEN);
  assert.deepEqual(events.map((e) => e.type), ['run_started']);

  fetchStub.respond('/api/runs/r1', { status: 200, body: { ...running, status: 'completed', duration_ms: 9, functional: { verdict: 'PASS', results: [] } } });
  stop.probe();
  await flush();
  assert.equal(events.at(-1).type, 'run_finished');
  assert.deepEqual(transports, ['sse', 'idle']);
  assert.equal(source.readyState, EventSource.CLOSED);
});

test('a poll that cannot reach Courier keeps polling, one request at a time', async (t) => {
  const first = fetchStub.defer('/api/runs/r1');
  fetchStub.reject('/api/runs/r1');
  fetchStub.respond('/api/runs/r1', { status: 500, body: { error: 'boom' } });
  fetchStub.respond('/api/runs/r1', { status: 200, body: running }, { times: Infinity });
  const { seen, transports, source } = follow(t);
  source.fail();
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(pollsOf(), 1, 'the slow poll is the only one out');

  first.reject();
  await flush();
  for (let i = 0; i < 4; i += 1) {
    t.mock.timers.tick(500);
    await flush();
  }
  assert.ok(pollsOf() >= 4);
  assert.deepEqual(transports, ['sse', 'polling']);
  assert.equal(seen.gone, 0);
});
