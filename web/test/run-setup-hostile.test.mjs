// What a hostile or damaged stored run setup can do to the page: nothing may
// throw, nothing may exceed the limits the inputs enforce, no prototype may be
// polluted, and a run started from a restored setup may send only the keys the
// page sends for a request the visitor built by hand. Then the write side: what
// writes the setup, what does not, and what the page does when the browser
// refuses or is gone.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, StorageEvent, localStorage, fetchStub, typeInto, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set } from '../js/store.js';
import * as runner from '../js/render-runner.js';

const KEY = 'courier.runner.v1';
const REFUSED = 'Could not save the run setup in this browser.';
const byId = (id) => document.getElementById(id);
const req = (n, extra = {}) => ({ id: `h${n}`, name: `Hostile ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [{ type: 'status', op: 'eq', value: 200 }], ...extra });
const valid = (sequence, extra = {}) => JSON.stringify({ version: 1, sequence, mode: 'functional', options: {}, ...extra });

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

// What the inputs enforce, and what a request the page builds looks like.
function assertWithinLimits(state, label) {
  assert.ok(state.sequence.length <= 50, `${label}: at most 50 queued`);
  const keys = new Set();
  for (const e of state.sequence) {
    assert.deepEqual(Object.keys(e).sort(), ['enabled', 'key', 'request'], label);
    assert.equal(typeof e.enabled, 'boolean', label);
    assert.equal(keys.has(e.key), false, `${label}: entry keys are unique`);
    keys.add(e.key);
    assert.deepEqual(Object.keys(e.request).sort(), ['assertions', 'endpoint', 'id', 'name', 'params'], label);
    for (const v of Object.values(e.request.params)) assert.equal(typeof v, 'string', label);
  }
  assert.ok(['functional', 'performance'].includes(state.mode), `${label}: mode`);
  const o = state.options;
  assert.deepEqual(Object.keys(o).sort(), ['concurrency', 'delay_ms', 'duration_secs', 'stop_on_failure'], label);
  assert.ok(Number.isInteger(o.concurrency) && o.concurrency >= 1 && o.concurrency <= 50, `${label}: concurrency ${o.concurrency}`);
  assert.ok(Number.isInteger(o.duration_secs) && o.duration_secs >= 1 && o.duration_secs <= 30, `${label}: duration ${o.duration_secs}`);
  assert.ok(Number.isInteger(o.delay_ms) && o.delay_ms >= 0 && o.delay_ms <= 1000, `${label}: delay ${o.delay_ms}`);
  assert.equal(typeof o.stop_on_failure, 'boolean', label);
}

// ---------------------------------------------------------------- hostile values at load

test('no stored run setup, however hostile, throws at load, exceeds a limit the inputs enforce, or pollutes a prototype', () => {
  const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort().join();
  const poison = '{"polluted":"yes"}';
  const raws = [
    '5'.repeat(5 * 1024 * 1024),
    JSON.stringify('x'.repeat(5 * 1024 * 1024)),
    'null', '[]', '"str"', '{"version":1', '{"version":"1","sequence":[]}',
    `{"version":1,"__proto__":${poison},"sequence":[{"enabled":true,"__proto__":${poison},"request":{"id":"a","endpoint":"e","__proto__":${poison},"constructor":{"prototype":${poison}},"params":{"__proto__":"x","constructor":"y"},"assertions":[{"__proto__":${poison},"type":"status","op":"eq","value":1}]}}],"mode":"performance","options":{"__proto__":${poison},"concurrency":3}}`,
    valid(Array.from({ length: 500 }, (_, i) => ({ enabled: true, request: req(i) }))),
    valid(Array.from({ length: 500 }, () => 5)),
    valid(Array.from({ length: 50 }, () => ({ enabled: true, request: null }))),
    valid(Array.from({ length: 3 }, (_, i) => ({ enabled: 'yes', request: req(i) }))),
    valid(Array.from({ length: 3 }, () => ({ enabled: true, request: req(1) }))), // duplicate ids
    valid([{ enabled: true, request: req(1, { assertions: Array.from({ length: 1000 }, () => ({ type: 'status', op: 'eq', value: 200 })) }) }]),
    valid([{ enabled: true, request: req(1, { assertions: [1, 'a', null] }) }]),
    valid([{ enabled: true, request: req(1, { params: { a: { b: 1 }, c: 'd' } }) }]),
    valid([], { options: { concurrency: 1e9, duration_secs: 1e9, delay_ms: 1e9 } }),
    valid([], { options: { concurrency: 'x', duration_secs: 'Infinity', delay_ms: null } }),
    valid([], { options: { concurrency: -1, duration_secs: 2.5, delay_ms: -0.5 } }),
    valid([], { options: { concurrency: 1e21, duration_secs: 1e-7, delay_ms: 1.5e3 } }),
    valid([], { options: { concurrency: [7], duration_secs: { n: 3 }, delay_ms: true } }),
    valid([], { options: { concurrency: ' 9 ', duration_secs: '0x10', delay_ms: '12abc' } }),
    valid([], { options: {} }),
    valid([], { options: undefined }),
    valid([], { mode: 'PERFORMANCE' }),
    valid([], { mode: 42 }),
    valid([], { mode: { toString: 'performance' } }),
    valid([], { mode: ['performance'] }),
  ];
  for (const [i, raw] of raws.entries()) {
    resetState();
    localStorage.setItem(KEY, raw);
    assert.doesNotThrow(() => runner.restore(), `value ${i}`);
    assertWithinLimits(get(), `value ${i}`);
    assert.doesNotThrow(() => runner.render(get()), `render of value ${i}`);
  }
  assert.equal(({}).polluted, undefined, 'Object.prototype was polluted');
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(), protoBefore);

  // A __proto__ key in a request is data, not a prototype, wherever it ends up.
  resetState();
  localStorage.setItem(KEY, raws[7]);
  runner.restore();
  const [only] = get().sequence;
  assert.equal(Object.getPrototypeOf(only.request), Object.prototype);
  assert.equal(only.request.polluted, undefined);
  assert.equal(get().options.polluted, undefined);
});

test('a restored sequence of hostile entries keeps what is usable, in order, and queued entries from a 500-entry value stop at 50', () => {
  localStorage.setItem(KEY, valid([
    ...Array.from({ length: 4 }, () => ({ enabled: true, request: req(1) })), // duplicate ids stay four entries
    { enabled: 'yes', request: req(2) },
    5,
    { enabled: false, request: req(3) },
    ...Array.from({ length: 100 }, (_, i) => ({ enabled: true, request: req(10 + i) })),
  ]));
  runner.restore();
  const seq = get().sequence;
  assert.equal(seq.length, 50);
  assert.deepEqual(seq.slice(0, 5).map((e) => [e.request.id, e.enabled]), [['h1', true], ['h1', true], ['h1', true], ['h1', true], ['h3', false]]);
  assert.equal(new Set(seq.map((e) => e.key)).size, 50, 'duplicate ids still get their own entry keys');
  runner.render(get());
  assert.equal(byId('sequence-list').querySelectorAll('input[type="checkbox"]').length, 50);
  assert.equal(byId('sequence-count').textContent, '50 of 50 - 49 selected');
});

// ---------------------------------------------------------------- what reaches the wire

test('a restored run sends only the keys the page sends for a request built by hand, at every level', async () => {
  const smuggled = { url: 'http://192.0.2.10/x', host: '192.0.2.10', method: 'DELETE', headers: { 'X-A': '1' }, constructor: { prototype: { x: 1 } } };
  localStorage.setItem(KEY, JSON.stringify({
    version: 1,
    smuggledTop: 1,
    sequence: [{ enabled: true, extra: 1, request: req(1, { ...smuggled, assertions: [{ type: 'status', op: 'eq', value: 200, url: 'http://192.0.2.10/y', host: '192.0.2.10' }] }) }],
    mode: 'functional',
    options: { concurrency: 3, url: 'http://192.0.2.10/z', host: 'x' },
  }));
  runner.init({});
  runner.restore();
  runner.render(get());
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'x' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  const body = fetchStub.calls[0].json();
  assert.deepEqual(Object.keys(body).sort(), ['mode', 'options', 'sequence']);
  assert.deepEqual(Object.keys(body.options).sort(), ['concurrency', 'delay_ms', 'duration_secs', 'stop_on_failure']);
  assert.deepEqual(Object.keys(body.sequence[0]).sort(), ['assertions', 'endpoint', 'id', 'name', 'params']);
  // An assertion has four fields the editor can set; a stored extra one is not among them.
  for (const a of body.sequence[0].assertions) {
    for (const k of Object.keys(a)) assert.ok(['type', 'op', 'value', 'path'].includes(k), `assertion key ${k} was sent to the server`);
  }
});

test('a stored assertion nested ten thousand levels deep does not make the page throw or wedge Start', async () => {
  const depth = 10000;
  const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`;
  const raw = `{"version":1,"sequence":[{"enabled":true,"request":{"id":"deep","endpoint":"search","name":"deep","params":{},"assertions":[{"type":"json","path":"a","op":"eq","value":${nested}}]}},{"enabled":true,"request":${JSON.stringify(req(2))}}],"mode":"functional","options":{}}`;
  localStorage.setItem(KEY, raw);
  runner.init({});
  assert.doesNotThrow(() => runner.restore());
  assert.doesNotThrow(() => runner.render(get()), 'rendering the restored sequence');

  // Whatever became of the deep entry, the visitor can still work with the rest.
  const visible = byId('sequence-list').querySelectorAll('.seq-row').length;
  assert.equal(visible, get().sequence.length, 'every restored entry is shown, or none is restored');
  assert.doesNotThrow(() => runner.add(req(3)), 'queueing another request');

  fetchStub.respond('/api/runs', { status: 400, body: { error: 'x' } }, { method: 'POST' });
  runner.render(get());
  byId('start-run').click();
  await flush();
  assert.deepEqual(listenerErrors, [], 'Start');
  runner.render(get());
  assert.equal(byId('start-run').textContent, 'Start run', 'Start is not stuck on "Starting..."');
  assert.equal(byId('start-run').disabled, false);
});

// ---------------------------------------------------------------- when the setup is written

test('a refused write shows the note on the first change and the next accepted write clears it, with a status poll between', () => {
  runner.init({});
  runner.restore();
  localStorage.failOn('setItem');
  byId('mode-performance').click();
  runner.render(get());
  assert.equal(byId('sequence-note').textContent, REFUSED);
  set({ status: { running: false } });
  runner.render(get());
  assert.equal(byId('sequence-note').textContent, REFUSED, 'a poll does not clear the note');
  localStorage.heal();
  byId('mode-functional').click();
  runner.render(get());
  assert.equal(byId('sequence-note').hidden, true);
  assert.equal(JSON.parse(localStorage.peek(KEY)).mode, 'functional');
});

test('storage that throws on every call from the start leaves the runner fully usable', async () => {
  localStorage.failOn('getItem');
  localStorage.failOn('setItem');
  localStorage.failOn('removeItem');
  runner.init({});
  assert.doesNotThrow(() => runner.restore());
  assert.doesNotThrow(() => runner.savedCollections.init());
  runner.add(req(1));
  runner.add(req(2));
  runner.render(get());
  byId('mode-performance').click();
  typeInto(byId('concurrency'), '7');
  byId('sequence-list').querySelectorAll('input[type="checkbox"]')[0].click();
  typeInto(byId('save-sequence-name'), 'Nowhere');
  byId('save-sequence').click();
  runner.render(get());
  assert.deepEqual(listenerErrors, [], 'a handler threw');
  assert.equal(get().sequence.length, 2);
  assert.equal(get().options.concurrency, 7);
  assert.ok(byId('sequence-note').textContent.includes(REFUSED));

  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'r-1' } }, { method: 'POST' });
  fetchStub.respond('/api/status', { body: { running: true, run_id: 'r-1' } });
  byId('start-run').click();
  await flush();
  assert.deepEqual(listenerErrors, [], 'Start threw');
  const body = fetchStub.calls[0].json();
  assert.equal(body.mode, 'performance');
  assert.equal(body.sequence.length, 1, 'only the checked request is sent');
  assert.equal(body.options.concurrency, 7);
});

// ---------------------------------------------------------------- two tabs

test('another tab writing the setup is never adopted here, not by an event, a render, a poll or an option change, until this tab writes', () => {
  runner.init({});
  runner.restore();
  runner.add(req(1));
  runner.add(req(2));
  const mine = get().sequence;
  const theirs = valid([{ enabled: true, request: req(7) }], { mode: 'performance', options: { concurrency: 50 } });

  localStorage.writeFromAnotherTab(KEY, theirs);
  // An event whose newValue is stale and one for a cleared store: neither is read.
  window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: theirs, storageArea: localStorage }));
  window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null, storageArea: localStorage }));
  for (let i = 0; i < 5; i += 1) {
    set({ status: { running: false, budget_balance: 100 + i } });
    runner.render(get());
  }
  assert.equal(get().sequence, mine, 'the very same sequence is still shown');
  assert.equal(get().mode, 'functional');
  assert.equal(localStorage.peek(KEY), theirs, 'and nothing was written over theirs by a poll or event');

  // A change in this tab stores this tab's setup whole.
  byId('stop-on-failure').click();
  const stored = JSON.parse(localStorage.peek(KEY));
  assert.deepEqual(stored.sequence.map((e) => e.request.id), ['h1', 'h2']);
  assert.equal(stored.mode, 'functional');
  assert.equal(stored.options.stop_on_failure, true);
  assert.equal(stored.options.concurrency, 10);
});

test('a second page loading while the first has a setup stored gets the first one, and the first is not changed by it', () => {
  runner.init({});
  runner.restore();
  runner.add(req(1));
  const stored = localStorage.peek(KEY);
  const first = get().sequence;
  resetState();
  runner.restore(); // the second tab's load
  assert.equal(get().sequence.length, 1);
  assert.equal(localStorage.peek(KEY), stored, 'loading writes nothing');
  assert.notEqual(get().sequence, first);
});
