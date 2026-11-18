// A fetch route answered by a function: the fake server a test that models
// Courier, rather than scripting each answer, is built on.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub } from './shim.mjs';

beforeEach(() => {
  resetBrowser();
});

test('a served route is answered by its function every time, from the call it was given', async () => {
  let n = 0;
  fetchStub.serve(/^\/api\/runs\/[^/]+$/, (call) => {
    n += 1;
    return n === 2 ? Promise.reject(new TypeError('Failed to fetch')) : { status: 200, body: { url: call.url, n } };
  }, { method: 'GET' });
  assert.deepEqual(await (await fetch('/api/runs/r1')).json(), { url: '/api/runs/r1', n: 1 });
  await assert.rejects(fetch('/api/runs/r2'), TypeError);
  assert.deepEqual(await (await fetch('/api/runs/r3')).json(), { url: '/api/runs/r3', n: 3 });
  assert.equal(fetchStub.calls.length, 3);

  // The pattern and the method are the whole match.
  await assert.rejects(fetch('/api/runs/r3/stream'), /nothing scripted/);
  await assert.rejects(fetch('/api/runs/r1', { method: 'DELETE' }), /nothing scripted/);
  assert.equal(fetchStub.unmatched.length, 2);
});

test('a served route that throws is a network failure, and one that waits can be aborted', async () => {
  fetchStub.serve('/api/status', () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(fetch('/api/status'), TypeError);

  fetchStub.reset();
  fetchStub.serve('/api/status', () => new Promise(() => {}));
  const controller = new AbortController();
  const pending = fetch('/api/status', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('a route scripted before a served one is used first, and the served one after it runs out', async () => {
  fetchStub.respond('/api/status', { status: 503, body: { error: 'down' } });
  fetchStub.serve('/api/status', () => ({ status: 200, body: { running: false } }));
  assert.equal((await fetch('/api/status')).status, 503);
  assert.equal((await fetch('/api/status')).status, 200);
  assert.equal((await fetch('/api/status')).status, 200);
});
