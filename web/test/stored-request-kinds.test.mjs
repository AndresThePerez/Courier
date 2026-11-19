// Every field of a stored run setup and saved collection, read back as every
// kind of JSON value and as the edge values around each bound. Whatever is
// stored, what comes back is made of the editor's fields, each a primitive of
// the editor's kind (a name and a parameter value cut as the server cuts them,
// an assertion's path and value whole), encodable, and sharing nothing with
// anything else.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage, StorageEvent, listenerErrors } from './shim.mjs';
import { resetState, get } from '../js/store.js';
import * as runner from '../js/render-runner.js';
import { createSavedCollections } from '../js/run-config.js';

const SETUP = 'courier.runner.v1';
const SAVED = 'courier.collections.v1';

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

// ------------------------------------------------------------------ building raw text

const MISSING = Symbol('missing');
class Raw {
  constructor(text) { this.text = text; }
}
const raw = (text) => new Raw(text);

// ser writes JSON, leaving out MISSING members and writing Raw text as it is,
// so a value JSON.stringify would change (-0, 1e999, a "__proto__" member, a
// structure no recursive encoder survives) reaches storage as written.
function ser(v) {
  if (v instanceof Raw) return v.text;
  if (Array.isArray(v)) return `[${v.map((x) => (x === MISSING ? 'null' : ser(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v).filter(([, x]) => x !== MISSING).map(([k, x]) => `${JSON.stringify(k)}:${ser(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// withAt copies obj with the member at path replaced, or removed for MISSING.
function withAt(obj, path, value) {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const copy = Array.isArray(obj) ? obj.slice() : { ...obj };
  copy[head] = withAt(obj[head], rest, value);
  return copy;
}

const deep = (n, open = '[', close = ']') => raw(`${open.repeat(n)}${close.repeat(n)}`);
const deepObject = (n) => raw(`${'{"a":'.repeat(n)}1${'}'.repeat(n)}`);

// 120 characters whose last pair straddles the cut, and 256 and 500 the same way.
const straddle = (n) => `${'x'.repeat(n - 1)}\u{1F600}${'y'.repeat(5)}`;

const VALUES = {
  missing: MISSING,
  null: null,
  true: true,
  false: false,
  empty: '',
  space: ' ',
  one: 'x',
  len120: 'n'.repeat(120),
  len121: 'n'.repeat(121),
  len200: 'i'.repeat(200),
  len201: 'i'.repeat(201),
  len256: 'v'.repeat(256),
  len257: 'v'.repeat(257),
  words33: Array.from({ length: 33 }, () => 'w').join(' '),
  len500: 'v'.repeat(500),
  len501: 'v'.repeat(501),
  multibyte501: '€'.repeat(501),
  pairs251: '\u{1F600}'.repeat(251),
  straddle120: straddle(120),
  straddle256: straddle(256),
  straddle500: straddle(500),
  longText: 'z'.repeat(100000),
  zero: 0,
  one_n: 1,
  negative: -1,
  fraction: 2.5,
  negZero: raw('-0'),
  big: raw('1e308'),
  infinite: raw('1e999'),
  negInfinite: raw('-1e999'),
  exponent: raw('1E2'),
  emptyArray: [],
  array: [7],
  nestedArray: [[[1]]],
  object: { a: 1 },
  protoObject: raw('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}'),
  deepArray: deep(20000),
  deepObject: deepObject(20000),
};

// ------------------------------------------------------------------ the bases

const REQUEST = {
  id: 'ws-1',
  name: 'Mine',
  endpoint: 'search',
  params: { q: 'pikachu' },
  assertions: [{ type: 'json', path: '$.total', op: 'gt', value: 1 }],
};
const SETUP_VALUE = {
  version: 1,
  sequence: [{ enabled: true, request: REQUEST }],
  mode: 'performance',
  options: { stop_on_failure: true, delay_ms: 5, concurrency: 25, duration_secs: 20 },
};
const SAVED_VALUE = { version: 1, collections: [{ id: 'wc-1', name: 'All', requests: [REQUEST] }] };

const requestPaths = [
  ['id'], ['name'], ['endpoint'], ['params'], ['params', 'q'], ['assertions'], ['assertions', 0],
  ['assertions', 0, 'type'], ['assertions', 0, 'op'], ['assertions', 0, 'path'], ['assertions', 0, 'value'],
];
const setupPaths = [
  ['version'], ['sequence'], ['sequence', 0], ['sequence', 0, 'enabled'], ['sequence', 0, 'request'], ['mode'], ['options'],
  ['options', 'stop_on_failure'], ['options', 'delay_ms'], ['options', 'concurrency'], ['options', 'duration_secs'],
  ...requestPaths.map((p) => ['sequence', 0, 'request', ...p]),
];
const savedPaths = [
  ['version'], ['collections'], ['collections', 0], ['collections', 0, 'id'], ['collections', 0, 'name'],
  ['collections', 0, 'requests'], ['collections', 0, 'requests', 0],
  ...requestPaths.map((p) => ['collections', 0, 'requests', 0, ...p]),
];

// ------------------------------------------------------------------ what comes back

const ASSERTION_OPS = {
  status: ['eq', 'neq'],
  latency: ['lt'],
  json: ['eq', 'neq', 'gt', 'lt', 'exists', 'contains', 'count'],
  body_contains: ['contains'],
};
const LIMITS = { delay_ms: [0, 1000], concurrency: [1, 50], duration_secs: [1, 30] };

function checkRequest(r, where) {
  const say = (m) => `${where}: ${m}`;
  assert.deepEqual(Object.keys(r), ['id', 'name', 'endpoint', 'params', 'assertions'], say('keys'));
  assert.equal(Object.getPrototypeOf(r), Object.prototype, say('prototype'));
  for (const k of ['id', 'endpoint']) assert.ok(typeof r[k] === 'string' && r[k].length >= 1 && r[k].length <= 200, say(k));
  assert.ok(typeof r.name === 'string' && r.name.length <= 120, say('name'));
  assert.equal(Object.getPrototypeOf(r.params), Object.prototype, say('params prototype'));
  const params = Object.entries(r.params);
  assert.ok(params.length <= 32, say('params count'));
  for (const [k, v] of params) {
    assert.ok(k.length >= 1 && k.length <= 64, say(`param key ${k.length}`));
    assert.ok(typeof v === 'string' && [...v].length <= 256 && v.split(/\s+/).filter(Boolean).length <= 32, say('param value'));
  }
  assert.ok(Array.isArray(r.assertions) && r.assertions.length <= 20, say('assertions'));
  for (const a of r.assertions) {
    assert.equal(Object.getPrototypeOf(a), Object.prototype, say('assertion prototype'));
    for (const k of Object.keys(a)) assert.ok(['type', 'op', 'path', 'value'].includes(k), say(`assertion key ${k}`));
    assert.ok(Object.hasOwn(ASSERTION_OPS, a.type) && ASSERTION_OPS[a.type].includes(a.op), say(`pair ${a.type} ${a.op}`));
    // A path and a text value are kept at any length: text cannot nest.
    if ('path' in a) assert.ok(a.type === 'json' && typeof a.path === 'string', say('path'));
    if ('value' in a) {
      const ok = typeof a.value === 'string' || (a.type !== 'body_contains' && Number.isFinite(a.value));
      assert.ok(ok, say(`value ${String(a.value).slice(0, 20)}`));
    }
  }
  // Encodable by the recursive encoders the page uses, and cloneable.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(r)), say('encodes'));
}

function checkSetup(loaded, where) {
  assert.ok(loaded.sequence.length <= 50, where);
  for (const e of loaded.sequence) {
    assert.deepEqual(Object.keys(e).sort(), ['enabled', 'key', 'request'], where);
    assert.equal(typeof e.enabled, 'boolean', where);
    checkRequest(e.request, where);
  }
  assert.ok(['functional', 'performance'].includes(loaded.mode), where);
  assert.deepEqual(Object.keys(loaded.options), ['stop_on_failure', 'delay_ms', 'concurrency', 'duration_secs'], where);
  assert.equal(typeof loaded.options.stop_on_failure, 'boolean', where);
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const n = loaded.options[k];
    assert.ok(Number.isInteger(n) && n >= lo && n <= hi, `${where}: ${k}=${n}`);
  }
}

function restoreSaved(area) {
  let state = { savedCollections: [] };
  const saved = createSavedCollections({ storage: area, get: () => state, set: (p) => { state = { ...state, ...p }; }, maxRequests: 50 });
  saved.init();
  return state.savedCollections;
}

function checkSaved(collections, where) {
  for (const c of collections) {
    assert.deepEqual(Object.keys(c), ['id', 'name', 'requests'], where);
    assert.ok(typeof c.id === 'string' && c.id.length >= 1 && c.id.length <= 200, where);
    assert.ok(typeof c.name === 'string' && c.name.length <= 120, where);
    assert.ok(c.requests.length <= 50, where);
    c.requests.forEach((r, i) => checkRequest(r, `${where} request ${i}`));
  }
}

const proto = () => Object.keys(Object.prototype).join();

// ------------------------------------------------------------------ the tests

test('a stored run setup restores without throwing, as checked fields, whatever kind of value each field holds', () => {
  let cases = 0;
  for (const path of setupPaths) {
    for (const [name, value] of Object.entries(VALUES)) {
      const text = ser(withAt(SETUP_VALUE, path, value));
      const area = new FakeStorage();
      area.setItem(SETUP, text);
      const where = `${path.join('.')} = ${name}`;
      let first;
      assert.doesNotThrow(() => { first = runner.createRunSetup(area).load(); }, where);
      checkSetup(first, where);
      const second = runner.createRunSetup(area).load();
      assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)), `${where}: a second restore differs`);
      cases += 1;
    }
  }
  assert.ok(cases > 300);
  assert.equal(proto(), '', 'Object.prototype was written to');
  assert.equal(({}).polluted, undefined);
  assert.deepEqual(listenerErrors, []);
});

test('a stored saved collection restores without throwing, as checked fields, whatever kind of value each field holds', () => {
  for (const path of savedPaths) {
    for (const [name, value] of Object.entries(VALUES)) {
      const area = new FakeStorage();
      area.setItem(SAVED, ser(withAt(SAVED_VALUE, path, value)));
      const where = `${path.join('.')} = ${name}`;
      let collections;
      assert.doesNotThrow(() => { collections = restoreSaved(area); }, where);
      checkSaved(collections, where);
    }
  }
  assert.equal(proto(), '', 'Object.prototype was written to');
  assert.equal(({}).polluted, undefined);
});

test('a hostile saved collection written by another tab is rebuilt when its storage event arrives', () => {
  const area = new FakeStorage();
  let state = { savedCollections: [] };
  const saved = createSavedCollections({ storage: area, get: () => state, set: (p) => { state = { ...state, ...p }; }, target: globalThis, maxRequests: 50 });
  saved.init();

  const hostile = {
    ...REQUEST,
    url: 'http://192.0.2.10/', method: 'DELETE',
    params: raw('{"q":"x","__proto__":"kept as data"}'),
    assertions: [{ type: 'json', path: '$', op: 'eq', value: deep(10000), url: 'http://192.0.2.10/y' }, { type: 'status', op: 'eq', value: 200, host: '192.0.2.10' }],
  };
  area.setItem(SAVED, ser({ version: 1, collections: [{ id: 'wc-9', name: 'From elsewhere', requests: [hostile], extra: 1 }] }));
  window.dispatchEvent(new StorageEvent('storage', { key: SAVED, newValue: area.peek(SAVED), storageArea: area }));
  assert.deepEqual(listenerErrors, []);

  assert.equal(state.savedCollections.length, 1);
  checkSaved(state.savedCollections, 'event');
  assert.deepEqual(state.savedCollections[0].requests[0].assertions, [{ type: 'json', path: '$', op: 'eq' }, { type: 'status', op: 'eq', value: 200 }]);
  assert.equal(proto(), '');
});

test('a saved collection and the run setup hold copies: changing the queued request afterwards changes neither', () => {
  const area = new FakeStorage();
  let state = { savedCollections: [] };
  const saved = createSavedCollections({ storage: area, get: () => state, set: (p) => { state = { ...state, ...p }; }, maxRequests: 50 });
  saved.init();

  const queued = JSON.parse(JSON.stringify(REQUEST));
  const { collection } = saved.create('Copy', [queued]);
  queued.params.q = 'changed';
  queued.assertions[0].value = 999;
  queued.assertions.push({ type: 'status', op: 'eq', value: 200 });
  queued.name = 'changed';

  assert.deepEqual(saved.find(collection.id).requests[0], REQUEST, 'the saved copy followed the queued request');
  assert.notEqual(saved.find(collection.id).requests[0], queued);
  assert.notEqual(saved.find(collection.id).requests[0].params, queued.params);
  assert.notEqual(saved.find(collection.id).requests[0].assertions[0], queued.assertions[0]);

  // Mutating the published copy does not reach what storage will give a second tab.
  saved.find(collection.id).requests[0].params.q = 'edited in place';
  assert.deepEqual(restoreSaved(area)[0].requests[0], REQUEST);
});

test('a restored run setup shares no object with the one restored from the same storage', () => {
  const area = new FakeStorage();
  area.setItem(SETUP, ser(SETUP_VALUE));
  const a = runner.createRunSetup(area).load();
  const b = runner.createRunSetup(area).load();
  assert.notEqual(a.sequence[0].request, b.sequence[0].request);
  assert.notEqual(a.sequence[0].request.params, b.sequence[0].request.params);
  assert.notEqual(a.sequence[0].request.assertions[0], b.sequence[0].request.assertions[0]);
  assert.notEqual(a.options, b.options);
  a.sequence[0].request.params.q = 'x';
  a.sequence[0].request.assertions.length = 0;
  a.options.concurrency = 1;
  assert.deepEqual(runner.createRunSetup(area).load().sequence[0].request, REQUEST);
  assert.equal(get().sequence.length, 0);
});
