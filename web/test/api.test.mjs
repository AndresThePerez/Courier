import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush } from './shim.mjs';
import * as api from '../js/api.js';

beforeEach(() => {
  resetBrowser();
});

const payload = { mode: 'functional', sequence: [], options: {} };

test('startRun: 202 is a started run', async () => {
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'r1' } }, { method: 'POST' });
  assert.deepEqual(await api.startRun(payload), { ok: true, runId: 'r1' });

  const [call] = fetchStub.calls;
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.json(), payload);
});

test('startRun: 409 naming a run is busy', async () => {
  fetchStub.respond('/api/runs', { status: 409, body: { run_id: 'r1' } }, { method: 'POST' });
  const outcome = await api.startRun(payload);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'busy');
  assert.equal(outcome.runId, 'r1');
});

test('startRun: 409 naming a cooldown is cooling', async () => {
  const until = '2026-11-17T12:00:05Z';
  fetchStub.respond('/api/runs', { status: 409, body: { cooldown_until: until } }, { method: 'POST' });
  const outcome = await api.startRun(payload);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'cooling');
  assert.equal(outcome.cooldownUntil, until);
});

test('startRun: 400 is invalid and names the field', async () => {
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'x', field: 'mode' } }, { method: 'POST' });
  const outcome = await api.startRun(payload);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'invalid');
  assert.equal(outcome.field, 'mode');
  assert.equal(outcome.error, 'x');
});

test('send: 429 is busy', async () => {
  fetchStub.respond('/api/send', { status: 429, body: { error: 'another send is in flight' } }, { method: 'POST' });
  const outcome = await api.send({ id: 'r1', endpoint: 'search' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'busy');
});

test('cancelRun: 204 is ok', async () => {
  fetchStub.respond('/api/runs/r1', { status: 204 }, { method: 'DELETE' });
  assert.deepEqual(await api.cancelRun('r1'), { ok: true });
});

test('cancelRun: 404 is gone', async () => {
  fetchStub.respond('/api/runs/r1', { status: 404, body: { error: 'no such run' } }, { method: 'DELETE' });
  const outcome = await api.cancelRun('r1');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.gone, true);
});

test('a GET the server refuses answers with the status attached, and does not throw', async () => {
  fetchStub.respond('/api/status', { status: 503, body: { error: 'down' } });
  assert.deepEqual(await api.getStatus(), { ok: false, kind: 'error', status: 503, error: 'down', body: { error: 'down' } });

  fetchStub.respond('/api/runs/gone', { status: 404, body: { error: 'no run "gone"' } });
  const missing = await api.getRun('gone');
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
  assert.equal(missing.error, 'no run "gone"');
});

test('a GET that succeeds answers with the body', async () => {
  fetchStub.respond('/api/status', { status: 200, body: { running: false } });
  assert.deepEqual(await api.getStatus(), { ok: true, body: { running: false } });
  fetchStub.respond('/api/runs', { status: 200, body: { runs: [] } });
  assert.deepEqual(await api.getHistory(), { ok: true, body: { runs: [] } });
});

// ------------------------------------------------------------------ the network

const NETWORK = { ok: false, kind: 'network', error: 'Could not reach Courier' };

const CALLS = [
  ['getCollections', '/api/collections', 'GET', () => api.getCollections()],
  ['getStatus', '/api/status', 'GET', () => api.getStatus()],
  ['getHistory', '/api/runs', 'GET', () => api.getHistory()],
  ['getRun', '/api/runs/r1', 'GET', () => api.getRun('r1')],
  ['startRun', '/api/runs', 'POST', () => api.startRun(payload)],
  ['send', '/api/send', 'POST', () => api.send({ id: 'r1', endpoint: 'search' })],
  ['cancelRun', '/api/runs/r1', 'DELETE', () => api.cancelRun('r1')],
];

test('every call answers a rejected fetch as the network outcome, and never throws', async () => {
  for (const [name, url, method, call] of CALLS) {
    fetchStub.reject(url, new TypeError('Failed to fetch'), { method });
    let outcome;
    await assert.doesNotReject(async () => { outcome = await call(); }, name);
    assert.deepEqual(outcome, NETWORK, name);
  }
});

test('every call answers a connection that drops while the body is read as the network outcome', async () => {
  for (const [name, url, method, call] of CALLS) {
    const body = new ReadableStream({ pull(c) { c.error(new TypeError('network error')); } });
    fetchStub.serve(url, () => ({ status: 200, body: 'x' }), { method });
    const real = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const res = await real(...args);
      return new Response(body, { status: res.status });
    };
    try {
      assert.deepEqual(await call(), NETWORK, name);
    } finally {
      globalThis.fetch = real;
      fetchStub.reset();
    }
  }
});

test('a payload that cannot be encoded is an outcome, not a throw, and nothing is sent', async () => {
  const outcome = await api.startRun({ mode: 'functional', n: 1n });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'error');
  const sent = await api.send({ id: 'r1', n: 1n });
  assert.equal(sent.ok, false);
  assert.equal(sent.kind, 'error');
  assert.equal(fetchStub.calls.length, 0);
});

test('a started run is announced to the page with its id and mode', async () => {
  const seen = [];
  api.onRunStarted((id, mode) => seen.push([id, mode]));
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'r9' } }, { method: 'POST' });
  await api.startRun({ mode: 'performance', sequence: [], options: {} });
  api.onRunStarted(() => {});
  assert.deepEqual(seen, [['r9', 'performance']]);
});

// ------------------------------------------------------------------ timeouts

const TIMEOUTS = { getCollections: 10000, getStatus: 10000, getHistory: 10000, getRun: 10000, cancelRun: 10000, startRun: 20000, send: 20000 };

// settledAfter reports whether a promise has settled, without waiting on it.
function watchSettle(promise) {
  const seen = { done: false, value: undefined };
  promise.then((v) => { seen.done = true; seen.value = v; });
  return seen;
}

test('a call that gets no answer is given up as the network outcome: 10s for reads and cancel, 20s for Send and Start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  for (const [name, url, method, call] of CALLS) {
    fetchStub.defer(url, { method });
    const seen = watchSettle(call());
    await flush();
    t.mock.timers.tick(TIMEOUTS[name] - 1);
    await flush();
    assert.equal(seen.done, false, `${name} is still waiting just before ${TIMEOUTS[name]}ms`);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(seen.done, true, `${name} gave up at ${TIMEOUTS[name]}ms`);
    assert.deepEqual(seen.value, NETWORK, name);
    fetchStub.reset();
  }
});

test('an answer whose body is cut off by the timeout, after its headers arrived, is the network outcome', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const real = globalThis.fetch;
  for (const [name, url, method, call] of CALLS) {
    fetchStub.respond(url, { status: 200, body: { run_id: 'r1', runs: [] } }, { method });
    // The headers arrive; the body is not read until the test lets it be.
    let letBody;
    const stalled = new Promise((resolve) => { letBody = resolve; });
    globalThis.fetch = async (...args) => {
      const res = await real(...args);
      const text = res.text.bind(res);
      res.text = async () => {
        await stalled;
        return text();
      };
      return res;
    };
    try {
      const seen = watchSettle(call());
      await flush();
      t.mock.timers.tick(TIMEOUTS[name]);
      letBody();
      await flush();
      assert.equal(seen.done, true, name);
      assert.deepEqual(seen.value, NETWORK, name);
    } finally {
      globalThis.fetch = real;
      fetchStub.reset();
    }
  }
});

test('an answered call leaves no timer behind: its signal is never aborted afterwards', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const real = globalThis.fetch;
  const signals = [];
  globalThis.fetch = (input, init = {}) => {
    signals.push(init.signal);
    return real(input, init);
  };
  try {
    for (const [, url, method, call] of CALLS) {
      fetchStub.respond(url, { status: 200, body: {} }, { method });
      await call();
    }
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(signals.length, CALLS.length);
    for (const signal of signals) {
      assert.ok(signal instanceof AbortSignal, 'every request carries a signal');
      assert.equal(signal.aborted, false);
    }
  } finally {
    globalThis.fetch = real;
  }
});
