// A report or a catalog is read item by item: a list the dashboard draws
// that holds something other than records is refused like any other answer
// of the wrong shape, and a list the server writes as null is an empty one.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, listenerErrors } from './shim.mjs';
import { resetState, get, set } from '../js/store.js';
import * as api from '../js/api.js';
import { isReport, isCatalog } from '../js/api.js';
import * as sidebar from '../js/render-sidebar.js';

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

const perf = (performance) => ({ id: 'p1', mode: 'performance', status: 'completed', started_at: '2026-11-18T10:00:00Z', duration_ms: 10, config: {}, entries: [], performance });
const overall = (extra = {}) => ({ index: -1, requests: 1, latency: {}, sla: {}, apdex: {}, histogram: [], status_counts: {}, error_kinds: {}, ...extra });
const good = () => ({ verdict: 'PASS', verdict_reasons: [], slo: {}, overall: overall(), per_request: [], overrun_ms: 0 });

test('a performance block whose per-request list, histogram or reasons hold the wrong items is refused', () => {
  assert.ok(isReport(perf(good())), 'the well-formed report is taken');
  const wrong = {
    'per_request [null]': { per_request: [null] },
    'per_request [3]': { per_request: [3] },
    'per_request {}': { per_request: {} },
    'histogram [null]': { overall: overall({ histogram: [null] }) },
    'histogram "x"': { overall: overall({ histogram: 'x' }) },
    'verdict_reasons [5]': { verdict_reasons: [5] },
    'verdict_reasons [null]': { verdict_reasons: [null] },
    'overall []': { overall: [] },
    'overall.sla []': { overall: overall({ sla: [] }) },
    'overall.status_counts []': { overall: overall({ status_counts: [] }) },
    'slo "x"': { slo: 'x' },
  };
  for (const [name, patch] of Object.entries(wrong)) {
    assert.equal(isReport(perf({ ...good(), ...patch })), false, name);
  }
  // Go writes a nil slice or map as null; those are empty, not wrong.
  for (const [name, patch] of Object.entries({
    'per_request null': { per_request: null },
    'verdict_reasons null': { verdict_reasons: null },
    'histogram null': { overall: overall({ histogram: null }) },
    'status_counts null': { overall: overall({ status_counts: null, error_kinds: null }) },
    'ladder_ms null': { slo: { ladder_ms: null } },
  })) {
    assert.equal(isReport(perf({ ...good(), ...patch })), true, name);
  }
});

test('a collection whose requests the server wrote as null is a catalog, and the sidebar draws it as an empty collection', async () => {
  const body = { collections: [{ id: 'c1', name: 'Empty', description: '', requests: null }], endpoints: null, target: '' };
  assert.equal(isCatalog(body), true);
  fetchStub.respond('/api/collections', { status: 200, body }, { method: 'GET' });
  const res = await api.getCollections();
  assert.equal(res.ok, true);
  assert.deepEqual(res.body.collections[0].requests, []);
  sidebar.init({});
  set({ collections: res.body.collections });
  assert.doesNotThrow(() => sidebar.render(get()));
  assert.match(document.getElementById('collections-tree').textContent, /Empty/);
  assert.deepEqual(listenerErrors, []);
});
