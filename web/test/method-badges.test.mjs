// Method badges are read from the endpoint catalog by endpoint id, wherever a
// request is listed: the sidebar tree, the run sequence and the result rows.
// A request whose endpoint the page does not know (a stored one for an
// endpoint that is gone, or any request before the catalog has loaded) shows
// a muted placeholder: never "undefined", and never a guessed GET.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, get, set } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as sidebar from '../js/render-sidebar.js';
import * as runner from '../js/render-runner.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const req = (id, endpoint, name = id) => ({ id, name, endpoint, params: {}, assertions: [] });
const ODD = 'odd "id"] [x=\'1\'] \\ <b>';

const ENDPOINTS = [
  { id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] },
  { id: 'create', label: 'Create', method: 'POST', path: '/things', params: [] },
  { id: 'lower', label: 'Lower', method: 'get', path: '/l', params: [] },
  { id: 'mixed', label: 'Mixed', method: 'Post', path: '/m', params: [] },
  { id: 'remove', label: 'Remove', method: 'DELETE', path: '/r', params: [] },
  { id: 'empty', label: 'Empty', method: '', path: '/e', params: [] },
  { id: 'missing', label: 'Missing', path: '/x', params: [] },
  { id: 'number', label: 'Number', method: 7, path: '/n', params: [] },
  { id: ODD, label: 'Odd', method: 'POST', path: '/o', params: [] },
];

// EXPECT is what each endpoint id shows: [class, text].
const EXPECT = {
  search: ['method method-get', 'GET'],
  create: ['method method-post', 'POST'],
  lower: ['method method-get', 'GET'],
  mixed: ['method method-post', 'POST'],
  remove: ['method method-other', 'DELETE'],
  empty: ['method method-none', '---'],
  missing: ['method method-none', '---'],
  number: ['method method-none', '---'],
  gone: ['method method-none', '---'],
  [ODD]: ['method method-post', 'POST'],
};

const requests = Object.keys(EXPECT).map((endpoint, i) => req(`r${i}`, endpoint, `Request for ${endpoint}`));

function paint() {
  sidebar.render(get());
  runner.render(get());
  results.render(get());
}

function badgeIn(row) {
  return row.querySelector('.method');
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
  runner.init({});
  sidebar.init({ add: (r) => runner.add(r), addAll: (c) => runner.addAll(c) });
});

test('a request for a POST endpoint renders method-post, read from the catalog', () => {
  set({ endpoints: ENDPOINTS, collections: [{ id: 'c', name: 'C', requests: [req('p', 'create', 'Make one')] }] });
  paint();
  const badge = badgeIn(byId('collections-tree').querySelector('.req-row'));
  assert.equal(badge.className, 'method method-post');
  assert.equal(badge.textContent, 'POST');
});

test('every list badges every method the same way: upper-cased, coloured for GET and POST, muted otherwise', () => {
  set({ endpoints: ENDPOINTS, collections: [{ id: 'c', name: 'C', requests }] });
  for (const r of requests) runner.add(r);
  set({
    run: { id: 'run-1', mode: 'functional', total: requests.length, started_at: '', config: {}, entries: [] },
    results: requests.map((r, index) => ({ index, name: r.name, endpoint: r.endpoint, status: 200, passed: true, assertions: [] })),
  });
  paint();

  const lists = {
    tree: [...byId('collections-tree').querySelectorAll('.req-row')],
    sequence: [...byId('sequence-list').querySelectorAll('.seq-row')],
    results: [...byId('results-rows').querySelectorAll('.res-row')],
  };
  for (const [where, rows] of Object.entries(lists)) {
    assert.equal(rows.length, requests.length, where);
    rows.forEach((row, i) => {
      const endpoint = requests[i].endpoint;
      const badge = badgeIn(row);
      assert.ok(badge, `${where}: ${endpoint} has a badge`);
      assert.deepEqual([badge.className, badge.textContent], EXPECT[endpoint], `${where}: ${endpoint}`);
      assert.doesNotMatch(row.textContent, /undefined|null/, `${where}: ${endpoint}`);
    });
  }
  const placeholder = badgeIn(lists.tree[Object.keys(EXPECT).indexOf('gone')]);
  assert.equal(placeholder.getAttribute('aria-label'), 'Method unknown');
  assert.deepEqual(listenerErrors, []);
});

test('before the catalog has loaded every badge is the placeholder, and each list picks the method up once it arrives', () => {
  workspace.init();
  workspace.save(req('ws-1', 'create', 'Mine'));
  runner.savedCollections.init();
  runner.savedCollections.create('Saved', [req('r1', 'create', 'Saved request')]);
  runner.add(req('r1', 'create', 'Queued'));
  set({
    run: { id: 'run-1', mode: 'functional', total: 1, started_at: '', config: {}, entries: [] },
    results: [{ index: 0, name: 'Row', endpoint: 'create', status: 201, passed: true, assertions: [] }],
  });
  paint();
  const all = () => [
    badgeIn(byId('workspace-tree')),
    badgeIn(byId('saved-collections')),
    badgeIn(byId('sequence-list')),
    badgeIn(byId('results-rows')),
  ];
  for (const badge of all()) assert.deepEqual([badge.className, badge.textContent], ['method method-none', '---']);

  set({ endpoints: ENDPOINTS });
  paint();
  for (const badge of all()) assert.deepEqual([badge.className, badge.textContent], ['method method-post', 'POST']);
  workspace.stop();
});

test('no list hard-codes a method, and the plain-text choice is gone with its comment', () => {
  for (const file of ['render-sidebar.js', 'render-runner.js', 'render-results.js']) {
    const src = readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /text: 'GET'/, file);
    assert.doesNotMatch(src, /no coloured method badges/, file);
  }
});

test('the badge colours are the existing pass and warn tokens', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.method-get\s*\{[^}]*color:\s*var\(--pass\)/);
  assert.match(css, /\.method-post\s*\{[^}]*color:\s*var\(--warn\)/);
});
