// A history run that cannot be opened is said where the visitor is looking.
// Clicking a history row shows the Results tab at every width, and below
// 900px the drawer closes over nothing: so the failure is said on the
// Results tab, in one status line, as well as beside the list it was clicked
// in (which is not a live region, so it is announced once). The line goes
// once the Results tab shows another run.

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
const GONE = 'run-gone-1';
const KEPT = 'run-kept-1';
const entry = (id) => ({ id, mode: 'functional', status: 'completed', started_at: '2026-11-18T09:00:00Z', duration_ms: 30, summary: '1 passed' });
const kept = {
  id: KEPT, mode: 'functional', status: 'completed', started_at: '2026-11-18T09:00:00Z', duration_ms: 30, config: {}, entries: [{ index: 0, name: 'Kept' }],
  functional: { verdict: 'PASS', results: [{ index: 0, name: 'Kept', endpoint: 'search', query: '?q=a', status: 200, latency_ms: 4, size_bytes: 9, passed: true, skipped: false, assertions: [{ assertion: { type: 'status', op: 'eq', value: 200 }, passed: true, expected: '200', actual: '200' }] }] },
};

let unsubscribe = null;
let page = null;

async function boot(t, narrow) {
  media.set(NARROW, narrow);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  fetchStub.serve('/api/collections', () => ({ status: 200, body: { collections: [], endpoints: [], target: 'search.example' } }), { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: { running: false } }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => ({ status: 200, body: { runs: [entry(GONE), entry(KEPT)] } }), { method: 'GET' });
  fetchStub.serve(`/api/runs/${GONE}`, () => ({ status: 404, body: { error: 'no run' } }), { method: 'GET' });
  fetchStub.serve(`/api/runs/${KEPT}`, () => ({ status: 200, body: kept }), { method: 'GET' });
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
const shown = () => ['runner', 'editor', 'results'].filter((n) => byId(`tab-${n}`).getAttribute('aria-selected') === 'true');

for (const narrow of [true, false]) {
  test(`${narrow ? 'below' : 'above'} 900px, a history run that cannot be opened is said on the Results tab, once, and the line goes with the next run shown`, async (t) => {
    await boot(t, narrow);
    if (narrow) byId('sidebar-toggle').click();
    rowFor(GONE).click();
    await flush(10);

    assert.deepEqual(shown(), ['results'], 'the click did not show Results; the case proves nothing');
    if (narrow) assert.equal(Boolean(byId('panel-sidebar').inert), true, 'the drawer is still open; the case proves nothing');
    assert.equal(line().getAttribute('role'), 'status');
    assert.equal(said(), 'That run is no longer stored on the server.');
    assert.ok(byId('panel-results').contains(line()), 'the line is not on the Results tab');

    // Said once: the sentence beside the list is not a live region too.
    const besides = [...byId('history-list').querySelectorAll('.note')].filter((n) => n.textContent === said());
    assert.equal(besides.length, 1, 'the sentence beside the list is gone');
    for (const node of besides) {
      for (let n = node; n && n !== document.body; n = n.parentNode) {
        assert.equal(n.getAttribute('role') === 'status' || n.hasAttribute('aria-live'), false, 'the sentence is announced twice');
      }
    }

    // Polls and renders leave it in place, said once.
    const before = line();
    for (let i = 0; i < 3; i += 1) set({ status: { running: false, budget_balance: 10 + i } });
    assert.ok(line() === before);
    assert.equal(said(), 'That run is no longer stored on the server.');

    // Another run opened: the line goes.
    if (narrow) byId('sidebar-toggle').click();
    rowFor(KEPT).click();
    await flush(10);
    assert.match(byId('results-rows').textContent, /Kept/, 'the kept run did not open; the case proves nothing');
    assert.equal(said(), '');
    assert.deepEqual(listenerErrors, []);
  });
}
