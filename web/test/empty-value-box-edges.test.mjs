// Edges of the empty value box: every type and operator that takes a value,
// values that look empty but are not (zero, minus zero, spaces, false), the
// last assertion of a full request, an operator switched to one that takes no
// value and back, and the doors a stored empty value can come through.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import { requestPayload, requestProblem, assertionProblem, valueKind, coerceValue, opsByType, isQueueable } from '../js/request-model.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];

let unsubscribe = null;

function boot({ saved, setup } = {}) {
  if (saved) localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: saved }));
  if (setup) localStorage.setItem(SETUP, JSON.stringify(setup));
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  runner.init({ refresh: async () => {} });
  sidebar.init({
    select: (request) => { editor.onSelect(); sidebar.selectRequest(request); },
    add: (request) => runner.add(request),
    addAll: (collection) => runner.addAll(collection),
  });
  unsubscribe = subscribe((state) => { sidebar.render(state); editor.render(state); runner.render(state); });
  set({ endpoints });
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
});

const rows = () => byId('assertion-rows').querySelectorAll('.assert-row');
const valueBox = (j) => rows()[j].querySelector('input.assert-value');
const sends = () => fetchStub.calls.filter((c) => c.url === '/api/send');
const starts = () => fetchStub.calls.filter((c) => c.url === '/api/runs' && c.method === 'POST');

// Every (type, op) pair whose operator takes a value, with a json path where
// one is needed.
const valued = Object.entries(opsByType).flatMap(([type, ops]) => ops
  .map((op) => (type === 'json' ? { type, op, path: '$.a' } : { type, op }))
  .filter((a) => valueKind(a) !== 'none'));

test('every operator that takes a value refuses an empty one by its value field, while the server mirror still accepts it where the server does', () => {
  assert.ok(valued.length >= 8, `pairs read: ${valued.length}`);
  for (const a of valued) {
    const built = requestPayload({ id: 'x', endpoint: 'search', params: {}, assertions: [{ ...a, value: '' }] });
    assert.equal(Object.hasOwn(built.assertions[0], 'value'), false, `${a.type} ${a.op}: no value on the wire`);
    const problem = requestProblem(built);
    assert.ok(problem && problem.part === 'value', `${a.type} ${a.op}: refused by its value field, got ${JSON.stringify(problem)}`);
    assert.equal(coerceValue(a, ''), undefined, `${a.type} ${a.op}: an empty box is no value`);
  }
  // The mirror is unchanged: wherever the server takes a string, it takes "".
  for (const a of valued.filter((x) => valueKind(x) !== 'number')) {
    assert.equal(assertionProblem({ ...a, value: '' }), null, `${a.type} ${a.op}`);
  }
});

test('values that only look empty are sent exactly as given: zero, minus zero, spaces, the text "0", false', () => {
  const cases = [
    [{ type: 'status', op: 'eq' }, 0],
    [{ type: 'json', op: 'eq', path: '$.a' }, 0],
    [{ type: 'json', op: 'eq', path: '$.a' }, -0],
    [{ type: 'json', op: 'eq', path: '$.a' }, '0'],
    [{ type: 'json', op: 'eq', path: '$.a' }, ' '],
    [{ type: 'json', op: 'neq', path: '$.a' }, false],
    [{ type: 'body_contains', op: 'contains' }, ' '],
    [{ type: 'json', op: 'count', path: '$.a' }, 0],
  ];
  for (const [a, value] of cases) {
    const built = requestPayload({ id: 'x', endpoint: 'search', assertions: [{ ...a, value }] });
    assert.ok(Object.hasOwn(built.assertions[0], 'value'), `${JSON.stringify(a)} ${String(value)}: kept`);
    assert.ok(Object.is(built.assertions[0].value, value), `${JSON.stringify(a)}: ${String(value)} is not rewritten`);
  }
});

test('typing a zero in any form into a number box is a number, and spaces are kept as typed', () => {
  const json = { type: 'json', op: 'eq', path: '$.a' };
  assert.equal(coerceValue(json, '0'), 0);
  assert.equal(coerceValue(json, '0.0'), 0);
  assert.ok(Object.is(coerceValue(json, '-0'), -0), 'minus zero stays a number');
  assert.equal(coerceValue(json, ' '), ' ', 'spaces are a string value, not a zero');
  assert.equal(coerceValue(json, 'false'), 'false');
  assert.equal(coerceValue({ type: 'status', op: 'eq' }, ' '), ' ', 'spaces in a status box are kept, and refused by type');
  const spaced = requestPayload({ id: 'x', endpoint: 'search', assertions: [{ type: 'status', op: 'eq', value: ' ' }] });
  assert.equal(requestProblem(spaced).part, 'value');
});

test('the twentieth assertion erased is refused as assertion 20, on its own box only', async () => {
  const assertions = Array.from({ length: 20 }, (_, i) => ({ type: 'json', path: `$.f${i}`, op: 'eq', value: `v${i}` }));
  boot({ saved: [{ id: 'ws-full', name: 'Full', endpoint: 'search', params: { q: 'x' }, assertions }] });
  sidebar.selectRequest(workspace.find('ws-full'));
  assert.equal(rows().length, 20);
  typeInto(valueBox(19), '');
  byId('send-request').click();
  await flush();
  assert.equal(byId('send-status').textContent, 'Refused - Assertion 20: eq needs a number or a string value');
  assert.equal(sends().length, 0);
  const marked = byId('assertion-rows').querySelectorAll('[aria-invalid="true"]');
  assert.equal(marked.length, 1, 'one field is marked');
  assert.ok(marked[0] === valueBox(19), 'the twentieth value box is the one marked');
  assert.equal(valueBox(0).getAttribute('aria-invalid'), null);

  byId('save-request').click();
  assert.equal(byId('editor-note').textContent, 'Kept in this browser, but not ready to run - Assertion 20: eq needs a number or a string value');
  assert.deepEqual(listenerErrors, []);
});

test('an operator switched to exists and back again: the box is empty exactly when Send refuses it', async () => {
  boot({ saved: [{ id: 'ws-op', name: 'Op', endpoint: 'search', params: { q: 'x' }, assertions: [{ type: 'json', path: '$.a', op: 'eq', value: 'Pi' }] }] });
  sidebar.selectRequest(workspace.find('ws-op'));
  const pick = (op) => {
    const select = rows()[0].querySelector('.assert-op');
    select.value = op;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  pick('exists');
  fetchStub.respond('/api/send', { status: 400, body: { error: 'stop here', field: 'endpoint' } }, { method: 'POST' });
  byId('send-request').click();
  await flush();
  assert.equal(sends().length, 1, 'exists takes no value and is sent');
  assert.equal(Object.hasOwn(sends()[0].json().assertions[0], 'value'), false, 'with no value on the wire');

  pick('eq');
  const box = valueBox(0);
  assert.ok(box, 'eq shows its value box again');
  fetchStub.respond('/api/send', { status: 400, body: { error: 'stop here', field: 'endpoint' } }, { method: 'POST' });
  byId('send-request').click();
  await flush();
  if (box.value === '') {
    assert.equal(sends().length, 1, 'an empty box after the switch is refused here');
    assert.match(byId('send-status').textContent, /^Refused - Assertion 1: eq needs/);
  } else {
    assert.equal(sends().length, 2, 'a box still holding its value is sent');
    assert.equal(sends()[1].json().assertions[0].value, box.value);
  }
  assert.deepEqual(listenerErrors, []);
});

test('a stored empty value is refused by Add all, and Start refuses a restored queue holding one in its second request', async () => {
  const ok = { id: 'ws-ok', name: 'Fine', endpoint: 'search', params: { q: 'x' }, assertions: [{ type: 'status', op: 'eq', value: 200 }] };
  const empty = { id: 'ws-empty', name: 'Empty', endpoint: 'search', params: { q: 'x' }, assertions: [{ type: 'latency', op: 'lt', value: '' }] };
  boot({
    saved: [ok, empty],
    setup: { version: 1, mode: 'functional', options: {}, sequence: [{ enabled: true, request: ok }, { enabled: true, request: empty }] },
  });
  assert.equal(get().sequence.length, 2, 'the restored queue holds both');
  assert.equal(isQueueable(empty), false);

  byId('start-run').click();
  await flush();
  assert.equal(starts().length, 0, 'nothing was started');
  assert.match(byId('start-note').textContent, /^Refused - Request 2, assertion 1: /);

  runner.addAll({ id: 'c', name: 'Mixed', requests: [ok, empty] });
  assert.equal(get().sequence.length, 2, 'Add all queued nothing');
  assert.deepEqual(listenerErrors, []);
});
