// The sidebar holds still while nothing it shows changes: a status poll, which
// lands every few seconds while idle and four times a second during a
// performance run, leaves every part of it as the very nodes it was, and a
// focused control keeps its focus. Each input a part paints, changed on its
// own, repaints that part: a remembered key that leaves one out would show
// stale content, and each case below is what would catch it.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const req = (id, name, endpoint = 'search') => ({ id, name, endpoint, params: { q: 'a' }, assertions: [] });
const collections = [
  { id: 'c1', name: 'Basics', description: '', requests: [req('b1', 'Find'), req('b2', 'Look')] },
  { id: 'c2', name: 'More', description: '', requests: [req('b3', 'Other')] },
];
const savedList = [{ id: 'wc-1', name: 'Saved run', requests: [req('b1', 'Find'), req('ws-1', 'Mine')] }];
const history = [
  { id: 'run-1', mode: 'functional', status: 'completed', started_at: '2026-11-16T14:03:22Z', duration_ms: 120, summary: '3 passed' },
];

let unsubscribe = null;

function boot(extra = {}) {
  sidebar.init({});
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({
    collections,
    endpoints,
    target: 'search.example',
    workspace: [req('ws-1', 'Mine'), req('ws-2', 'Yours')],
    savedCollections: savedList,
    history,
    ...extra,
  });
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
});

const parts = ['collections-tree', 'workspace-tree', 'saved-collections', 'history-list'];
const childrenOf = (id) => [...byId(id).childNodes];
const snapshot = () => Object.fromEntries(parts.map((id) => [id, childrenOf(id)]));
const sameNodes = (before, label) => {
  for (const id of parts) {
    const now = childrenOf(id);
    assert.equal(now.length, before[id].length, `${label}: #${id} gained or lost children`);
    now.forEach((node, i) => assert.ok(node === before[id][i], `${label}: #${id} child ${i} was rebuilt`));
  }
};
const poll = (n) => set({ status: { running: n % 2 === 0, mode: 'performance', run_id: `r${n}`, budget_balance: 1000 + n } });

test('ten status polls leave every part of the sidebar as the very same nodes', () => {
  boot();
  const before = snapshot();
  assert.ok(before['collections-tree'].length > 0 && before['history-list'].length > 0, 'nothing was painted; the case proves nothing');
  for (let n = 0; n < 10; n += 1) poll(n);
  sameNodes(before, 'after ten polls');
  assert.deepEqual(listenerErrors, []);
});

test('a focused sidebar button stays the active element through ten status polls', () => {
  boot();
  const add = [...byId('collections-tree').querySelectorAll('button')].find((b) => b.textContent === '+');
  const history0 = byId('history-list').querySelector('button');
  for (const button of [add, history0]) {
    button.focus();
    assert.ok(document.activeElement === button, 'the button did not take focus; the case proves nothing');
    for (let n = 0; n < 10; n += 1) poll(n);
    assert.ok(document.activeElement === button, `focus left ${button.dataset.focusKey}`);
    assert.ok(button.isConnected, `${button.dataset.focusKey} was taken out of the page`);
  }
  assert.deepEqual(listenerErrors, []);
});

test('the history list arriving again with equal content, as every refresh hands it, rebuilds nothing', () => {
  boot();
  const before = snapshot();
  set({ history: JSON.parse(JSON.stringify(history)) });
  set({ collections: JSON.parse(JSON.stringify(collections)), workspace: JSON.parse(JSON.stringify(get().workspace)) });
  set({ savedCollections: JSON.parse(JSON.stringify(savedList)), endpoints: JSON.parse(JSON.stringify(endpoints)) });
  sameNodes(before, 'after equal copies');
});

// ------------------------------------------------------------- one input each

const names = (id) => [...byId(id).querySelectorAll('.req-open')].map((b) => b.textContent);
const selected = (id) => [...byId(id).querySelectorAll('.req-open.is-selected')].map((b) => b.title);
const marks = (id) => [...byId(id).querySelectorAll('.in-run')].map((m) => m.textContent);
const badges = (id) => [...byId(id).querySelectorAll('.method')].map((m) => m.textContent);

test('collections: a changed catalog repaints the curated tree', () => {
  boot();
  const changed = [{ ...collections[0], name: 'Renamed', requests: [req('b1', 'Found')] }];
  set({ collections: changed });
  assert.deepEqual([...byId('collections-tree').querySelectorAll('.collection-name')].map((n) => n.textContent), ['Renamed']);
  assert.deepEqual(names('collections-tree'), ['GET Found']);
});

test('selected id: the selection moving repaints the curated tree and My Workspace', () => {
  boot();
  set({ selectedId: 'b2' });
  assert.deepEqual(selected('collections-tree'), ['Look']);
  assert.deepEqual(selected('workspace-tree'), []);
  set({ selectedId: 'ws-2' });
  assert.deepEqual(selected('collections-tree'), []);
  assert.deepEqual(selected('workspace-tree'), ['Yours']);
});

test('in-run marks: queueing a request repaints its mark in the curated tree, My Workspace and a saved collection', () => {
  boot();
  assert.deepEqual(marks('collections-tree'), []);
  set({ sequence: [{ key: 'q1', enabled: true, request: req('b1', 'Find') }] });
  assert.deepEqual(marks('collections-tree'), ['in run']);
  assert.deepEqual(marks('saved-collections'), ['in run']);
  set({ sequence: [{ key: 'q1', enabled: true, request: req('b1', 'Find') }, { key: 'q2', enabled: false, request: req('b1', 'Find') }] });
  assert.deepEqual(marks('collections-tree'), ['in run x2']);
  set({ sequence: [{ key: 'q3', enabled: true, request: req('ws-1', 'Mine') }] });
  assert.deepEqual(marks('collections-tree'), []);
  assert.deepEqual(marks('workspace-tree'), ['in run']);
  assert.deepEqual(marks('saved-collections'), ['in run']);
});

test('endpoints: the catalog\'s methods arriving repaint every badge in the sidebar', () => {
  boot({ endpoints: [] });
  assert.deepEqual(badges('collections-tree'), ['---', '---', '---']);
  set({ endpoints });
  assert.deepEqual(badges('collections-tree'), ['GET', 'GET', 'GET']);
  assert.deepEqual(badges('workspace-tree'), ['GET', 'GET']);
  assert.deepEqual(badges('saved-collections'), ['GET', 'GET']);
  set({ endpoints: [{ ...endpoints[0], method: 'POST' }] });
  assert.deepEqual(badges('collections-tree'), ['POST', 'POST', 'POST']);
  assert.deepEqual(badges('workspace-tree'), ['POST', 'POST']);
  assert.deepEqual(badges('saved-collections'), ['POST', 'POST']);
});

test('catalog notice: a failed load replaces Loading with the notice and Retry', () => {
  boot({ collections: [] });
  assert.equal(byId('collections-tree').textContent, 'Loading collections...');
  set({ notice: 'Could not load collections from the server.' });
  assert.match(byId('collections-tree').textContent, /^Could not load collections from the server\. Retry$/);
});

test('catalog loading: a retry going out and coming back flips Retry\'s marking', () => {
  boot({ collections: [], notice: 'Could not load collections from the server.' });
  const retry = () => byId('collections-tree').querySelector('button');
  assert.equal(retry().getAttribute('aria-disabled'), 'false');
  set({ catalogLoading: true });
  assert.equal(retry().getAttribute('aria-disabled'), 'true');
  set({ catalogLoading: false });
  assert.equal(retry().getAttribute('aria-disabled'), 'false');
});

test('workspace: a saved request renamed repaints My Workspace', () => {
  boot();
  set({ workspace: [req('ws-1', 'Renamed'), req('ws-2', 'Yours')] });
  assert.deepEqual(names('workspace-tree'), ['GET Renamed', 'GET Yours']);
  set({ workspace: [] });
  assert.equal(byId('workspace-tree').textContent, 'Empty. Editing a built-in request copies it here.');
});

test('saved collections: a renamed saved collection repaints the list', () => {
  boot();
  set({ savedCollections: [{ ...savedList[0], name: 'Other name' }] });
  assert.deepEqual([...byId('saved-collections').querySelectorAll('.collection-name')].map((n) => n.textContent), ['Other name']);
});

test('history: a new run arriving repaints the history list', () => {
  boot();
  assert.equal(byId('history-list').querySelectorAll('.req-open').length, 1);
  set({ history: [{ ...history[0], id: 'run-2', summary: '1 failed' }, ...history] });
  const titles = [...byId('history-list').querySelectorAll('.req-open')].map((b) => b.title);
  assert.deepEqual(titles, ['run-2 - 1 failed', 'run-1 - 3 passed']);
});

test('history note: an entry that could not be opened says so in the history list', () => {
  boot();
  const notes = () => [...byId('history-list').children].filter((c) => c.classList.contains('note')).map((c) => c.textContent);
  assert.deepEqual(notes(), []);
  set({ historyNote: 'That run is no longer on the server.' });
  assert.deepEqual(notes(), ['That run is no longer on the server.']);
  set({ historyNote: '' });
  assert.deepEqual(notes(), []);
});

test('target: the catalog\'s target name repaints the topbar label and the note under the sidebar', () => {
  boot();
  assert.equal(byId('target-label').textContent, 'target: search.example');
  set({ target: 'other.example' });
  assert.equal(byId('target-label').textContent, 'target: other.example');
  assert.equal(byId('target-note-name').textContent, 'other.example');
});

test('history notice: a failed history read puts the sentence and Retry above the list, and a good one takes them away', () => {
  boot();
  const notice = () => (byId('history-notice').hidden ? '' : byId('history-notice').textContent);
  assert.equal(notice(), '');
  set({ historyNotice: 'Could not load history from the server.' });
  assert.equal(notice(), 'Could not load history from the server. Retry');
  set({ historyNotice: '' });
  assert.equal(notice(), '');
});

test('history loading: a history Retry going out and coming back flips its marking', () => {
  boot({ historyNotice: 'Could not load history from the server.' });
  const retry = () => byId('history-notice').querySelector('button');
  assert.equal(retry().getAttribute('aria-disabled'), 'false');
  set({ historyLoading: true });
  assert.equal(retry().getAttribute('aria-disabled'), 'true');
  set({ historyLoading: false });
  assert.equal(retry().getAttribute('aria-disabled'), 'false');
});

test('history loaded: an empty list says Loading until a server has answered, then No runs yet.', () => {
  boot({ history: [] });
  assert.equal(byId('history-list').textContent, 'Loading history...');
  set({ historyLoaded: true });
  assert.equal(byId('history-list').textContent, 'No runs yet.');
});

test('history notice, in the list: an empty list stops saying Loading once a read has failed', () => {
  boot({ history: [] });
  assert.equal(byId('history-list').textContent, 'Loading history...');
  set({ historyNotice: 'Could not load history from the server.' });
  assert.equal(byId('history-list').textContent, '');
});
