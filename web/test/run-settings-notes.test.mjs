// A run setting the page changes says what was typed, the bound it met and
// the value the run will use, beside the field, once; and Start only ever
// sends the whole numbers it said it would.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as runner from '../js/render-runner.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  if (unsubscribe) unsubscribe();
  resetBrowser();
  resetState();
  set({ endpoints: [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }] });
  runner.init({});
  unsubscribe = subscribe((state) => runner.render(state));
});

const FIELDS = {
  concurrency: { id: 'concurrency', key: 'concurrency', lo: 1, hi: 50, fallback: 10 },
  delay: { id: 'delay-ms', key: 'delay_ms', lo: 0, hi: 1000, fallback: 0 },
  duration: { id: 'duration-secs', key: 'duration_secs', lo: 1, hi: 30, fallback: 10 },
};

const noteOf = (field) => byId(`${field.id}-note`);
const type = (field, text) => typeInto(byId(field.id), text);
const stored = () => JSON.parse(localStorage.peek(SETUP)).options;

test('concurrency: each changed value names what was typed, the bound and the value used', () => {
  const f = FIELDS.concurrency;
  const cases = [
    ['0', '0 is under the floor of 1 - the run will use the default, 10.', 10],
    ['1e2', '1e2 is 100, over the cap of 50 - the run will use 50.', 50],
    ['51', '51 is over the cap of 50 - the run will use 50.', 50],
    ['abc', '"abc" is not a number - the run will use the default, 10.', 10],
    ['2.5', '2.5 is not a whole number - the run will use 2.', 2],
    ['', 'Empty - the run will use the default, 10.', 10],
    ['-1', '-1 is under the floor of 1 - the run will use the default, 10.', 10],
    ['0x10', '0x10 is 16 - the run will use 16.', 16],
    ['1e999', '1e999 is over the cap of 50 - the run will use 50.', 50],
    ['٣', '"٣" is not a number - the run will use the default, 10.', 10],
    ['10 workers', '"10 workers" is not a number - the run will use the default, 10.', 10],
    ['0.5', '0.5 is under the floor of 1 - the run will use the default, 10.', 10],
    ['50.9', '50.9 is not a whole number - the run will use 50.', 50],
  ];
  for (const [text, said, used] of cases) {
    type(f, text);
    assert.equal(noteOf(f).textContent, said, JSON.stringify(text));
    assert.equal(noteOf(f).hidden, false, JSON.stringify(text));
    assert.equal(get().options.concurrency, used, JSON.stringify(text));
    assert.equal(stored().concurrency, used, `${JSON.stringify(text)}: the value used is what is kept`);
  }
  // A value used as typed needs no note, and takes the last one away.
  for (const [text, used] of [['7', 7], [' 7 ', 7], ['50', 50], ['1', 1]]) {
    type(f, text);
    assert.equal(noteOf(f).textContent, '', JSON.stringify(text));
    assert.equal(noteOf(f).hidden, true, JSON.stringify(text));
    assert.equal(get().options.concurrency, used);
  }
  assert.deepEqual(listenerErrors, []);
});

test('delay and duration follow the same pattern with their own bounds and defaults', () => {
  const cases = [
    [FIELDS.delay, '-1', '-1 is under the floor of 0 - the run will use the default, 0.', 0],
    [FIELDS.delay, '1001', '1001 is over the cap of 1000 - the run will use 1000.', 1000],
    [FIELDS.delay, '2.5', '2.5 is not a whole number - the run will use 2.', 2],
    [FIELDS.delay, '', 'Empty - the run will use the default, 0.', 0],
    [FIELDS.delay, 'abc', '"abc" is not a number - the run will use the default, 0.', 0],
    [FIELDS.delay, '1e2', '1e2 is 100 - the run will use 100.', 100],
    [FIELDS.duration, '0', '0 is under the floor of 1 - the run will use the default, 10.', 10],
    [FIELDS.duration, '31', '31 is over the cap of 30 - the run will use 30.', 30],
    [FIELDS.duration, '1e2', '1e2 is 100, over the cap of 30 - the run will use 30.', 30],
    [FIELDS.duration, '', 'Empty - the run will use the default, 10.', 10],
    [FIELDS.duration, '2.5', '2.5 is not a whole number - the run will use 2.', 2],
  ];
  for (const [f, text, said, used] of cases) {
    type(f, text);
    assert.equal(noteOf(f).textContent, said, `${f.key} ${JSON.stringify(text)}`);
    assert.equal(get().options[f.key], used, `${f.key} ${JSON.stringify(text)}`);
  }
});

test('each note sits beside its field, is announced politely, and is not announced again by a poll', () => {
  for (const f of Object.values(FIELDS)) {
    const note = noteOf(f);
    assert.ok(note, `${f.id}-note exists`);
    assert.equal(note.getAttribute('role'), 'status');
    assert.equal(note.getAttribute('aria-live'), 'polite');
    assert.ok(byId(f.id).closest('.options') === note.parentNode, `${f.id}-note is in its field's group`);
    assert.ok((byId(f.id).getAttribute('aria-describedby') || '').split(' ').includes(`${f.id}-note`));
    type(f, '1e999');
    const text = note.firstChild;
    for (let i = 0; i < 3; i += 1) set({ status: { running: false, budget_balance: 100 + i } });
    assert.ok(note.firstChild === text, `${f.id}: the note's text was not replaced by a render`);
  }
});

test('Start never sends a non-integer option, whatever was typed', async () => {
  runner.add({ id: 'r1', name: 'One', endpoint: 'search', params: { q: 'x' }, assertions: [] });
  const inputs = ['0', '1e2', '51', 'abc', '2.5', '', '-1', ' 7 ', '0x10', '1e999', '٣', '10 workers'];
  // What each input is used as, field by field, in the order above.
  const used = {
    concurrency: [10, 50, 50, 10, 2, 10, 10, 7, 16, 50, 10, 10],
    delay_ms: [0, 100, 51, 0, 2, 0, 0, 7, 16, 1000, 0, 0],
    duration_secs: [10, 30, 30, 10, 2, 10, 10, 7, 16, 30, 10, 10],
  };
  for (const f of Object.values(FIELDS)) {
    for (const [i, text] of inputs.entries()) {
      type(f, text);
      fetchStub.respond('/api/runs', { status: 400, body: { error: 'x', field: 'mode' } }, { method: 'POST' });
      const before = fetchStub.calls.length;
      byId('start-run').click();
      await flush();
      const call = fetchStub.calls.slice(before).find((c) => c.url === '/api/runs');
      assert.ok(call, `${f.key} ${JSON.stringify(text)}: Start sent`);
      const { options } = call.json();
      for (const g of Object.values(FIELDS)) {
        const v = options[g.key];
        assert.ok(Number.isInteger(v) && v >= g.lo && v <= g.hi, `${f.key} ${JSON.stringify(text)}: ${g.key}=${v}`);
      }
      assert.equal(options[f.key], used[f.key][i], `${f.key} ${JSON.stringify(text)}: sends the value used`);
      assert.equal(options[f.key], get().options[f.key], `${f.key} ${JSON.stringify(text)}: sends what the page shows`);
    }
  }
  assert.deepEqual(listenerErrors, []);
});

test('a knee preset that sets the knobs takes their notes away', () => {
  set({ collections: [{ id: 'search-basics', name: 'Search basics', requests: [{ id: 'r1', name: 'One', endpoint: 'search', params: {}, assertions: [] }] }] });
  set({});
  type(FIELDS.concurrency, '99');
  type(FIELDS.duration, '99');
  assert.notEqual(noteOf(FIELDS.concurrency).textContent, '');
  byId('knee-buttons').querySelector('button').click();
  assert.equal(noteOf(FIELDS.concurrency).textContent, '');
  assert.equal(noteOf(FIELDS.duration).textContent, '');
});
