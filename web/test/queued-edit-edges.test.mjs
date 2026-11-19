// Save, +, Add all and a queued row's Edit at their edges: a saved request
// changed since it was queued, a second tab, a full or disabled
// localStorage, a request deleted while open or queued, duplicates, reorders,
// and the refused-field marks and run settings around them.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resetBrowser, localStorage, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe, renderAll } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page', 'id', 'set', 'type', 'rarity', 'sort', 'order', 'size', 'from', 'prefix', 'n'] }];

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
  runner.init({ edit: (key) => { editor.openQueued(key); set({ activeTab: 'editor' }); } });
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
const removeOf = (i) => [...rows()[i].querySelectorAll('button')].find((b) => /^Remove/.test(b.title || '') || b.textContent === 'x');
const assertionRow = (j) => byId('assertion-rows').querySelectorAll('.assert-row')[j];
const marked = () => rows().map((r, i) => (r.classList.contains('is-invalid') ? i + 1 : 0)).filter(Boolean);
const storedWorkspace = (id) => JSON.parse(localStorage.peek(WORKSPACE)).requests.find((r) => r.id === id) || null;

async function refuse(field, error) {
  fetchStub.respond('/api/runs', { status: 400, body: { error, field } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
}

// ------------------------------------------------------------------ the visitor's saved data

test('Edit on a row queued before its saved request was changed does not silently throw the newer saved version away', () => {
  // Queued as it was; then improved in My Workspace (this tab or another).
  const old = req('ws-a', 1);
  const newer = { ...req('ws-a', 1), name: 'Improved', assertions: [{ type: 'json', path: '$.results[0].name', op: 'contains', value: 'Pikachu' }] };
  boot({ saved: [newer], setup: setupOf([old]) });
  editOf(0).click();
  // One keystroke in the opened draft.
  typeInto(byId('editor-name'), 'Req 1!');
  const kept = storedWorkspace('ws-a');
  const lost = kept.name !== 'Improved' && JSON.stringify(kept.assertions) !== JSON.stringify(newer.assertions);
  const said = byId('editor-note').hidden ? '' : byId('editor-note').textContent;
  assert.ok(!lost || said !== '', `the saved request was overwritten by the older queued copy without a word: ${JSON.stringify(kept)}`);
});

test('Edit on a queued row after another tab changed its saved request does not silently write the older queued copy over it', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1)]) });
  const newer = { ...req('ws-a', 1), name: 'Changed elsewhere', assertions: [{ type: 'json', path: '$.total', op: 'gt', value: 100 }] };
  localStorage.writeFromAnotherTab(WORKSPACE, JSON.stringify({ version: 1, requests: [newer] }));
  assert.equal(workspace.find('ws-a').name, 'Changed elsewhere');
  editOf(0).click();
  typeInto(assertionRow(0).querySelector('.assert-value'), '201');
  const kept = storedWorkspace('ws-a');
  const lost = kept.name !== 'Changed elsewhere';
  const said = byId('editor-note').hidden ? '' : byId('editor-note').textContent;
  assert.ok(!lost || said !== '', `the other tab's change was overwritten without a word: ${JSON.stringify(kept)}`);
});

test('Save of a fix through Edit with storage full: the note and what the run holds agree, and nothing is claimed saved', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-0', 0), { ...req('ws-a', 1), assertions: [{ type: 'json', path: '', op: 'exists' }] }]) });
  const keys = get().sequence.map((e) => e.key);
  editOf(1).click();
  typeInto(assertionRow(0).querySelector('.assert-path'), '$.ok');
  localStorage.failOn('setItem');
  byId('save-request').click();
  const note = byId('editor-note').textContent;
  assert.doesNotMatch(note, /^Saved/, 'a refused write is never reported as saved');
  assert.equal(note, workspace.WRITE_REFUSED);
  assert.deepEqual(get().sequence.map((e) => e.key), keys, 'no entry added, lost or moved');
  assert.equal(get().sequence[0].request.id, 'ws-0', 'no other entry changed');
  localStorage.heal();
  // Nothing reached storage under a false claim.
  const setup = JSON.parse(localStorage.peek(SETUP));
  assert.equal(setup.sequence.length, 2);
  assert.deepEqual(listenerErrors, []);
});

test('with storage disabled entirely, Edit, Save and Start still work on this page and never throw', async () => {
  boot({ setup: setupOf([{ ...req('cur-1', 1), assertions: [{ type: 'json', path: '', op: 'exists' }] }]) });
  for (const m of ['setItem', 'getItem', 'removeItem']) localStorage.failOn(m);
  editOf(0).click();
  assert.ok(get().draft && get().draft.id.startsWith('ws-'), 'the curated row forks even when the write is refused');
  assert.equal(get().sequence[0].request.id, get().draft.id);
  typeInto(assertionRow(0).querySelector('.assert-path'), '$.x');
  byId('save-request').click();
  assert.equal(get().sequence[0].request.assertions[0].path, '$.x');
  // A second Edit of the same row opens the same copy, not a second fork.
  const id = get().draft.id;
  editOf(0).click();
  assert.equal(get().draft.id, id, 'one fork per entry');
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-1' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  const body = fetchStub.calls.find((c) => c.url === '/api/runs').json();
  assert.equal(body.sequence[0].assertions[0].path, '$.x');
  assert.deepEqual(listenerErrors, []);
});

test('Edit, then another tab deletes the saved original: the editor closes, the queued entry is untouched, and a later Edit forks', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1)]) });
  const key = get().sequence[0].key;
  editOf(0).click();
  assert.equal(get().draft.id, 'ws-a');
  localStorage.writeFromAnotherTab(WORKSPACE, JSON.stringify({ version: 1, requests: [] }));
  assert.equal(get().draft, null);
  assert.equal(get().sequence[0].key, key);
  assert.equal(get().sequence[0].request.id, 'ws-a');
  editOf(0).click();
  assert.notEqual(get().draft.id, 'ws-a');
  assert.equal(get().sequence[0].request.id, get().draft.id);
  assert.deepEqual(listenerErrors, []);
});

test('Edit, reorder, then Save names the row where the entry is now; Edit, remove the row, then Save touches no entry', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-0', 0), req('ws-a', 1), req('ws-2', 2)]) });
  editOf(1).click();
  const up = [...rows()[1].querySelectorAll('button')].find((b) => /up$/.test(b.title || b.getAttribute('aria-label') || ''));
  up.click();
  typeInto(byId('editor-name'), 'Moved');
  byId('save-request').click();
  assert.equal(byId('editor-note').textContent, 'Saved "Moved" to My Workspace and to request 1 in the run.');
  assert.equal(get().sequence[0].request.name, 'Moved');

  editOf(0).click();
  const before = get().sequence.map((e) => JSON.stringify(e));
  const removed = before.shift();
  removeOf(0).click();
  assert.ok(!get().sequence.some((e) => JSON.stringify(e) === removed));
  typeInto(byId('editor-name'), 'After removal');
  byId('save-request').click();
  assert.equal(byId('editor-note').textContent, 'Saved "After removal" to My Workspace.');
  assert.deepEqual(get().sequence.map((e) => JSON.stringify(e)), before, 'no other entry changed');
  assert.deepEqual(listenerErrors, []);
});

test('a request queued three times: only the refused copy is marked, and the mark follows it when a copy above is removed', async () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1), req('ws-0', 0), req('ws-a', 1), req('ws-a', 1)], (i) => i !== 1) });
  // Payload: [a, a, a]; index 1 is visible row 3.
  await refuse('sequence[1].assertions[1]', 'gt needs a numeric value, got a string');
  assert.deepEqual(marked(), [3]);
  assert.equal(byId('start-note').textContent, 'Refused - Request 3, assertion 2: gt needs a numeric value, got a string');
  removeOf(0).click();
  assert.deepEqual(marked(), [2]);
  assert.equal(byId('start-note').textContent, 'Refused - Request 2, assertion 2: gt needs a numeric value, got a string');
  // Unchecking the refused row keeps the mark and its number.
  rows()[1].querySelector('.seq-check').click();
  assert.deepEqual(marked(), [2]);
  // The refused copy opened through Edit carries the control mark.
  editOf(1).click();
  const marks = byId('assertion-rows').querySelectorAll('[aria-invalid="true"]');
  assert.equal(marks.length, 1);
  assert.ok(marks[0] === assertionRow(1).querySelector('.assert-value'), 'the refused control');
  assert.ok(byId(marks[0].getAttribute('aria-describedby')) !== null);
  assert.deepEqual(listenerErrors, []);
});

test('hostile refused fields never throw, mark at most one row, and every aria-describedby points at an element', async () => {
  boot({ setup: setupOf([1, 2, 3, 4, 5, 6, 7].map((n) => req(`ws-${n}`, n)), (i) => i % 2 === 0) });
  const fields = ['sequence[0].params.q', 'sequence[1].endpoint', 'options.concurrency', 'mode', 'body', 'sequence[2',
    'sequence[-1]', 'sequence[1e9]', 'sequence[2].assertions[99]', '__proto__', 'x'.repeat(10000), 'sequence[3].assertions[0]',
    'sequence[0].assertions[1].value', undefined, null, 42, ''];
  const ok = new Set();
  for (const field of fields) {
    await refuse(field, '<img src=x onerror=alert(1)> refused');
    const text = byId('start-note').textContent;
    assert.ok(text.startsWith('Refused - '), `${String(field).slice(0, 30)} -> ${text.slice(0, 80)}`);
    assert.equal(byId('start-note').querySelectorAll('*').length, 0, 'the message is text');
    assert.ok(marked().length <= 1, String(field).slice(0, 30));
    for (const node of document.querySelectorAll('[aria-describedby]')) {
      for (const id of node.getAttribute('aria-describedby').split(' ').filter(Boolean)) {
        assert.ok(byId(id) !== null, `aria-describedby="${id}" names nothing (${String(field).slice(0, 30)})`);
      }
    }
    if (marked().length) ok.add(String(field));
  }
  assert.ok(ok.has('sequence[0].params.q') && ok.has('sequence[3].assertions[0]'));
  assert.ok(!ok.has('sequence[1e9]') && !ok.has('sequence[-1]') && !ok.has('mode'));
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ one builder

test('Send and Start put the same request on the wire after real typing, with an unchecked sibling queued', async () => {
  boot({ saved: [req('ws-a', 1, { assertions: [] })] });
  sidebar.selectRequest(workspace.find('ws-a'));
  byId('add-param').click();
  byId('add-assertion').click();
  byId('add-assertion').click();
  byId('add-assertion').click();
  const sel = (j, cls) => assertionRow(j).querySelector(cls);
  sel(1, '.assert-type').value = 'json';
  sel(1, '.assert-type').dispatchEvent(new Event('change', { bubbles: true }));
  typeInto(sel(1, '.assert-path'), ' $.a ');
  typeInto(sel(1, '.assert-path'), '$.a b');
  typeInto(sel(1, '.assert-value'), ' 1e2 ');
  sel(2, '.assert-type').value = 'latency';
  sel(2, '.assert-type').dispatchEvent(new Event('change', { bubbles: true }));
  typeInto(sel(2, '.assert-value'), '0.001');
  typeInto(byId('param-rows').querySelectorAll('.param-value')[1], '');

  fetchStub.respond('/api/send', { status: 200, body: { status: 200, passed: true, endpoint: 'search', query: '', latency_ms: 1, size_bytes: 0, body: '', assertions: [] } }, { method: 'POST' });
  byId('send-request').click();
  await flush();
  const sent = JSON.parse(fetchStub.calls.find((c) => c.url === '/api/send').body);

  runner.add(req('ws-other', 9));
  runner.add(workspace.find('ws-a'));
  rows()[0].querySelector('.seq-check').click();
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-1' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  const run = fetchStub.calls.find((c) => c.url === '/api/runs').json();
  assert.equal(run.sequence.length, 1);
  assert.deepEqual(run.sequence[0], sent);
  assert.equal(sent.assertions[1].path, '$.a b', 'the path is sent as typed');
  for (const k of ['delay_ms', 'concurrency', 'duration_secs']) assert.ok(Number.isInteger(run.options[k]), k);
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ run settings

test('typing 1, 0, 0 into concurrency with focus kept: the field reads what was typed, the run uses the cap, and the note says so', async () => {
  boot({ setup: setupOf([req('ws-a', 1)]) });
  const input = byId('concurrency');
  input.focus();
  let text = '';
  for (const ch of '100') {
    text += ch;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    set({ status: { running: false, budget_balance: 1000 } });
    assert.equal(input.value, text, 'the field is not rewritten while typing');
  }
  assert.equal(get().options.concurrency, 50);
  assert.equal(byId('concurrency-note').textContent, '100 is over the cap of 50 - the run will use 50.');
  assert.equal(JSON.parse(localStorage.peek(SETUP)).options.concurrency, 50);
  set({ mode: 'performance' });
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-1' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  const call = fetchStub.calls.find((c) => c.url === '/api/runs');
  assert.ok(call, 'the run started');
  assert.equal(call.json().options.concurrency, 50);
  assert.deepEqual(listenerErrors, []);
});

test('a stored setup with out-of-cap or fractional options restores to whole numbers inside the caps, and Start sends them', async () => {
  boot({ setup: { ...setupOf([req('ws-a', 1)]), options: { concurrency: 2.5, delay_ms: 1e9, duration_secs: '7.9', stop_on_failure: 'yes' } } });
  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-1' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  const { options } = fetchStub.calls.find((c) => c.url === '/api/runs').json();
  assert.deepEqual(options, { stop_on_failure: false, delay_ms: 1000, concurrency: 2, duration_secs: 7 });
  for (const id of ['delay-ms-note', 'concurrency-note', 'duration-secs-note']) assert.equal(byId(id).hidden, true, `${id} announces nothing at boot`);
});

// ------------------------------------------------------------------ curated collections

const DATA = new URL('../../internal/collections/data/', import.meta.url);
const curated = readdirSync(DATA).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8')));

test('every curated collection can be added whole, and every knee preset queues the five search requests', () => {
  boot();
  set({ collections: curated });
  for (const c of curated) {
    runner.addAll(c);
    assert.doesNotMatch(byId('sequence-note').textContent, /invalid assertion/, c.id);
    set({ sequence: [] });
  }
  for (const c of curated) for (const r of c.requests) {
    runner.add(r);
    assert.doesNotMatch(byId('sequence-note').textContent, /invalid assertion/, r.id);
    set({ sequence: [] });
  }
  for (const button of byId('knee-buttons').querySelectorAll('button')) {
    button.click();
    assert.equal(get().sequence.length, curated.find((c) => c.id === 'search-basics').requests.length, button.textContent);
    assert.equal(get().sequence.length, 5);
  }
  assert.deepEqual(listenerErrors, []);
});

// ------------------------------------------------------------------ one pane's failure

test('a pane that throws on every render costs only that pane, and its error is logged once per render', (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const drawn = [];
  const panes = ['a', 'b', 'c', 'd'].map((name) => (state) => { drawn.push(`${name}:${state.n}`); });
  for (let broken = 0; broken < 4; broken += 1) {
    drawn.length = 0;
    errors.mock.resetCalls();
    const renders = panes.map((fn, i) => (i === broken ? () => { throw new Error('pane down'); } : fn));
    renderAll(renders, { n: 1 });
    renderAll(renders, { n: 2 });
    assert.equal(drawn.length, 6, `pane ${broken}: the other three drew twice`);
    assert.equal(errors.mock.callCount(), 2, 'one log per render');
  }
});
