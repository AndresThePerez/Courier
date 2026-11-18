// What an abort does to a scripted response the fake fetch already answered:
// the unread body errors with the abort reason, everything else about the
// response (status, headers, an empty body, a body already read) stays.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush } from './shim.mjs';

beforeEach(() => {
  resetBrowser();
});

test('a body read to the end before the abort keeps its value', async () => {
  fetchStub.respond('/api/runs/r1', { status: 200, body: { id: 'r1' } });
  const controller = new AbortController();
  const res = await fetch('/api/runs/r1', { signal: controller.signal });
  const data = await res.json();
  controller.abort();
  await flush();
  assert.deepEqual(data, { id: 'r1' });
  assert.equal(res.bodyUsed, true);
});

test('a 204 under a signal has no body, and aborting it afterwards throws nothing', async () => {
  fetchStub.respond('/api/runs/r1', { status: 204 });
  const controller = new AbortController();
  const res = await fetch('/api/runs/r1', { signal: controller.signal });
  assert.equal(res.status, 204);
  assert.equal(res.body, null);
  assert.doesNotThrow(() => controller.abort());
  assert.equal(await res.text(), '');
});

test('status, statusText and headers survive the body being tied to the signal', async () => {
  fetchStub.respond('/api/runs', { status: 409, statusText: 'Conflict', headers: { 'retry-after': '3' }, body: { error: 'busy' } });
  const controller = new AbortController();
  const res = await fetch('/api/runs', { signal: controller.signal });
  assert.equal(res.status, 409);
  assert.equal(res.ok, false);
  assert.equal(res.statusText, 'Conflict');
  assert.equal(res.headers.get('retry-after'), '3');
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), { error: 'busy' });
});

test('an abort between fetch resolving and json() rejects json() with the abort reason, text() too', async () => {
  const reason = new Error('superseded');
  fetchStub.respond('/api/a', { status: 200, body: { a: 1 } });
  fetchStub.respond('/api/b', { status: 200, body: 'plain' });
  const one = new AbortController();
  const two = new AbortController();
  const a = await fetch('/api/a', { signal: one.signal });
  const b = await fetch('/api/b', { signal: two.signal });
  one.abort(reason);
  two.abort();
  await assert.rejects(a.json(), (err) => err === reason);
  await assert.rejects(b.text(), (err) => err.name === 'AbortError');
});

test('a fetch without a signal keeps its body readable as before', async () => {
  fetchStub.respond('/api/status', { status: 200, body: { ok: true } });
  const res = await fetch('/api/status');
  assert.deepEqual(await res.json(), { ok: true });
});
