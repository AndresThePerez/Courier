// When the server cuts a parameter value, a name or an id to fit its limits,
// it lists what it cut in `truncated` on Send's 200 and on the run's 202. The
// page says so in one status sentence, naming the request and the field the
// way the page names them, and the sentence goes with the next Send or Start.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import { cutText } from '../js/request-model.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const req = (n) => ({ id: `ws-cut-${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [] });
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
  runner.init({ refresh: async () => {} });
  unsubscribe = subscribe((state) => { editor.render(state); runner.render(state); });
});

const said = (id) => (byId(id).hidden ? '' : byId(id).textContent);

async function start(answer) {
  fetchStub.respond('/api/runs', answer, { method: 'POST' });
  byId('start-run').click();
  await flush();
}

const rowButton = (i, test) => [...byId('sequence-list').querySelectorAll('.seq-row')[i].querySelectorAll('button')].find(test);

async function send(answer) {
  fetchStub.respond('/api/send', answer, { method: 'POST' });
  byId('send-request').click();
  await flush();
}

test('a Send whose answer lists a cut parameter says which, in a status sentence, until the next Send', async () => {
  sidebar.selectRequest(req(1));
  await send(sent({ truncated: ['params.q'] }));
  assert.equal(byId('send-cut').getAttribute('role'), 'status');
  assert.equal(said('send-cut'), `Cut to fit: parameter q (${Param}).`);
  await send(sent());
  assert.equal(said('send-cut'), '', 'the sentence outlived the next Send');
  assert.deepEqual(listenerErrors, []);
});

test('a Send that cut the name, a parameter and the id names all three in the order the server gave', async () => {
  sidebar.selectRequest(req(1));
  await send(sent({ truncated: ['name', 'params.q', 'id'] }));
  assert.equal(said('send-cut'), `Cut to fit: name (${Name}); parameter q (${Param}); id (${Name}).`);
});

test('a Send refused after a cut one takes the sentence away', async () => {
  sidebar.selectRequest(req(1));
  await send(sent({ truncated: ['params.q'] }));
  await send({ status: 400, body: { error: 'nope', field: 'endpoint' } });
  assert.equal(said('send-cut'), '');
});

test('a cut field the page does not know is said as it came, and a list that is not one says nothing', async () => {
  sidebar.selectRequest(req(1));
  await send(sent({ truncated: ['surprise[2]', 'params.page'] }));
  assert.equal(said('send-cut'), `Cut to fit: surprise[2]; parameter page (${Param}).`);
  await send(sent({ truncated: 'params.q' }));
  assert.equal(said('send-cut'), '');
  await send(sent({ truncated: [7, null] }));
  assert.equal(said('send-cut'), '');
  assert.deepEqual(listenerErrors, []);
});

test('a run\'s cut fields are named by the request each belongs to, as the caller labels it', () => {
  const label = (i) => ['Request 2', ''][i];
  assert.equal(cutText(['sequence[0].params.q', 'sequence[1].name', 'sequence[0].id'], label),
    `Cut to fit: Request 2, parameter q (${Param}); sequence[1].name; Request 2, id (${Name}).`);
  assert.equal(cutText([], label), '');
  assert.equal(cutText(null, label), '');
});

test('a Start whose answer lists cuts names each request by its row, as a refusal of the same run does, past an unchecked row', async () => {
  for (let n = 1; n <= 3; n += 1) runner.add(req(n));
  byId('sequence-list').querySelectorAll('.seq-check')[0].click(); // row 1 unchecked: not sent
  await start({ status: 400, body: { error: 'nope', field: 'sequence[0].params.q' } });
  assert.equal(said('start-note'), 'Refused - Request 2, parameter "q": nope', 'the refusal names the row; the case proves nothing');

  await start({ status: 202, body: { run_id: 'run-cut-1', truncated: ['sequence[0].params.q', 'sequence[1].name'] } });
  assert.equal(byId('start-cut').getAttribute('role'), 'status');
  assert.equal(said('start-cut'), `Cut to fit: Request 2, parameter q (${Param}); Request 3, name (${Name}).`);
  assert.deepEqual(listenerErrors, []);
});

test('after Start the sentence follows each request through a reorder, and says when one was removed', async () => {
  for (let n = 1; n <= 3; n += 1) runner.add(req(n));
  byId('sequence-list').querySelectorAll('.seq-check')[0].click();
  await start({ status: 202, body: { run_id: 'run-cut-2', truncated: ['sequence[0].params.q', 'sequence[1].name'] } });
  rowButton(2, (b) => (b.title || '').endsWith('up')).click(); // Request 3 moves above Request 2
  assert.equal(said('start-cut'), `Cut to fit: Request 3, parameter q (${Param}); Request 2, name (${Name}).`);
  rowButton(1, (b) => b.title === 'Remove from the run').click(); // the one whose name was cut
  assert.equal(said('start-cut'), `Cut to fit: Request 2, parameter q (${Param}); a request since removed from the run, name (${Name}).`);
  assert.deepEqual(listenerErrors, []);
});

for (const [what, answer] of [
  ['accepted', { status: 202, body: { run_id: 'run-next' } }],
  ['refused', { status: 400, body: { error: 'nope', field: 'mode' } }],
  ['answered busy with a live run', { status: 409, body: { error: 'busy', run_id: 'run-other' } }],
  ['answered busy for a moment', { status: 503, headers: { 'Retry-After': '1' }, body: { error: 'the server is busy checking other requests; try again in a moment' } }],
]) {
  test(`the sentence goes with the next Start, ${what}`, async () => {
    runner.add(req(1));
    await start({ status: 202, body: { run_id: 'run-cut-3', truncated: ['sequence[0].params.q'] } });
    assert.equal(said('start-cut'), `Cut to fit: Request 1, parameter q (${Param}).`, 'nothing to take away; the case proves nothing');
    set({ status: { running: false } });
    await start(answer);
    assert.equal(said('start-cut'), '');
    assert.deepEqual(listenerErrors, []);
  });
}

test('a run this tab did not start never shows the sentence', async () => {
  runner.add(req(1));
  set({ status: { running: true, run_id: 'run-elsewhere', mode: 'functional' } });
  set({ status: { running: false } });
  await start({ status: 409, body: { error: 'busy', run_id: 'run-elsewhere', truncated: ['sequence[0].params.q'] } });
  assert.equal(said('start-cut'), '');
  assert.equal(get().status.run_id, 'run-elsewhere');
});

test('a truncated that is not a list of text says nothing, or only its text, and the 202 is still a start', async () => {
  runner.add(req(1));
  for (const [truncated, want] of [
    ['sequence[0].params.q', ''],
    [{ 0: 'sequence[0].params.q' }, ''],
    [[7, null, { f: 1 }], ''],
    [[7, 'sequence[0].params.q'], `Cut to fit: Request 1, parameter q (${Param}).`],
    [['sequence[9].params.q'], `Cut to fit: sequence[9].params.q.`],
  ]) {
    set({ status: { running: false } });
    await start({ status: 202, body: { run_id: 'run-odd', truncated } });
    assert.equal(get().status.running, true, `${JSON.stringify(truncated)}: the run did not start`);
    assert.equal(get().status.run_id, 'run-odd');
    assert.equal(said('start-cut'), want, JSON.stringify(truncated));
  }
  assert.deepEqual(listenerErrors, []);
});

test('a cut field the page does not know is shown as text, clipped', async () => {
  sidebar.selectRequest(req(1));
  const markup = '<img src=x onerror="alert(1)"><b>bold</b>';
  await send(sent({ truncated: [markup] }));
  assert.equal(said('send-cut'), `Cut to fit: ${markup}.`);
  assert.equal(byId('send-cut').querySelectorAll('*').length, 0, 'markup in the server text became elements');
  const long = `odd${'x'.repeat(500)}`;
  await send(sent({ truncated: [long, 'params.q'] }));
  assert.equal(said('send-cut'), `Cut to fit: ${long.slice(0, 80)}...; parameter q (${Param}).`);
  const astral = '\u{1F600}'.repeat(100);
  await send(sent({ truncated: [`params.${astral}`] }));
  assert.equal(said('send-cut'), `Cut to fit: parameter ${'\u{1F600}'.repeat(80)}... (${Param}).`);
  assert.equal(said('send-cut').isWellFormed(), true);
});
