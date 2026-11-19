// Edges of the parameter mark and of the server's busy answer: parameter
// names with dots, brackets and quotes, a name the open request does not hold,
// a second refusal replacing the first, a key renamed rather than its value
// edited, a parameter mark beside an assertion mark, and a 503 arriving while
// a refusal is showing or after a send already in flight, with no second
// request made on its own across thirty seconds.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const Keys = ['q', 'page', 'limit', 'a.b', 'x[0]', 'say "hi"'];
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: Keys }];
const req = (n, params = { q: `q${n}`, page: '2' }) => ({ id: `ws-${n}`, name: `Request ${n}`, endpoint: 'search', params, assertions: [{ type: 'status', op: 'eq', value: 200 }] });
const Said = 'the server is busy checking other requests; try again in a moment';

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

const paramRows = () => [...byId('param-rows').querySelectorAll('.param-row')];
const valueOf = (key) => paramRows().find((row) => row.querySelector('.param-key').value === key).querySelector('.param-value');
const describedBy = (control) => document.getElementById(control.getAttribute('aria-describedby') || '');
const invalid = () => [...byId('editor-form').querySelectorAll('[aria-invalid="true"]')];
const marksInParams = () => byId('param-rows').querySelectorAll('.field-error');
const posts = (url) => fetchStub.calls.filter((c) => c.url === url && c.method === 'POST');

async function sendRefused(field, error) {
  fetchStub.respond('/api/send', { status: 400, body: { error, field } }, { method: 'POST' });
  byId('send-request').click();
  await flush();
}

test('parameter names holding a dot, brackets or quotes are each marked on their own field', async () => {
  sidebar.selectRequest(req(1, { q: 'a', 'a.b': '1', 'x[0]': '2', 'say "hi"': '3' }));
  for (const key of ['a.b', 'x[0]', 'say "hi"']) {
    await sendRefused(`params.${key}`, `bad ${key}`);
    assert.equal(byId('send-status').textContent, `Refused - Parameter ${JSON.stringify(key)}: bad ${key}`);
    const marked = invalid();
    assert.equal(marked.length, 1, `${key}: one field marked`);
    assert.ok(marked[0] === valueOf(key), `${key}: its own value field is the one marked`);
    assert.equal(describedBy(valueOf(key)).textContent, `bad ${key}`);
    assert.equal(marksInParams().length, 1, `${key}: one message`);
  }
  assert.deepEqual(listenerErrors, []);
});

test('a refused parameter the open request does not hold is said at the end of the table, with no field marked invalid', async () => {
  sidebar.selectRequest(req(1));
  await sendRefused('params.limit', 'limit is required');
  assert.equal(invalid().length, 0);
  const [error] = marksInParams();
  assert.ok(error, 'the message is in the parameter table');
  assert.equal(error.textContent, 'limit is required');
  assert.ok(error.parentNode === byId('param-rows'), 'at the end of the table, not inside a row');
  assert.ok(describedBy(byId('add-param')) === error);
  assert.deepEqual(listenerErrors, []);
});

test('a second refusal replaces the first: one message, on the newly named field', async () => {
  sidebar.selectRequest(req(1));
  await sendRefused('params.q', 'first');
  await sendRefused('params.page', 'second');
  assert.equal(marksInParams().length, 1);
  assert.equal(valueOf('q').getAttribute('aria-invalid'), null);
  assert.equal(valueOf('q').getAttribute('aria-describedby'), null);
  assert.equal(valueOf('page').getAttribute('aria-invalid'), 'true');
  assert.equal(describedBy(valueOf('page')).textContent, 'second');
  // And a refusal of an assertion replaces a parameter's.
  await sendRefused('assertions[0].value', 'no such status');
  assert.equal(marksInParams().length, 0, 'the parameter message is gone');
  assert.equal(valueOf('page').getAttribute('aria-invalid'), null);
  assert.deepEqual(listenerErrors, []);
});

test('renaming the refused parameter, rather than editing its value, takes the mark away', async () => {
  sidebar.selectRequest(req(1));
  await sendRefused('params.q', 'not allowed');
  assert.equal(valueOf('q').getAttribute('aria-invalid'), 'true');
  const key = paramRows()[0].querySelector('.param-key');
  key.value = 'limit';
  key.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(invalid().length, 0, 'no field is invalid');
  assert.equal(marksInParams().length, 0, 'no message is left');
  assert.equal(valueOf('limit').getAttribute('aria-describedby'), null);
  assert.deepEqual(listenerErrors, []);
});

test('a run\'s parameter refusal and Send\'s assertion refusal on one open request show side by side under distinct ids', async () => {
  runner.add(req(1));
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'page is not allowed', field: 'sequence[0].params.page' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  const row = byId('sequence-list').querySelectorAll('.seq-row')[0];
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Edit').click();
  assert.equal(valueOf('page').getAttribute('aria-invalid'), 'true');

  // The run's refusal of the parameter is still true of this request; Send's
  // refusal of an assertion is a second, separate fact about it.
  await sendRefused('assertions[0].value', 'status out of range');
  const errors = [...byId('editor-form').querySelectorAll('.field-error')];
  const ids = errors.map((e) => e.getAttribute('id'));
  assert.equal(errors.length, 2, 'both messages show');
  assert.equal(invalid().length, 2, 'the parameter and the assertion value are both marked');
  assert.equal(new Set(ids).size, ids.length, `error ids are distinct: ${ids}`);
  for (const control of invalid()) {
    const said = describedBy(control);
    assert.ok(said, 'every invalid field is described by a message that exists');
    assert.ok(errors.includes(said));
  }
  assert.deepEqual(listenerErrors, []);
});

test('Start answered 503 while a parameter refusal shows keeps that refusal as it was, and nothing is sent again across thirty seconds', async (t) => {
  runner.add(req(1));
  runner.add(req(2));
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'page is not allowed', field: 'sequence[1].params.page' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  const before = byId('sequence-list').querySelectorAll('.is-invalid');
  assert.equal(before.length, 1);

  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  fetchStub.respond('/api/runs', { status: 503, headers: { 'Retry-After': '1' }, body: { error: Said } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  assert.equal(byId('start-note').textContent, `Busy - ${Said}`);
  const after = byId('sequence-list').querySelectorAll('.is-invalid');
  assert.equal(after.length, 1, 'still one row marked');
  assert.ok(after[0] === byId('sequence-list').querySelectorAll('.seq-row')[1], 'the same row');
  assert.equal(byId('start-run').disabled, false);

  for (let s = 0; s < 30; s += 1) {
    t.mock.timers.tick(1000);
    await flush(2);
  }
  assert.equal(posts('/api/runs').length, 2, 'no Start was made on its own');

  const editButton = [...byId('sequence-list').querySelectorAll('.seq-row')[1].querySelectorAll('button')].find((b) => b.textContent === 'Edit');
  editButton.click();
  assert.equal(valueOf('page').getAttribute('aria-invalid'), 'true', 'the field mark is still there through Edit');
  assert.deepEqual(listenerErrors, []);
});

test('a 503 arriving for a send already in flight reads busy, brings Send back at once, and a body that is not JSON or a JSON non-object still reads busy', async () => {
  sidebar.selectRequest(req(1));
  const pending = fetchStub.defer('/api/send', { method: 'POST' });
  byId('send-request').click();
  await flush();
  assert.ok(pending.requested);
  byId('send-request').click();
  await flush();
  assert.equal(posts('/api/send').length, 1, 'a second press while one is in flight sends nothing');
  pending.resolve({ status: 503, headers: { 'Retry-After': '5' }, body: { error: Said } });
  await flush();
  assert.equal(byId('send-status').textContent, `Busy - ${Said}`);
  assert.equal(byId('send-request').disabled, false);
  assert.equal(invalid().length, 0);

  for (const body of ['<html>busy</html>', '"busy"', '[1]', 'null', '{"error":42}', '{"error":""}']) {
    fetchStub.respond('/api/send', { status: 503, body }, { method: 'POST' });
    byId('send-request').click();
    await flush();
    assert.equal(byId('send-status').textContent, 'Busy - the server is busy; try again in a moment', `body ${body}`);
    assert.equal(byId('send-request').disabled, false);
  }
  assert.equal(invalid().length, 0);
  assert.deepEqual(listenerErrors, []);
});
