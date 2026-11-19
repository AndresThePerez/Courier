// Two places keyboard focus used to fall to the page body: a history Retry
// that brings back an empty list (the Retry is gone and there is no row to
// take focus), and a results filter button, replaced on every render of a
// live run.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as api from '../js/api.js';
import { createLive } from '../js/live.js';
import * as sidebar from '../js/render-sidebar.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];

let unsubscribe = null;
let page = null;

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

// ---------------------------------------------------------------- history Retry

test('a history Retry that brings back an empty list puts focus on the History heading, not the page', async (t) => {
  const answers = ['down', []];
  fetchStub.serve('/api/collections', () => ({ status: 200, body: { collections: [], endpoints: [], target: 'search.example' } }), { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: { running: false } }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next === 'down') throw new TypeError('Failed to fetch');
    return { status: 200, body: { runs: next } };
  }, { method: 'GET' });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  page = createLive({ api, get, set, showTab: (name) => set({ activeTab: name }) });
  sidebar.init({ ...page.hooks.sidebar });
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({});
  await page.boot();
  await flush();

  const retry = [...byId('panel-sidebar').querySelectorAll('button')].find((b) => b.dataset.focusKey === 'history-retry');
  assert.ok(retry, 'the first read did not fail; the case proves nothing');
  retry.focus();
  retry.click();
  await flush();
  assert.match(byId('history-list').textContent, /No runs yet\./, 'the list did not come back empty; the case proves nothing');
  const heading = byId('history-heading');
  assert.ok(heading, 'the History heading has no id to be found by');
  assert.equal(heading.textContent.trim(), 'History');
  assert.equal(heading.getAttribute('tabindex'), '-1', 'the heading takes focus without joining the tab order');
  assert.ok(document.activeElement === heading, `focus is on ${document.activeElement && document.activeElement.localName}`);
  assert.deepEqual(listenerErrors, []);
});

// ---------------------------------------------------------------- results filter

const row = (index, extra = {}) => ({
  index, name: `R${index}`, endpoint: 'search', query: '?q=a', status: 200, latency_ms: 4, size_bytes: 10, passed: true, skipped: false,
  assertions: [], ...extra,
});

const filterButtons = () => [...byId('results-filter').querySelectorAll('button')];
const filterButton = (name) => filterButtons().find((b) => b.textContent.startsWith(`${name} `));

function liveRun(id, rows) {
  unsubscribe = subscribe((state) => results.render(state));
  set({ endpoints, transport: 'sse', run: { id, mode: 'functional', total: 12, started_at: '2026-11-18T10:00:00Z', config: {}, entries: [] }, report: null, results: rows });
}

test('a focused filter button keeps focus, and its node, across ten renders of a live run', () => {
  liveRun('filter-run-1', [row(0)]);
  const before = filterButtons();
  const failed = filterButton('failed');
  failed.focus();
  assert.ok(document.activeElement === failed, 'the button did not take focus; the case proves nothing');
  for (let i = 1; i <= 10; i += 1) {
    if (i % 2) set({ results: [...get().results, row(i, i % 3 === 0 ? { passed: false } : {})] });
    else set({ status: { running: true, budget_balance: 100 - i } });
    assert.ok(document.activeElement === failed, `focus left the filter button on render ${i}`);
  }
  filterButtons().forEach((b, i) => assert.ok(b === before[i], `filter button ${i} was replaced`));
  assert.equal(filterButton('all').textContent, 'all 6', 'the counts are updated in place');
  assert.equal(filterButton('failed').textContent, 'failed 2');
  assert.deepEqual(listenerErrors, []);
});

test('pressing a filter keeps the same buttons, moves the pressed state, and filters by the newest rows', () => {
  liveRun('filter-run-2', [row(0), row(1, { passed: false })]);
  const before = filterButtons();
  filterButton('failed').focus();
  filterButton('failed').click();
  filterButtons().forEach((b, i) => assert.ok(b === before[i], `filter button ${i} was replaced by the press`));
  assert.ok(document.activeElement === filterButton('failed'));
  assert.equal(filterButton('failed').getAttribute('aria-pressed'), 'true');
  assert.equal(filterButton('all').getAttribute('aria-pressed'), 'false');
  assert.ok(filterButton('failed').classList.contains('is-on'));
  assert.ok(!filterButton('all').classList.contains('is-on'));

  // Rows that arrive after the press are filtered too, and a later press
  // reads them, not the rows of the render the button was drawn in.
  set({ results: [...get().results, row(2, { passed: false }), row(3)] });
  assert.equal(byId('results-rows').querySelectorAll('.res-row').length, 2);
  filterButton('passed').click();
  assert.deepEqual([...byId('results-rows').querySelectorAll('.res-row summary')].map((s) => s.dataset.focusKey), ['res:0', 'res:3']);
  assert.deepEqual(listenerErrors, []);
});
