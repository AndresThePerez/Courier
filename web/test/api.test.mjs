import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub } from './shim.mjs';
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
