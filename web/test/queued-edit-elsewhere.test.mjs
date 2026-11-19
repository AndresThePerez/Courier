// A queued row's Edit against changes made elsewhere: the saved request
// changed in another tab before, during and after an edit, a full or disabled
// localStorage, a reload in between, and where focus and the refused mark
// land afterwards. Nothing a visitor made may be replaced without a word, and
// no copy may be made when nothing changed elsewhere.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page', 'size'] }];

const req = (id, n = 1, extra = {}) => ({
  id, name: `Req ${n}`, endpoint: 'search', params: { q: `q${n}` },
  assertions: [{ type: 'status', op: 'eq', value: 200 }, { type: 'json', path: '$.total', op: 'gt', value: n }], ...extra,
});
const setupOf = (requests, enabled = () => true) => ({
  version: 1, mode: 'functional', options: {}, sequence: requests.map((request, i) => ({ enabled: enabled(i), request })),
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

// reload is a fresh page over what this browser stored.
function reload() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
  const kept = localStorage.snapshot();
  resetBrowser();
  resetState();
  for (const [k, v] of Object.entries(kept)) localStorage.setItem(k, v);
  boot();
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
const assertionRow = (j) => byId('assertion-rows').querySelectorAll('.assert-row')[j];
const marked = () => rows().map((r, i) => (r.classList.contains('is-invalid') ? i + 1 : 0)).filter(Boolean);
const stored = () => JSON.parse(localStorage.peek(WORKSPACE)).requests;
const storedById = (id) => stored().find((r) => r.id === id) || null;
const otherTabWrites = (requests) => localStorage.writeFromAnotherTab(WORKSPACE, JSON.stringify({ version: 1, requests }));
const note = () => (byId('editor-note').hidden ? '' : byId('editor-note').textContent);

function typeChars(input, text) {
  for (const c of text) typeInto(input, input.value + c);
}

test('a change from another tab between two keystrokes of a linked draft forks once: the change, the keystrokes and the queued copy all survive', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-0', 0), req('ws-a', 1), req('ws-2', 2)], (i) => i !== 2) });
  const keys = get().sequence.map((e) => e.key);
  editOf(1).click();
  assert.equal(get().draft.id, 'ws-a', 'the same request opens linked');
  typeChars(byId('editor-name'), '!');
  const elsewhere = { ...req('ws-a', 1), name: 'Changed elsewhere', params: { q: 'other' } };
  otherTabWrites([elsewhere]);
  typeChars(byId('editor-name'), 'abcdefghijklmnopqrs');

  // The other tab's version is kept whole, the 20 keystrokes are in one copy.
  assert.deepEqual(storedById('ws-a'), elsewhere, 'the change made elsewhere was overwritten');
  assert.equal(stored().length, 2, `one copy, not one per keystroke: ${stored().map((r) => r.name)}`);
  const copy = stored().find((r) => r.id !== 'ws-a');
  assert.equal(copy.name, 'Req 1!abcdefghijklmnopqrs');
  assert.ok(get().draft.id === copy.id, 'the editor writes the copy');
  assert.match(note(), /Copied to My Workspace as ".*" - the run now uses this copy\./);

  // The entry: same key, same position, enabled flag kept, the queued content.
  assert.deepEqual(get().sequence.map((e) => e.key), keys);
  assert.deepEqual(get().sequence.map((e) => e.enabled), [true, true, false]);
  const entry = get().sequence[1].request;
  assert.equal(entry.id, copy.id);
  assert.deepEqual(entry.params, { q: 'q1' });
  assert.deepEqual(entry.assertions, req('ws-a', 1).assertions);

  // A second change to the original does not fork the copy.
  otherTabWrites([{ ...elsewhere, name: 'Changed again' }, copy]);
  typeChars(byId('editor-name'), 'Z');
  assert.equal(JSON.parse(localStorage.peek(WORKSPACE)).requests.length, 2, 'the copy was copied again');
  assert.equal(storedById('ws-a').name, 'Changed again');

  // Save writes the copy and that entry only, and names that row.
  byId('save-request').click();
  assert.equal(note().includes(`Saved "Req 1!abcdefghijklmnopqrsZ" to My Workspace and to request 2 in the run.`), true, note());
  assert.equal(get().sequence[1].request.name, 'Req 1!abcdefghijklmnopqrsZ');
  assert.equal(get().sequence[0].request.id, 'ws-0');
  assert.equal(get().sequence[2].request.id, 'ws-2');
  assert.equal(storedById('ws-a').name, 'Changed again');

  // A second Edit of the row opens the copy without forking again.
  editOf(1).click();
  assert.ok(get().draft.id === copy.id);
  assert.equal(stored().length, 2);
  assert.deepEqual(listenerErrors, []);
});

test('a change from another tab between the last keystroke and Save keeps it, and Save puts the visitor\'s version into that entry', async () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1)]) });
  editOf(0).click();
  typeInto(assertionRow(1).querySelector('.assert-value'), '7');
  const elsewhere = { ...req('ws-a', 1), assertions: [{ type: 'latency', op: 'lt', value: 99 }] };
  otherTabWrites([elsewhere]);
  byId('save-request').click();
  assert.deepEqual(storedById('ws-a'), elsewhere, 'Save wrote over the change made elsewhere');
  const copy = stored().find((r) => r.id !== 'ws-a');
  assert.ok(copy, 'the visitor\'s version was kept as a copy');
  assert.equal(copy.assertions[1].value, 7);
  assert.equal(get().sequence[0].request.id, copy.id);
  assert.equal(get().sequence[0].request.assertions[1].value, 7);
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-1' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  const body = fetchStub.calls.find((c) => c.url === '/api/runs').json();
  assert.equal(body.sequence[0].assertions[1].value, 7, 'Start sends the saved fix');
  assert.deepEqual(listenerErrors, []);
});

for (const [label, fail] of [
  ['full', ['setItem']],
  ['disabled', ['setItem', 'getItem', 'removeItem']],
]) {
  test(`20 keystrokes into a linked draft with storage ${label} make no copy when nothing changed elsewhere`, () => {
    boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1)]) });
    editOf(0).click();
    for (const m of fail) localStorage.failOn(m);
    typeChars(byId('editor-name'), 'abcdefghijklmnopqrst');
    assert.equal(get().workspace.length, 1, `copies made: ${get().workspace.map((r) => r.name)}`);
    assert.equal(get().draft.id, 'ws-a');
    assert.equal(get().draft.name, 'Req 1abcdefghijklmnopqrst');
    assert.equal(get().sequence[0].request.id, 'ws-a');
    assert.doesNotMatch(note(), /Copied/);
    localStorage.heal();
    assert.deepEqual(listenerErrors, []);
  });
}

test('20 keystrokes into a linked draft holding extra keys, a padded name and a json exists value make no copy', () => {
  const odd = {
    ...req('ws-a', 1), name: '  padded  ', legacy: { kept: true },
    assertions: [{ type: 'json', op: 'exists', path: '$.x', value: 5, note: 'old build' }],
  };
  boot({ saved: [odd], setup: setupOf([odd]) });
  editOf(0).click();
  assert.equal(get().draft.id, 'ws-a', 'an unchanged request opens linked');
  typeChars(byId('editor-name'), 'abcdefghijklmnopqrst');
  assert.equal(stored().length, 1, `copies made: ${stored().map((r) => r.name)}`);
  assert.equal(get().sequence[0].request.id, 'ws-a');
  assert.deepEqual(listenerErrors, []);
});

test('after a reload, Edit on a row whose saved request nothing changed opens it without another copy', () => {
  // A 120-character name (the editor's maxlength) copied once: the copy's
  // name is the page's own, and nothing changes it afterwards.
  const long = { ...req('ws-a', 1), name: 'N'.repeat(120) };
  boot({ saved: [long], setup: setupOf([long]) });
  // The saved request changes after it was queued, so Edit copies the row.
  otherTabWrites([{ ...long, params: { q: 'newer' } }]);
  editOf(0).click();
  const copyId = get().draft.id;
  assert.notEqual(copyId, 'ws-a');
  assert.equal(stored().length, 2);

  reload();
  assert.equal(get().sequence[0].request.id, copyId);
  editOf(0).click();
  assert.ok(get().draft.id === copyId, `a request nothing changed was copied again as "${get().draft.name}"`);
  assert.equal(stored().length, 2, `copies after reload: ${stored().length}`);
  assert.deepEqual(listenerErrors, []);
});

test('after a reload, Edit on a row queued from a request saved with a long parameter value opens it without a copy', () => {
  // An older build kept parameter values longer than today's 500 cap.
  const old = { ...req('ws-a', 1), params: { q: 'x'.repeat(600) } };
  boot({ saved: [old], setup: setupOf([old]) });
  reload();
  editOf(0).click();
  assert.ok(get().draft.id === 'ws-a', `a request nothing changed was copied as "${get().draft.name}"`);
  assert.equal(stored().length, 1);
  assert.deepEqual(listenerErrors, []);
});

test('focus lands on the request name after Edit, for a linked open and a fork, and stays there through later renders and polls', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1), req('cur-1', 2)]) });
  for (const i of [0, 1]) {
    set({ activeTab: 'runner' });
    editOf(i).focus();
    editOf(i).click();
    assert.ok(document.activeElement === byId('editor-name'), `row ${i + 1}: focus is on the name`);
    assert.equal(get().activeTab, 'editor');
    set({ status: { running: true, run_id: 'r', mode: 'functional' } });
    set({ status: { running: false } });
    runner.render(get());
    assert.ok(document.activeElement === byId('editor-name'), `row ${i + 1}: a later render moved focus`);
  }
  assert.ok(get().sequence[1].request.id.startsWith('ws-'), 'the curated row was forked');
  assert.deepEqual(listenerErrors, []);
});

test('a refused row opened through Edit, then changed in another tab: the fork keeps the row mark on that entry and the editor mark follows the rule', async () => {
  const bad = { ...req('ws-a', 1), assertions: [{ type: 'status', op: 'eq', value: 200 }, { type: 'json', path: '$.total', op: 'gt', value: 'many' }] };
  boot({ saved: [bad], setup: setupOf([req('ws-0', 0), bad]) });
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'gt needs a numeric value, got a string', field: 'sequence[1].assertions[1]' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  assert.deepEqual(marked(), [2]);
  editOf(1).click();
  const value = () => assertionRow(1).querySelector('.assert-value');
  assert.equal(value().getAttribute('aria-invalid'), 'true');
  otherTabWrites([{ ...bad, name: 'Renamed elsewhere' }]);
  typeInto(value(), '3');
  const copyId = get().draft.id;
  assert.notEqual(copyId, 'ws-a', 'the keystroke forked');
  assert.equal(storedById('ws-a').name, 'Renamed elsewhere');
  assert.ok(value().getAttribute('aria-invalid') !== 'true', 'a fixed value keeps the run mark');
  assert.deepEqual(marked(), [2], 'the row keeps its mark until Save');
  typeInto(value(), 'many');
  assert.equal(value().getAttribute('aria-invalid'), 'true', 'the refused value typed back is marked again');
  typeInto(value(), '3');
  byId('save-request').click();
  assert.deepEqual(marked(), [], 'a saved fix clears the row');
  assert.equal(get().sequence[1].request.id, copyId);
  assert.equal(get().sequence[1].request.assertions[1].value, 3);
  assert.equal(get().sequence[0].request.id, 'ws-0', 'the fix landed on that entry only');
  typeInto(value(), 'many');
  const said = value().getAttribute('aria-invalid') === 'true'
    ? byId(value().getAttribute('aria-describedby')).textContent : '';
  assert.doesNotMatch(said, /gt needs a numeric value, got a string/, 'no run mark after a saved fix');
  assert.deepEqual(listenerErrors, []);
});
