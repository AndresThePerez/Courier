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

test('a GET that fails throws with the status attached', async () => {
  fetchStub.respond('/api/status', { status: 503, body: { error: 'down' } });
  await assert.rejects(api.getStatus(), (err) => err.status === 503 && err.message === 'down');
});
