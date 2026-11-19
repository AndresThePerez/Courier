// The history notice at its edges: a failure arriving while a visitor is in
// the list leaves the list and their focus alone, Retry pressed while another
// history read is already out settles both, and a failure followed by an
// answer is never left saying either the failure or "Loading".

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as api from '../js/api.js';
import { createLive } from '../js/live.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const FAILED = 'Could not load history from the server.';
const run = (id) => ({ id, mode: 'functional', status: 'completed', started_at: '2026-11-16T14:03:22Z', duration_ms: 120, summary: '3 passed' });

let unsubscribe = null;
let page = null;

// makeServer answers each history read from a queue of answers: a list of
// runs, 'down', or 'hold' for a read the test settles itself through
// server.release(list).
function makeServer(script) {
  const server = { script: script.slice(), asked: 0, held: [] };
  server.release = (answer) => {
    const next = server.held.shift();
    next(answer === 'down' ? Promise.reject(new TypeError('Failed to fetch')) : { status: 200, body: { runs: answer } });
  };
  fetchStub.serve('/api/collections', () => ({ status: 200, body: { collections: [], endpoints: [], target: 'search.example' } }), { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: { running: false } }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => {
    server.asked += 1;
    const next = server.script.length > 1 ? server.script.shift() : server.script[0];
    if (next === 'down') throw new TypeError('Failed to fetch');
    if (next === 'hold') return new Promise((resolve) => { server.held.push(resolve); });
    return { status: 200, body: { runs: next } };
  }, { method: 'GET' });
  return server;
}

async function bootPage(t, server) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  page = createLive({ api, get, set, showTab: (name) => set({ activeTab: name }) });
  sidebar.init({ ...page.hooks.sidebar });
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({});
  await page.boot();
  await flush();
  return server;
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (page) page.stop();
  page = null;
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
});

const said = () => byId('panel-sidebar').textContent.replace(/\s+/g, ' ');
const rows = () => [...byId('history-list').querySelectorAll('.req-open')];
const retry = () => [...byId('panel-sidebar').querySelectorAll('button')].find((b) => b.dataset.focusKey === 'history-retry');

test('a failed read arriving while a history row is focused leaves that row, its node and its focus in place', async (t) => {
  await bootPage(t, makeServer([[run('run-1'), run('run-2')], 'down']));
  const before = rows();
  before[1].focus();
  assert.ok(document.activeElement === before[1], 'the row did not take focus; the case proves nothing');
  await page.hooks.runner.refresh();
  await flush();
  assert.ok(said().includes(`${FAILED} Retry`), 'the failure is not said; the case proves nothing');
  rows().forEach((node, i) => assert.ok(node === before[i], `history row ${i} was rebuilt by the failure`));
  assert.ok(document.activeElement === before[1], 'focus left the history row when the failure arrived');
  assert.deepEqual(listenerErrors, []);
});

test('Retry pressed while another history read is out leaves neither the failure nor a busy Retry once the answer lands', async (t) => {
  const server = await bootPage(t, makeServer(['down', 'hold']));
  assert.ok(retry(), 'the first read did not fail; the case proves nothing');
  const out = page.hooks.runner.refresh();
  await flush();
  assert.equal(server.held.length, 1, 'no history read is out; the case proves nothing');
  retry().click();
  assert.equal(get().historyLoading, true);
  server.release([run('run-7')]);
  await flush();
  // A read marked stale is read again; this answer is the one that lands.
  while (server.held.length > 0) {
    server.release([run('run-7')]);
    await flush();
  }
  await out;
  assert.equal(retry(), undefined, 'Retry is still there after a good answer');
  assert.ok(!said().includes(FAILED), said());
  assert.equal(get().historyLoading, false, 'Retry is left marked busy');
  assert.deepEqual(rows().map((b) => b.title), ['run-7 - 3 passed']);
  assert.deepEqual(listenerErrors, []);
});

test('Retry that fails while a list is shown keeps the list and Retry ready for another press', async (t) => {
  const server = await bootPage(t, makeServer([[run('run-1')], 'down']));
  await page.hooks.runner.refresh();
  await flush();
  const asked = server.asked;
  retry().click();
  await flush();
  assert.equal(server.asked, asked + 1);
  assert.deepEqual(rows().map((b) => b.title), ['run-1 - 3 passed']);
  assert.equal(retry().getAttribute('aria-disabled'), 'false');
  retry().click();
  await flush();
  assert.equal(server.asked, asked + 2, 'a second Retry after the first settled did not ask again');
});

test('the list never says Loading once any answer, good or bad, has arrived', async (t) => {
  await bootPage(t, makeServer(['down', [], 'down', [run('run-1')]]));
  const loading = () => /Loading history/.test(said());
  assert.equal(loading(), false);
  for (let i = 0; i < 3; i += 1) {
    retry() ? retry().click() : await page.hooks.runner.refresh();
    await flush();
    assert.equal(loading(), false, `the list says Loading after answer ${i + 2}`);
  }
  assert.deepEqual(rows().map((b) => b.title), ['run-1 - 3 passed']);
  assert.equal(retry(), undefined);
});
