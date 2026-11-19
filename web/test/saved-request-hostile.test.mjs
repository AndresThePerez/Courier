// A saved request is the visitor's own, but its stored form can be edited by
// hand in the browser's storage. Whatever it then holds, every pane keeps
// drawing: a name that is not text is read as no name, a request this
// browser cannot copy is left out at load, and an assertion type the page
// does not know is shown as one it cannot use, refused by field like any
// other.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe, renderAll } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];

const good = { id: 'ws-good', name: 'Good one', endpoint: 'search', params: { q: 'x' }, assertions: [{ type: 'status', op: 'eq', value: 200 }] };

let unsubscribe = null;
let renderErrors = [];

// boot stores the raw text as the stored workspace and wires the page the way
// main.js does, every pane through renderAll, so a pane that throws is seen.
function boot(raw) {
  localStorage.setItem(WORKSPACE, raw);
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
  unsubscribe = subscribe((state) => renderAll([sidebar.render, editor.render, runner.render], state));
  set({ endpoints });
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  renderErrors = [];
  t.mock.method(console, 'error', (...args) => { renderErrors.push(args); });
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
});

const stored = (requests) => JSON.stringify({ version: 1, requests: [good, ...requests] });
const tree = () => byId('workspace-tree');
const openButton = (text) => [...tree().querySelectorAll('.req-open')].find((b) => b.textContent.includes(text));

// deep builds a value nested n levels deep as JSON text, so it is the browser's
// parser that builds it, as it would on a real load.
const deep = (n) => `${'['.repeat(n)}1${']'.repeat(n)}`;

function stillDraws() {
  assert.ok(openButton('Good one'), 'the sidebar lists the request it can show');
  openButton('Good one').click();
  assert.equal(get().draft.id, 'ws-good');
  assert.equal(byId('editor-form').hidden, false, 'the editor draws');
  assert.equal(byId('editor-name').value, 'Good one');
  typeInto(byId('editor-name'), 'Good two');
  assert.ok(openButton('Good two'), 'the sidebar follows an edit');
  assert.deepEqual(renderErrors, [], 'no pane threw');
  assert.deepEqual(listenerErrors, []);
}

test('a saved request whose name is not text is shown under its id in every pane, never as [object Object]', () => {
  boot(stored([
    { id: 'ws-obj', name: { first: 'x' }, endpoint: 'search', params: {}, assertions: [] },
    { id: 'ws-list', name: ['x'], endpoint: 'search' },
    { id: 'ws-num', name: 7, endpoint: 'search' },
  ]));
  assert.doesNotMatch(tree().textContent, /\[object /);
  assert.deepEqual(get().workspace.map((r) => r.id), ['ws-good', 'ws-obj', 'ws-list', 'ws-num']);
  for (const id of ['ws-obj', 'ws-list', 'ws-num']) assert.ok(openButton(id), `${id} is listed under its id`);

  openButton('ws-obj').click();
  assert.equal(get().draft.id, 'ws-obj');
  assert.equal(byId('editor-name').value, '');

  // Queued, the row names it by its id as well.
  runner.add(workspace.find('ws-obj'));
  assert.equal(get().sequence.length, 1);
  assert.doesNotMatch(byId('sequence-list').textContent, /\[object /);
  assert.match(byId('add-note').textContent, /^Added "ws-obj"/);
  stillDraws();
});

test('a saved request nested too deep for this browser to copy is left out, and every pane keeps drawing', () => {
  const raw = `{"version":1,"requests":[${JSON.stringify(good)},`
    + `{"id":"ws-deep-param","name":"Deep param","endpoint":"search","params":{"q":${deep(10000)}}},`
    + `{"id":"ws-deep-value","name":"Deep value","endpoint":"search","assertions":[{"type":"json","path":"$","op":"eq","value":${deep(10000)}}]},`
    + `{"id":"ws-deep-key","name":"Deep extra","endpoint":"search","extra":${deep(10000)}}]}`;
  boot(raw);
  assert.deepEqual(get().workspace.map((r) => r.id), ['ws-good']);
  assert.doesNotMatch(tree().textContent, /Deep/);
  stillDraws();
});

for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
  test(`a saved assertion of type ${type} is shown as unusable, and the editor keeps drawing`, async () => {
    boot(stored([{ id: 'ws-odd', name: 'Odd type', endpoint: 'search', params: { q: 'x' }, assertions: [
      { type: 'status', op: 'eq', value: 200 },
      { type, op: 'eq', value: 1 },
    ] }]));
    openButton('Odd type').click();
    assert.equal(get().draft.id, 'ws-odd');
    assert.equal(byId('editor-form').hidden, false);
    assert.equal(byId('editor-name').value, 'Odd type');
    const rows = byId('assertion-rows').querySelectorAll('.assert-row');
    assert.equal(rows.length, 2, 'both assertions are drawn');
    assert.equal(rows[1].querySelectorAll('.assert-op option').length, 0, 'no operator is offered for a type the page does not know');

    // Send refuses it by field, and nothing is sent.
    byId('send-request').click();
    await flush();
    assert.match(byId('send-status').textContent, /^Refused - Assertion 2: unknown assertion type/);
    assert.equal(fetchStub.calls.filter((c) => c.url === '/api/send').length, 0);

    // The + is refused by the same check, and the runner still draws.
    runner.add(workspace.find('ws-odd'));
    assert.equal(get().sequence.length, 0);
    assert.match(byId('add-note').textContent, /invalid assertion/);

    // The row can be removed, and the editor carries on.
    const remove = [...rows[1].querySelectorAll('button')].find((b) => b.title === 'Remove this assertion');
    remove.click();
    assert.equal(byId('assertion-rows').querySelectorAll('.assert-row').length, 1);
    assert.deepEqual(renderErrors, [], 'no pane threw');
    assert.deepEqual(listenerErrors, []);
    stillDraws();
  });
}

test('requests the editor itself wrote load exactly as stored', () => {
  const written = [
    good,
    { id: 'ws-num-param', name: 'Numeric', endpoint: 'search', params: { q: 7 }, assertions: [] },
    { id: 'ws-no-params', name: 'Bare', endpoint: 'search' },
    { id: 'ws-unnamed', endpoint: 'search', params: {}, assertions: [{ type: 'json', path: '$.a', op: 'exists' }] },
  ];
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: written }));
  assert.deepEqual(workspace.load().requests, written);
});
