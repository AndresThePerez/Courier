// The Results tab's line for a history run that could not be opened, under
// every way of failing and every way the visitor moves on: it says the click's
// failure once, at both widths, stays true while the tab shows what it showed
// at the click, and never stands over another run.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, media, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as api from '../js/api.js';
import { createLive } from '../js/live.js';
import * as sidebar from '../js/render-sidebar.js';
import * as results from '../js/render-results.js';
import * as tabs from '../js/tabs.js';

const byId = (id) => document.getElementById(id);
const NARROW = '(max-width: 900px)';
const GONE = 'run-gone-2';
const DOWN = 'run-down-2';
const ODD = 'run-odd-2';
const SLOW = 'run-slow-2';
const KEPT = 'run-kept-2';
const NEW = 'run-new-2';
const entry = (id) => ({ id, mode: 'functional', status: 'completed', started_at: '2026-11-18T09:00:00Z', duration_ms: 30, summary: '1 passed' });
const kept = {
  id: KEPT, mode: 'functional', status: 'completed', started_at: '2026-11-18T09:00:00Z', duration_ms: 30, config: {}, entries: [{ index: 0, name: 'Kept' }],
  functional: { verdict: 'PASS', results: [{ index: 0, name: 'Kept', endpoint: 'search', query: '?q=a', status: 200, latency_ms: 4, size_bytes: 9, passed: true, skipped: false, assertions: [{ assertion: { type: 'status', op: 'eq', value: 200 }, passed: true, expected: '200', actual: '200' }] }] },
};

const GoneSaid = 'That run is no longer stored on the server.';
const DownSaid = 'Could not open that run - Courier could not be reached.';

let unsubscribe = null;
let page = null;
let slow = null;

async function boot(t, narrow) {
  media.set(NARROW, narrow);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  fetchStub.serve('/api/collections', () => ({ status: 200, body: { collections: [], endpoints: [], target: 'search.example' } }), { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: { running: false } }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => ({ status: 200, body: { runs: [entry(GONE), entry(DOWN), entry(ODD), entry(SLOW), entry(KEPT)] } }), { method: 'GET' });
  fetchStub.serve(`/api/runs/${GONE}`, () => ({ status: 404, body: { error: 'no run' } }), { method: 'GET' });
  fetchStub.serve(`/api/runs/${DOWN}`, () => { throw new TypeError('Failed to fetch'); }, { method: 'GET' });
  fetchStub.serve(`/api/runs/${ODD}`, () => ({ status: 200, body: { id: 'someone-else', mode: 'functional' } }), { method: 'GET' });
  fetchStub.serve(`/api/runs/${KEPT}`, () => ({ status: 200, body: kept }), { method: 'GET' });
  slow = fetchStub.defer(`/api/runs/${SLOW}`, { method: 'GET' });
  page = createLive({ api, get, set, showTab: tabs.showTab });
  tabs.init();
  sidebar.init({ ...page.hooks.sidebar });
  unsubscribe = subscribe((state) => { tabs.renderTabs(state); sidebar.render(state); results.render(state); });
  set({ activeTab: 'runner' });
  await page.boot();
  await flush();
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

const rowFor = (id) => [...byId('history-list').querySelectorAll('.req-open')].find((b) => b.title.startsWith(id));
const line = () => byId('history-open-note');
const said = () => (line().hidden ? '' : line().textContent);

async function open(id, narrow) {
  if (narrow) {
    if (byId('panel-sidebar').inert) byId('sidebar-toggle').click();
    assert.equal(Boolean(byId('panel-sidebar').inert), false, 'the drawer did not open; the case proves nothing');
  }
  rowFor(id).click();
  await flush(10);
  if (narrow) assert.equal(Boolean(byId('panel-sidebar').inert), true, 'the drawer is still open; the case proves nothing');
  assert.equal(byId('tab-results').getAttribute('aria-selected'), 'true', 'the click did not show Results');
}

for (const narrow of [true, false]) {
  const width = narrow ? 'below' : 'above';

  test(`${width} 900px, a run that cannot be reached and one whose answer is not its report are each said, and the right sentence replaces the last`, async (t) => {
    await boot(t, narrow);
    await open(DOWN, narrow);
    assert.equal(said(), DownSaid);
    await open(ODD, narrow);
    assert.equal(said(), DownSaid, 'an answer that is not the run\'s report reads as one that never arrived');
    await open(GONE, narrow);
    assert.equal(said(), GoneSaid);
    assert.equal(document.querySelectorAll('#history-open-note').length, 1);
    assert.deepEqual(listenerErrors, []);
  });

  test(`${width} 900px, the same failing row clicked twice says it again, in one line, and a tab change and back keeps it`, async (t) => {
    await boot(t, narrow);
    await open(GONE, narrow);
    const node = line();
    assert.equal(said(), GoneSaid);
    await open(GONE, narrow);
    assert.ok(line() === node, 'the line was replaced');
    assert.equal(said(), GoneSaid);
    tabs.showTab('runner');
    set({ activeTab: 'runner' });
    tabs.showTab('results');
    set({ activeTab: 'results' });
    assert.equal(said(), GoneSaid, 'a tab change took a still-true sentence away');
    assert.deepEqual(listenerErrors, []);
  });

  test(`${width} 900px, a failure over a run already shown stays with that run until another is opened, and is gone after the same run is opened again`, async (t) => {
    await boot(t, narrow);
    await open(KEPT, narrow);
    assert.match(byId('results-rows').textContent, /Kept/, 'the kept run did not open; the case proves nothing');
    await open(GONE, narrow);
    assert.equal(said(), GoneSaid);
    assert.match(byId('results-rows').textContent, /Kept/, 'the click cost the visitor the run they were looking at');
    await open(KEPT, narrow);
    assert.equal(said(), '', 'the sentence outlived a successful open of the run on screen');
    assert.deepEqual(listenerErrors, []);
  });

  test(`${width} 900px, a run this tab starts after the failure takes the line away, and its finish does not bring it back`, async (t) => {
    await boot(t, narrow);
    await open(GONE, narrow);
    assert.equal(said(), GoneSaid);
    fetchStub.respond('/api/runs', { status: 202, body: { run_id: NEW } }, { method: 'POST' });
    await api.startRun({ mode: 'functional', sequence: [], options: {} });
    await flush(10);
    assert.equal(get().run && get().run.id, NEW, 'the new run is not shown; the case proves nothing');
    assert.equal(said(), '', 'the sentence about the history click stands over the new run');
    set({ status: { running: false, budget_balance: 3 } });
    assert.equal(said(), '');
    assert.deepEqual(listenerErrors, []);
  });

  test(`${width} 900px, a slow failing open overtaken by a new run started here is never said over that run`, async (t) => {
    await boot(t, narrow);
    await open(SLOW, narrow);
    fetchStub.respond('/api/runs', { status: 202, body: { run_id: NEW } }, { method: 'POST' });
    await api.startRun({ mode: 'functional', sequence: [], options: {} });
    await flush(10);
    assert.equal(get().run && get().run.id, NEW, 'the new run is not shown; the case proves nothing');
    slow.resolve({ status: 404, body: { error: 'no run' } });
    await flush(10);
    assert.equal(said(), '', 'a failure the visitor stopped waiting for is said over the new run');
    assert.deepEqual(listenerErrors, []);
  });
}
