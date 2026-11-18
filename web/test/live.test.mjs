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
