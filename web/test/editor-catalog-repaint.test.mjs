// The editor draws from the endpoint catalog in three places: the endpoint
// picker, the parameter table (which keys an endpoint allows) and the line
// above a Send's response (its method and path). A request can be open, and a
// Send answered, before the catalog arrives, so each of the three is repainted
// when the catalog changes, read here as painted.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe, renderAll } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const search = { id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] };

let unsubscribe = null;

function boot() {
  localStorage.setItem(WORKSPACE, JSON.stringify({
    version: 1,
    requests: [{ id: 'ws-a', name: 'Find', endpoint: 'search', params: { q: 'mew' }, assertions: [] }],
  }));
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  runner.init({});
  sidebar.init({ select: (request) => { editor.onSelect(); sidebar.selectRequest(request); } });
  unsubscribe = subscribe((state) => renderAll([sidebar.render, editor.render, runner.render, results.render], state));
  set({});
  editor.onSelect();
  sidebar.selectRequest(workspace.find('ws-a'));
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
});

const options = () => [...byId('endpoint-select').querySelectorAll('option')].map((o) => o.textContent);

test('a request opened before the catalog arrives gets its parameter table once the catalog is in', () => {
  boot();
  assert.match(byId('param-rows').textContent, /takes no query parameters/, 'the case starts without a catalog');

  set({ endpoints: [search] });

  const values = [...byId('param-rows').querySelectorAll('.param-value')].map((i) => i.value);
  assert.deepEqual(values, ['mew'], 'the parameter the request holds is not shown');
  assert.equal(byId('add-param').disabled, false, 'Add stays dead though the endpoint allows another key');
  assert.deepEqual(options(), ['Search - GET /search']);
  assert.deepEqual(listenerErrors, []);
});

test('a catalog replaced by one of the same length repaints the endpoint picker', () => {
  boot();
  set({ endpoints: [search] });
  set({ endpoints: [{ ...search, label: 'Search cards' }] });
  assert.deepEqual(options(), ['Search cards - GET /search']);
  assert.deepEqual(listenerErrors, []);
});

test('a Send answered before the catalog arrives names the method and path once it is in', async () => {
  boot();
  fetchStub.respond('/api/send', {
    status: 200,
    body: { status: 200, passed: true, endpoint: 'search', query: '?q=mew', latency_ms: 1, size_bytes: 2, body: '{}', assertions: [] },
  }, { method: 'POST' });
  byId('send-request').click();
  await flush();
  const line = () => byId('send-response').querySelector('.note').textContent;
  assert.equal(line(), '--- search?q=mew', 'the case starts without a catalog');

  set({ endpoints: [search] });

  assert.equal(line(), 'GET /search?q=mew');
  assert.equal(get().send.result.endpoint, 'search');
  assert.deepEqual(listenerErrors, []);
});
