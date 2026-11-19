// A second visit through the page's own entry file, for the wiring the first
// one does not reach: the page index.html loads is main.js, a run already live
// when the page opens is followed, and a history row opens its run.
//
// main.js boots on import and a module is evaluated once per process, so this
// file holds a single test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchStub, eventSources, flush, listenerErrors } from './shim.mjs';

const byId = (id) => document.getElementById(id);
const LIVE = 'run-live-1';
const OLD = 'run-old-1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const shown = () => ['runner', 'editor', 'results'].filter((name) => byId(`tab-${name}`).getAttribute('aria-selected') === 'true');

test('the entry file index.html loads is main.js, a live run is followed on open, and a history row opens its run', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const errors = [];
  t.mock.method(console, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });

  // Every script and stylesheet the page names is a file that is shipped,
  // and the module script is the entry file imported below.
  const scripts = [...document.querySelectorAll('script')].filter((s) => s.getAttribute('src'));
  assert.deepEqual(scripts.map((s) => [s.getAttribute('type'), s.getAttribute('src')]), [['module', '/js/main.js']]);
  const web = new URL('../', import.meta.url);
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const href = link.getAttribute('href');
    assert.ok(existsSync(fileURLToPath(new URL(href.replace(/^\//, ''), web))), `stylesheet ${href} is shipped`);
  }

  const old = {
    id: OLD, mode: 'functional', status: 'completed', started_at: '2026-11-18T09:00:00Z', duration_ms: 30, config: {},
    entries: [{ index: 0, name: 'Old probe' }],
    functional: { verdict: 'PASS', results: [{ index: 0, name: 'Old probe', endpoint: 'search', query: '?q=ditto', status: 200, latency_ms: 9, size_bytes: 20, passed: true, skipped: false, assertions: [], body_preview: '{}' }] },
  };
  fetchStub.serve('/api/collections', () => ({ status: 200, body: { collections: [], endpoints, target: 'search.example' } }), { method: 'GET' });
  fetchStub.serve('/api/status', () => ({ status: 200, body: { running: true, run_id: LIVE, mode: 'functional', started_at: '2026-11-19T10:00:00Z', budget_balance: 1500 } }), { method: 'GET' });
  fetchStub.serve('/api/runs', () => ({ status: 200, body: { runs: [{ id: OLD, mode: 'functional', status: 'completed', started_at: '2026-11-18T09:00:00Z', duration_ms: 30, summary: '1 passed' }] } }), { method: 'GET' });
  fetchStub.serve(`/api/runs/${OLD}`, () => ({ status: 200, body: old }), { method: 'GET' });
  fetchStub.serve(`/api/runs/${LIVE}`, () => ({ status: 200, body: { id: LIVE, mode: 'functional', status: 'running', started_at: '2026-11-19T10:00:00Z', config: {}, entries: [] } }), { method: 'GET' });

  await import(`../js/${scripts[0].getAttribute('src').split('/').pop()}`);
  await flush(10);

  // A run live when the page opened is followed.
  assert.equal(byId('run-state').textContent, 'run in progress - functional');
  assert.ok(eventSources.instances.some((s) => s.url.endsWith(`/api/runs/${LIVE}/stream`)), 'the live run is not followed');

  // A history row opens its run in Results.
  const rowButton = byId('history-list').querySelector('.req-open');
  assert.ok(rowButton, 'the history row is not drawn');
  rowButton.click();
  await flush(10);
  assert.ok(fetchStub.calls.some((c) => c.url === `/api/runs/${OLD}`), 'the history row asked for nothing');
  assert.deepEqual(shown(), ['results']);
  assert.match(byId('results-rows').textContent, /ditto/, 'the old run\'s rows are not painted');

  assert.deepEqual(errors, [], 'a render module threw');
  assert.deepEqual(listenerErrors, []);
});
