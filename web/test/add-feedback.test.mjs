// What a visitor is told when a request goes into the run, wherever they are
// looking: the Runner tab counts what is queued, a polite live region says
// what was added, the tree marks what is already in the run, and the control
// that was pressed keeps the keyboard focus through every rebuild of the tree,
// a status poll's included.
//
// The page is built the way main.js builds it (see live-page.test.mjs).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetBrowser, fetchStub, flush, listenerErrors, localStorage } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as api from '../js/api.js';
import { createLive } from '../js/live.js';
import * as workspace from '../js/workspace.js';
import * as sidebar from '../js/render-sidebar.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as results from '../js/render-results.js';

const SETUP_KEY = 'courier.runner.v1';
const byId = (id) => document.getElementById(id);
const req = (n, extra = {}) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [], ...extra });
const tab = () => byId('tab-runner').textContent;
const note = () => byId('add-note').textContent;
const focusKey = () => (document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focusKey || '' : '');
const keyed = (key) => [...document.querySelectorAll('[data-focus-key]')].find((n) => n.dataset.focusKey === key);
const curated = () => byId('collections-tree');
const markerOf = (row) => row.querySelector('.in-run');
const rowOf = (tree, name) => [...tree.querySelectorAll('.req-row')].find((r) => r.textContent.includes(name));

function makeServer() {
  const server = {
    status: { running: false, budget_balance: 1500 },
    catalog: {
      collections: [
        { id: 'search-basics', name: 'Search basics', requests: [req(1), req(2), req(3), req(4), req(5)] },
        { id: 'other', name: 'Other', requests: [req(6)] },
      ],
      endpoints: [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }],
      target: 'pokesearch',
    },
    catalogDown: 0,
  };
  fetchStub.serve('/api/collections', () => {
    if (server.catalogDown > 0) {
      server.catalogDown -= 1;
      throw new TypeError('Failed to fetch');
    }
    return { status: 200, body: server.catalog };
  }, { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: server.status }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => ({ status: 200, body: { runs: [] } }), { method: 'GET' });
  return server;
}

let unsubscribe = null;
let page = null;

async function bootPage(t, server, { before } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const showTab = (name) => set({ activeTab: name });
  page = createLive({ api, get, set, showTab });
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  runner.init(page.hooks.runner);
  sidebar.init({
    select: (request) => {
      editor.onSelect();
      sidebar.selectRequest(request);
      showTab('editor');
    },
    add: (request) => runner.add(request),
    addAll: (collection) => runner.addAll(collection),
    ...page.hooks.sidebar,
  });
  unsubscribe = subscribe((state) => {
    sidebar.render(state);
    editor.render(state);
    runner.render(state);
    results.render(state);
    page.scheduleSync();
  });
  set({ activeTab: 'runner' });
  if (before) before();
  await page.boot();
  await flush();
  return server;
}

// poll lets the page's 3 s status poll land and repaint everything.
async function poll(t) {
  t.mock.timers.tick(3000);
  await flush();
}

function openAll() {
  for (const d of curated().querySelectorAll('details')) d.open = true;
}

function plus(collectionId, requestId) {
  return keyed(`add:${collectionId}:${requestId}`);
}

function addAllButton(tree, name) {
  return [...tree.querySelectorAll('button')].find((b) => b.textContent.startsWith('Add all') && b.closest('details').textContent.includes(name));
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  if (page) page.stop();
  page = null;
  workspace.stop();
  api.onRunStarted(() => {});
});

// ------------------------------------------------------------------ the tab label

test('the Runner tab counts what is queued, and reads plain Runner when nothing is', () => {
  assert.equal(runner.runnerTabLabel([]), 'Runner');
  assert.equal(runner.runnerTabLabel([{ enabled: true }]), 'Runner (1)');
  assert.equal(runner.runnerTabLabel([{ enabled: true }, { enabled: false }]), 'Runner (2)', 'an unchecked row is still queued');
  assert.equal(runner.runnerTabLabel(undefined), 'Runner');
});

test('with the Request tab showing, + and Add all count up on the Runner tab', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  assert.equal(tab(), 'Runner');
  set({ activeTab: 'editor' });

  runner.add(req(9));
  assert.equal(tab(), 'Runner (1)');
  runner.addAll(server.catalog.collections[0]);
  assert.equal(tab(), 'Runner (6)');

  // Unchecking keeps the request queued; removing it does not.
  set({ activeTab: 'runner' });
  byId('sequence-list').querySelector('input[type="checkbox"]').click();
  assert.equal(tab(), 'Runner (6)');
  [...byId('sequence-list').querySelectorAll('button')].find((b) => b.title === 'Remove from the run').click();
  assert.equal(tab(), 'Runner (5)');
  assert.deepEqual(listenerErrors, []);
});

test('a sequence restored at load is counted on the Runner tab and marked in the tree, with nothing announced', async (t) => {
  localStorage.setItem(SETUP_KEY, JSON.stringify({
    version: 1,
    sequence: [{ enabled: true, request: req(1) }, { enabled: false, request: req(1) }, { enabled: true, request: req(2) }],
    mode: 'functional',
    options: {},
  }));
  const server = makeServer();
  await bootPage(t, server);
  assert.equal(tab(), 'Runner (3)');
  assert.equal(note(), '');
  assert.equal(markerOf(rowOf(curated(), 'Request 1')).textContent, 'in run x2');
  assert.equal(markerOf(rowOf(curated(), 'Request 2')).textContent, 'in run');
});

// ------------------------------------------------------------------ the note

test('adding one request says so in the polite live region', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  const region = byId('add-note');
  assert.equal(region.getAttribute('role'), 'status');
  assert.equal(region.getAttribute('aria-live'), 'polite');

  runner.addAll(server.catalog.collections[0]);
  runner.add(req(6, { name: 'Pikachu by name' }));
  assert.equal(note(), 'Added "Pikachu by name" to the run - 6 queued.');
});

test('Add all says how many it added and how many are queued', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.add(req(9));
  runner.addAll(server.catalog.collections[0]);
  assert.equal(note(), 'Added the 5 requests in "Search basics" to the run - 6 queued.');
  runner.addAll(server.catalog.collections[1]);
  assert.equal(note(), 'Added the 1 request in "Other" to the run - 7 queued.');
});

test('at the cap the note says what was not added, and agrees with the cap note beside the sequence', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  set({ sequence: Array.from({ length: 47 }, (_, i) => ({ key: `s${i}`, enabled: true, request: req(100 + i) })) });
  runner.addAll(server.catalog.collections[0]);
  assert.equal(note(), 'Added 3 of the 5 requests in "Search basics" to the run - 50 queued, the cap.');
  assert.equal(byId('sequence-note').textContent, 'Added 3 of 5 - 50 requests is the cap.');

  runner.add(req(7));
  assert.equal(note(), 'Could not add "Request 7" - the run already holds 50 requests, the cap.');
  assert.equal(byId('sequence-note').textContent, '50 requests is the cap - remove one before adding another.');
  runner.addAll(server.catalog.collections[1]);
  assert.equal(note(), 'Could not add "Other" - the run already holds 50 requests, the cap.');
  assert.equal(tab(), 'Runner (50)');
  assert.equal(get().sequence.length, 50);

  runner.addAll({ id: 'empty', name: 'Empty', requests: [] });
  assert.equal(note(), 'Nothing added - "Empty" has no requests.');
});

test('a name with quotes, markup or 120 characters is shown as text', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  const long = 'N'.repeat(120);
  for (const name of ['say "hi" & <b>bye</b>', '<img src=x onerror=alert(1)>', long]) {
    runner.add(req(1, { name }));
    assert.equal(note(), `Added "${name}" to the run - ${get().sequence.length} queued.`);
    assert.equal(byId('add-note').children.length, 0, 'no element was made from the name');
  }
  runner.add(req(1, { name: '' }));
  assert.equal(note(), 'Added "r1" to the run - 4 queued.', 'a request without a name is called by its id');
});

test('the live region is not rewritten by a status poll or an unrelated render, and goes when what it counted changes', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.add(req(1));
  runner.add(req(2));
  const text = byId('add-note').firstChild;
  assert.equal(text.nodeType, 3);
  server.status = { running: false, budget_balance: 1400 };
  await poll(t);
  set({ selectedId: 'r2' });
  assert.equal(byId('add-note').firstChild, text, 'the same text node: nothing is announced again');

  // Unchecking or moving a row keeps the count true, and the note.
  byId('sequence-list').querySelector('input[type="checkbox"]').click();
  assert.equal(note(), 'Added "Request 2" to the run - 2 queued.');
  // Removing one makes it untrue, so it goes.
  [...byId('sequence-list').querySelectorAll('button')].find((b) => b.title === 'Remove from the run').click();
  assert.equal(note(), '');
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ focus

test('focus stays on the + that was pressed, through the re-render and the next status poll', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  openAll();
  const button = plus('search-basics', 'r2');
  assert.ok(button, 'each + carries data-focus-key="add:<collection id>:<request id>"');
  button.focus();
  button.click();
  assert.equal(get().sequence.length, 1);
  assert.notEqual(document.activeElement, document.body);
  assert.equal(focusKey(), 'add:search-basics:r2');
  assert.notEqual(document.activeElement, button, 'the tree was rebuilt, and focus followed the key');

  server.status = { running: false, budget_balance: 1200 };
  await poll(t);
  assert.equal(focusKey(), 'add:search-basics:r2', 'and survived the poll');

  // Pressed again from the keyboard: it adds again.
  document.activeElement.click();
  assert.equal(get().sequence.length, 2);
  assert.equal(focusKey(), 'add:search-basics:r2');
  assert.deepEqual(listenerErrors, []);
});

test('focus stays on Add all through the re-render and the next status poll', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  openAll();
  const button = addAllButton(curated(), 'Search basics');
  button.focus();
  button.click();
  assert.equal(get().sequence.length, 5);
  assert.equal(focusKey(), 'add-all:search-basics');
  await poll(t);
  assert.equal(focusKey(), 'add-all:search-basics');
  assert.deepEqual(listenerErrors, []);
});

test('focus stays on a workspace request\'s +, and a saved collection\'s Add all, through the re-render and a poll', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  workspace.save({ id: 'ws-1', name: 'Mine', endpoint: 'search', params: {}, assertions: [] });
  runner.savedCollections.create('Saved one', [req(1), req(2)]);
  const ws = keyed('add:workspace:ws-1');
  ws.focus();
  ws.click();
  assert.equal(focusKey(), 'add:workspace:ws-1');
  await poll(t);
  assert.equal(focusKey(), 'add:workspace:ws-1');

  const id = get().savedCollections[0].id;
  const all = keyed(`add-all:saved:${id}`);
  all.focus();
  all.click();
  assert.equal(get().sequence.length, 3);
  assert.equal(focusKey(), `add-all:saved:${id}`);
  await poll(t);
  assert.equal(focusKey(), `add-all:saved:${id}`);
  assert.deepEqual(listenerErrors, []);
});

test('focus stays on the catalog\'s Retry while it loads, and moves into the collections once they are there', async (t) => {
  const server = makeServer();
  server.catalogDown = 2;
  await bootPage(t, server);
  const retry = keyed('catalog-retry');
  assert.ok(retry);
  retry.focus();
  retry.click();
  await flush();
  assert.equal(focusKey(), 'catalog-retry', 'a Retry that failed again keeps focus');
  await poll(t);
  assert.equal(focusKey(), 'catalog-retry', 'and through a poll');

  keyed('catalog-retry').click();
  await flush();
  assert.match(curated().textContent, /Search basics/);
  assert.notEqual(document.activeElement, document.body, 'focus did not drop to the page');
  assert.ok(curated().contains(document.activeElement), 'it is on the first collection');
  assert.deepEqual(listenerErrors, []);
});

test('deleting a saved request puts focus on Undo, and Undo puts it back on the request', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  workspace.save({ id: 'ws-1', name: 'Mine', endpoint: 'search', params: {}, assertions: [] });
  const del = keyed('delete:ws-1');
  del.focus();
  del.click();
  assert.ok(!workspace.find('ws-1'));
  const undo = document.activeElement;
  assert.equal(undo.textContent, 'Undo');
  await poll(t);
  assert.equal(document.activeElement, undo, 'the poll does not take it');
  undo.click();
  assert.ok(workspace.find('ws-1'));
  assert.equal(focusKey(), 'open:workspace:ws-1');
  assert.deepEqual(listenerErrors, []);
});

test('deleting a saved collection puts focus on Undo', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.savedCollections.create('Saved one', [req(1)]);
  const id = get().savedCollections[0].id;
  const del = keyed(`delete-saved:${id}`);
  del.focus();
  del.click();
  assert.equal(get().savedCollections.length, 0);
  assert.equal(document.activeElement.textContent, 'Undo');
  await poll(t);
  assert.equal(document.activeElement.textContent, 'Undo');
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ markers

test('a queued request is marked in the tree with an accessible name, twice as x2, and the mark goes with it', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  openAll();
  assert.equal(markerOf(rowOf(curated(), 'Request 1')), null);
  plus('search-basics', 'r1').click();
  let mark = markerOf(rowOf(curated(), 'Request 1'));
  assert.equal(mark.textContent, 'in run');
  assert.equal(mark.getAttribute('aria-label'), 'Queued in the run once');
  assert.equal(mark.getAttribute('role'), 'img');
  plus('search-basics', 'r1').click();
  mark = markerOf(rowOf(curated(), 'Request 1'));
  assert.equal(mark.textContent, 'in run x2');
  assert.equal(mark.getAttribute('aria-label'), 'Queued in the run 2 times');
  assert.equal(markerOf(rowOf(curated(), 'Request 2')), null);

  // An unchecked row is still queued.
  byId('sequence-list').querySelector('input[type="checkbox"]').click();
  assert.equal(markerOf(rowOf(curated(), 'Request 1')).textContent, 'in run x2');

  for (let i = 0; i < 2; i += 1) {
    [...byId('sequence-list').querySelectorAll('button')].find((b) => b.title === 'Remove from the run').click();
  }
  assert.equal(markerOf(rowOf(curated(), 'Request 1')), null);
  assert.deepEqual(listenerErrors, []);
});

test('a queued request is known by its id: an edit after queueing keeps the mark, a delete takes the row and leaves the queue', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  workspace.save({ id: 'ws-1', name: 'Mine', endpoint: 'search', params: {}, assertions: [] });
  keyed('add:workspace:ws-1').click();
  const ws = byId('workspace-tree');
  assert.equal(markerOf(rowOf(ws, 'Mine')).textContent, 'in run');
  workspace.save({ id: 'ws-1', name: 'Mine, renamed', endpoint: 'search', params: { q: 'x' }, assertions: [] });
  assert.equal(markerOf(rowOf(ws, 'Mine, renamed')).textContent, 'in run');
  workspace.remove('ws-1');
  assert.equal(rowOf(ws, 'Mine'), undefined);
  assert.equal(get().sequence.length, 1, 'the queued copy stays');
  assert.equal(tab(), 'Runner (1)');
});

test('changing only the sequence re-marks every tree, the memoised saved collections included', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  workspace.save({ id: 'ws-1', name: 'Mine', endpoint: 'search', params: {}, assertions: [] });
  runner.savedCollections.create('Saved one', [req(1), { id: 'ws-1', name: 'Mine', endpoint: 'search', params: {}, assertions: [] }]);
  const savedTree = byId('saved-collections');
  const list = get().savedCollections;
  assert.equal(savedTree.querySelectorAll('.in-run').length, 0);

  set({ sequence: [{ key: 'x1', enabled: true, request: req(1) }, { key: 'x2', enabled: false, request: { id: 'ws-1', name: 'Mine', endpoint: 'search', params: {}, assertions: [] } }] });
  assert.equal(get().savedCollections, list, 'only the sequence changed');
  assert.equal(markerOf(rowOf(savedTree, 'Request 1')).textContent, 'in run');
  assert.equal(markerOf(rowOf(savedTree, 'Mine')).textContent, 'in run');
  assert.equal(markerOf(rowOf(curated(), 'Request 1')).textContent, 'in run');
  assert.equal(markerOf(rowOf(byId('workspace-tree'), 'Mine')).textContent, 'in run');

  set({ sequence: [] });
  assert.equal(savedTree.querySelectorAll('.in-run').length, 0);
  assert.equal(curated().querySelectorAll('.in-run').length, 0);
});

test('a status poll rebuilds no saved collection and writes no run setup', async (t) => {
  const server = makeServer();
  await bootPage(t, server);
  runner.savedCollections.create('Saved one', [req(1)]);
  runner.add(req(1));
  const node = byId('saved-collections').querySelector('details');
  const writes = [];
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => { writes.push(k); return real(k, v); };
  try {
    for (let i = 0; i < 3; i += 1) {
      server.status = { running: false, budget_balance: 1000 + i };
      await poll(t);
    }
  } finally {
    delete localStorage.setItem;
  }
  assert.deepEqual(writes, []);
  assert.equal(byId('saved-collections').querySelector('details'), node);
});

test('the add note is a polite region the page carries', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="add-note"[^>]*role="status"/);
  const embed = readFileSync(new URL('../embed_test.go', import.meta.url), 'utf8');
  assert.match(embed, /"add-note"/);
});
