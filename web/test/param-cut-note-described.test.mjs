// The note that says a parameter value will be cut describes the value box it
// is about, so a screen reader reads it with the field: each box whose value
// will be cut carries "param-cut-note" in its aria-describedby, beside any
// refusal mark's own id, and loses it when the value fits.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] }];
const req = (q, page = '2') => ({ id: 'ws-d', name: 'D', endpoint: 'search', params: { q, page }, assertions: [] });
const Long = 'x'.repeat(300);

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  if (unsubscribe) unsubscribe();
  resetBrowser();
  resetState();
  workspace.init();
  set({ endpoints });
  editor.init();
  runner.init({ refresh: async () => {} });
  unsubscribe = subscribe((state) => { editor.render(state); runner.render(state); });
});

const valueOf = (key) => [...byId('param-rows').querySelectorAll('.param-row')]
  .find((row) => row.querySelector('.param-key').value === key).querySelector('.param-value');
const ids = (control) => (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);

test('a value box whose value will be cut is described by the note, and only that box', () => {
  sidebar.selectRequest(req(Long));
  assert.deepEqual(ids(valueOf('q')), ['param-cut-note']);
  assert.deepEqual(ids(valueOf('page')), []);

  typeInto(valueOf('page'), Long);
  assert.deepEqual(ids(valueOf('page')), ['param-cut-note']);
  typeInto(valueOf('q'), 'short');
  assert.equal(valueOf('q').hasAttribute('aria-describedby'), false, 'a value that fits is still described by the note');
  assert.deepEqual(ids(valueOf('page')), ['param-cut-note']);
  assert.deepEqual(listenerErrors, []);
});

test('a box carrying a refusal mark and the cut note is described by both, and keeps the note when the mark goes', async () => {
  sidebar.selectRequest(req(Long));
  fetchStub.respond('/api/send', { status: 400, body: { error: 'the value of q is not allowed', field: 'params.q' } }, { method: 'POST' });
  byId('send-request').click();
  await flush();
  const q = valueOf('q');
  assert.equal(q.getAttribute('aria-invalid'), 'true', 'the refusal was not marked; the case proves nothing');
  assert.deepEqual([...ids(q)].sort(), ['param-cut-note', 'param-error']);
  assert.ok(byId('param-error') && byId('param-cut-note'), 'an id leads nowhere');

  // A poll repaints the same marks, without doubling an id.
  set({ status: { running: false, budget_balance: 10 } });
  assert.deepEqual([...ids(valueOf('q'))].sort(), ['param-cut-note', 'param-error']);

  typeInto(valueOf('q'), `${Long}y`);
  assert.equal(valueOf('q').getAttribute('aria-invalid'), null);
  assert.deepEqual(ids(valueOf('q')), ['param-cut-note']);
  typeInto(valueOf('q'), 'short');
  assert.equal(valueOf('q').hasAttribute('aria-describedby'), false);
  assert.deepEqual(listenerErrors, []);
});
