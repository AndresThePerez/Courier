// When too many request bodies arrive at once the server answers 503 with
// Retry-After and says it is busy. That is a moment, not a refusal: Send and
// Start read "Busy - ...", their buttons come straight back, nothing is
// marked invalid, and nothing is retried on its own.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as api from '../js/api.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const req = (n) => ({ id: `ws-busy-${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: 'x' }, assertions: [{ type: 'status', op: 'eq', value: 200 }] });

const Said = 'the server is busy checking other requests; try again in a moment';
const Busy = { status: 503, headers: { 'Retry-After': '1' }, body: { error: Said } };

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  if (unsubscribe) unsubscribe();
  resetBrowser();
  resetState();
  set({ endpoints });
  editor.init();
  runner.init({ refresh: async () => {} });
  unsubscribe = subscribe((state) => { editor.render(state); runner.render(state); });
});

const posts = (url) => fetchStub.calls.filter((c) => c.url === url && c.method === 'POST');

test('the api reads a 503 from Send and from Start as busy, with the server\'s sentence', async () => {
  fetchStub.respond('/api/send', Busy, { method: 'POST' });
  assert.deepEqual(await api.send(req(1)), { ok: false, kind: 'busy', error: Said });
  fetchStub.respond('/api/runs', Busy, { method: 'POST' });
  assert.deepEqual(await api.startRun({ mode: 'functional', sequence: [req(1)], options: {} }), { ok: false, kind: 'overloaded', error: Said });
});

test('Send answered 503 reads "Busy - ...", comes back at once, marks nothing, and does not retry', async () => {
  sidebar.selectRequest(req(1));
  fetchStub.respond('/api/send', Busy, { method: 'POST' });
  byId('send-request').click();
  await flush();
  assert.equal(byId('send-status').textContent, `Busy - ${Said}`);
  assert.doesNotMatch(byId('send-status').textContent, /Refused/);
  assert.equal(byId('send-request').disabled, false, 'Send is pressable again');
  assert.equal(byId('editor-form').querySelectorAll('[aria-invalid="true"]').length, 0);
  assert.equal(byId('editor-form').querySelectorAll('.field-error').length, 0);
  await flush(20);
  assert.equal(posts('/api/send').length, 1, 'nothing was sent again on its own');
  assert.deepEqual(listenerErrors, []);
});

test('Start answered 503 reads "Busy - ...", comes back at once, marks no row, and does not retry', async () => {
  runner.add(req(1));
  runner.add(req(2));
  fetchStub.respond('/api/runs', Busy, { method: 'POST' });
  byId('start-run').click();
  await flush();
  assert.equal(byId('start-note').textContent, `Busy - ${Said}`);
  assert.doesNotMatch(byId('start-note').textContent, /Could not start|Refused/);
  assert.equal(byId('start-run').disabled, false, 'Start is pressable again');
  assert.equal(byId('start-run').textContent, 'Start run');
  assert.equal(byId('sequence-list').querySelectorAll('.is-invalid').length, 0);
  assert.equal(get().status, null, 'no run state was adopted from it');
  await flush(20);
  assert.equal(posts('/api/runs').length, 1, 'nothing was started again on its own');

  // The next Start that is taken clears it.
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-busy-1' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  assert.doesNotMatch(byId('start-note').textContent, /Busy/);
  assert.deepEqual(listenerErrors, []);
});

test('a 503 with no sentence still reads as busy', async () => {
  sidebar.selectRequest(req(1));
  fetchStub.respond('/api/send', { status: 503, headers: { 'Retry-After': '1' } }, { method: 'POST' });
  byId('send-request').click();
  await flush();
  assert.match(byId('send-status').textContent, /^Busy - /);
  runner.add(req(1));
  fetchStub.respond('/api/runs', { status: 503, body: 'not json' }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  assert.match(byId('start-note').textContent, /^Busy - /);
});
