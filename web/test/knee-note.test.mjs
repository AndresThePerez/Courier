// A knee preset replaces the queued sequence, the mode and both performance
// knobs in one press. The note under the buttons says what it replaced, so a
// visitor who had queued their own requests is not left to find them gone.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as sidebar from '../js/render-sidebar.js';
import * as runner from '../js/render-runner.js';

const KEY = 'courier.runner.v1';
const byId = (id) => document.getElementById(id);
const req = (n) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [] });
const basics = { id: 'search-basics', name: 'Search basics', requests: [1, 2, 3, 4, 5].map((n) => req(n)) };
const note = () => byId('knee-note').textContent;
const knee = (workers) => [...byId('knee-buttons').querySelectorAll('button')].find((b) => b.textContent.startsWith(`${workers} worker`));
const queue = (n) => set({ sequence: Array.from({ length: n }, (_, i) => ({ key: `q${i}`, enabled: true, request: req(100 + i) })) });

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
  runner.init({});
  sidebar.init({});
  unsubscribe = subscribe((state) => {
    sidebar.render(state);
    runner.render(state);
  });
  set({ collections: [basics], endpoints: [{ id: 'search', method: 'GET' }] });
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
});

test('with 3 queued in functional mode, the 25-worker preset says what it replaced and that it switched mode', () => {
  queue(3);
  knee(25).click();
  assert.equal(note(), 'Replaced the 3 queued requests with the 5 search-basics requests at 25 workers for 10s and switched to Performance. Press Start run to take your own reading.');
  assert.equal(byId('knee-note').hidden, false);
  assert.deepEqual(get().sequence.map((e) => e.request.id), ['r1', 'r2', 'r3', 'r4', 'r5']);
  assert.equal(get().mode, 'performance');
  assert.equal(get().options.concurrency, 25);
  assert.equal(byId('tab-runner').textContent, 'Runner (5)');
  assert.deepEqual(listenerErrors, []);
});

test('with nothing queued, the note is the one it always was', () => {
  knee(25).click();
  assert.equal(note(), 'Loaded 5 search requests at 25 workers for 10s. Press Start run to take your own reading.');
  set({ mode: 'performance', sequence: [] });
  knee(1).click();
  assert.equal(note(), 'Loaded 5 search requests at 1 worker for 10s. Press Start run to take your own reading.');
});

test('one queued request is singular, and a mode already Performance is not said to switch', () => {
  queue(1);
  knee(10).click();
  assert.equal(note(), 'Replaced the 1 queued request with the 5 search-basics requests at 10 workers for 10s and switched to Performance. Press Start run to take your own reading.');

  queue(2);
  assert.equal(get().mode, 'performance');
  knee(50).click();
  assert.equal(note(), 'Replaced the 2 queued requests with the 5 search-basics requests at 50 workers for 10s. Press Start run to take your own reading.');

  queue(50);
  knee(1).click();
  assert.equal(note(), 'Replaced the 50 queued requests with the 5 search-basics requests at 1 worker for 10s. Press Start run to take your own reading.');
});

test('unchecked requests are replaced too, and are counted', () => {
  set({ sequence: [{ key: 'a', enabled: false, request: req(7) }, { key: 'b', enabled: true, request: req(8) }] });
  knee(25).click();
  assert.match(note(), /^Replaced the 2 queued requests /);
});

test('a preset replaces the add note, which no longer describes the queue', () => {
  runner.add(req(9));
  assert.equal(byId('add-note').textContent, 'Added "Request 9" to the run - 1 queued.');
  knee(25).click();
  assert.equal(byId('add-note').textContent, '');
});

test('after a failed catalog load the note says so, points at Retry, and nothing is replaced', () => {
  set({ collections: [], notice: 'Could not load collections from the server.' });
  queue(3);
  const before = get().sequence;
  knee(25).click();
  assert.equal(note(), 'The curated collections could not be loaded - press Retry under Collections, then try a preset again. Nothing was replaced.');
  assert.equal(get().sequence, before);
  assert.equal(get().mode, 'functional');
});

test('while the catalog is still loading, or lacks the collection, nothing is replaced and the note says why', () => {
  set({ collections: [] });
  queue(3);
  knee(25).click();
  assert.equal(note(), 'The curated collections have not loaded yet - give the page a moment and try again.');
  set({ collections: [{ id: 'other', name: 'Other', requests: [req(1)] }] });
  knee(25).click();
  assert.equal(note(), 'The search-basics collection is not in the catalog the server sent - nothing was replaced.');
  assert.equal(get().sequence.length, 3);
});

test('a preset writes the run setup once, keeps focus on its button through later renders, and touches no run', () => {
  queue(3);
  const writes = [];
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => { writes.push(k); return real(k, v); };
  try {
    const button = knee(25);
    button.focus();
    button.click();
    for (let i = 0; i < 3; i += 1) set({ status: { running: false, budget_balance: 1500 - i } });
    assert.equal(document.activeElement, button);
  } finally {
    delete localStorage.setItem;
  }
  assert.deepEqual(writes, [KEY]);
  assert.equal(get().run, null);
  assert.equal(get().report, null);
  assert.deepEqual(get().results, []);
});
