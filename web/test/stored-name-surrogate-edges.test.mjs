// A stored name whose 120th UTF-16 unit is the first half of a surrogate
// pair, through the restore, a second restore, a copy, the payload and its
// JSON: nothing throws, the cut is stable, the JSON is well formed and reads
// back the same, and the page never sends more characters than the server
// keeps.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage } from './shim.mjs';
import * as workspace from '../js/workspace.js';
import { requestOf, MaxName } from '../js/storage.js';
import { requestPayload, runPayload } from '../js/request-model.js';

const rocket = '\u{1F680}';
const restored = (name) => requestOf({ id: 'run-pair', name, endpoint: 'search', params: {}, assertions: [] });

let shared;

beforeEach(() => {
  resetBrowser();
  shared = new FakeStorage();
});

test('a pair across the 120th unit is cut to its first half, and a second restore changes nothing', () => {
  for (const tail of ['', 'z', rocket, 'z'.repeat(40)]) {
    const name = `${'a'.repeat(MaxName - 1)}${rocket}${tail}`;
    const once = restored(name);
    assert.equal(once.name.length, MaxName);
    assert.equal(once.name, `${'a'.repeat(MaxName - 1)}\uD83D`);
    assert.equal(once.name.isWellFormed(), false, 'the cut leaves the first half alone, as the comment says');
    assert.deepEqual(restored(once.name), once, 'a second restore is the first');
  }
});

test('a pair that ends exactly at the 120th unit is kept whole', () => {
  const name = `${'a'.repeat(MaxName - 2)}${rocket}`;
  assert.equal(restored(name).name, name);
  assert.equal(restored(`${name}tail`).name, name);
});

test('the payload of a name cut inside a pair is well-formed JSON, plain ASCII, and reads back the same', () => {
  const request = restored(`${'a'.repeat(MaxName - 1)}${rocket}`);
  for (const payload of [requestPayload(request), runPayload('functional', [request], { delay_ms: 0, concurrency: 1, duration_secs: 1 })]) {
    const json = JSON.stringify(payload);
    assert.ok(json.includes('\\ud83d'), 'the lone half goes out as an escape');
    assert.equal(json.isWellFormed(), true);
    assert.match(json, /^[\x20-\x7e]*$/);
    assert.deepEqual(JSON.parse(json), payload);
  }
  const sent = JSON.parse(JSON.stringify(requestPayload(request))).name;
  // The server reads the lone half as one character: 120, within its cap.
  assert.equal(Array.from(sent).length, MaxName);
});

test('a copy of a restored name cut inside a pair is well formed, within the cap, and stored as written', () => {
  let state = { workspace: [], draft: null, selectedId: null };
  const ws = workspace.createWorkspace({
    storage: shared,
    get: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
  });
  ws.init();
  const source = restored(`${'a'.repeat(MaxName - 1)}${rocket}`);
  const first = ws.fork(source).request;
  const second = ws.fork(source).request;
  for (const r of [first, second]) {
    assert.ok(r.name.length <= MaxName, r.name);
    assert.equal(r.name.isWellFormed(), true);
  }
  assert.notEqual(first.name, second.name);
  const stored = JSON.parse(shared.getItem('courier.workspace.v1')).requests.map((r) => requestOf(r).name);
  assert.deepEqual(stored, [first.name, second.name]);
});
