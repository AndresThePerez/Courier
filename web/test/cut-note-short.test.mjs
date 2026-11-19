// The cut sentence stays short: each field is said once however often the
// server lists it, and at most five are listed, then "and N more". Send and
// Start read it the same way.

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
const params = (n) => Array.from({ length: n }, (_, i) => `params.p${i}`);
const phrases = (n) => Array.from({ length: n }, (_, i) => `parameter p${i} (${Param})`);

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

test('a field the server lists twice is said once', () => {
  assert.equal(cutText(['params.q', 'name', 'params.q', 'name']), `Cut to fit: parameter q (${Param}); name (${Name}).`);
  const label = (i) => `Request ${i + 1}`;
  assert.equal(cutText(['sequence[0].params.q', 'sequence[1].params.q', 'sequence[0].params.q'], label),
    `Cut to fit: Request 1, parameter q (${Param}); Request 2, parameter q (${Param}).`);
});

test('five fields are listed whole; a sixth and more are counted', () => {
  assert.equal(cutText(params(5)), `Cut to fit: ${phrases(5).join('; ')}.`);
  assert.equal(cutText(params(6)), `Cut to fit: ${phrases(5).join('; ')}; and 1 more.`);
  assert.equal(cutText(params(50)), `Cut to fit: ${phrases(5).join('; ')}; and 45 more.`);
  assert.equal(cutText([...params(6), ...params(6)]), `Cut to fit: ${phrases(5).join('; ')}; and 1 more.`, 'a repeat was counted');
  assert.equal(cutText([1, null, '', ...params(5)]), `Cut to fit: ${phrases(5).join('; ')}.`, 'something that is not a field was counted');
});

test('a Send whose answer lists fifty fields and repeats says five and counts the rest, in one status line', async () => {
  sidebar.selectRequest(req(1));
  fetchStub.respond('/api/send', sent({ truncated: [...params(50), 'params.p0', 'params.p1'] }), { method: 'POST' });
  byId('send-request').click();
  await flush();
  assert.equal(byId('send-cut').getAttribute('role'), 'status');
  assert.equal(said('send-cut'), `Cut to fit: ${phrases(5).join('; ')}; and 45 more.`);
  assert.equal(byId('send-cut').children.length, 0);
  assert.deepEqual(listenerErrors, []);
});

test('a Start whose answer lists many fields says five and counts the rest', async () => {
  runner.add(req(1));
  runner.add(req(2));
  const truncated = [];
  for (let i = 0; i < 2; i += 1) truncated.push(`sequence[${i}].params.q`, `sequence[${i}].name`, `sequence[${i}].id`, `sequence[${i}].params.q`);
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-1', truncated } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  assert.equal(said('start-cut'), `Cut to fit: Request 1, parameter q (${Param}); Request 1, name (${Name}); Request 1, id (${Name}); `
    + `Request 2, parameter q (${Param}); Request 2, name (${Name}); and 1 more.`);
  assert.deepEqual(listenerErrors, []);
});

test('a malformed index or a field in markup is said as text, never relabelled, within the five', async () => {
  runner.add(req(1));
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-1', truncated: [
    'sequence[99999999999999999999].params.q', 'sequence[-1].params.q', 'sequence[0].params.<b>x</b>',
  ] } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  assert.equal(said('start-cut'), `Cut to fit: sequence[99999999999999999999].params.q; sequence[-1].params.q; Request 1, parameter <b>x</b> (${Param}).`);
  assert.equal(byId('start-cut').children.length, 0, 'server text became elements');
  assert.deepEqual(listenerErrors, []);
});
