// A keyboard visitor's focus is never dropped to the page: not when the
// Reset confirm they are in goes away, and not when a live run's rows arrive
// around the row they are reading.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as sidebar from '../js/render-sidebar.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  localStorage.heal();
  workspace.stop();
});

// ---------------------------------------------------------------- reset

function bootSidebar() {
  localStorage.setItem(WORKSPACE, JSON.stringify({
    version: 1,
    requests: [{ id: 'ws-a', name: 'Find', endpoint: 'search', params: {}, assertions: [] }],
  }));
  workspace.init();
  sidebar.init({});
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({ endpoints });
}

// press is a keyboard press on a confirm button: focus is on it when it fires.
function press(text) {
  const button = [...byId('reset-confirm').querySelectorAll('button')].find((b) => b.textContent === text);
  button.focus();
  assert.ok(document.activeElement === button, `${text} did not take focus; the case proves nothing`);
  button.click();
}

test('Cancel in the Reset confirm puts focus back on Reset', () => {
  bootSidebar();
  byId('reset-workspace').click();
  press('Cancel');
  assert.equal(byId('reset-confirm').hidden, true);
  assert.ok(document.activeElement === byId('reset-workspace'), 'focus was left on a hidden button');
  assert.equal(get().workspace.length, 1);
  assert.deepEqual(listenerErrors, []);
});

test('a confirmed Reset puts focus back on Reset', () => {
  bootSidebar();
  byId('reset-workspace').click();
  press('Reset workspace');
  assert.equal(get().workspace.length, 0, 'the reset did not happen; the case proves nothing');
  assert.ok(document.activeElement === byId('reset-workspace'), 'focus was left on a hidden button');
  assert.deepEqual(listenerErrors, []);
});

test('a Reset the browser refuses puts focus back on Reset, with the note saying why', () => {
  bootSidebar();
  localStorage.failOn('setItem');
  localStorage.failOn('removeItem');
  byId('reset-workspace').click();
  press('Reset workspace');
  assert.equal(byId('workspace-note').hidden, false);
  assert.equal(byId('workspace-note').textContent, workspace.RESET_REFUSED);
  assert.ok(document.activeElement === byId('reset-workspace'), 'focus was left on a hidden button');
  assert.deepEqual(listenerErrors, []);
});

// ---------------------------------------------------------------- result rows

let seq = 0;
const row = (index, extra = {}) => ({
  index, name: `R${index}`, endpoint: 'search', query: '?q=a', status: 200, latency_ms: 4, size_bytes: 10, passed: true, skipped: false,
  assertions: [], ...extra,
});

function live(rows) {
  unsubscribe = subscribe((state) => results.render(state));
  seq += 1;
  set({ endpoints, transport: 'sse', run: { id: `focus-run-${seq}`, mode: 'functional', total: 5, started_at: '2026-11-18T10:00:00Z', config: {}, entries: [] }, report: null, results: rows });
}

const shown = () => [...byId('results-rows').querySelectorAll('.res-row')];
const arrive = (r) => set({ results: [...get().results, r] });

test('a row\'s summary focused during a live run keeps focus as more rows arrive', () => {
  live([row(0), row(1)]);
  const summary = shown()[0].querySelector('summary');
  summary.focus();
  arrive(row(2));
  arrive(row(3, { passed: false }));
  assert.equal(shown().length, 4, 'the rows did not arrive; the case proves nothing');
  assert.ok(document.activeElement === summary, 'focus left the row\'s summary');
  assert.ok(summary.isConnected);
  assert.deepEqual(listenerErrors, []);
});

test('a control inside an open row keeps focus as more rows arrive, and the row stays open', () => {
  live([row(0, { body_preview: '{"total":3}' }), row(1)]);
  const first = shown()[0];
  first.open = true;
  first.dispatchEvent(new Event('toggle'));
  const control = first.querySelector('.res-detail button');
  assert.ok(control, 'the open row has no control; the case proves nothing');
  control.focus();
  arrive(row(2));
  assert.ok(document.activeElement === control, 'focus left the control inside the open row');
  assert.equal(shown()[0].open, true);
  assert.deepEqual(listenerErrors, []);
});

test('a row delivered again under the same index takes the focus its summary had', () => {
  live([row(0), row(1)]);
  shown()[1].querySelector('summary').focus();
  const rows = get().results.slice();
  rows[1] = row(1, { body_preview: '{"total":3}' });
  set({ results: rows });
  const now = shown()[1].querySelector('summary');
  assert.ok(document.activeElement === now, 'focus dropped to the page when its row was drawn again');
  assert.deepEqual(listenerErrors, []);
});
