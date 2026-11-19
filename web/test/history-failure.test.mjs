// A history request that failed says so, with Retry, the way a failed catalog
// load does, rather than "No runs yet." over runs that may well exist. An
// earlier list stays on screen: those runs were on the server a moment ago
// and can still be opened. "No runs yet." is said only by a server that
// answered with none.

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

// server answers history from a script: each entry is a list of runs, or
// 'down' for a request that never arrives, or 'garbled' for an answer that is
// not a list of runs.
function makeServer(script) {
  const server = { script: script.slice(), asked: 0 };
  fetchStub.serve('/api/collections', () => ({ status: 200, body: { collections: [], endpoints: [], target: 'search.example' } }), { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: { running: false } }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => {
    server.asked += 1;
    const next = server.script.length > 1 ? server.script.shift() : server.script[0];
    if (next === 'down') throw new TypeError('Failed to fetch');
    if (next === 'garbled') return { status: 200, body: { runs: 'none' } };
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
const rows = () => [...byId('history-list').querySelectorAll('.req-open')].map((b) => b.title);
const retry = () => [...byId('panel-sidebar').querySelectorAll('button')].find((b) => b.textContent === 'Retry' && b.dataset.focusKey === 'history-retry');

test('before history has answered, the list says it is loading, not that there are no runs', () => {
  sidebar.init({});
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({});
  assert.doesNotMatch(said(), /No runs yet\./);
  assert.match(byId('history-list').textContent, /Loading history\.\.\./);
});

for (const failure of ['down', 'garbled']) {
  test(`a first history request that fails (${failure}) says history could not be loaded, offers Retry, and never says No runs yet.`, async (t) => {
    await bootPage(t, makeServer([failure]));
    assert.doesNotMatch(said(), /No runs yet\./);
    assert.doesNotMatch(said(), /Loading history/, 'the list still says it is loading after the read failed');
    assert.ok(said().includes(`${FAILED} Retry`), said());
    const button = retry();
    assert.ok(button, 'there is no Retry');
    assert.ok(button.classList.contains('btn') && button.classList.contains('btn-mini'), 'Retry does not look like the catalog\'s');
    assert.ok(button.closest('.tree-empty'), 'the sentence does not look like the catalog\'s');
    assert.deepEqual(rows(), []);
    assert.deepEqual(listenerErrors, []);
  });
}

test('a history request that fails after one that succeeded keeps the list it had, and says the list could not be loaded', async (t) => {
  await bootPage(t, makeServer([[run('run-1'), run('run-2')], 'down']));
  assert.deepEqual(rows(), ['run-1 - 3 passed', 'run-2 - 3 passed']);
  assert.ok(!said().includes(FAILED));

  await page.hooks.runner.refresh();
  await flush();
  assert.deepEqual(rows(), ['run-1 - 3 passed', 'run-2 - 3 passed'], 'the earlier list went');
  assert.ok(said().includes(`${FAILED} Retry`), said());
  assert.doesNotMatch(said(), /No runs yet\./);
  assert.deepEqual(listenerErrors, []);
});

test('Retry that succeeds replaces the sentence with the list, and Retry is marked busy, not disabled, while it is out', async (t) => {
  const server = await bootPage(t, makeServer(['down', [run('run-9')]]));
  const button = retry();
  button.focus();
  const asked = server.asked;
  button.click();
  assert.equal(server.asked, asked + 1, 'Retry did not ask again');
  assert.equal(button.disabled, false);
  assert.equal(retry() && retry().getAttribute('aria-disabled'), 'true', 'Retry is not marked busy while it is out');
  retry().click();
  assert.equal(server.asked, asked + 1, 'a second press asked again while the first was out');

  await flush();
  assert.ok(!said().includes(FAILED), said());
  assert.equal(retry(), undefined);
  assert.deepEqual(rows(), ['run-9 - 3 passed']);
  assert.ok(document.activeElement !== document.body, 'focus dropped to the page when Retry went');
  assert.deepEqual(listenerErrors, []);
});

test('a Retry that fails again keeps saying so, with Retry ready again', async (t) => {
  await bootPage(t, makeServer(['down']));
  retry().click();
  await flush();
  assert.ok(said().includes(`${FAILED} Retry`));
  assert.equal(retry().getAttribute('aria-disabled'), 'false');
});

test('a successful answer with no runs says No runs yet. and nothing about a failure', async (t) => {
  await bootPage(t, makeServer([[]]));
  assert.equal(byId('history-list').textContent, 'No runs yet.');
  assert.ok(!said().includes(FAILED));
  assert.equal(retry(), undefined);
});

test('a successful answer after a failure with no runs says No runs yet.', async (t) => {
  await bootPage(t, makeServer(['down', []]));
  assert.doesNotMatch(said(), /No runs yet\./);
  retry().click();
  await flush();
  assert.equal(byId('history-list').textContent, 'No runs yet.');
  assert.ok(!said().includes(FAILED));
});
