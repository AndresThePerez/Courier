import { test } from 'node:test';
import assert from 'node:assert/strict';
import './shim.mjs';
import * as store from '../js/store.js';

test('resetState puts the state back to how the page starts', () => {
  assert.equal(typeof store.resetState, 'function', 'store.js exports resetState');

  const state = store.get();
  store.set({
    sequence: [{ key: 'seq-1', enabled: true, request: { id: 'r1' } }],
    mode: 'performance',
    options: { ...state.options, concurrency: 50 },
    transport: 'sse',
  });
  assert.equal(store.get().sequence.length, 1);

  store.resetState();

  assert.deepEqual(store.get().sequence, []);
  assert.equal(store.get().mode, 'functional');
  assert.deepEqual(store.get().options, { stop_on_failure: false, delay_ms: 0, concurrency: 10, duration_secs: 10 });
  assert.equal(store.get().transport, 'idle');
  assert.ok(store.get() === state, 'the state object keeps its identity, so held references stay live');
});

test('resetState hands out fresh nested defaults, not the ones a test mutated', () => {
  store.resetState();
  store.get().options.concurrency = 3;
  store.get().workspace.push({ id: 'ws-1' });
  store.resetState();
  assert.equal(store.get().options.concurrency, 10);
  assert.deepEqual(store.get().workspace, []);
});

test('resetState drops keys a test added', () => {
  store.set({ extra: true });
  store.resetState();
  assert.equal('extra' in store.get(), false);
});
