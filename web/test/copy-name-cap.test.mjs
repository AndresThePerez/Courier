// A copy's name fits the name cap whole: " (copy)" and " (copy N)" are kept,
// and the base name is shortened instead, so nothing cuts the suffix off on a
// reload or a run, and two copies of one long name still differ.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage } from './shim.mjs';
import * as workspace from '../js/workspace.js';
import { requestOf, MaxName } from '../js/storage.js';
import { requestPayload } from '../js/request-model.js';

const KEY = 'courier.workspace.v1';

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

const atCap = (unit = 'N') => ({ id: 'search-long', name: unit.repeat(MaxName), endpoint: 'search', params: {}, assertions: [] });

// reloaded is the name as this browser reads it back.
const reloaded = (ws, id) => {
  const raw = JSON.parse(shared.getItem(KEY)).requests.find((r) => r.id === id);
  return requestOf(raw).name;
};

test('a copy of a name at the cap keeps " (copy)" whole and fits the cap', () => {
  const ws = tab();
  const { request } = ws.fork(atCap());
  assert.equal(request.name.length, MaxName);
  assert.ok(request.name.endsWith(' (copy)'), request.name);
  assert.equal(request.name, `${'N'.repeat(MaxName - ' (copy)'.length)} (copy)`);
  assert.equal(reloaded(ws, request.id), request.name, 'a reload reads the same name');
  assert.equal(requestPayload(requestOf(request)).name, request.name, 'a run sends the same name');
});

test('numbered copies of one name at the cap stay distinct and whole', () => {
  const ws = tab();
  const names = [];
  for (let i = 0; i < 12; i += 1) names.push(ws.fork(atCap()).request.name);
  assert.equal(new Set(names).size, names.length, `distinct: ${names.map((n) => n.slice(-12)).join(', ')}`);
  assert.ok(names[1].endsWith(' (copy 2)'), names[1]);
  assert.ok(names[11].endsWith(' (copy 12)'), names[11]);
  for (const n of names) assert.ok(n.length <= MaxName, `${n.length}: ${n.slice(-12)}`);
});

test('a base of characters outside the BMP is shortened by whole characters', () => {
  const ws = tab();
  const { request } = ws.fork(atCap('\u{1F600}'));
  assert.ok(request.name.length <= MaxName);
  assert.ok(request.name.endsWith(' (copy)'));
  assert.equal(request.name.isWellFormed(), true, 'no half of a character is left');
  assert.equal(reloaded(ws, request.id), request.name);
});

test('a short name is copied as before', () => {
  const ws = tab();
  const short = { id: 'search-pikachu', name: 'Search pikachu', endpoint: 'search', params: {}, assertions: [] };
  assert.equal(ws.fork(short).request.name, 'Search pikachu (copy)');
  assert.equal(ws.fork(short).request.name, 'Search pikachu (copy 2)');
});
