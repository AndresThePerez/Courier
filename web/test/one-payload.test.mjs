// Send and Start put the same request on the wire byte for byte, through one
// builder, and both refuse an empty JSON path before anything is sent rather
// than rewriting it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import { requestPayload } from '../js/request-model.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] }];

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  if (unsubscribe) unsubscribe();
  resetBrowser();
  resetState();
  set({ endpoints });
  editor.init();
  runner.init({});
  unsubscribe = subscribe((state) => { editor.render(state); runner.render(state); });
});

const sendOk = { status: 200, body: { status: 200, passed: true, endpoint: 'search', query: '', latency_ms: 1, size_bytes: 0, body: '', assertions: [] } };

async function sent(request) {
  set({ draft: JSON.parse(JSON.stringify(request)), selectedId: request.id, send: null });
  fetchStub.respond('/api/send', sendOk, { method: 'POST' });
  const before = fetchStub.calls.length;
  byId('send-request').click();
  await flush();
  const calls = fetchStub.calls.slice(before).filter((c) => c.url === '/api/send');
  return calls.length ? calls[0].body : null;
}

async function started(request) {
  set({ sequence: [{ key: 'k1', enabled: true, request: JSON.parse(JSON.stringify(request)) }] });
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'x', field: 'mode' } }, { method: 'POST' });
  const before = fetchStub.calls.length;
  byId('start-run').click();
  await flush();
  const calls = fetchStub.calls.slice(before).filter((c) => c.url === '/api/runs');
  return calls.length ? calls[0].json() : null;
}

// Requests the server accepts, written the odd ways a visitor or a stored
// value can write them.
const Odd = [
  { id: 'ws-1', name: 'Every type', endpoint: 'search', params: { q: 'pika chu', page: '2' }, assertions: [
    { type: 'status', op: 'eq', value: 200 },
    { type: 'status', op: 'neq', value: 599 },
    { type: 'latency', op: 'lt', value: 0.001 },
    { type: 'json', path: '$', op: 'exists' },
    { type: 'json', path: '$.a b', op: 'eq', value: ' ' },
    { type: 'json', path: '$.results[0].name', op: 'neq', value: '1e2' },
    { type: 'json', path: '$.total', op: 'gt', value: -1 },
    { type: 'json', path: '$.total', op: 'lt', value: 100 },
    { type: 'json', path: '$.items', op: 'count', value: 0 },
    { type: 'json', path: '$.名前', op: 'contains', value: 'ünï ☃ \u{1F600}' },
    { type: 'body_contains', op: 'contains', value: '' },
  ] },
  // Fields the wire has no place for, at every level, and a value an exists
  // check ignores.
  { id: 'ws-2', name: '', endpoint: 'search', url: 'http://192.0.2.10/', method: 'DELETE', params: { q: 'x' }, assertions: [
    { type: 'json', path: '$.a', op: 'exists', value: 7, url: 'http://192.0.2.10/' },
    { type: 'status', op: 'eq', value: 200, path: '$.not.sent' },
  ] },
  { id: 'ws-3', name: 'No params, no assertions', endpoint: 'search' },
  { id: 'ws-4', name: 'Long but in bounds', endpoint: 'search', params: {}, assertions: [
    { type: 'json', path: `$.${'p'.repeat(498)}`, op: 'eq', value: '\u{1F600}'.repeat(500) },
  ] },
];

test('Send and Start put the same request on the wire byte for byte, and it is the one builder\'s', async () => {
  for (const request of Odd) {
    const send = await sent(request);
    const run = await started(request);
    assert.ok(send !== null, `${request.id}: Send posted`);
    assert.ok(run !== null, `${request.id}: Start posted`);
    assert.equal(JSON.stringify(run.sequence[0]), send, `${request.id}: the same bytes`);
    assert.equal(send, JSON.stringify(requestPayload(request)), `${request.id}: built by requestPayload`);
  }
  const wire = JSON.parse(await sent(Odd[1]));
  assert.deepEqual(Object.keys(wire).sort(), ['assertions', 'endpoint', 'id', 'name', 'params']);
  assert.deepEqual(wire.assertions, [{ type: 'json', op: 'exists', path: '$.a' }, { type: 'status', op: 'eq', value: 200 }]);
  assert.deepEqual(listenerErrors, []);
});

test('an empty JSON path is not rewritten to $', () => {
  const built = requestPayload({ id: 'ws-e', endpoint: 'search', assertions: [{ type: 'json', path: '', op: 'eq', value: 1 }] });
  assert.equal(built.assertions[0].path, '');
});

test('Send and Start both refuse an empty JSON path with the same message, and send nothing', async () => {
  for (const path of ['', undefined]) {
    const request = { id: 'ws-e', name: 'Empty path', endpoint: 'search', params: {}, assertions: [
      { type: 'status', op: 'eq', value: 200 },
      { type: 'json', path, op: 'eq', value: 1 },
    ] };
    const before = fetchStub.calls.length;
    assert.equal(await sent(request), null, 'Send made no request');
    assert.equal(byId('send-status').textContent, 'Refused - Assertion 2: JSON path is required');
    assert.equal(await started(request), null, 'Start made no request');
    assert.equal(byId('start-note').textContent, 'Refused - Request 1, assertion 2: JSON path is required');
    assert.equal(fetchStub.calls.length, before);
    assert.equal(byId('start-run').textContent, 'Start run');
    assert.equal(byId('send-request').disabled, false);
  }
  assert.deepEqual(listenerErrors, []);
});
