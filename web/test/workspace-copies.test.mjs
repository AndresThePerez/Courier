import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage } from './shim.mjs';
import * as workspace from '../js/workspace.js';

const KEY = 'courier.workspace.v1';
const curated = { id: 'search-pikachu', name: 'Search pikachu', endpoint: 'search', params: {}, assertions: [] };

let shared;

beforeEach(() => {
  resetBrowser();
  shared = new FakeStorage();
});

function tab() {
  let state = { workspace: [], draft: null, selectedId: null };
  const ws = workspace.createWorkspace({
    storage: shared,
    get: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
  });
  ws.init();
  return ws;
}

test('forking the same request again numbers the copies', () => {
  const ws = tab();
  assert.equal(ws.fork(curated).request.name, 'Search pikachu (copy)');
  assert.equal(ws.fork(curated).request.name, 'Search pikachu (copy 2)');
  assert.equal(ws.fork(curated).request.name, 'Search pikachu (copy 3)');
});

test('the number skips names already taken, including ones saved by another tab', () => {
  const ws = tab();
  shared.setItem(KEY, JSON.stringify({
    version: 1,
    requests: [
      { ...curated, id: 'ws-a', name: 'Search pikachu (copy)' },
      { ...curated, id: 'ws-b', name: 'Search pikachu (copy 2)' },
    ],
  }));
  assert.equal(ws.fork(curated).request.name, 'Search pikachu (copy 3)');
});

test('a free first copy name is used before any number', () => {
  shared.setItem(KEY, JSON.stringify({
    version: 1,
    requests: [{ ...curated, id: 'ws-b', name: 'Search pikachu (copy 2)' }],
  }));
  const ws = tab();
  assert.equal(ws.fork(curated).request.name, 'Search pikachu (copy)');
});
