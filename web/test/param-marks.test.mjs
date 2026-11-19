// A parameter the server refuses is marked in the editor the way a refused
// assertion is: the message beside the parameter's field (or beside the
// parameter table when no parameter is named), the field aria-invalid and
// described by it, and the mark gone once that field is edited. This holds
// for Send's own refusal and for a run's refusal of a request opened through
// its row's Edit.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] }];
const req = (n, id = `ws-${n}`) => ({ id, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}`, page: '2' }, assertions: [{ type: 'status', op: 'eq', value: 200 }] });

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  if (unsubscribe) unsubscribe();
  resetBrowser();
  resetState();
  workspace.init();
  set({ endpoints });
  editor.init();
  runner.init({ refresh: async () => {}, edit: (key) => editor.openQueued(key) });
  unsubscribe = subscribe((state) => { editor.render(state); runner.render(state); });
});

const valueOf = (key) => [...byId('param-rows').querySelectorAll('.param-row')]
  .find((row) => row.querySelector('.param-key').value === key).querySelector('.param-value');
const describedBy = (control) => document.getElementById(control.getAttribute('aria-describedby') || '');
const invalid = () => byId('editor-form').querySelectorAll('[aria-invalid="true"]');
const marksInParams = () => byId('param-rows').querySelectorAll('.field-error');

async function sendRefused(field, error) {
  fetchStub.respond('/api/send', { status: 400, body: { error, field } }, { method: 'POST' });
  byId('send-request').click();
  await flush();
}

test('Send refused for one parameter marks that field, and editing it takes the mark away', async () => {
  sidebar.selectRequest(req(1));
  await sendRefused('params.q', 'the value of q is not allowed');
  assert.equal(byId('send-status').textContent, 'Refused - Parameter "q": the value of q is not allowed');
  const q = valueOf('q');
  assert.equal(q.getAttribute('aria-invalid'), 'true');
  const error = describedBy(q);
  assert.ok(error, 'the field is described by an error');
  assert.equal(error.textContent, 'the value of q is not allowed');
  assert.ok(q.parentNode.contains(error), 'the error is beside the field');
  assert.equal(valueOf('page').getAttribute('aria-invalid'), null, 'the other parameter is not marked');
  assert.equal(invalid().length, 1);

  // A poll repaints nothing: the same nodes, no second message.
  set({ status: { running: false, budget_balance: 10 } });
  assert.ok(describedBy(valueOf('q')) === error, 'the same message node after a render');
  assert.equal(marksInParams().length, 1);

  typeInto(valueOf('q'), 'q1x');
  assert.equal(valueOf('q').getAttribute('aria-invalid'), null);
  assert.equal(valueOf('q').getAttribute('aria-describedby'), null);
  assert.equal(marksInParams().length, 0);
  assert.deepEqual(listenerErrors, []);
});

test('Send refused for the parameters as a whole puts the message beside the table, and an edit takes it away', async () => {
  sidebar.selectRequest(req(1));
  await sendRefused('params', 'too many parameters');
  assert.equal(byId('send-status').textContent, 'Refused - Parameters: too many parameters');
  const [error] = marksInParams();
  assert.ok(error, 'a message is in the parameter table');
  assert.equal(error.textContent, 'too many parameters');
  assert.ok(byId('param-rows').contains(error));
  assert.ok(describedBy(byId('add-param')) === error, 'Add parameter is described by it');
  for (const key of ['q', 'page']) assert.ok(describedBy(valueOf(key)) === error, `${key} is described by it`);
  assert.equal(invalid().length, 0, 'no single field is named, so none is invalid');

  typeInto(valueOf('page'), '3');
  assert.equal(marksInParams().length, 0);
  assert.equal(byId('add-param').getAttribute('aria-describedby'), null);
  assert.equal(valueOf('q').getAttribute('aria-describedby'), null);
  assert.deepEqual(listenerErrors, []);
});

test('a run refused for a parameter marks that field in the request opened through the row\'s Edit', async () => {
  runner.add(req(1));
  runner.add(req(2));
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'page must be a number', field: 'sequence[1].params.page' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  assert.equal(byId('start-note').textContent, 'Refused - Request 2, parameter "page": page must be a number');
  const row = byId('sequence-list').querySelectorAll('.seq-row')[1];
  assert.ok(row.classList.contains('is-invalid'), 'the row is marked');

  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Edit').click();
  assert.match(get().draft.name, /^Request 2/, 'the refused request is open');
  const page = () => valueOf('page');
  assert.equal(page().getAttribute('aria-invalid'), 'true');
  assert.equal(describedBy(page()).textContent, 'page must be a number');
  assert.equal(valueOf('q').getAttribute('aria-invalid'), null);

  // Edited, it is no longer the parameter refused; typed back, it is again.
  typeInto(page(), '7');
  assert.equal(page().getAttribute('aria-invalid'), null);
  assert.equal(marksInParams().length, 0);
  typeInto(page(), '2');
  assert.equal(page().getAttribute('aria-invalid'), 'true');

  // Saved fixed, the refusal ends.
  typeInto(page(), '7');
  byId('save-request').click();
  typeInto(page(), '2');
  assert.equal(page().getAttribute('aria-invalid'), null, 'a saved fix ends the refusal');
  assert.deepEqual(listenerErrors, []);
});

test('a run refused for a parameter marks nothing in another request open in the editor', async () => {
  runner.add(req(1));
  runner.add(req(2));
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'nope', field: 'sequence[1].params.q' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  sidebar.selectRequest(req(1));
  assert.equal(invalid().length, 0);
  assert.equal(marksInParams().length, 0);
});
