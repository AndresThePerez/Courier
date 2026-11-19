// A request the server would refuse is not saved or queued, and one already
// queued can be opened from its row, fixed and saved back into that row.

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
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] }];

const good = (id, n = 1) => ({ id, name: `Good ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [{ type: 'status', op: 'eq', value: 200 }] });
const bad = (id, name = 'Bad') => ({ id, name, endpoint: 'search', params: { q: 'x' }, assertions: [{ type: 'status', op: 'eq', value: 200 }, { type: 'json', path: '', op: 'eq', value: 1 }] });
const Refused = (name) => `"${name}" has an invalid assertion - fix it in the editor before queuing it.`;

let unsubscribe = null;
let opened = [];

function boot({ setup, saved } = {}) {
  if (setup) localStorage.setItem(SETUP, JSON.stringify(setup));
  if (saved) localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: saved }));
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  // The page's wiring of the row's Edit (main.js does the same).
  runner.init({ edit: (key) => { editor.openQueued(key); opened.push(key); set({ activeTab: 'editor' }); } });
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
  opened = [];
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
});

const rows = () => [...byId('sequence-list').querySelectorAll('.seq-row')];
const editOf = (i) => [...rows()[i].querySelectorAll('button')].find((b) => b.textContent === 'Edit');
const assertionRow = (j) => byId('assertion-rows').querySelectorAll('.assert-row')[j];

// ------------------------------------------------------------------ Save

test('Save refuses a draft the server would refuse, with the reason beside the assertion', () => {
  boot({ saved: [bad('ws-b')] });
  sidebar.selectRequest(workspace.find('ws-b'));
  byId('save-request').click();
  assert.equal(byId('editor-note').textContent, 'Not saved - Assertion 2: JSON path is required');
  const path = assertionRow(1).querySelector('.assert-path');
  assert.equal(path.getAttribute('aria-invalid'), 'true');
  assert.equal(byId(path.getAttribute('aria-describedby')).textContent, 'JSON path is required');
  assert.ok(assertionRow(1).contains(byId(path.getAttribute('aria-describedby'))));

  // Fixed, it saves, and the mark goes.
  typeInto(path, '$.total');
  assert.equal(path.getAttribute('aria-invalid'), null);
  byId('save-request').click();
  assert.equal(byId('editor-note').textContent, 'Saved "Bad" to My Workspace.');
  assert.equal(workspace.find('ws-b').assertions[1].path, '$.total');
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ + and Add all

test('+ refuses a workspace request the server would refuse, says so once, and adds nothing', () => {
  boot({ saved: [bad('ws-b'), good('ws-g')] });
  runner.add(good('ws-g'));
  const writes = localStorage.peek(SETUP);
  runner.add(workspace.find('ws-b'));
  assert.equal(get().sequence.length, 1);
  assert.equal(byId('sequence-note').textContent, Refused('Bad'));
  assert.equal(byId('add-note').textContent, Refused('Bad'));
  assert.equal(byId('tab-runner').textContent, 'Runner (1)');
  assert.equal(localStorage.peek(SETUP), writes, 'nothing was stored');
  const marks = [...byId('workspace-tree').querySelectorAll('.in-run')];
  assert.equal(marks.length, 1, 'only the queued request wears the mark');
  assert.deepEqual(listenerErrors, []);
});

test('Add all refuses a collection holding one request the server would refuse, names it, and adds none of it', () => {
  boot();
  runner.add(good('r0', 0));
  runner.addAll({ id: 'c1', name: 'Mixed', requests: [good('r1', 1), bad('r2', 'Broken'), good('r3', 3)] });
  assert.equal(get().sequence.length, 1);
  assert.equal(byId('sequence-note').textContent, Refused('Broken'));
  assert.equal(byId('add-note').textContent, Refused('Broken'));
  assert.equal(byId('tab-runner').textContent, 'Runner (1)');

  // A saved collection is held to the same rule.
  localStorage.setItem('courier.collections.v1', JSON.stringify({ version: 1, collections: [{ id: 'wc-1', name: 'Saved', requests: [good('r4', 4), bad('r5', 'Stored bad')] }] }));
  runner.savedCollections.init();
  runner.addAll(get().savedCollections[0]);
  assert.equal(get().sequence.length, 1);
  assert.equal(byId('sequence-note').textContent, Refused('Stored bad'));

  // A valid one still goes in, and the refusal goes away.
  runner.addAll({ id: 'c2', name: 'Fine', requests: [good('r6', 6)] });
  assert.equal(get().sequence.length, 2);
  assert.equal(byId('sequence-note').textContent, '');
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ Edit a queued request

const setupOf = (requests) => ({ version: 1, mode: 'functional', options: {}, sequence: requests.map((request) => ({ enabled: true, request })) });

test('a queued row\'s Edit opens that queued request in the editor', () => {
  boot({ saved: [good('ws-b')], setup: setupOf([good('ws-0', 0), bad('ws-b')]) });
  const key = get().sequence[1].key;
  editOf(1).click();
  assert.deepEqual(opened, [key]);
  assert.equal(get().activeTab, 'editor');
  assert.equal(get().draft.id, 'ws-b');
  assert.deepEqual(get().draft.assertions, bad('ws-b').assertions, 'the queued copy is what opens, not the saved one');
  assert.equal(editOf(1).getAttribute('aria-label'), 'Edit Bad');
});

test('saving the fix updates the saved request and that queued entry in place, and the next Start sends it', async () => {
  boot({ saved: [bad('ws-b')], setup: setupOf([good('ws-0', 0), bad('ws-b'), good('ws-2', 2)]) });
  const keys = get().sequence.map((e) => e.key);
  editOf(1).click();
  const path = assertionRow(1).querySelector('.assert-path');
  typeInto(path, '$.total');
  // Not in the run until it is saved.
  assert.equal(get().sequence[1].request.assertions[1].path, '');
  byId('save-request').click();
  assert.deepEqual(get().sequence.map((e) => e.key), keys, 'same keys, same positions');
  assert.equal(get().sequence[1].request.assertions[1].path, '$.total');
  assert.equal(workspace.find('ws-b').assertions[1].path, '$.total');
  assert.match(byId('editor-note').textContent, /^Saved "Bad" to My Workspace and to request 2 in the run\.$/);
  assert.equal(JSON.parse(localStorage.peek(SETUP)).sequence[1].request.assertions[1].path, '$.total', 'the run setup kept it');

  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-1' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  const body = fetchStub.calls.find((c) => c.url === '/api/runs').json();
  assert.equal(body.sequence[1].assertions[1].path, '$.total');
  assert.deepEqual(listenerErrors, []);
});

test('a refused queued request fixed through Edit loses its mark', async () => {
  boot({ saved: [good('ws-b')], setup: setupOf([good('ws-0', 0), good('ws-b')]) });
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'a status assertion needs a whole number from 100 to 599, got 200', field: 'sequence[1].assertions[0]' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  assert.equal(rows()[1].classList.contains('is-invalid'), true);
  editOf(1).click();
  const value = assertionRow(0).querySelector('.assert-value');
  assert.equal(value.getAttribute('aria-invalid'), 'true', 'the opened entry carries the run\'s mark');
  typeInto(value, '201');
  byId('save-request').click();
  assert.equal(rows()[1].classList.contains('is-invalid'), false);
  assert.doesNotMatch(byId('start-note').textContent, /Refused/);
  assert.equal(byId('assertion-rows').querySelectorAll('[aria-invalid="true"]').length, 0);
});

test('Edit on a queued curated request forks it into My Workspace and points that entry at the fork', () => {
  boot({ setup: setupOf([bad('cur-1', 'Curated'), bad('cur-1', 'Curated')]) });
  const keys = get().sequence.map((e) => e.key);
  editOf(1).click();
  const fork = get().draft;
  assert.ok(fork.id.startsWith('ws-'), 'the editor holds a workspace copy');
  assert.equal(workspace.find(fork.id) !== null, true, 'the fork is saved');
  assert.deepEqual(get().sequence.map((e) => e.key), keys);
  assert.equal(get().sequence[1].request.id, fork.id, 'the entry points at the fork');
  assert.equal(get().sequence[0].request.id, 'cur-1', 'the other copy is left alone');

  typeInto(assertionRow(1).querySelector('.assert-path'), '$.x');
  byId('save-request').click();
  assert.equal(get().sequence[1].request.assertions[1].path, '$.x');
  assert.equal(get().sequence[0].request.assertions[1].path, '');

  // The other copy forks to a second workspace request of its own.
  editOf(0).click();
  assert.notEqual(get().draft.id, fork.id);
  assert.equal(get().sequence[0].request.id, get().draft.id);
  assert.deepEqual(listenerErrors, []);
});

test('Edit on a queued request whose saved original was deleted forks the queued copy rather than opening something gone', () => {
  boot({ saved: [good('ws-b')], setup: setupOf([bad('ws-b')]) });
  workspace.remove('ws-b');
  editOf(0).click();
  const draft = get().draft;
  assert.ok(draft && draft.id !== 'ws-b' && draft.id.startsWith('ws-'));
  assert.equal(get().sequence[0].request.id, draft.id);
  typeInto(assertionRow(1).querySelector('.assert-path'), '$.y');
  byId('save-request').click();
  assert.equal(get().sequence[0].request.assertions[1].path, '$.y');
  assert.equal(get().draft !== null, true, 'the editor stayed open');
});

test('opening another request ends the link: its Save does not touch the queued entry', () => {
  boot({ saved: [bad('ws-b'), good('ws-g')], setup: setupOf([bad('ws-b')]) });
  editOf(0).click();
  sidebar.selectRequest(workspace.find('ws-g'));
  editor.onSelect();
  sidebar.selectRequest(workspace.find('ws-b'));
  typeInto(assertionRow(1).querySelector('.assert-path'), '$.z');
  byId('save-request').click();
  assert.equal(byId('editor-note').textContent, 'Saved "Bad" to My Workspace.');
  assert.equal(get().sequence[0].request.assertions[1].path, '', 'the queued copy is unchanged');
});

// ------------------------------------------------------------------ requests stored by an older build

test('a saved request of a shape the editor never writes opens as text, sends only its known fields, and is refused by field', async () => {
  // As deep as this browser can still copy: the page copies a request it opens.
  const deep = JSON.parse(`${'['.repeat(3000)}"x"${']'.repeat(3000)}`);
  const odd = {
    id: 'ws-odd', name: { not: 'text' }, endpoint: 'search', extra: { deep },
    params: { q: 7, page: { a: [1] } },
    assertions: [{ type: 'json', path: '$.a', op: 'eq', value: deep }, { type: 'status', op: 'eq', value: 200, junk: deep }],
  };
  boot({ saved: [odd] });
  assert.doesNotThrow(() => sidebar.selectRequest(workspace.find('ws-odd')));
  assert.equal(byId('editor-form').hidden, false);
  assert.equal(byId('editor-name').value, '');
  assert.equal(assertionRow(0).querySelector('.assert-value').value, '');
  assert.deepEqual([...byId('param-rows').querySelectorAll('.param-value')].map((i) => i.value), ['7', '']);

  fetchStub.respond('/api/send', { status: 200, body: { status: 200, assertions: [] } }, { method: 'POST' });
  byId('send-request').click();
  await flush();
  assert.equal(fetchStub.calls.filter((c) => c.url === '/api/send').length, 0, 'nothing was sent');
  assert.equal(byId('send-status').textContent, 'Refused - Assertion 1: eq needs a number or a string value');
  assert.deepEqual(listenerErrors, []);
});
