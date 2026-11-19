// What "the same request" means for a queued row's Edit: the name counts, keys
// nothing sends do not, and neither does what storing a request cuts. A copy
// made because the saved request changed elsewhere keeps the queued content in
// the run, and pressing Edit again on the row already open changes nothing.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import { sameRequest } from '../js/request-model.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page', 'size'] }];

const req = (id, n = 1, extra = {}) => ({
  id, name: `Req ${n}`, endpoint: 'search', params: { q: `q${n}` },
  assertions: [{ type: 'status', op: 'eq', value: 200 }, { type: 'json', path: '$.total', op: 'gt', value: n }], ...extra,
});
const setupOf = (requests) => ({
  version: 1, mode: 'functional', options: {}, sequence: requests.map((request) => ({ enabled: true, request })),
});

let unsubscribe = null;

function boot({ setup, saved } = {}) {
  if (setup) localStorage.setItem(SETUP, JSON.stringify(setup));
  if (saved) localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: saved }));
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  runner.init({ edit: (key) => editor.editQueued(key, (name) => set({ activeTab: name })) });
  sidebar.init({
    select: (request) => { editor.onSelect(); sidebar.selectRequest(request); },
    add: (request) => runner.add(request),
    addAll: (collection) => runner.addAll(collection),
  });
  unsubscribe = subscribe((state) => { sidebar.render(state); editor.render(state); runner.render(state); });
  set({ endpoints });
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
});

const rows = () => [...byId('sequence-list').querySelectorAll('.seq-row')];
const editOf = (i) => [...rows()[i].querySelectorAll('button')].find((b) => b.textContent === 'Edit');
const pathInput = (j) => byId('assertion-rows').querySelectorAll('.assert-row')[j].querySelector('.assert-path');
const stored = () => JSON.parse(localStorage.peek(WORKSPACE)).requests;
const storedById = (id) => stored().find((r) => r.id === id) || null;
const otherTabWrites = (requests) => localStorage.writeFromAnotherTab(WORKSPACE, JSON.stringify({ version: 1, requests }));
const note = () => (byId('editor-note').hidden ? '' : byId('editor-note').textContent);

test('a copy made because the saved request changed elsewhere leaves the queued content in the run, not the unsaved draft', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1)]) });
  editOf(0).click();
  assert.equal(get().draft.id, 'ws-a', 'the same request opens linked');
  typeInto(pathInput(1), '$.totalx');
  const elsewhere = { ...req('ws-a', 1), params: { q: 'other' } };
  otherTabWrites([elsewhere]);
  typeInto(pathInput(1), '$.totalxy');

  assert.deepEqual(storedById('ws-a'), elsewhere, 'the change made elsewhere was overwritten');
  assert.equal(stored().length, 2);
  const copy = stored().find((r) => r.id !== 'ws-a');
  assert.equal(copy.assertions[1].path, '$.totalxy', 'the copy holds what was typed');
  const entry = get().sequence[0].request;
  assert.equal(entry.id, copy.id, 'the run uses the copy');
  assert.deepEqual(entry.params, req('ws-a', 1).params, 'the queued params were replaced');
  assert.deepEqual(entry.assertions, req('ws-a', 1).assertions, 'unsaved keystrokes reached the run');
  assert.deepEqual(listenerErrors, []);
});

test('a change elsewhere to only the name of a linked draft\'s saved request makes a copy on the next keystroke and keeps that name', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1)]) });
  editOf(0).click();
  assert.equal(get().draft.id, 'ws-a');
  const renamed = { ...req('ws-a', 1), name: 'Renamed elsewhere' };
  otherTabWrites([renamed]);
  typeInto(pathInput(1), '$.totals');

  assert.deepEqual(storedById('ws-a'), renamed, 'the name given elsewhere was overwritten');
  assert.equal(stored().length, 2, 'no copy was made');
  assert.notEqual(get().draft.id, 'ws-a');
  assert.equal(get().sequence[0].request.id, get().draft.id);
  assert.deepEqual(listenerErrors, []);
});

test('sameRequest tells a renamed request apart and ignores keys that are never sent', () => {
  const a = req('ws-a', 1);
  assert.equal(sameRequest(a, { ...a, name: 'Other' }), false, 'a name-only difference');
  const extra = {
    ...a, legacy: { kept: true }, method: 'POST',
    assertions: a.assertions.map((x) => ({ ...x, note: 'old build' })),
  };
  assert.equal(sameRequest(a, extra), true, 'keys the payload never carries');
});

test('sameRequest treats a request and its stored form as the same request', () => {
  const long = { ...req('ws-a', 1), name: `${'N'.repeat(120)} (copy)`, params: { q: 'x'.repeat(600) } };
  const cut = { ...long, name: 'N'.repeat(120), params: { q: 'x'.repeat(256) } };
  assert.equal(sameRequest(long, cut), true);
  assert.equal(sameRequest(long, { ...cut, params: { q: 'y'.repeat(256) } }), false);
});

test('Edit pressed again on the row already open keeps the draft as typed and makes no copy', () => {
  boot({ saved: [req('ws-a', 1), req('ws-b', 2)], setup: setupOf([req('ws-a', 1), req('ws-b', 2)]) });
  const name = byId('editor-name');
  editOf(0).click();
  typeInto(name, 'Req 1a');
  editOf(0).click();
  typeInto(name, 'Req 1ab');
  set({ activeTab: 'runner' });
  editOf(0).focus();
  editOf(0).click();

  assert.equal(stored().length, 2, `copies made: ${stored().map((r) => r.name)}`);
  assert.equal(get().draft.id, 'ws-a');
  assert.equal(get().draft.name, 'Req 1ab', 'the unsaved keystrokes were dropped');
  assert.equal(name.value, 'Req 1ab');
  assert.equal(get().activeTab, 'editor');
  assert.ok(document.activeElement === name, 'focus is on the name');
  assert.doesNotMatch(note(), /Copied/);
  assert.equal(get().sequence[0].request.name, 'Req 1', 'unsaved keystrokes reached the run');

  // Another row opens as before.
  editOf(1).click();
  assert.equal(get().draft.id, 'ws-b');
  assert.equal(get().draft.name, 'Req 2');
  assert.equal(stored().length, 2);
  assert.deepEqual(listenerErrors, []);
});
