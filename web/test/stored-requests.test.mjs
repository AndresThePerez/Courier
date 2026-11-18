// What a request read back from this browser is turned into before the page
// shows, queues or sends it: a request the editor built comes back exactly as
// it was written, and anything else is rebuilt from the fields the editor
// writes, of the kinds it writes, within its bounds.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage } from './shim.mjs';
import * as runner from '../js/render-runner.js';
import { createSavedCollections } from '../js/run-config.js';

const SETUP = 'courier.runner.v1';
const SAVED = 'courier.collections.v1';

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
});

// restoredFrom stores requests as the run setup and as a saved collection, in
// the raw text given, and answers what each of the two reads back.
function restoredFrom(requestsJSON) {
  const area = new FakeStorage();
  area.setItem(SETUP, `{"version":1,"sequence":[${requestsJSON.map((r) => `{"enabled":true,"request":${r}}`).join(',')}],"mode":"functional","options":{}}`);
  area.setItem(SAVED, `{"version":1,"collections":[{"id":"wc-1","name":"All","requests":[${requestsJSON.join(',')}]}]}`);
  const setup = runner.createRunSetup(area).load().sequence.map((e) => e.request);
  let state = { savedCollections: [] };
  const saved = createSavedCollections({ storage: area, get: () => state, set: (p) => { state = { ...state, ...p }; }, maxRequests: 50 });
  saved.init();
  const [collection] = state.savedCollections;
  return { setup, collection: collection ? collection.requests : [] };
}

const request = (assertions, extra = {}) => ({ id: 'ws-1', name: 'Mine', endpoint: 'search', params: { q: 'pikachu' }, assertions, ...extra });

// Every shape the editor writes: curated assertions as the server sends them
// (type, path, op, value), a new row (type, op, value), a row switched to json
// (path last), json exists with and without a value left from an earlier
// operator, text typed into a numeric slot, emptied fields, a request with no
// parameters or assertions, and a healthz request.
const editorMade = [
  request([{ type: 'status', op: 'eq', value: 200 }]),
  request([{ type: 'status', op: 'neq', value: '20x' }]),
  request([{ type: 'latency', op: 'lt', value: 150 }]),
  request([{ type: 'json', path: '$.total', op: 'gt', value: 106 }]),
  request([{ type: 'json', path: '$.results[0].name', op: 'eq', value: 'Alakazam' }]),
  request([{ type: 'json', path: '$.facets.sets[172]', op: 'exists' }]),
  request([{ type: 'json', path: '$.status', op: 'exists', value: 'ok' }]),
  request([{ type: 'json', op: 'eq', value: 200, path: '$' }]),
  request([{ type: 'json', path: '', op: 'contains', value: '' }]),
  request([{ type: 'json', path: '$.suggestions', op: 'count', value: 0 }]),
  request([{ type: 'json', path: '$.total', op: 'lt', value: -1.5 }]),
  request([{ type: 'json', path: '$.total', op: 'neq', value: 'x'.repeat(500) }]),
  request([{ type: 'body_contains', op: 'contains', value: 'Charizard' }]),
  request([{ type: 'body_contains', op: 'contains', value: '200' }]),
  request([]),
  request(Array.from({ length: 20 }, (_, i) => ({ type: 'status', op: 'eq', value: 200 + i }))),
  { id: 'ws-2', name: '', endpoint: 'search', params: {}, assertions: [] },
  { id: 'health-check', name: 'Health (copy)', endpoint: 'healthz', params: {}, assertions: [{ type: 'status', op: 'eq', value: 200 }] },
  request([], { name: 'n'.repeat(120), params: { q: 'v'.repeat(500), page: '2', types: 'Fire' } }),
];

test('a request the editor built, of every assertion type, reads back byte for byte from the run setup and a saved collection', () => {
  const raws = editorMade.map((r) => JSON.stringify(r));
  const { setup, collection } = restoredFrom(raws);
  assert.deepEqual(setup.map((r) => JSON.stringify(r)), raws);
  assert.deepEqual(collection.map((r) => JSON.stringify(r)), raws);
});

// rebuilt answers the one request restoredFrom reads back from raw, after
// checking the run setup and the saved collection agree on it.
function rebuilt(raw) {
  const { setup, collection } = restoredFrom([raw]);
  assert.deepEqual(setup, collection, raw.slice(0, 200));
  return setup[0] || null;
}

const one = (a) => JSON.stringify(request([a]));
const assertionOf = (a) => {
  const r = rebuilt(one(a));
  return r.assertions.length ? r.assertions[0] : null;
};

test('a stored assertion keeps only type, op, a json path and a value of a kind the editor writes', () => {
  // Keys the editor never writes are dropped, at every level.
  assert.deepEqual(assertionOf({ type: 'status', op: 'eq', value: 200, url: 'http://192.0.2.10/', host: '192.0.2.10', method: 'DELETE' }), { type: 'status', op: 'eq', value: 200 });
  const r = rebuilt(JSON.stringify(request([], { url: 'http://192.0.2.10/', method: 'DELETE', headers: { A: '1' } })));
  assert.deepEqual(Object.keys(r), ['id', 'name', 'endpoint', 'params', 'assertions']);

  // A path belongs to json alone, and is text.
  assert.deepEqual(assertionOf({ type: 'status', op: 'eq', path: '$.x', value: 200 }), { type: 'status', op: 'eq', value: 200 });
  assert.deepEqual(assertionOf({ type: 'json', path: { a: 1 }, op: 'exists' }), { type: 'json', op: 'exists' });
  assert.deepEqual(assertionOf({ type: 'json', path: ['$'], op: 'exists' }), { type: 'json', op: 'exists' });

  // A value is text or a finite number, and only text for body_contains.
  for (const value of [{ a: 1 }, [1], [[[]]], null, true, false]) {
    assert.deepEqual(assertionOf({ type: 'json', path: '$', op: 'eq', value }), { type: 'json', path: '$', op: 'eq' }, JSON.stringify(value));
  }
  assert.deepEqual(assertionOf({ type: 'body_contains', op: 'contains', value: 5 }), { type: 'body_contains', op: 'contains' });
  const infinite = rebuilt(`{"id":"a","endpoint":"search","assertions":[{"type":"latency","op":"lt","value":1e999}]}`);
  assert.deepEqual(infinite.assertions, [{ type: 'latency', op: 'lt' }]);

  // A type or operator the page does not know drops the assertion, and only it.
  for (const [type, op] of [['status', 'gt'], ['latency', 'eq'], ['body_contains', 'eq'], ['header', 'eq'], ['constructor', 'eq'], ['__proto__', 'eq'], ['toString', 'eq'], [1, 'eq'], ['json', null], ['json', ['eq']]]) {
    assert.equal(assertionOf({ type, op, value: 1 }), null, `${type} ${op}`);
  }
  const mixed = rebuilt(JSON.stringify(request([{ type: 'status', op: 'gt', value: 1 }, { type: 'status', op: 'eq', value: 200 }])));
  assert.deepEqual(mixed.assertions, [{ type: 'status', op: 'eq', value: 200 }]);
});

test('a stored request is held to the editor\'s bounds', () => {
  const long = 'x'.repeat(5000);
  assert.deepEqual(assertionOf({ type: 'json', path: long, op: 'eq', value: long }), { type: 'json', path: 'x'.repeat(500), op: 'eq', value: 'x'.repeat(500) });

  const big = rebuilt(JSON.stringify(request(
    Array.from({ length: 1000 }, (_, i) => ({ type: 'status', op: 'eq', value: i })),
    { name: long, params: { q: long } },
  )));
  assert.equal(big.assertions.length, 20, 'the editor\'s cap of 20 assertions');
  assert.deepEqual(big.assertions.at(-1), { type: 'status', op: 'eq', value: 19 });
  assert.equal(big.name.length, 120);
  assert.equal(big.params.q.length, 500);

  // An id, endpoint or parameter the page could not have made drops the request.
  for (const extra of [
    { id: 'i'.repeat(201) },
    { endpoint: 'e'.repeat(201) },
    { params: { ['k'.repeat(65)]: 'v' } },
    { params: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, 'v'])) },
    { params: { q: { deep: [] } } },
    { params: { q: 7 } },
  ]) {
    assert.equal(rebuilt(JSON.stringify(request([], extra))), null, JSON.stringify(extra).slice(0, 80));
  }
});

test('a stored request is a new object, sharing nothing with what was parsed', () => {
  // A request holding a "__proto__" parameter keeps it as data, and the
  // request and its containers have the plain prototypes.
  const r = rebuilt('{"id":"a","endpoint":"search","params":{"__proto__":"x","q":"y"},"assertions":[{"__proto__":{"polluted":1},"type":"status","op":"eq","value":1}]}');
  assert.deepEqual(Object.keys(r.params), ['__proto__', 'q']);
  assert.equal(Object.getPrototypeOf(r.params), Object.prototype);
  assert.equal(Object.getPrototypeOf(r.assertions[0]), Object.prototype);
  assert.equal(r.assertions[0].polluted, undefined);
  assert.equal(({}).polluted, undefined);
});

test('a stored option nested ten thousand levels deep reads as the default', () => {
  const area = new FakeStorage();
  const deep = `${'['.repeat(10000)}7${']'.repeat(10000)}`;
  area.setItem(SETUP, `{"version":1,"sequence":[],"mode":"performance","options":{"concurrency":${deep},"duration_secs":[12],"delay_ms":{"n":3}}}`);
  const { options } = runner.createRunSetup(area).load();
  assert.deepEqual(options, { stop_on_failure: false, delay_ms: 0, concurrency: 10, duration_secs: 10 });
});
