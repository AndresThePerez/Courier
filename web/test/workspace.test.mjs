import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage } from './shim.mjs';
import { resetState, get } from '../js/store.js';
import * as workspace from '../js/workspace.js';

const KEY = 'courier.workspace.v1';

const request = {
  id: 'ws-1',
  name: 'Search pikachu',
  endpoint: 'search',
  params: { q: 'pikachu' },
  assertions: [{ type: 'status', op: 'eq', value: 200 }],
};

beforeEach(() => {
  resetBrowser();
  resetState();
});

test('a saved request survives a reload', () => {
  workspace.save(request);

  assert.ok(localStorage.peek(KEY), 'save wrote to localStorage');
  const loaded = workspace.load();
  assert.deepEqual(loaded.requests, [request]);
});

test('init reads the saved workspace into the state', () => {
  workspace.save(request);
  resetState();
  workspace.init();
  assert.deepEqual(get().workspace, [request]);
});

test('a value from a newer version loads as an empty workspace', () => {
  localStorage.setItem(KEY, JSON.stringify({ version: 2, counter: 4, requests: [request] }));
  assert.deepEqual(workspace.load(), { counter: 0, requests: [] });
});

test('a value that is not JSON loads as an empty workspace', () => {
  localStorage.setItem(KEY, 'not json');
  assert.deepEqual(workspace.load(), { counter: 0, requests: [] });
});

test('nothing stored loads as an empty workspace', () => {
  assert.deepEqual(workspace.load(), { counter: 0, requests: [] });
});
