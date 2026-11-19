// A queued row's Edit on a request that is still the same as its saved
// original opens the saved request itself. The run's copy may have been cut
// by the stored form (a name to 120 characters, a parameter value to 500)
// while the saved request was not, and keystrokes are stored as they are
// typed: opening the cut copy would write it over the saved request on the
// first keystroke, without a word.

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


const LONG = `${'N'.repeat(120)} (copy)`;

test('after a reload, Edit and one keystroke keep a saved 127-character name whole', () => {
  const saved = { ...req('ws-n', 1), name: LONG };
  boot({ saved: [saved], setup: setupOf([saved]) });
  reload();
  assert.equal(get().sequence[0].request.name.length, 120, 'the run setup was expected to keep the stored form');
  editOf(0).click();
  assert.equal(get().draft.id, 'ws-n');
  typeInto(pathInput(1), '$.totals');

  assert.equal(workspace.find('ws-n').name, LONG, 'My Workspace lost the end of the name');
  assert.equal(storedById('ws-n').name, LONG, 'localStorage lost the end of the name');
  assert.equal(storedById('ws-n').assertions[1].path, '$.totals', 'the keystroke missed the saved request');
  assert.equal(stored().length, 1, 'a copy was made');
  assert.equal(get().workspace.length, 1);
  assert.equal(byId('editor-name').value, LONG, 'the editor shows the cut name');
  assert.doesNotMatch(note(), /Copied/);
  assert.deepEqual(listenerErrors, []);
});

test('after a reload, Edit and one keystroke keep a saved 600-character parameter value whole', () => {
  const saved = { ...req('ws-v', 2), params: { q: 'v'.repeat(600) } };
  boot({ saved: [saved], setup: setupOf([saved]) });
  reload();
  editOf(0).click();
  assert.equal(get().draft.id, 'ws-v');
  typeInto(pathInput(1), '$.totals');

  assert.equal(workspace.find('ws-v').params.q.length, 600, 'My Workspace cut the value');
  assert.equal(storedById('ws-v').params.q.length, 600, 'localStorage cut the value');
  assert.equal(storedById('ws-v').assertions[1].path, '$.totals');
  assert.equal(stored().length, 1, 'a copy was made');
  assert.doesNotMatch(note(), /Copied/);
  assert.deepEqual(listenerErrors, []);
});

test('two tabs: a name tail shortened in the other tab survives Edit and the next keystroke here', () => {
  const saved = { ...req('ws-n', 1), name: LONG };
  boot({ saved: [saved], setup: setupOf([saved]) });
  const elsewhere = { ...saved, name: `${'N'.repeat(120)} (cop)` };
  otherTabWrites([elsewhere]);
  assert.equal(workspace.find('ws-n').name, elsewhere.name, 'the other tab write was expected to arrive');
  editOf(0).click();
  assert.equal(get().draft.id, 'ws-n');
  typeInto(pathInput(1), '$.totals');

  assert.equal(storedById('ws-n').name, elsewhere.name, 'the name the other tab stored was overwritten');
  assert.equal(storedById('ws-n').assertions[1].path, '$.totals');
  assert.equal(stored().length, 1, 'a copy was made');
  assert.equal(byId('editor-name').value, elsewhere.name, 'the editor shows the queued name, not the saved one');
  assert.deepEqual(listenerErrors, []);
});

test('Save through Edit on a saved long name updates the same row, Start sends it, and the next reload-and-Edit makes no copy', async () => {
  const saved = { ...req('ws-n', 1), name: LONG };
  boot({ saved: [saved, req('ws-b', 2)], setup: setupOf([req('ws-b', 2), saved]) });
  reload();
  const keys = get().sequence.map((e) => e.key);
  editOf(1).click();
  typeInto(pathInput(1), '$.totals');
  byId('save-request').click();
  assert.match(note(), /^Saved /);
  assert.deepEqual(get().sequence.map((e) => e.key), keys, 'same keys, same positions');
  assert.equal(get().sequence[1].request.id, 'ws-n');
  assert.equal(get().sequence[1].request.assertions[1].path, '$.totals', 'Save missed the row');
  assert.equal(get().sequence[1].request.name, LONG, 'the row holds the saved name');
  assert.equal(storedById('ws-n').name, LONG);

  fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-1' } }, { method: 'POST' });
  byId('start-run').click();
  await flush();
  const body = fetchStub.calls.find((c) => c.url === '/api/runs').json();
  assert.equal(body.sequence[1].id, 'ws-n');
  assert.equal(body.sequence[1].assertions[1].path, '$.totals');
  assert.equal(body.sequence[1].name, LONG, 'the run sent another name');
  assert.equal(JSON.parse(localStorage.peek(SETUP)).sequence[1].request.name, LONG, 'the run setup stored another name');

  // Read back, the run setup cuts the name again; that alone is no reason to copy.
  reload();
  assert.equal(get().sequence[1].request.name, 'N'.repeat(120));
  editOf(1).click();
  assert.equal(get().draft.id, 'ws-n', 'the second cycle opened a copy');
  typeInto(pathInput(1), '$.totalsx');
  assert.equal(stored().length, 2, 'the second cycle made a copy');
  assert.equal(storedById('ws-n').name, LONG, 'the second cycle cut the saved name');
  assert.equal(storedById('ws-n').assertions[1].path, '$.totalsx');
  assert.doesNotMatch(note(), /Copied/);
  assert.equal(get().sequence[1].request.id, 'ws-n', 'the run was re-pointed');
  assert.deepEqual(listenerErrors, []);
});

test('a saved request that cannot be copied leaves the editor closed with a warning and throws nothing', () => {
  boot({ saved: [req('ws-a', 1)], setup: setupOf([req('ws-a', 1)]) });
  set({ workspace: get().workspace.map((r) => (r.id === 'ws-a' ? { ...r, extra: 1n } : r)) });
  const warned = console.warn.mock.calls.length;
  editOf(0).click();
  assert.equal(get().draft, null, 'the editor opened');
  assert.ok(console.warn.mock.calls.length > warned, 'no warning');
  assert.equal(get().sequence[0].request.id, 'ws-a', 'the run was re-pointed');
  assert.equal(stored().length, 1, 'a copy was made');
  assert.deepEqual(listenerErrors, []);
});
