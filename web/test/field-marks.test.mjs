// A refused field is shown beside the request and the assertion it belongs
// to: the run's note names the visible row, 1-based and past unchecked rows,
// with the field named once; the row and, when that request is open, the
// offending control are marked; and the marks stay until something they
// describe changes.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] }];
const req = (n) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [{ type: 'status', op: 'eq', value: 200 }, { type: 'json', path: '$.total', op: 'gt', value: n }] });

let unsubscribe = null;
let refreshes = 0;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  if (unsubscribe) unsubscribe();
  resetBrowser();
  resetState();
  refreshes = 0;
  set({ endpoints });
  editor.init();
  runner.init({ refresh: async () => { refreshes += 1; } });
  unsubscribe = subscribe((state) => { editor.render(state); runner.render(state); });
});

const rows = () => [...byId('sequence-list').querySelectorAll('.seq-row')];
const marked = () => rows().map((r, i) => (r.classList.contains('is-invalid') ? i + 1 : 0)).filter(Boolean);
const note = () => byId('start-note').textContent;
const describedBy = (control) => {
  const ids = (control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean);
  return ids.map((id) => document.getElementById(id)).filter(Boolean);
};

function queueSeven() {
  for (let n = 1; n <= 7; n += 1) runner.add(req(n));
  rows()[1].querySelector('.seq-check').click(); // row 2 unchecked
  assert.equal(get().sequence[1].enabled, false);
}

async function refuse(field, error) {
  fetchStub.respond('/api/runs', { status: 400, body: field === undefined ? { error } : { error, field } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
}

const Msg = 'a status assertion needs a whole number from 100 to 599, got 700';

test('a refused field reads as the visible row and assertion, 1-based, past an unchecked row, with the field named once', async () => {
  queueSeven();
  await refuse('sequence[4].assertions[0]', Msg);
  assert.equal(note(), `Refused - Request 6, assertion 1: ${Msg}`);
  assert.doesNotMatch(note(), /sequence\[|assertions\[/);
  assert.equal(note().match(/assertion 1/g).length, 1);
  assert.deepEqual(listenerErrors, []);
});

test('the refused row is marked, with an inline error its checkbox points at, and no other row is', async () => {
  queueSeven();
  await refuse('sequence[4].assertions[0]', Msg);
  assert.deepEqual(marked(), [6]);
  const check = rows()[5].querySelector('.seq-check');
  const [error] = describedBy(check);
  assert.ok(error, 'the checkbox is described by an error');
  assert.ok(rows()[5].contains(error), 'the error is inside the row');
  assert.equal(error.textContent, `Assertion 1: ${Msg}`);
  for (const i of [0, 1, 2, 3, 4, 6]) assert.equal(rows()[i].querySelector('.seq-check').getAttribute('aria-describedby'), null, `row ${i + 1}`);
});

test('with the refused request open in the editor, the offending control is marked and described', async () => {
  queueSeven();
  await refuse('sequence[4].assertions[0]', Msg);
  sidebar.selectRequest(get().sequence[5].request);
  const value = byId('assertion-rows').querySelectorAll('.assert-row')[0].querySelector('.assert-value');
  assert.equal(value.getAttribute('aria-invalid'), 'true');
  const [error] = describedBy(value);
  assert.ok(error, 'the value input is described by an error');
  assert.equal(error.textContent, Msg);
  const other = byId('assertion-rows').querySelectorAll('.assert-row')[1];
  assert.equal(other.querySelector('.assert-value').getAttribute('aria-invalid'), null);
  assert.equal(other.querySelector('.assert-path').getAttribute('aria-invalid'), null);

  // A path the server names is the path control.
  await refuse('sequence[4].assertions[1].path', 'the path must start with $');
  const path = byId('assertion-rows').querySelectorAll('.assert-row')[1].querySelector('.assert-path');
  assert.equal(path.getAttribute('aria-invalid'), 'true');
  assert.equal(byId('assertion-rows').querySelectorAll('.assert-row')[0].querySelector('.assert-value').getAttribute('aria-invalid'), null);
  assert.equal(describedBy(path)[0].textContent, 'the path must start with $');

  // Typed into, the refused path is no longer the one refused.
  typeInto(path, '$.total');
  assert.equal(byId('assertion-rows').querySelectorAll('[aria-invalid="true"]').length, 0);
  assert.equal(byId('assertion-rows').querySelectorAll('.field-error').length, 0);
  assert.deepEqual(listenerErrors, []);
});

test('a refused queued request opened with Edit loses the editor mark once the fix is typed, and the row keeps its mark until Save', async () => {
  queueSeven();
  await refuse('sequence[4].assertions[0]', Msg);
  editor.openQueued(get().sequence[5].key);
  const value = () => byId('assertion-rows').querySelectorAll('.assert-row')[0].querySelector('.assert-value');
  assert.equal(value().getAttribute('aria-invalid'), 'true', 'the opened entry carries the run\'s mark');

  typeInto(value(), '201');
  assert.equal(value().getAttribute('aria-invalid'), null, 'no stale mark after the fix is typed');
  assert.equal(value().getAttribute('aria-describedby'), null);
  assert.equal(byId('assertion-rows').querySelectorAll('.field-error').length, 0, 'no stale message');
  assert.deepEqual(marked(), [6], 'the run still holds the refused copy');

  // Typed back to what was refused, it is the refused assertion again.
  typeInto(value(), '200');
  assert.equal(value().getAttribute('aria-invalid'), 'true');
  assert.equal(describedBy(value())[0].textContent, Msg);

  typeInto(value(), '201');
  byId('save-request').click();
  assert.deepEqual(marked(), []);
  typeInto(value(), '200');
  assert.equal(value().getAttribute('aria-invalid'), null, 'a saved fix ends the refusal');
  assert.deepEqual(listenerErrors, []);
});

test('a refused request opened from the sidebar loses the run\'s editor mark as soon as its refused assertion is typed into', async () => {
  for (let n = 1; n <= 3; n += 1) runner.add({ ...req(n), id: `ws-${n}` });
  await refuse('sequence[1].assertions[1]', 'gt needs a numeric value, got a string');
  sidebar.selectRequest(get().sequence[1].request);
  const value = () => byId('assertion-rows').querySelectorAll('.assert-row')[1].querySelector('.assert-value');
  assert.equal(value().getAttribute('aria-invalid'), 'true');
  typeInto(value(), '5');
  assert.equal(get().draft.id, 'ws-2', 'the same request, not a copy');
  assert.equal(value().getAttribute('aria-invalid'), null);
  assert.equal(byId('assertion-rows').querySelectorAll('.field-error').length, 0);
  assert.deepEqual(marked(), [2]);
  assert.deepEqual(listenerErrors, []);
});

test('another request open in the editor carries no mark', async () => {
  queueSeven();
  await refuse('sequence[4].assertions[0]', Msg);
  sidebar.selectRequest(get().sequence[4].request);
  assert.equal(byId('assertion-rows').querySelectorAll('[aria-invalid="true"]').length, 0);
});

test('a Send answered 400 for an assertion marks that control and reads "Refused - Assertion n: message"', async () => {
  sidebar.selectRequest({ ...req(1), id: 'ws-1' });
  fetchStub.respond('/api/send', { status: 400, body: { error: 'count needs a whole number of 0 or more, got 1.5', field: 'assertions[1]' } }, { method: 'POST' });
  byId('send-request').click();
  await flush();
  assert.equal(byId('send-status').textContent, 'Refused - Assertion 2: count needs a whole number of 0 or more, got 1.5');
  const row = byId('assertion-rows').querySelectorAll('.assert-row')[1];
  const value = row.querySelector('.assert-value');
  assert.equal(value.getAttribute('aria-invalid'), 'true');
  assert.equal(describedBy(value)[0].textContent, 'count needs a whole number of 0 or more, got 1.5');
  assert.equal(byId('send-response').textContent.includes('assertions[1]'), false, 'the field is named once');

  // Editing the request takes the mark away.
  typeInto(value, '3');
  assert.equal(byId('assertion-rows').querySelectorAll('[aria-invalid="true"]').length, 0);
  assert.equal(byId('send-status').textContent, '');
  assert.deepEqual(listenerErrors, []);
});

test('marks stay through renders, polls, another request\'s edit, and a reorder, where they follow the request', async () => {
  queueSeven();
  await refuse('sequence[4].assertions[0]', Msg);
  for (let i = 0; i < 3; i += 1) set({ status: { running: false, budget_balance: 1000 - i } });
  set({});
  assert.deepEqual(marked(), [6]);
  assert.equal(note(), `Refused - Request 6, assertion 1: ${Msg}`);

  // Another request edited in the editor.
  sidebar.selectRequest({ ...req(3), id: 'ws-3' });
  typeInto(byId('editor-name'), 'Renamed');
  assert.deepEqual(marked(), [6]);

  // Moved up one: the mark and the note go with it.
  const up = [...rows()[5].querySelectorAll('button')].find((b) => b.title.startsWith('Move') && b.title.endsWith('up'));
  up.click();
  assert.deepEqual(marked(), [5]);
  assert.equal(note(), `Refused - Request 5, assertion 1: ${Msg}`);
  assert.equal(rows()[4].querySelector('.seq-name').textContent, 'Request 6');
  assert.deepEqual(listenerErrors, []);
});

test('marks clear when the refused row is removed', async () => {
  queueSeven();
  await refuse('sequence[4].assertions[0]', Msg);
  const remove = [...rows()[5].querySelectorAll('button')].find((b) => b.title === 'Remove from the run');
  remove.click();
  assert.deepEqual(marked(), []);
  assert.doesNotMatch(note(), /Refused/);
});

test('marks clear when the next Start succeeds', async () => {
  queueSeven();
  await refuse('sequence[4].assertions[0]', Msg);
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-1' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  set({ status: { running: false } });
  assert.deepEqual(marked(), []);
  assert.doesNotMatch(note(), /Refused/);
});

test('a refusal naming no row, a row past the end, or a field the page does not know marks nothing and shows the field as it came', async () => {
  queueSeven();
  const cases = [
    ['sequence[9].assertions[0]', 'x', 'Refused - sequence[9].assertions[0]: x'],
    ['options.concurrency', 'y', 'Refused - Concurrency: y'],
    ['mode', 'z', 'Refused - Run mode: z'],
    ['sequence', 'w', 'Refused - Run sequence: w'],
    ['surprise[2]', 'v', 'Refused - surprise[2]: v'],
    [undefined, 'u', 'Refused - u'],
    ['body', 't', 'Refused - t'],
    ['sequence[0].params.q', 's', 'Refused - Request 1, parameter "q": s'],
    ['sequence[2].endpoint', 'r', 'Refused - Request 4, endpoint: r'],
  ];
  for (const [field, error, text] of cases) {
    await refuse(field, error);
    assert.equal(note(), text, String(field));
    if (!field || !/^sequence\[[0-5]\]\./.test(field)) assert.deepEqual(marked(), [], String(field));
  }
  assert.deepEqual(listenerErrors, []);
});

test('a refusal for a row removed while the answer was out marks nothing and says the request has gone', async () => {
  queueSeven();
  let settle;
  fetchStub.serve('/api/runs', () => new Promise((resolve) => { settle = resolve; }), { method: 'POST' });
  byId('start-run').click();
  await flush();
  const remove = [...rows()[5].querySelectorAll('button')].find((b) => b.title === 'Remove from the run');
  remove.click();
  settle({ status: 400, body: { error: Msg, field: 'sequence[4].assertions[0]' } });
  await flush();
  assert.deepEqual(marked(), []);
  assert.equal(note(), `Refused - a request since removed from the run: ${Msg}`);
  assert.deepEqual(listenerErrors, []);
});
