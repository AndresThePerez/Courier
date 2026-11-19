// Small edges of the three-pane layout: one sidebar part that cannot be drawn
// does not stop the others, a finished report that brings no rows redraws the
// open live rows as finished, and the sidebar's + answers a press over at
// least 24 by 24px at every width.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import { initialLive, reduce } from '../js/live.js';
import * as sidebar from '../js/render-sidebar.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const req = (id, name) => ({ id, name, endpoint: 'search', params: { q: 'a' }, assertions: [] });

let unsubscribe = null;
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
});

// ---------------------------------------------------------------- sidebar parts

test('a curated collection that cannot be drawn leaves My Workspace, history and focus to update', () => {
  sidebar.init({});
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({
    endpoints,
    collections: [{ id: 'broken', name: 'Broken', description: '', requests: 5 }],
    workspace: [req('ws-1', 'Mine')],
    history: [],
    historyLoaded: true,
  });
  assert.ok(errors.length > 0, 'the broken part did not throw; the case proves nothing');

  // Another part changes: it is painted.
  set({ workspace: [req('ws-1', 'Mine'), req('ws-2', 'Also mine')] });
  const names = [...byId('workspace-tree').querySelectorAll('.req-open')].map((b) => b.title);
  assert.deepEqual(names, ['Mine', 'Also mine']);
  set({ history: [{ id: 'run-1', mode: 'functional', status: 'completed', started_at: '2026-11-16T14:03:22Z', duration_ms: 120, summary: '3 passed' }] });
  assert.equal(byId('history-list').querySelectorAll('.req-open').length, 1, 'history was not painted');

  // The focus restore after the parts still runs: a focused workspace
  // control rebuilt by a change is focused again.
  const add = () => [...byId('workspace-tree').querySelectorAll('button')].find((b) => b.dataset.focusKey === 'add:workspace:ws-2');
  add().focus();
  const before = add();
  set({ workspace: [req('ws-1', 'Mine renamed'), req('ws-2', 'Also mine')] });
  assert.ok(add() !== before, 'the workspace was not rebuilt; the case proves nothing');
  assert.ok(document.activeElement === add(), 'focus was not put back after the broken part');
  assert.deepEqual(listenerErrors, []);
});

// ---------------------------------------------------------------- report without rows

test('a finished report carrying no row list redraws the open live rows as finished', () => {
  const ev = (type, data = {}) => ({ type, run_id: 'run-r', data });
  const row = (index) => ({ index, name: `R${index}`, endpoint: 'search', query: '?q=a', status: 200, latency_ms: 4, size_bytes: 10, passed: true, skipped: false, assertions: [] });
  let live = initialLive();
  for (const e of [
    { type: 'status', status: { running: true, run_id: 'run-r', mode: 'functional', started_at: '2026-11-18T10:00:00Z' } },
    ev('run_started', { mode: 'functional', total: 2 }),
    ev('request_result', row(0)),
    ev('request_result', row(1)),
  ]) live = reduce(live, e);
  const show = () => set({ endpoints, transport: 'sse', run: live.run, results: live.results, report: live.report, outcome: live.outcome });
  unsubscribe = subscribe((state) => results.render(state));
  show();

  const shown = (i) => byId('results-rows').querySelectorAll('.res-row')[i];
  shown(1).open = true;
  shown(1).dispatchEvent(new Event('toggle'));
  assert.match(shown(1).textContent, /arrives with the finished report/, 'the open row does not read as live; the case proves nothing');

  const liveRows = live.results;
  live = reduce(live, ev('run_finished', { status: 'completed', duration_ms: 900, verdict: 'PASS' }));
  live = reduce(live, { type: 'report', run_id: 'run-r', report: { id: 'run-r', mode: 'functional', status: 'completed', started_at: '2026-11-18T10:00:00Z', duration_ms: 900, entries: [], config: {}, functional: { verdict: 'PASS' } } });
  assert.ok(live.report, 'the report did not land; the case proves nothing');
  assert.ok(live.results === liveRows, 'the live rows were not kept; the case proves nothing');
  show();
  assert.equal(shown(1).open, true, 'the open row was closed');
  assert.match(shown(1).textContent, /No response body was captured for this request\./, 'the open row still reads as live');
  assert.doesNotMatch(shown(0).textContent, /arrives with the finished report/);
  assert.deepEqual(listenerErrors, []);
});

// ---------------------------------------------------------------- the + hit area

test('every + in the sidebar carries the class that widens its hit area, and the rule widens it to 24 by 24px', () => {
  sidebar.init({});
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({ endpoints, collections: [{ id: 'c1', name: 'Basics', description: '', requests: [req('b1', 'Find')] }], workspace: [req('ws-1', 'Mine')] });
  const pluses = [...byId('panel-sidebar').querySelectorAll('button')].filter((b) => b.textContent === '+');
  assert.equal(pluses.length, 2);
  for (const b of pluses) assert.ok(b.classList.contains('req-add'), b.getAttribute('aria-label'));

  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.req-add\s*\{[^}]*position:\s*relative/);
  const layer = /\.req-add::after\s*\{([^}]*)\}/.exec(css);
  assert.ok(layer, 'no layer widens the +');
  assert.match(layer[1], /content:\s*''/);
  assert.match(layer[1], /position:\s*absolute/);
  assert.match(layer[1], /width:\s*max\(100%,\s*24px\)/);
  assert.match(layer[1], /height:\s*max\(100%,\s*24px\)/);
  assert.match(layer[1], /translate\(-50%,\s*-50%\)/, 'the layer is not centred on the +');
});
