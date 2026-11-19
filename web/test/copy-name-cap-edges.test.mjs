// Edges of a copy's name at the name cap: lengths around the point where the
// suffix starts to need room, names that already end in a copy suffix, a
// character outside the BMP and a combining mark exactly at the cut, many
// copies of one capped name, and the name read back and put on the wire.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage } from './shim.mjs';
import * as workspace from '../js/workspace.js';
import { requestOf, MaxName } from '../js/storage.js';
import { requestPayload, runPayload } from '../js/request-model.js';

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

const named = (name) => ({ id: 'search-x', name, endpoint: 'search', params: {}, assertions: [] });
const storedName = (id) => requestOf(JSON.parse(shared.getItem(KEY)).requests.find((r) => r.id === id)).name;

test('names of 113, 114, 119 and 120 characters: the suffix is whole and the base is cut only as far as it must be', () => {
  for (const len of [112, 113, 114, 119, 120]) {
    shared = new FakeStorage();
    const ws = tab();
    const base = 'b'.repeat(len);
    const first = ws.fork(named(base)).request.name;
    const keep = Math.min(len, MaxName - ' (copy)'.length);
    assert.equal(first, `${'b'.repeat(keep)} (copy)`, `${len}: first copy`);
    assert.ok(first.length <= MaxName, `${len}: within the cap`);
    const second = ws.fork(named(base)).request.name;
    assert.equal(second, `${'b'.repeat(Math.min(len, MaxName - ' (copy 2)'.length))} (copy 2)`, `${len}: second copy`);
    assert.equal(storedName(ws.load().requests[1].id), second, `${len}: read back whole`);
  }
});

test('a name already ending in a copy suffix keeps its own suffix as part of the base', () => {
  const ws = tab();
  assert.equal(ws.fork(named('Search (copy)')).request.name, 'Search (copy) (copy)');
  assert.equal(ws.fork(named('Search (copy 9)')).request.name, 'Search (copy 9) (copy)');
  const capped = `${'c'.repeat(MaxName - ' (copy 9)'.length)} (copy 9)`;
  assert.equal(capped.length, MaxName);
  const copy = ws.fork(named(capped)).request.name;
  assert.ok(copy.endsWith(' (copy)'), copy);
  assert.equal(copy.length, MaxName);
});

test('a character outside the BMP straddling the cut is dropped whole, and the copy is still read back unchanged', () => {
  // 112 units, then one pair at units 112-113: the pair does not fit in 113.
  const base = `${'a'.repeat(112)}\u{1F680}${'z'.repeat(6)}`;
  assert.equal(base.length, MaxName);
  const ws = tab();
  const { request } = ws.fork(named(base));
  assert.equal(request.name, `${'a'.repeat(112)} (copy)`);
  assert.equal(request.name.isWellFormed(), true);
  assert.equal(storedName(request.id), request.name);
  const payload = runPayload('functional', [requestOf(request)], {});
  assert.equal(payload.sequence[0].name, request.name, 'a run sends the copy name as stored');
});

test('a combining mark at the cut leaves well-formed text within the cap', () => {
  const base = `${'e\u0301'.repeat(60)}`;
  assert.equal(base.length, MaxName);
  const ws = tab();
  const { request } = ws.fork(named(base));
  assert.ok(request.name.length <= MaxName);
  assert.ok(request.name.endsWith(' (copy)'));
  assert.equal(request.name.isWellFormed(), true);
  assert.ok(base.startsWith(request.name.slice(0, -' (copy)'.length)), 'the base is a prefix of the original');
});

test('fifty copies of one capped name are all distinct, all whole and within the cap, and survive a reload', () => {
  const ws = tab();
  const base = 'Q'.repeat(MaxName);
  const names = [];
  for (let i = 0; i < 50; i += 1) names.push(ws.fork(named(base)).request.name);
  assert.equal(new Set(names).size, 50, 'all distinct');
  for (const [i, n] of names.entries()) {
    assert.ok(n.length <= MaxName, `${i}: ${n.length}`);
    assert.ok(n.endsWith(i === 0 ? ' (copy)' : ` (copy ${i + 1})`), `${i}: ${n.slice(-12)}`);
  }
  // Another tab reading the same storage sees the same fifty names.
  const other = tab();
  const read = other.load().requests.map((r) => requestOf(r).name);
  assert.deepEqual(read, names);
  assert.deepEqual(read.map((n) => requestPayload({ id: 'x', endpoint: 'search', name: n }).name), names);
  // A copy made in the other tab takes the next number.
  assert.ok(other.fork(named(base)).request.name.endsWith(' (copy 51)'));
});

test('a copy of a request with no name, or an empty one, is named from the fallback', () => {
  const ws = tab();
  assert.equal(ws.fork({ id: 'x', endpoint: 'search' }).request.name, 'Request (copy)');
  assert.equal(ws.fork(named('')).request.name, 'Request (copy 2)');
});

test('a restored name of characters outside the BMP is cut in UTF-16 units, never past the server\'s cap in characters', () => {
  const restored = (name) => requestOf({ id: 'run-astral', name, endpoint: 'search', params: {}, assertions: [] }).name;
  const rocket = '\u{1F680}';
  // 60 such characters fill the 120 units and are kept whole.
  assert.equal(restored(rocket.repeat(60)), rocket.repeat(60));
  // 100 of them are within the server's 120 characters but not within 120
  // units: the page keeps 60, shorter than the server would, never longer.
  for (const n of [61, 100, MaxName, MaxName + 30]) {
    const name = restored(rocket.repeat(n));
    assert.equal(name, rocket.repeat(60), `${n} characters`);
    assert.ok(Array.from(name).length <= MaxName, 'longer than the server keeps');
  }
});
