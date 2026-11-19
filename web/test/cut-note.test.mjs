// When the server cuts a parameter value, a name or an id to fit its limits,
// it lists what it cut in `truncated` on Send's 200. The page says so in one
// status sentence, naming the field the way the page names it, and the
// sentence goes with the next Send.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
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
