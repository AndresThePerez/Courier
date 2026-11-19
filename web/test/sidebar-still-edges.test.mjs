// The sidebar at the edges of holding still: every way a part's content can
// change is read back from the page and compared with the state, a part that
// was kept hands its controls the request as it is now, and a live run's
// polls and progress events leave every kind of sidebar control, an open
// collection and an open confirm exactly where they were.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, StorageEvent, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [
  { id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] },
  { id: 'lookup', label: 'Lookup', method: 'POST', path: '/lookup', params: [] },
];
const req = (id, name, extra = {}) => ({ id, name, endpoint: 'search', params: { q: 'a' }, assertions: [], ...extra });
const collections = [
  { id: 'c1', name: 'Basics', description: 'First', requests: [req('b1', 'Find'), req('b2', 'Look')] },
  { id: 'c2', name: 'More', description: '', requests: [req('b3', 'Other')] },
];
const savedList = [{ id: 'wc-1', name: 'Saved run', requests: [req('b1', 'Find'), req('ws-a', 'Mine')] }];
const run = (id, extra = {}) => ({ id, mode: 'functional', status: 'completed', started_at: '2026-11-16T14:03:22Z', duration_ms: 120, summary: '3 passed', ...extra });

let unsubscribe = null;
let calls = null;

function boot(extra = {}, stored = [req('ws-a', 'Mine'), req('ws-b', 'Yours')]) {
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: stored }));
  workspace.init();
  calls = { select: [], add: [], addAll: [], openRun: [], retryHistory: 0, retryCatalog: 0 };
  sidebar.init({
    select: (request) => calls.select.push(structuredClone(request)),
    add: (request) => calls.add.push(structuredClone(request)),
    addAll: (collection) => calls.addAll.push(structuredClone(collection)),
    openRun: (id) => calls.openRun.push(id),
    retryHistory: () => { calls.retryHistory += 1; },
    retryCatalog: () => { calls.retryCatalog += 1; },
  });
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({ collections, endpoints, target: 'search.example', savedCollections: savedList, history: [run('run-1')], historyLoaded: true, ...extra });
}

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

const rowsOf = (id) => [...byId(id).querySelectorAll('.req-row')];
const openOf = (id, title) => [...byId(id).querySelectorAll('.req-open')].find((b) => b.title === title);
const plusOf = (id, title) => [...openOf(id, title).closest('.req-row').querySelectorAll('button')].find((b) => b.textContent === '+');
const paintedWorkspace = () => rowsOf('workspace-tree').map((row) => ({
  name: row.querySelector('.req-open').title,
  method: row.querySelector('.method').textContent,
  selected: row.querySelector('.req-open').classList.contains('is-selected'),
  mark: row.querySelector('.in-run') ? row.querySelector('.in-run').textContent : '',
}));
const workspaceFromState = () => {
  const s = get();
  return s.workspace.map((r) => {
    const n = s.sequence.filter((e) => e.request && e.request.id === r.id).length;
    const ep = s.endpoints.find((e) => e.id === r.endpoint);
    return { name: r.name || r.id, method: ep ? ep.method : '---', selected: r.id === s.selectedId, mark: n === 0 ? '' : n === 1 ? 'in run' : `in run x${n}` };
  });
};

// ---------------------------------------------------------------- a kept part acts on the current request

test('a saved request changed only where the row does not paint it hands its new content to + and to the open button', () => {
  boot();
  set({ workspace: [req('ws-a', 'Mine', { params: { q: 'changed' }, assertions: [{ type: 'status', op: 'eq', value: 201 }] }), req('ws-b', 'Yours')] });
  plusOf('workspace-tree', 'Mine').click();
  openOf('workspace-tree', 'Mine').click();
  assert.deepEqual(calls.add.map((r) => r.params), [{ q: 'changed' }], '+ added the request as it was before the change');
  assert.deepEqual(calls.select.map((r) => r.assertions), [[{ type: 'status', op: 'eq', value: 201 }]], 'the open button opened the request as it was before the change');
  assert.deepEqual(listenerErrors, []);
});

test('a curated request changed only in its params hands the new params to + and Add all', () => {
  boot();
  set({ collections: [{ ...collections[0], requests: [req('b1', 'Find', { params: { q: 'zz' } }), req('b2', 'Look')] }, collections[1]] });
  plusOf('collections-tree', 'Find').click();
  byId('collections-tree').querySelector('button[data-focus-key="add-all:c1"]').click();
  assert.deepEqual(calls.add.map((r) => r.params.q), ['zz']);
  assert.deepEqual(calls.addAll[0].requests.map((r) => r.params.q), ['zz', 'a']);
});

test('a saved collection whose inner request changed only in its params hands the new params to Add all', () => {
  boot();
  set({ savedCollections: [{ ...savedList[0], requests: [req('b1', 'Find', { params: { q: 'new' } }), req('ws-a', 'Mine')] }] });
  byId('saved-collections').querySelector('button[data-focus-key="add-all:saved:wc-1"]').click();
  assert.deepEqual(calls.addAll[0].requests.map((r) => r.params.q), ['new', 'a']);
});

// ---------------------------------------------------------------- what is painted matches the state

test('a saved request renamed, moved to another endpoint, deleted and brought back by Undo is painted as the state holds it at each step', () => {
  boot({ selectedId: 'ws-a' });
  assert.deepEqual(paintedWorkspace(), workspaceFromState());

  workspace.save(req('ws-a', 'Renamed'));
  assert.deepEqual(paintedWorkspace(), workspaceFromState());
  assert.equal(paintedWorkspace()[0].name, 'Renamed', 'the rename did not reach the state; the case proves nothing');

  workspace.save(req('ws-a', 'Renamed', { endpoint: 'lookup', params: {} }));
  assert.deepEqual(paintedWorkspace(), workspaceFromState());
  assert.equal(paintedWorkspace()[0].method, 'POST');

  byId('workspace-tree').querySelector('button[data-focus-key="delete:ws-a"]').click();
  assert.deepEqual(paintedWorkspace(), workspaceFromState());
  assert.deepEqual(paintedWorkspace().map((r) => r.name), ['Yours']);

  const undo = [...byId('workspace-note').querySelectorAll('button')].find((b) => b.textContent === 'Undo');
  undo.click();
  assert.deepEqual(paintedWorkspace(), workspaceFromState());
  assert.ok(paintedWorkspace().some((r) => r.name === 'Renamed' && r.selected), 'the request brought back lost its selection mark');
  assert.ok(document.activeElement === openOf('workspace-tree', 'Renamed'), 'focus did not go to the request brought back');
  assert.deepEqual(listenerErrors, []);
});

test('a saved request changed in another tab, delivered by the storage event, repaints My Workspace', () => {
  boot();
  const next = JSON.stringify({ version: 1, requests: [req('ws-a', 'From the other tab', { endpoint: 'lookup', params: {} }), req('ws-c', 'New there')] });
  localStorage.setItem(WORKSPACE, next);
  window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE, newValue: next, storageArea: localStorage }));
  assert.deepEqual(get().workspace.map((r) => r.name), ['From the other tab', 'New there'], 'the event did not reach the state; the case proves nothing');
  assert.deepEqual(paintedWorkspace(), workspaceFromState());
  assert.deepEqual(listenerErrors, []);
});

test('the selection moving between the curated tree and My Workspace, and onto a request that went, leaves exactly one painted selection or none', () => {
  boot();
  const selectedEverywhere = () => [...byId('panel-sidebar').querySelectorAll('.req-open.is-selected')].map((b) => b.dataset.focusKey);
  set({ selectedId: 'b3' });
  assert.deepEqual(selectedEverywhere(), ['open:c2:b3']);
  set({ selectedId: 'ws-b' });
  assert.deepEqual(selectedEverywhere(), ['open:workspace:ws-b']);
  set({ workspace: [req('ws-a', 'Mine')] });
  assert.deepEqual(selectedEverywhere(), []);
  set({ selectedId: 'b1' });
  assert.deepEqual(selectedEverywhere(), ['open:c1:b1']);
});

test('in-run marks follow add, uncheck, remove and a whole sequence replaced at once', () => {
  boot();
  const entry = (key, request, enabled = true) => ({ key, enabled, request });
  const paintedMarks = () => Object.fromEntries([...byId('panel-sidebar').querySelectorAll('.in-run')].map((m) => [m.closest('.req-row').querySelector('.req-open, .req-name').textContent.replace(/^\S+ /, ''), m.textContent]));

  set({ sequence: [entry('s1', req('ws-a', 'Mine'))] });
  assert.equal(paintedWorkspace()[0].mark, 'in run');
  set({ sequence: [entry('s1', req('ws-a', 'Mine'), false), entry('s2', req('ws-a', 'Mine'))] });
  assert.deepEqual(paintedWorkspace(), workspaceFromState());
  assert.equal(paintedWorkspace()[0].mark, 'in run x2', 'an unchecked entry stopped counting');
  set({ sequence: [entry('s2', req('ws-a', 'Mine'))] });
  assert.equal(paintedWorkspace()[0].mark, 'in run');
  // A preset replaces the whole sequence with one that has a different shape.
  set({ sequence: [entry('p1', req('b2', 'Look')), entry('p2', req('b2', 'Look')), entry('p3', req('b3', 'Other'))] });
  assert.deepEqual(paintedWorkspace(), workspaceFromState());
  assert.deepEqual(paintedMarks(), { Look: 'in run x2', Other: 'in run' });
  set({ sequence: [] });
  assert.deepEqual(paintedMarks(), {});
});

test('a verdict, a status and a duration arriving on a history entry, even written into the same array, repaint its row', () => {
  boot();
  const row = () => byId('history-list').querySelector('.req-open');
  set({ history: [run('run-1', { status: 'running', duration_ms: 0 })] });
  assert.match(row().textContent, /\(running\)/);
  assert.equal(row().querySelector('.history-verdict'), null);

  const list = get().history;
  list[0].status = 'completed';
  list[0].verdict = 'FAIL';
  list[0].duration_ms = 4321;
  set({ history: list });
  assert.doesNotMatch(row().textContent, /\(running\)/, 'the status changed in place is not painted');
  assert.equal(row().querySelector('.history-verdict') && row().querySelector('.history-verdict').textContent, 'FAIL');
  assert.ok(row().querySelector('.history-verdict').classList.contains('fail'));
  assert.notEqual(row().querySelector('.note').textContent, '3 passed - 0ms');
});

test('history ageing out its oldest entry and taking a new one paints exactly the new list', () => {
  boot();
  const list = Array.from({ length: 20 }, (_, i) => run(`run-${20 - i}`));
  set({ history: list });
  const titles = () => [...byId('history-list').querySelectorAll('.req-open')].map((b) => b.title.split(' ')[0]);
  assert.equal(titles().length, 20);
  set({ history: [run('run-21'), ...list.slice(0, 19)] });
  assert.deepEqual(titles(), ['run-21', ...list.slice(0, 19).map((e) => e.id)]);
});

test('a catalog that fails and then loads replaces the notice with the collections, first one open', () => {
  boot({ collections: [], notice: 'Could not load collections from the server.' });
  assert.match(byId('collections-tree').textContent, /Could not load collections/);
  set({ catalogLoading: true });
  set({ collections, notice: '', catalogLoading: false });
  const details = [...byId('collections-tree').querySelectorAll('details')];
  assert.deepEqual(details.map((d) => [d.dataset.id, d.open]), [['c1', true], ['c2', false]]);
  assert.doesNotMatch(byId('collections-tree').textContent, /Could not load/);
});

test('a description and a saved collection\'s inner request name each repaint their part', () => {
  boot();
  set({ collections: [{ ...collections[0], description: 'Second' }, collections[1]] });
  assert.equal(byId('collections-tree').querySelector('summary').title, 'Second');
  set({ savedCollections: [{ ...savedList[0], requests: [req('b1', 'Renamed inside'), req('ws-a', 'Mine')] }] });
  assert.deepEqual([...byId('saved-collections').querySelectorAll('.req-name')].map((n) => n.textContent), ['Renamed inside', 'Mine']);
});

// ---------------------------------------------------------------- storms and focus

const polls = (n) => {
  for (let i = 0; i < n; i += 1) {
    set({ status: { running: true, mode: 'performance', run_id: 'perf-1', budget_balance: 900 - i } });
    set({ progress: { requests: i * 10, errors: 0 }, history: get().history.map((e) => ({ ...e })) });
  }
};

test('fifty polls and fifty progress events keep focus on every kind of sidebar control, and leave open collections and an open confirm as they were', () => {
  boot({ historyNotice: 'Could not load history from the server.' });
  const curated = byId('collections-tree').querySelector('details[data-id="c2"]');
  curated.open = true;
  const saved = byId('saved-collections').querySelector('details[data-id="wc-1"]');
  saved.open = true;
  byId('reset-workspace').click();
  const confirmButtons = [...byId('reset-confirm').querySelectorAll('button')];
  assert.equal(confirmButtons.length, 2, 'the confirm did not open; the case proves nothing');

  const controls = [
    openOf('collections-tree', 'Find'),
    plusOf('workspace-tree', 'Mine'),
    byId('workspace-tree').querySelector('button[data-focus-key="delete:ws-b"]'),
    byId('collections-tree').querySelector('summary[data-focus-key="collection:c1"]'),
    byId('saved-collections').querySelector('button[data-focus-key="delete-saved:wc-1"]'),
    byId('reset-workspace'),
    confirmButtons[1],
    byId('history-list').querySelector('button'),
    byId('history-notice').querySelector('button'),
  ];
  for (const control of controls) {
    assert.ok(control, 'a control the case needs is missing');
    control.focus();
    assert.ok(document.activeElement === control, `${control.dataset.focusKey || control.id || control.textContent} did not take focus; the case proves nothing`);
    polls(50);
    assert.ok(document.activeElement === control, `focus left ${control.dataset.focusKey || control.id || control.textContent}`);
    assert.ok(control.isConnected, `${control.dataset.focusKey || control.id || control.textContent} was taken out of the page`);
  }
  assert.ok(curated.isConnected && curated.open, 'the open curated collection was closed or rebuilt');
  assert.ok(saved.isConnected && saved.open, 'the open saved collection was closed or rebuilt');
  assert.equal(byId('reset-confirm').hidden, false, 'the open confirm was closed');
  assert.ok(confirmButtons.every((b) => b.isConnected), 'the confirm was redrawn');
  assert.deepEqual(listenerErrors, []);
});

test('a part rebuilt for its own reason leaves focus where it is in another part', () => {
  boot();
  const del = byId('workspace-tree').querySelector('button[data-focus-key="delete:ws-b"]');
  del.focus();
  set({ history: [run('run-2'), run('run-1')] });
  set({ collections: [collections[0]] });
  set({ savedCollections: [] });
  assert.ok(document.activeElement === del, 'focus in My Workspace was moved by another part being rebuilt');

  const historyRow = byId('history-list').querySelector('button');
  historyRow.focus();
  const workspaceRows = rowsOf('workspace-tree');
  set({ workspace: [req('ws-a', 'Mine again'), req('ws-b', 'Yours')] });
  set({ selectedId: 'b1' });
  assert.ok(document.activeElement === historyRow, 'focus in History was moved by another part being rebuilt');
  assert.ok(workspaceRows[0] !== rowsOf('workspace-tree')[0], 'My Workspace was not rebuilt; the case proves nothing');
  assert.deepEqual(listenerErrors, []);
});

test('a focused + in a part that is rebuilt comes back to the + of the same request', () => {
  boot();
  const plus = plusOf('collections-tree', 'Look');
  plus.focus();
  set({ collections: [{ ...collections[0], name: 'Renamed' }, collections[1]] });
  assert.ok(!plus.isConnected, 'the tree was not rebuilt; the case proves nothing');
  assert.equal(document.activeElement.dataset.focusKey, 'add:c1:b2');
});
