// The first screen says what Courier is and how it is used before it asks
// for anything, and the first curated collection is open so there is a
// request to pick without hunting for one.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const req = (id, name) => ({ id, name, endpoint: 'search', params: { q: 'a' }, assertions: [] });
const collections = [
  { id: 'c1', name: 'Basics', description: '', requests: [req('b1', 'Find')] },
  { id: 'c2', name: 'More', description: '', requests: [req('b2', 'Look')] },
  { id: 'c3', name: 'Last', description: '', requests: [req('b3', 'Other')] },
];

let unsubscribe = null;

beforeEach(() => {
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
});

function boot() {
  sidebar.init({});
  unsubscribe = subscribe((state) => sidebar.render(state));
}

// precedes says a comes before b in document order.
function precedes(a, b) {
  const order = [...document.querySelectorAll('*')];
  return order.indexOf(a) < order.indexOf(b);
}

const openIds = () => [...byId('collections-tree').querySelectorAll('details[data-id]')].filter((d) => d.open).map((d) => d.dataset.id);

test('the runner opens with the one-line statement of what Courier is, above the knee panel', () => {
  const lede = byId('product-statement');
  assert.ok(lede, 'there is no statement');
  assert.equal(text(lede), 'Courier runs curated API requests against a sandboxed search service and shows where it starts to break under load.');
  assert.ok(byId('panel-runner').contains(lede), 'the statement is not on the runner');
  assert.ok(precedes(lede, byId('knee-panel')), 'the statement is not above the knee panel');
});

test('a three-step strip says how the page is used, on the runner and above the knee panel', () => {
  const steps = byId('first-steps');
  assert.ok(steps, 'there is no strip');
  assert.equal(text(steps), '1 Pick a request · 2 Send it · 3 Run a sequence');
  assert.ok(byId('panel-runner').contains(steps));
  assert.ok(precedes(steps, byId('knee-panel')), 'the strip is not above the knee panel');
});

test('the first render of the catalog opens the first collection and only that one', () => {
  boot();
  set({ endpoints });
  assert.deepEqual(openIds(), []);
  set({ collections });
  assert.deepEqual(openIds(), ['c1']);
  assert.deepEqual(listenerErrors, []);
});

test('the first collection is open when the catalog arrives on a Retry after a failed load', () => {
  boot();
  set({ endpoints, notice: 'Could not load collections from the server.' });
  set({ catalogLoading: true });
  set({ collections, notice: null, catalogLoading: false });
  assert.deepEqual(openIds(), ['c1']);
});

test('a collection the visitor closed or opened stays as they left it when the tree is drawn again', () => {
  boot();
  set({ endpoints, collections });
  const details = () => [...byId('collections-tree').querySelectorAll('details[data-id]')];
  details()[0].open = false;
  details()[2].open = true;
  set({ selectedId: 'b2' });
  assert.ok(details()[1].querySelector('.req-open.is-selected'), 'the tree was not drawn again; the case proves nothing');
  assert.deepEqual(openIds(), ['c3']);

  details()[2].open = false;
  set({ selectedId: 'b3' });
  assert.deepEqual(openIds(), [], 'a tree the visitor closed all of was opened again');
});
