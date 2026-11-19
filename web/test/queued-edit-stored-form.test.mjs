// Which requests count as the same when a queued row's Edit compares the run's
// copy with the saved request: what a visitor sees or the server reads still
// tells two apart once both are in their stored form, what is never shown or
// sent does not, and nothing the page wrote is copied again on every reload.
// A second Edit on the row already open keeps the typing and still guards a
// change made in another tab.

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
const buttonOf = (i, match) => [...rows()[i].querySelectorAll('button')].find(match);
const editOf = (i) => buttonOf(i, (b) => b.textContent === 'Edit');
const removeOf = (i) => buttonOf(i, (b) => b.title === 'Remove from the run');
const pathInput = (j) => byId('assertion-rows').querySelectorAll('.assert-row')[j].querySelector('.assert-path');
const marked = () => rows().map((r, i) => (r.classList.contains('is-invalid') ? i + 1 : 0)).filter(Boolean);
const stored = () => JSON.parse(localStorage.peek(WORKSPACE)).requests;
const storedById = (id) => stored().find((r) => r.id === id) || null;
const otherTabWrites = (requests) => localStorage.writeFromAnotherTab(WORKSPACE, JSON.stringify({ version: 1, requests }));
const note = () => (byId('editor-note').hidden ? '' : byId('editor-note').textContent);

test('sameRequest still tells apart every difference a visitor sees or the server reads, after both sides are put in stored form', () => {
  const a = req('ws-a', 1, { params: { q: 'q1', page: '2' } });
  const differ = {
    'a name inside the first 120 characters': { ...a, name: 'Req 2' },
    'the 120th character of a long name': [{ ...a, name: `${'N'.repeat(119)}A` }, { ...a, name: `${'N'.repeat(119)}B` }],
    'the endpoint': { ...a, endpoint: 'pokemon' },
    'a parameter value': { ...a, params: { q: 'q1', page: '3' } },
    'the 500th character of a parameter value': [{ ...a, params: { q: `${'x'.repeat(499)}a` } }, { ...a, params: { q: `${'x'.repeat(499)}b` } }],
    'a parameter key': { ...a, params: { q: 'q1', size: '2' } },
    'a parameter added': { ...a, params: { q: 'q1', page: '2', size: '5' } },
    'a parameter removed': { ...a, params: { q: 'q1' } },
    'an assertion type': { ...a, assertions: [{ type: 'latency', op: 'eq', value: 200 }, a.assertions[1]] },
    'an assertion operator': { ...a, assertions: [{ type: 'status', op: 'gt', value: 200 }, a.assertions[1]] },
    'a json path': { ...a, assertions: [a.assertions[0], { ...a.assertions[1], path: '$.count' }] },
    'an assertion value': { ...a, assertions: [{ type: 'status', op: 'eq', value: 201 }, a.assertions[1]] },
    'a number and the same digits as text': { ...a, assertions: [{ type: 'status', op: 'eq', value: '200' }, a.assertions[1]] },
    'zero and empty text': [
      { ...a, assertions: [a.assertions[0], { ...a.assertions[1], op: 'eq', value: 0 }] },
      { ...a, assertions: [a.assertions[0], { ...a.assertions[1], op: 'eq', value: '' }] },
    ],
    'an assertion added': { ...a, assertions: [...a.assertions, { type: 'body_contains', op: 'contains', value: 'x' }] },
    'an assertion removed': { ...a, assertions: [a.assertions[0]] },
    'the 20th assertion': [
      { ...a, assertions: Array.from({ length: 20 }, (_, i) => ({ type: 'status', op: 'eq', value: i === 19 ? 404 : 200 })) },
      { ...a, assertions: Array.from({ length: 20 }, () => ({ type: 'status', op: 'eq', value: 200 })) },
    ],
  };
  for (const [what, pair] of Object.entries(differ)) {
    const [x, y] = Array.isArray(pair) ? pair : [a, pair];
    assert.equal(sameRequest(x, y), false, `${what} must tell two requests apart`);
    assert.equal(sameRequest(y, x), false, `${what} must tell two requests apart (other way round)`);
  }
});

test('sameRequest ignores what is never shown or sent: key order, extra keys and empty defaults', () => {
  const a = req('ws-a', 1);
  const reordered = {
    assertions: [{ value: 200, op: 'eq', type: 'status' }, { value: 1, op: 'gt', path: '$.total', type: 'json' }],
    params: { q: 'q1' }, endpoint: 'search', name: 'Req 1', id: 'ws-a',
  };
  assert.equal(sameRequest(a, reordered), true, 'key order of the request and of an assertion');
  assert.equal(sameRequest(a, { ...a, extra: [1, 2], assertions: a.assertions.map((x) => ({ ...x, colour: 'red' })) }), true, 'extra keys');
  const bare = { id: 'ws-b', endpoint: 'search' };
  assert.equal(sameRequest(bare, { ...bare, params: {}, assertions: [], name: '' }), true, 'missing versus empty');
  assert.equal(sameRequest(
    { ...a, assertions: [{ type: 'json', path: '$.a', op: 'eq', value: 0 }] },
    { ...a, assertions: [{ type: 'json', path: '$.a', op: 'eq', value: -0 }] },
  ), true, 'zero and minus zero are one value on the wire');
  const long = { ...a, name: `${'N'.repeat(120)} (copy 2)`, params: { q: 'x'.repeat(501) } };
  const cut = { ...a, name: 'N'.repeat(120), params: { q: 'x'.repeat(500) } };
  assert.equal(sameRequest(long, cut), true, 'a request and its stored form');
  assert.equal(sameRequest(cut, long), true, 'its stored form and the request: the answer does not depend on the order');
});

test('sameRequest compares a request the stored form refuses as it is: equal stays equal, a difference stays a difference', () => {
  // Numeric parameter values are refused by the stored form on either side.
  const older = { ...req('ws-a', 1), params: { q: 'q1', page: 2 } };
  assert.equal(sameRequest(older, { ...older, params: { q: 'q1', page: 2 } }), true, 'both refused, same content');
  assert.equal(sameRequest(older, { ...older, params: { q: 'q1', page: 3 } }), false, 'both refused, different content');
  assert.equal(sameRequest(older, { ...older, params: { q: 'q1', page: '2' } }), false, 'one refused: a number is not text');
  assert.equal(sameRequest({ ...older, params: { q: 'q1', page: '2' } }, older), false, 'one refused, other way round');
});

test('three reloads with Edit on every row make no copy of a page-made long name, an older long parameter value or a request queued twice', () => {
  const longName = { ...req('ws-n', 1), name: `${'N'.repeat(120)} (copy)` };
  const longValue = { ...req('ws-v', 2), params: { q: 'v'.repeat(600) } };
  const twice = req('ws-t', 3);
  boot({ saved: [longName, longValue, twice], setup: setupOf([longName, longValue, twice, twice]) });
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    reload();
    const ids = ['ws-n', 'ws-v', 'ws-t', 'ws-t'];
    for (let i = 0; i < rows().length; i += 1) {
      editOf(i).click();
      assert.equal(get().draft.id, ids[i], `cycle ${cycle}, row ${i + 1} opened a copy`);
      assert.doesNotMatch(note(), /Copied/, `cycle ${cycle}, row ${i + 1}`);
    }
    assert.equal(stored().length, 3, `cycle ${cycle}: copies made: ${stored().map((r) => r.name.slice(-12))}`);
    assert.deepEqual(get().sequence.map((e) => e.request.id), ids, `cycle ${cycle}: the run was re-pointed`);
  }
  assert.deepEqual(listenerErrors, []);
});

test('a second Edit on the open row does not skip the guard: a change made elsewhere since still survives the next keystroke', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1)]) });
  editOf(0).click();
  typeInto(pathInput(1), '$.totals');
  const elsewhere = { ...req('ws-a', 1), params: { q: 'changed elsewhere' } };
  otherTabWrites([elsewhere]);
  editOf(0).click();
  assert.equal(get().draft.id, 'ws-a', 'the second press reopened or copied');
  typeInto(pathInput(1), '$.totalsx');

  assert.deepEqual(storedById('ws-a'), elsewhere, 'the change made elsewhere was overwritten');
  assert.equal(stored().length, 2);
  const copy = stored().find((r) => r.id !== 'ws-a');
  assert.equal(copy.assertions[1].path, '$.totalsx', 'the typing reached the copy');
  assert.equal(get().draft.id, copy.id);
  assert.equal(get().sequence[0].request.id, copy.id, 'the run uses the copy');
  assert.match(note(), /Copied/, 'the copy was made without a word');
  assert.deepEqual(listenerErrors, []);
});

test('Edit on one row, typing, Edit on another and back loses nothing and makes a copy only with a note', () => {
  boot({ saved: [req('ws-a', 1), req('ws-b', 2)], setup: setupOf([req('ws-a', 1), req('ws-b', 2)]) });
  editOf(0).click();
  typeInto(byId('editor-name'), 'Req 1 typed');
  editOf(1).click();
  assert.equal(get().draft.id, 'ws-b');
  assert.equal(stored().length, 2, 'Edit on another row made a copy');
  editOf(0).click();

  assert.equal(storedById('ws-a').name, 'Req 1 typed', 'the typing kept in the saved request was lost');
  assert.equal(storedById('ws-b').name, 'Req 2');
  // The saved request now holds the typing, the run still the queued copy:
  // they are two requests, so the run's one is copied and the page says so.
  assert.equal(stored().length, 3);
  assert.notEqual(get().draft.id, 'ws-a');
  assert.equal(get().draft.name, 'Req 1 (copy)');
  assert.equal(get().sequence[0].request.id, get().draft.id);
  assert.equal(get().sequence[1].request.id, 'ws-b', 'the other row was re-pointed');
  assert.match(note(), /Copied/);
  assert.deepEqual(listenerErrors, []);
});

test('Edit, typing, removing the row and queuing the saved request again opens the new row linked without a copy', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1)]) });
  editOf(0).click();
  typeInto(pathInput(1), '$.totals');
  removeOf(0).click();
  assert.equal(rows().length, 0);
  runner.add(workspace.find('ws-a'));
  assert.equal(rows().length, 1);
  editOf(0).click();

  assert.equal(stored().length, 1, `copies made: ${stored().map((r) => r.name)}`);
  assert.equal(get().draft.id, 'ws-a');
  assert.equal(get().draft.assertions[1].path, '$.totals');
  assert.doesNotMatch(note(), /Copied/);
  typeInto(pathInput(1), '$.totalsx');
  byId('save-request').click();
  assert.equal(get().sequence[0].request.assertions[1].path, '$.totalsx', 'Save did not reach the new row');
  assert.equal(stored().length, 1);
  assert.deepEqual(listenerErrors, []);
});

test('a second Edit on a row marked refused keeps the mark and the note, and the fix still lands on that row alone', () => {
  const broken = { ...req('ws-a', 1), assertions: [{ type: 'json', path: '', op: 'exists' }] };
  boot({ saved: [broken, req('ws-b', 2)], setup: setupOf([req('ws-b', 2), broken]) });
  byId('start-run').click();
  assert.deepEqual(marked(), [2], 'Start marks the refused row');
  editOf(1).click();
  assert.equal(get().draft.id, 'ws-a');
  typeInto(pathInput(0), ' ');
  typeInto(pathInput(0), '');
  byId('save-request').click();
  const refused = note();
  assert.match(refused, /^Not saved/);
  assert.deepEqual(marked(), [2]);
  editOf(1).click();
  assert.equal(note(), refused, 'the second press changed the note');
  assert.deepEqual(marked(), [2], 'the second press moved or dropped the mark');
  assert.equal(get().draft.id, 'ws-a');
  assert.equal(stored().length, 2);

  typeInto(pathInput(0), '$.ok');
  byId('save-request').click();
  assert.match(note(), /^Saved/);
  assert.deepEqual(marked(), []);
  assert.equal(get().sequence[1].request.assertions[0].path, '$.ok', 'the fix missed its row');
  assert.deepEqual(get().sequence[0].request, req('ws-b', 2), 'the fix landed on the other row');
  assert.equal(stored().length, 2);
  assert.deepEqual(listenerErrors, []);
});
