// An assertion's JSON path and string value come back from storage whole, at
// any length, while every other bound on a stored request stays; and a Start
// that fails says whose fault it was.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, FakeStorage, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set } from '../js/store.js';
import * as runner from '../js/render-runner.js';
import * as results from '../js/render-results.js';
import { createSavedCollections } from '../js/run-config.js';

const SETUP = 'courier.runner.v1';
const SAVED = 'courier.collections.v1';
const byId = (id) => document.getElementById(id);

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  resetBrowser();
  resetState();
  set({ endpoints: [{ id: 'search', label: 'Search', params: ['q', 'page'] }] });
  runner.init({});
});

const request = (assertions, extra = {}) => ({ id: 'r1', name: 'Long', endpoint: 'search', params: { q: 'x' }, assertions, ...extra });
const setupText = (req) => JSON.stringify({ version: 1, sequence: [{ enabled: true, request: req }], mode: 'functional', options: {} });
const savedText = (req) => JSON.stringify({ version: 1, collections: [{ id: 'wc-1', name: 'Saved', requests: [req] }] });

function restoreSaved(area) {
  let state = { savedCollections: [] };
  const saved = createSavedCollections({ storage: area, get: () => state, set: (p) => { state = { ...state, ...p }; }, maxRequests: 50 });
  saved.init();
  return state.savedCollections;
}

test('a JSON path and a string value of 600 and 5,000 characters round-trip whole through the run setup and a saved collection', () => {
  for (const n of [500, 501, 600, 5000]) {
    const assertions = [
      { type: 'json', op: 'eq', path: `$.${'p'.repeat(n - 2)}`, value: 'v'.repeat(n) },
      { type: 'body_contains', op: 'contains', value: '\u{1F600}'.repeat(n / 2) },
    ];
    const area = new FakeStorage();
    area.setItem(SETUP, setupText(request(assertions)));
    const restored = runner.createRunSetup(area).load().sequence[0].request.assertions;
    assert.deepEqual(restored, assertions, `run setup at ${n}`);
    // Written back and read again: still the same.
    const again = runner.createRunSetup(area);
    assert.equal(again.save(again.load()).ok, true);
    assert.deepEqual(runner.createRunSetup(area).load().sequence[0].request.assertions, assertions, `run setup rewritten at ${n}`);

    const savedArea = new FakeStorage();
    savedArea.setItem(SAVED, savedText(request(assertions)));
    assert.deepEqual(restoreSaved(savedArea)[0].requests[0].assertions, assertions, `saved collection at ${n}`);
  }
});

test('every other bound stays: a name cut to 120, a parameter to 500, 20 assertions, and only checked primitives kept', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ type: 'status', op: 'eq', value: 200 + i }));
  const area = new FakeStorage();
  area.setItem(SETUP, setupText(request(many, { name: 'n'.repeat(130), params: { q: 'q'.repeat(700) } })));
  const r = runner.createRunSetup(area).load().sequence[0].request;
  assert.equal(r.name.length, 120);
  assert.equal(r.params.q.length, 500);
  assert.equal(r.assertions.length, 20);
  assert.deepEqual(r.assertions.map((a) => a.value), many.slice(0, 20).map((a) => a.value));

  for (const [what, bad] of Object.entries({ object: { a: 1 }, array: ['x'], boolean: true, null: null })) {
    const area2 = new FakeStorage();
    area2.setItem(SETUP, setupText(request([{ type: 'json', op: 'eq', path: '$.a', value: bad }])));
    const a = runner.createRunSetup(area2).load().sequence[0].request.assertions[0];
    assert.equal(Object.hasOwn(a, 'value'), false, `a ${what} value was kept`);
    assert.equal(a.path, '$.a');
  }
  // Non-finite numbers cannot be written as JSON; stored as raw text they read back as other kinds or fail.
  for (const text of ['1e999', '-1e999']) {
    const area3 = new FakeStorage();
    area3.setItem(SETUP, setupText(request([{ type: 'json', op: 'eq', path: '$.a', value: 0 }])).replace('"value":0', `"value":${text}`));
    const a = runner.createRunSetup(area3).load().sequence[0].request.assertions[0];
    assert.equal(Object.hasOwn(a, 'value'), false, `${text} was kept`);
  }
  // A path on an assertion that has none, and a path that is not text, are dropped.
  const area4 = new FakeStorage();
  area4.setItem(SETUP, setupText(request([{ type: 'status', op: 'eq', path: '$.a', value: 200 }, { type: 'json', op: 'eq', path: 7, value: 'x' }])));
  const [s, j] = runner.createRunSetup(area4).load().sequence[0].request.assertions;
  assert.equal(Object.hasOwn(s, 'path'), false);
  assert.equal(Object.hasOwn(j, 'path'), false);
});

test('a 1 MB assertion value restores, renders and is sent by Start without throwing or stalling', async () => {
  const huge = 'h'.repeat(1 << 20);
  localStorage.setItem(SETUP, setupText(request([{ type: 'body_contains', op: 'contains', value: huge }])));
  const t0 = performance.now();
  runner.restore();
  runner.render(get());
  results.render(get());
  const restoredMs = performance.now() - t0;
  assert.equal(get().sequence[0].request.assertions[0].value.length, huge.length);

  fetchStub.respond('/api/runs', { status: 400, body: { error: 'value too long', field: 'sequence[0].assertions[0].value' } }, { method: 'POST' });
  const t1 = performance.now();
  byId('start-run').click();
  await flush();
  const startMs = performance.now() - t1;
  const sent = fetchStub.calls.find((c) => c.url === '/api/runs').json();
  assert.equal(sent.sequence[0].assertions[0].value.length, huge.length, 'sent whole, for the server to refuse by field');
  assert.equal(byId('start-note').textContent, 'Refused - Request 1, assertion 1: value too long');
  assert.equal(byId('start-run').textContent, 'Start run');
  console.log(`1 MB value: restore and render ${restoredMs.toFixed(1)}ms, Start ${startMs.toFixed(1)}ms`);
  assert.ok(restoredMs < 3000 && startMs < 3000, `restore ${restoredMs.toFixed(0)}ms, start ${startMs.toFixed(0)}ms`);
  assert.deepEqual(listenerErrors, []);
});

test('Start blames the network for a failed fetch, and a queued request only for a payload the page could not build', async () => {
  runner.add({ id: 'ok', name: 'Fine', endpoint: 'search', params: { q: 'x' }, assertions: [] });
  runner.render(get());
  fetchStub.reject('/api/runs', new TypeError('Failed to fetch'), { method: 'POST' });
  byId('start-run').click();
  await flush();
  assert.equal(byId('start-note').textContent, 'Could not reach Courier - the run was not started.');
  assert.equal(byId('start-run').textContent, 'Start run');

  // A value JSON cannot encode (a BigInt) is the page's own fault, and is named as such; nothing is sent.
  set({ sequence: [{ key: 'q1', enabled: true, request: { id: 'bad', name: 'Bad', endpoint: 'search', params: {}, assertions: [{ type: 'status', op: 'eq', value: 10n }] } }] });
  runner.render(get());
  const before = fetchStub.calls.length;
  byId('start-run').click();
  await flush();
  assert.equal(byId('start-note').textContent, 'Could not start the run - a queued request could not be sent from this page.');
  assert.equal(fetchStub.calls.length, before, 'nothing was sent');
  assert.equal(byId('start-run').textContent, 'Start run');
  assert.deepEqual(listenerErrors, []);
});
