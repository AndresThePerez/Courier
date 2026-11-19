// The page's entry file, opened at an address that names a tab and with a
// saved collection kept in this browser: before the catalog has answered, the
// tab the address names is the one shown and the saved collection is listed.
//
// main.js boots on import and a module is evaluated once per process, so this
// file holds a single test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localStorage, fetchStub, flush, listenerErrors } from './shim.mjs';

const byId = (id) => document.getElementById(id);
const shown = () => ['runner', 'editor', 'results'].filter((name) => byId(`tab-${name}`).getAttribute('aria-selected') === 'true' && byId(`panel-${name}`).classList.contains('is-active'));

test('opened at #results with a saved collection, the page shows Results and lists the collection before the catalog arrives', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  location.hash = '#results';
  localStorage.setItem('courier.collections.v1', JSON.stringify({
    version: 1,
    collections: [{ id: 'wc-kept', name: 'Kept run', requests: [{ id: 'ws-k', name: 'Kept probe', endpoint: 'search', params: { q: 'mew' }, assertions: [] }] }],
  }));
  const catalog = fetchStub.defer('/api/collections', { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: { running: false, budget_balance: 1500 } }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => ({ status: 200, body: { runs: [] } }), { method: 'GET' });

  await import('../js/main.js');

  assert.equal(catalog.requested, true, 'the catalog was not asked for');
  assert.deepEqual(shown(), ['results'], 'the tab the address names is not shown before the catalog arrives');
  const saved = [...byId('saved-collections').querySelectorAll('details[data-id]')];
  assert.deepEqual(saved.map((d) => d.dataset.id), ['wc-kept'], 'the saved collection is not listed before the catalog arrives');
  assert.match(saved[0].textContent, /Kept run/);

  catalog.resolve({ status: 200, body: { collections: [], endpoints: [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }], target: 'search.example' } });
  await flush(10);
  assert.deepEqual(shown(), ['results']);
  assert.deepEqual(errors, [], 'a render module threw');
  assert.deepEqual(listenerErrors, []);
});
