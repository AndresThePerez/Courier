// What the page says the server cut, against what was sent and against what
// the visitor did since: the sentence names the rows a refusal of the same
// run would name, follows them through the visitor's changes, goes with
// every next Start or Send whatever becomes of it, and reads whatever the
// server's list holds as text, never as markup or object keys.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] }];
const req = (n, q = `q${n}`) => ({ id: `ws-edge-${n}`, name: `Request ${n}`, endpoint: 'search', params: { q }, assertions: [] });
const sent = (extra = {}) => ({ status: 200, body: { status: 200, passed: true, endpoint: 'search', query: '?q=x', latency_ms: 1, size_bytes: 2, body: '{}', assertions: [], ...extra } });

const Param = '256 characters, 32 words at most';
const Name = '120 characters at most';

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  if (unsubscribe) unsubscribe();
  resetBrowser();
  resetState();
  workspace.init();
  set({ endpoints });
  editor.init();
  runner.init({ refresh: async () => {}, edit: (key) => editor.editQueued(key, (name) => set({ activeTab: name })) });
  unsubscribe = subscribe((state) => { editor.render(state); runner.render(state); });
});

const said = (id) => (byId(id).hidden ? '' : byId(id).textContent);
const rows = () => [...byId('sequence-list').querySelectorAll('.seq-row')];
const rowButton = (i, pick) => [...rows()[i].querySelectorAll('button')].find(pick);
const check = (i) => rows()[i].querySelector('.seq-check');

async function start(answer) {
  if (answer instanceof Error) fetchStub.reject('/api/runs', answer, { method: 'POST' });
  else fetchStub.respond('/api/runs', answer, { method: 'POST' });
  byId('start-run').click();
  await flush();
}

async function send(answer) {
  fetchStub.respond('/api/send', answer, { method: 'POST' });
  byId('send-request').click();
  await flush();
}

async function cutRun(truncated = ['sequence[0].params.q']) {
  await start({ status: 202, body: { run_id: `run-edge-${Math.random()}`, truncated } });
  assert.notEqual(said('start-cut'), '', 'nothing was said to take away; the case proves nothing');
  set({ status: { running: false } });
}

for (const [what, answer] of [
  ['answered cooling down', { status: 409, body: { error: 'cooling', cooldown_until: '2099-01-01T00:00:00Z' } }],
  ['that never reached the server', new TypeError('Failed to fetch')],
  ['answered with a server error', { status: 500, body: { error: 'boom' } }],
]) {
  test(`the cut sentence goes with the next Start ${what}`, async () => {
    runner.add(req(1));
    await cutRun();
    await start(answer);
    assert.equal(said('start-cut'), '');
    assert.deepEqual(listenerErrors, []);
  });
}

test('the cut sentence numbers rows as the refusal of the same run does, through unchecking, removing, re-adding and an Edit-and-save', async () => {
  for (let n = 1; n <= 4; n += 1) runner.add(req(n));
  check(0).click();
  check(2).click(); // rows 1 and 3 unchecked: the payload holds rows 2 and 4
  await start({ status: 400, body: { error: 'nope', field: 'sequence[1].params.q' } });
  assert.equal(said('start-note'), 'Refused - Request 4, parameter "q": nope', 'the refusal names the row; the case proves nothing');

  await cutRun(['sequence[1].params.q', 'sequence[0].name']);
  assert.equal(said('start-cut'), `Cut to fit: Request 4, parameter q (${Param}); Request 2, name (${Name}).`);

  // Checking or unchecking rows after the start renumbers nothing.
  check(0).click();
  check(1).click();
  assert.equal(said('start-cut'), `Cut to fit: Request 4, parameter q (${Param}); Request 2, name (${Name}).`);

  // Edit and save a row (copied into My Workspace on the way): it is the same row.
  rowButton(3, (b) => b.textContent === 'Edit').click();
  assert.ok(get().draft, 'the row did not open; the case proves nothing');
  byId('save-request').click();
  assert.equal(get().sequence[3].request.id, get().draft.id, 'Save did not reach the row; the case proves nothing');
  assert.equal(said('start-cut'), `Cut to fit: Request 4, parameter q (${Param}); Request 2, name (${Name}).`);

  // Removed, then the same request added again: the new row is not the one the run sent.
  rowButton(1, (b) => b.title === 'Remove from the run').click();
  runner.add(req(2));
  assert.equal(rows().length, 4);
  assert.equal(said('start-cut'), `Cut to fit: Request 3, parameter q (${Param}); a request since removed from the run, name (${Name}).`);
  assert.deepEqual(listenerErrors, []);
});

test('a hostile truncated list is read as text only: duplicates, object keys, markup, a huge index, fifty entries', async () => {
  runner.add(req(1));
  const fifty = Array.from({ length: 50 }, (_, i) => `sequence[0].params.p${i}`);
  await cutRun([
    'sequence[0].params.__proto__', 'sequence[0].__proto__', 'sequence[0].params.constructor',
    'sequence[0].params.q', 'sequence[0].params.q', 'sequence[99999999999999999999].params.q',
    'sequence[-1].params.q', 'sequence[0].params.<b>x</b>', ...fifty,
  ]);
  const text = said('start-cut');
  assert.ok(text.startsWith(`Cut to fit: Request 1, parameter __proto__ (${Param}); Request 1, __proto__; Request 1, parameter constructor (${Param}); `), text.slice(0, 200));
  assert.ok(text.endsWith(`Request 1, parameter q (${Param}); sequence[99999999999999999999].params.q; and 52 more.`), 'an index past the run was relabelled, or the rest is not counted');
  assert.equal(text.split(`Request 1, parameter q (${Param})`).length - 1, 1, 'the duplicate is said twice');
  assert.equal(byId('start-cut').querySelectorAll('*').length, 0, 'server text became elements');
  assert.equal(Object.prototype.q, undefined);
  assert.equal({}.constructor, Object, 'the prototype was touched');
  assert.deepEqual(listenerErrors, []);
});

test('the Send sentence goes when another request is opened, and is never shown for a request this Send did not carry', async () => {
  editor.onSelect();
  sidebar.selectRequest(req(1));
  await send(sent({ truncated: ['params.q'] }));
  assert.equal(said('send-cut'), `Cut to fit: parameter q (${Param}).`);
  editor.onSelect();
  sidebar.selectRequest(req(2));
  assert.equal(said('send-cut'), '', 'the sentence about request 1 is shown over request 2');

  // A Send whose answer arrives after another request was opened says nothing.
  editor.onSelect();
  sidebar.selectRequest(req(1));
  const late = fetchStub.defer('/api/send', { method: 'POST' });
  byId('send-request').click();
  await flush();
  editor.onSelect();
  sidebar.selectRequest(req(2));
  late.resolve(sent({ truncated: ['params.q'] }));
  await flush();
  assert.equal(said('send-cut'), '');
  assert.deepEqual(listenerErrors, []);
});

test('a Send refused by the page itself, before anything is sent, takes the sentence away', async () => {
  editor.onSelect();
  sidebar.selectRequest({ ...req(1), assertions: [{ type: 'json', path: '', op: 'exists' }] });
  set({ draft: { ...get().draft, assertions: [] } });
  await send(sent({ truncated: ['params.q'] }));
  assert.equal(said('send-cut'), `Cut to fit: parameter q (${Param}).`, 'nothing to take away; the case proves nothing');
  set({ draft: { ...get().draft, assertions: [{ type: 'json', path: '', op: 'exists' }] } });
  const before = fetchStub.calls.length;
  byId('send-request').click();
  await flush();
  assert.equal(fetchStub.calls.length, before, 'the invalid draft was sent; the case proves nothing');
  assert.equal(said('send-cut'), '');
  assert.deepEqual(listenerErrors, []);
});
