// The run setup (sequence, mode, options) kept in this browser: what is
// stored, what a fresh page over the same storage restores, and what a stored
// value it cannot trust turns into.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage, localStorage, fetchStub, typeInto, flush } from './shim.mjs';
import { resetState, get, set } from '../js/store.js';
import * as runner from '../js/render-runner.js';

const KEY = 'courier.runner.v1';
const REFUSED = 'Could not save the run setup in this browser.';
const DEFAULT_OPTIONS = { stop_on_failure: false, delay_ms: 0, concurrency: 10, duration_secs: 10 };

const req = (n, extra = {}) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [{ type: 'status', op: 'eq', value: 200 }], ...extra });
const entry = (n, enabled = true) => ({ key: `k${n}`, enabled, request: req(n) });
const strip = (seq) => seq.map(({ enabled, request }) => ({ enabled, request }));

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

// ---------------------------------------------------------------- survives a reload

test('a fresh run setup over the same storage restores the sequence, its order and checks, the mode and the options', () => {
  const shared = new FakeStorage();
  const options = { stop_on_failure: true, delay_ms: 0, concurrency: 25, duration_secs: 20 };
  const saved = runner.createRunSetup(shared).save({
    sequence: [entry(1), entry(2, false), entry(3)],
    mode: 'performance',
    options,
  });
  assert.equal(saved.ok, true);

  const stored = JSON.parse(shared.peek(KEY));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.sequence, [
    { enabled: true, request: req(1) },
    { enabled: false, request: req(2) },
    { enabled: true, request: req(3) },
  ]);

  const loaded = runner.createRunSetup(shared).load();
  assert.deepEqual(strip(loaded.sequence), [
    { enabled: true, request: req(1) },
    { enabled: false, request: req(2) },
    { enabled: true, request: req(3) },
  ]);
  assert.equal(new Set(loaded.sequence.map((e) => e.key)).size, 3, 'every restored entry has its own key');
  assert.equal(loaded.mode, 'performance');
  assert.deepEqual(loaded.options, options);
});

test('queueing three, unchecking one, and choosing performance at 25 workers for 20s comes back after a reload', () => {
  runner.init({});
  runner.add(req(1));
  runner.add(req(2));
  runner.add(req(3));
  runner.render(get());

  const checks = document.getElementById('sequence-list').querySelectorAll('input[type="checkbox"]');
  checks[1].click();
  document.getElementById('mode-performance').click();
  runner.render(get());
  typeInto(document.getElementById('concurrency'), '25');
  typeInto(document.getElementById('duration-secs'), '20');

  const loaded = runner.createRunSetup(localStorage).load();
  assert.deepEqual(strip(loaded.sequence), [
    { enabled: true, request: req(1) },
    { enabled: false, request: req(2) },
    { enabled: true, request: req(3) },
  ]);
  assert.equal(loaded.mode, 'performance');
  assert.deepEqual(loaded.options, { ...DEFAULT_OPTIONS, concurrency: 25, duration_secs: 20 });

  // The reload: a fresh page state, restored from what is stored.
  resetState();
  runner.restore();
  assert.deepEqual(strip(get().sequence), strip(loaded.sequence));
  assert.equal(get().mode, 'performance');
  assert.deepEqual(get().options, { ...DEFAULT_OPTIONS, concurrency: 25, duration_secs: 20 });
  runner.render(get());
  assert.equal(document.getElementById('sequence-count').textContent, '3 of 50 - 2 selected');
  assert.equal(document.getElementById('concurrency').value, '25');
});

test('restoring the setup writes nothing back', () => {
  localStorage.setItem(KEY, JSON.stringify({ version: 1, sequence: [{ enabled: true, request: req(1) }], mode: 'functional', options: DEFAULT_OPTIONS }));
  const before = localStorage.peek(KEY);
  localStorage.failOn('setItem');
  runner.restore();
  localStorage.heal();
  assert.equal(localStorage.peek(KEY), before);
  assert.equal(get().sequence.length, 1);
});

// ---------------------------------------------------------------- bad values

const defaults = (loaded) => {
  assert.deepEqual(loaded.sequence, []);
  assert.equal(loaded.mode, 'functional');
  assert.deepEqual(loaded.options, DEFAULT_OPTIONS);
};

test('a wrong-version, garbage, null or non-object value loads the defaults', () => {
  const values = [
    JSON.stringify({ version: 2, sequence: [{ enabled: true, request: req(1) }], mode: 'performance', options: { concurrency: 25 } }),
    JSON.stringify({ sequence: [{ enabled: true, request: req(1) }], mode: 'performance' }),
    '{not json',
    'null',
    '42',
    '"performance"',
    '[]',
    JSON.stringify([{ version: 1 }]),
    '',
  ];
  for (const raw of values) {
    const shared = new FakeStorage();
    shared.setItem(KEY, raw);
    defaults(runner.createRunSetup(shared).load());
  }
  defaults(runner.createRunSetup(new FakeStorage()).load());
});

test('a stored value with the right version but wrong parts keeps only the parts it can use', () => {
  const shared = new FakeStorage();
  shared.setItem(KEY, JSON.stringify({ version: 1, sequence: 'all of them', mode: 7, options: 'fast' }));
  defaults(runner.createRunSetup(shared).load());

  shared.setItem(KEY, JSON.stringify({ version: 1, sequence: [{ enabled: true, request: req(1) }], mode: 'chaos', options: [25] }));
  const loaded = runner.createRunSetup(shared).load();
  assert.deepEqual(strip(loaded.sequence), [{ enabled: true, request: req(1) }]);
  assert.equal(loaded.mode, 'functional');
  assert.deepEqual(loaded.options, DEFAULT_OPTIONS);
});

test('a stored sequence longer than 50 is cut to the first 50', () => {
  const shared = new FakeStorage();
  const sequence = Array.from({ length: 500 }, (_, i) => ({ enabled: i % 2 === 0, request: req(i) }));
  shared.setItem(KEY, JSON.stringify({ version: 1, sequence, mode: 'performance', options: {} }));
  const loaded = runner.createRunSetup(shared).load();
  assert.equal(loaded.sequence.length, 50);
  assert.deepEqual(strip(loaded.sequence), sequence.slice(0, 50));
  assert.equal(loaded.mode, 'performance');
});

test('entries that are not objects, or hold a malformed request, are dropped', () => {
  const shared = new FakeStorage();
  const good = { enabled: true, request: req(1) };
  shared.setItem(KEY, JSON.stringify({
    version: 1,
    sequence: [
      null, 5, 'r1', [], { enabled: true }, { request: req(9) }, { enabled: 'yes', request: req(9) },
      { enabled: true, request: null },
      { enabled: true, request: { id: 'x' } },
      { enabled: true, request: { endpoint: 'search' } },
      { enabled: true, request: req(9, { id: '' }) },
      { enabled: true, request: req(9, { id: 7 }) },
      { enabled: true, request: req(9, { endpoint: '' }) },
      { enabled: true, request: req(9, { name: { x: 1 } }) },
      { enabled: true, request: req(9, { params: { q: 5 } }) },
      { enabled: true, request: req(9, { params: ['q'] }) },
      { enabled: true, request: req(9, { assertions: 'status' }) },
      { enabled: true, request: req(9, { assertions: [null] }) },
      good,
      { enabled: false, request: req(2, { params: null, assertions: null }) },
    ],
    mode: 'functional',
    options: {},
  }));
  const loaded = runner.createRunSetup(shared).load();
  assert.deepEqual(strip(loaded.sequence), [good, { enabled: false, request: req(2, { params: {}, assertions: [] }) }]);
});

test('a stored request keeps only the fields a run sends: no url, host or method comes back from storage', () => {
  const shared = new FakeStorage();
  shared.setItem(KEY, JSON.stringify({
    version: 1,
    sequence: [{ enabled: true, extra: 1, request: req(1, { url: 'http://192.0.2.10/admin', host: '192.0.2.10', method: 'DELETE', headers: { 'X-A': '1' } }) }],
    mode: 'functional',
    options: {},
  }));
  const [restored] = runner.createRunSetup(shared).load().sequence;
  assert.deepEqual(Object.keys(restored).sort(), ['enabled', 'key', 'request']);
  assert.deepEqual(restored.request, req(1));
});

test('stored options are clamped by the same rules as the inputs', () => {
  const cases = [
    [{ concurrency: 1e9 }, { concurrency: 50 }],
    [{ concurrency: 'x' }, { concurrency: 10 }],
    [{ concurrency: -1 }, { concurrency: 10 }],
    [{ concurrency: 0 }, { concurrency: 10 }],
    [{ concurrency: 2.5 }, { concurrency: 2 }],
    [{ concurrency: '25' }, { concurrency: 25 }],
    [{ concurrency: null }, { concurrency: 10 }],
    [{ concurrency: { n: 5 } }, { concurrency: 10 }],
    [{ duration_secs: 0 }, { duration_secs: 10 }],
    [{ duration_secs: 31 }, { duration_secs: 30 }],
    [{ duration_secs: 30 }, { duration_secs: 30 }],
    [{ delay_ms: -5 }, { delay_ms: 0 }],
    [{ delay_ms: 5000 }, { delay_ms: 1000 }],
    [{ delay_ms: 250 }, { delay_ms: 250 }],
    [{ stop_on_failure: 'yes' }, { stop_on_failure: false }],
    [{ stop_on_failure: 1 }, { stop_on_failure: false }],
    [{ stop_on_failure: true }, { stop_on_failure: true }],
    [{ surprise: 'x' }, {}],
  ];
  for (const [stored, want] of cases) {
    const shared = new FakeStorage();
    shared.setItem(KEY, JSON.stringify({ version: 1, sequence: [], mode: 'performance', options: stored }));
    assert.deepEqual(runner.createRunSetup(shared).load().options, { ...DEFAULT_OPTIONS, ...want }, JSON.stringify(stored));
  }
});

test('a stored mode other than functional or performance loads as functional', () => {
  for (const mode of ['chaos', 'Performance', '', null, 1, ['performance']]) {
    const shared = new FakeStorage();
    shared.setItem(KEY, JSON.stringify({ version: 1, sequence: [], mode, options: {} }));
    assert.equal(runner.createRunSetup(shared).load().mode, 'functional', JSON.stringify(mode));
  }
});

// ---------------------------------------------------------------- refused reads and writes

test('a refused read, or a storage that cannot be reached at all, loads the defaults without throwing', () => {
  const shared = new FakeStorage();
  shared.setItem(KEY, JSON.stringify({ version: 1, sequence: [{ enabled: true, request: req(1) }], mode: 'performance', options: {} }));
  shared.failOn('getItem');
  defaults(runner.createRunSetup(shared).load());

  defaults(runner.createRunSetup(() => { throw new Error('SecurityError'); }).load());

  localStorage.setItem(KEY, shared.peek(KEY));
  localStorage.failOn('getItem');
  assert.doesNotThrow(() => runner.restore());
  assert.deepEqual(get().sequence, []);
  assert.equal(get().mode, 'functional');
});

test('a refused write throws nothing, and the sequence note says the setup was not saved', () => {
  const shared = new FakeStorage();
  shared.failOn('setItem');
  assert.equal(runner.createRunSetup(shared).save({ sequence: [entry(1)], mode: 'functional', options: DEFAULT_OPTIONS }).ok, false);

  runner.init({});
  localStorage.failOn('setItem');
  assert.doesNotThrow(() => runner.add(req(1)));
  runner.render(get());
  const note = document.getElementById('sequence-note');
  assert.equal(note.textContent, REFUSED);
  assert.equal(note.hidden, false);
  assert.equal(get().sequence.length, 1, 'the page keeps the change it could not store');

  // Every kind of setup change is a write, and says so when it is refused.
  set({ sequence: [] });
  document.getElementById('mode-performance').click();
  runner.render(get());
  assert.equal(note.textContent, REFUSED);

  // Once a write is accepted again the note goes, and what is stored is the
  // whole setup as the page shows it.
  localStorage.heal();
  runner.add(req(2));
  runner.render(get());
  assert.equal(note.hidden, true);
  const stored = JSON.parse(localStorage.peek(KEY));
  assert.equal(stored.mode, 'performance');
  assert.deepEqual(stored.sequence, [{ enabled: true, request: req(2) }]);
});

test('a refused write and a cap note are both said', () => {
  runner.init({});
  set({ sequence: Array.from({ length: 48 }, (_, i) => entry(100 + i)) });
  localStorage.failOn('setItem');
  runner.addAll({ id: 'c', name: 'C', requests: [req(1), req(2), req(3)] });
  runner.render(get());
  assert.equal(document.getElementById('sequence-note').textContent, `Added 2 of 3 - 50 requests is the cap. ${REFUSED}`);
});

// ---------------------------------------------------------------- other tabs

test('another tab changing the run setup does not replace this tab\'s sequence, mode or options', () => {
  runner.init({});
  runner.add(req(1));
  const mine = strip(get().sequence);
  localStorage.writeFromAnotherTab(KEY, JSON.stringify({
    version: 1,
    sequence: [{ enabled: true, request: req(7) }, { enabled: true, request: req(8) }],
    mode: 'performance',
    options: { concurrency: 50 },
  }));
  assert.deepEqual(strip(get().sequence), mine);
  assert.equal(get().mode, 'functional');
  assert.deepEqual(get().options, DEFAULT_OPTIONS);

  // Last writer wins: this tab's next change stores its own setup whole.
  runner.add(req(2));
  const stored = JSON.parse(localStorage.peek(KEY));
  assert.deepEqual(stored.sequence.map((e) => e.request.id), ['r1', 'r2']);
  assert.equal(stored.mode, 'functional');
});

// ---------------------------------------------------------------- what reaches the server

test('a restored request is sent with the same payload keys as any other', async () => {
  localStorage.setItem(KEY, JSON.stringify({
    version: 1,
    sequence: [{ enabled: true, request: req(1, { url: 'http://192.0.2.10/', method: 'POST', endpoint: 'gone' }) }],
    mode: 'functional',
    options: { concurrency: 1e9 },
  }));
  runner.init({});
  runner.restore();
  runner.render(get());
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'unknown endpoint "gone"', field: 'sequence[0].endpoint' } }, { method: 'POST' });
  document.getElementById('start-run').click();
  await flush();

  const [call] = fetchStub.calls;
  const body = call.json();
  assert.deepEqual(Object.keys(body).sort(), ['mode', 'options', 'sequence']);
  assert.deepEqual(Object.keys(body.sequence[0]).sort(), ['assertions', 'endpoint', 'id', 'name', 'params']);
  assert.equal(body.sequence[0].endpoint, 'gone');
  assert.equal(body.options.concurrency, 50);
  runner.render(get());
  assert.equal(document.getElementById('start-note').textContent, 'Refused - sequence[0].endpoint: unknown endpoint "gone"');
});
