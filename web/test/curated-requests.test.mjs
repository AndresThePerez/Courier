// Every curated request ships inside the binary and every visitor meets it
// first, so the page must never refuse one: each is sent by Send as it is, and
// each knee preset starts a run of whole-number options without a refusal.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resetBrowser, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import { requestPayload } from '../js/request-model.js';

const byId = (id) => document.getElementById(id);

const DATA = new URL('../../internal/collections/data/', import.meta.url);
const curated = readdirSync(DATA).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8')));
const endpoints = [...new Set(curated.flatMap((c) => c.requests.map((r) => r.endpoint)))]
  .map((id) => ({ id, label: id, method: 'GET', path: `/${id}`, params: [] }));

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
  workspace.init();
  editor.init();
  runner.init({});
  unsubscribe = subscribe((state) => { editor.render(state); runner.render(state); });
  set({ endpoints, collections: curated });
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
});

test('Send sends every curated request as it is, without a refusal', async () => {
  let n = 0;
  for (const c of curated) {
    for (const r of c.requests) {
      n += 1;
      editor.onSelect();
      sidebar.selectRequest(r);
      fetchStub.respond('/api/send', { status: 200, body: { status: 200, passed: true, endpoint: r.endpoint, query: '', latency_ms: 1, size_bytes: 0, body: '', assertions: [] } }, { method: 'POST' });
      byId('send-request').click();
      await flush();
      const calls = fetchStub.calls.filter((call) => call.url === '/api/send');
      assert.equal(calls.length, n, `${c.id}/${r.id} was sent`);
      assert.deepEqual(JSON.parse(calls[n - 1].body), requestPayload(r), `${c.id}/${r.id} went as it is`);
      assert.doesNotMatch(byId('send-status').textContent, /Refused/, `${c.id}/${r.id}`);
    }
  }
  assert.ok(n > 0, 'the curated collections were read');
  assert.deepEqual(listenerErrors, []);
});

test('each knee preset starts a run of the five search requests with whole-number options and no refusal', async () => {
  const buttons = [...byId('knee-buttons').querySelectorAll('button')];
  assert.equal(buttons.length, 4);
  for (const [i, button] of buttons.entries()) {
    button.click();
    fetchStub.respond('/api/runs', { status: 202, body: { run_id: `run-${i}` } }, { method: 'POST' });
    byId('start-run').click();
    await flush();
    const calls = fetchStub.calls.filter((call) => call.url === '/api/runs');
    assert.equal(calls.length, i + 1, `${button.textContent} started a run`);
    const body = calls[i].json();
    assert.equal(body.mode, 'performance');
    assert.equal(body.sequence.length, 5, button.textContent);
    for (const [k, v] of Object.entries(body.options)) {
      if (k !== 'stop_on_failure') assert.ok(Number.isInteger(v), `${button.textContent}: ${k} is ${v}`);
    }
    assert.doesNotMatch(byId('start-note').textContent, /Refused/, button.textContent);
    set({ status: { running: false } });
  }
  assert.deepEqual(get().sequence.length, 5);
  assert.deepEqual(listenerErrors, []);
});
