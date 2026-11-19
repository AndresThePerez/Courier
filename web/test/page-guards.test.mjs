// One pane failing to draw leaves the others drawing and the page syncing;
// focus keys from anywhere on the page never reach a selector; and Send's
// answer names the method the catalog states, never a guessed one.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, eventSources, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe, renderAll } from '../js/store.js';
import * as api from '../js/api.js';
import { createLive } from '../js/live.js';
import * as sidebar from '../js/render-sidebar.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);

let unsubscribe = null;
let page = null;
let errors = [];

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args); });
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  if (page) page.stop();
  page = null;
  api.onRunStarted(() => {});
});

// ------------------------------------------------------------------ one pane throwing

test('renderAll draws every pane in order even when one throws, and logs the throw', () => {
  const drawn = [];
  const boom = new Error('pane broke');
  const panes = [
    (s) => drawn.push(['a', s]),
    () => { throw boom; },
    (s) => drawn.push(['c', s]),
    (s) => drawn.push(['d', s]),
  ];
  const state = { marker: 1 };
  assert.doesNotThrow(() => renderAll(panes, state));
  assert.deepEqual(drawn.map(([name]) => name), ['a', 'c', 'd']);
  assert.ok(drawn.every(([, s]) => s === state), 'every pane is handed the same state');
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'render failed');
  assert.ok(errors[0][1] === boom, 'the throw itself is logged');
});

// bootPage wires the page as main.js does, with one pane that always throws.
async function bootPage(t, server) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const showTab = (name) => set({ activeTab: name });
  page = createLive({ api, get, set, showTab });
  editor.init();
  runner.init(page.hooks.runner);
  sidebar.init({ ...page.hooks.sidebar });
  const broken = () => { throw new Error('this pane cannot draw'); };
  unsubscribe = subscribe((state) => {
    renderAll([sidebar.render, broken, runner.render, results.render], state);
    page.scheduleSync();
  });
  fetchStub.serve('/api/collections', () => ({ status: 200, body: { collections: [], endpoints: [], target: '' } }), { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: server.status }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => ({ status: 200, body: { runs: [] } }), { method: 'GET' });
  fetchStub.serve(/^\/api\/runs\/[^/]+$/, () => ({ status: 200, body: { id: 'run-1', mode: 'functional', status: 'running', started_at: '2026-11-18T10:00:00Z', entries: [] } }), { method: 'GET' });
  set({ activeTab: 'runner' });
  await page.boot();
  await flush();
}

test('with one pane throwing on every render, the panes after it still draw and the page still follows a live run', async (t) => {
  const server = { status: { running: true, run_id: 'run-1', mode: 'functional', started_at: '2026-11-18T10:00:00Z', budget_balance: 1500 } };
  await bootPage(t, server);
  assert.equal(byId('start-run').disabled, true, 'the run panel drew the live run');
  assert.equal(get().run && get().run.id, 'run-1', 'the page attached to the live run');
  assert.equal(eventSources.instances.length, 1);
  assert.ok(errors.some((e) => e[0] === 'render failed'));
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ focus keys

const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] }];
const request = (id, extra = {}) => ({ id, name: `Request ${id}`, endpoint: 'search', params: { q: 'x' }, assertions: [{ type: 'status', op: 'eq', value: 200 }], ...extra });

test('focus left on a sidebar control whose key holds a quote does not stop the editor from drawing, and stays where it is', () => {
  set({ endpoints });
  editor.init();
  const outside = document.createElement('button');
  outside.dataset.focusKey = 'open:ws:ws-"q] [x="y';
  byId('panel-sidebar').appendChild(outside);
  outside.focus();
  for (const id of ['ws-1', 'ws-2', 'ws-3']) {
    set({ draft: request(id), selectedId: id });
    assert.doesNotThrow(() => editor.render(get()), `render of ${id}`);
    assert.equal(byId('param-rows').querySelectorAll('.param-row').length, 1, `the table of ${id} was drawn`);
    assert.ok(document.activeElement === outside, 'focus stayed on the sidebar control');
  }
  assert.deepEqual(listenerErrors, []);
});

test('focus inside the editor follows its control across a rebuild by comparing keys', () => {
  set({ endpoints });
  editor.init();
  set({ draft: request('ws-a', { params: { q: 'x', page: '1' } }), selectedId: 'ws-a' });
  editor.render(get());
  const second = byId('param-rows').querySelectorAll('.param-value')[1];
  second.focus();
  set({ draft: request('ws-b', { params: { q: 'y', page: '2' } }), selectedId: 'ws-b' });
  editor.render(get());
  const now = byId('param-rows').querySelectorAll('.param-value')[1];
  assert.ok(now !== second, 'the table was rebuilt');
  assert.ok(document.activeElement === now, 'focus moved to the rebuilt control with the same key');
});

// ------------------------------------------------------------------ the Send line

async function sendAndRead(catalog, endpointId) {
  set({ endpoints: catalog });
  editor.init();
  set({ draft: request('ws-s', { endpoint: endpointId }), selectedId: 'ws-s' });
  editor.render(get());
  fetchStub.respond('/api/send', { status: 200, body: { status: 200, passed: true, endpoint: endpointId, query: '?q=x', latency_ms: 1, size_bytes: 2, body: '{}', assertions: [] } }, { method: 'POST' });
  const unsub = subscribe((state) => editor.render(state));
  byId('send-request').click();
  await flush();
  unsub();
  return byId('send-response').querySelector('.note').textContent;
}

test('Send\'s answer names the method the catalog states for the endpoint', async () => {
  const line = await sendAndRead([{ id: 'make', label: 'Make', method: 'post', path: '/make', params: ['q'] }], 'make');
  assert.equal(line, 'POST /make?q=x');
});

test('Send\'s answer for an endpoint the catalog does not list shows a placeholder method, never GET', async () => {
  const line = await sendAndRead([{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }], 'gone');
  assert.equal(line, '--- gone?q=x');
  const noMethod = await sendAndRead([{ id: 'quiet', label: 'Quiet', path: '/quiet', params: ['q'] }], 'quiet');
  assert.equal(noMethod, '--- /quiet?q=x');
  assert.deepEqual(listenerErrors, []);
});
