// The run panel against a request it cannot show or send, however it got into
// the page: one bad row must not take the panel, Start or the saved lists down
// with it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage, localStorage, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set } from '../js/store.js';
import * as runner from '../js/render-runner.js';
import { createSyncedList } from '../js/storage.js';

const REFUSED = 'Could not save the run setup in this browser.';
const byId = (id) => document.getElementById(id);
const req = (n) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [{ type: 'status', op: 'eq', value: 200 }] });

// deepRequest is a request no chip can print and no JSON can encode.
function deepRequest() {
  let value = [];
  for (let i = 0; i < 20000; i += 1) value = [value];
  return { id: 'deep', name: 'Deep', endpoint: 'search', params: {}, assertions: [{ type: 'json', path: '$', op: 'eq', value }] };
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
  runner.init({});
});

test('a queued row that cannot be shown leaves the rest of the panel drawn and can still be removed', () => {
  set({ sequence: [{ key: 'q1', enabled: true, request: deepRequest() }, { key: 'q2', enabled: true, request: req(2) }] });
  assert.doesNotThrow(() => runner.render(get()));
  const rows = byId('sequence-list').querySelectorAll('.seq-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].querySelector('.seq-name').textContent, 'Request 2');
  assert.equal(byId('sequence-count').textContent, '2 of 50 - 2 selected');

  const remove = [...rows[0].querySelectorAll('button')].find((b) => b.title === 'Remove from the run');
  assert.ok(remove, 'the row that cannot be shown still has its remove control');
  remove.click();
  runner.render(get());
  assert.deepEqual(listenerErrors, []);
  assert.deepEqual(get().sequence.map((e) => e.request.id), ['r2']);
  assert.deepEqual(JSON.parse(localStorage.peek('courier.runner.v1')).sequence.map((e) => e.request.id), ['r2']);
});

test('a setup that cannot be encoded is reported as not saved, and the change stays on the page', () => {
  set({ sequence: [{ key: 'q1', enabled: true, request: deepRequest() }] });
  runner.render(get());
  assert.doesNotThrow(() => runner.add(req(2)));
  runner.render(get());
  assert.equal(get().sequence.length, 2);
  assert.equal(byId('sequence-note').textContent, REFUSED);
});

test('Start with a request that cannot be sent says so and is not left on "Starting..."', async () => {
  set({ sequence: [{ key: 'q1', enabled: true, request: deepRequest() }, { key: 'q2', enabled: true, request: req(2) }] });
  runner.render(get());
  byId('start-run').click();
  await flush();
  assert.deepEqual(listenerErrors, [], 'Start threw');
  runner.render(get());
  assert.equal(byId('start-run').textContent, 'Start run');
  assert.equal(byId('start-run').disabled, false);
  assert.equal(byId('start-note').hidden, false);
  assert.match(byId('start-note').textContent, /^Could not start the run - /);
  assert.equal(fetchStub.calls.length, 0, 'nothing was sent');
});

test('a list entry that cannot be encoded is refused at once, not queued and retried on every later change', () => {
  const area = new FakeStorage();
  let state = { items: [] };
  const list = createSyncedList({
    storage: area,
    key: 'k',
    field: 'items',
    decode: (raw) => {
      const v = raw === null ? null : JSON.parse(raw);
      return { items: v ? v.items : [] };
    },
    encode: (items) => JSON.stringify({ items }),
    get: () => state,
    set: (p) => { state = { ...state, ...p }; },
  });
  list.init();

  let r;
  assert.doesNotThrow(() => { r = list.save({ id: 'bad', n: 1n }); });
  assert.deepEqual(r, { ok: false, deleted: false });
  assert.equal(list.queued(), 0);
  assert.deepEqual(state.items, []);

  assert.deepEqual(list.save({ id: 'good' }), { ok: true, deleted: false });
  assert.equal(list.queued(), 0);
  assert.deepEqual(JSON.parse(area.peek('k')).items, [{ id: 'good' }]);
  assert.deepEqual(state.items, [{ id: 'good' }]);

  // The same with reads refused, when nothing is encoded until a read succeeds.
  area.failOn('getItem');
  assert.deepEqual(list.save({ id: 'bad2', n: 2n }), { ok: false, deleted: false });
  assert.equal(list.queued(), 0);
  area.heal();
  assert.deepEqual(list.save({ id: 'good2' }), { ok: true, deleted: false });
  assert.deepEqual(JSON.parse(area.peek('k')).items.map((i) => i.id), ['good', 'good2']);
});

test('a run sends an assertion\'s four fields and nothing else, whichever list the request was queued from', async () => {
  // A saved request is queued as the page holds it; the payload is where its
  // fields are picked.
  runner.add({ ...req(1), url: 'http://192.0.2.10/', assertions: [{ type: 'json', path: '$.total', op: 'gt', value: 1, url: 'http://192.0.2.10/y', host: '192.0.2.10' }, { type: 'status', op: 'eq', value: 200, method: 'DELETE' }] });
  runner.render(get());
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'x' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  const [sent] = fetchStub.calls[0].json().sequence;
  assert.deepEqual(Object.keys(sent).sort(), ['assertions', 'endpoint', 'id', 'name', 'params']);
  assert.deepEqual(sent.assertions, [{ type: 'json', path: '$.total', op: 'gt', value: 1 }, { type: 'status', op: 'eq', value: 200 }]);
});
