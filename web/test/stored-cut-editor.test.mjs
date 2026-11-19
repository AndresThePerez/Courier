// A saved request holding a parameter value over the server's limits (more
// than 32 words, or more than 256 characters), queued and reloaded: the run
// setup keeps it cut as the server cuts, the saved request keeps it as
// written. Opening the queued row is opening the saved request, with no copy;
// opening and saving it without typing never shortens it; what Send and
// Start put on the wire is what the server would cut to the same value.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import { cutParamValue } from '../js/storage.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];

const FortyWords = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
const ThirtyTwoWords = Array.from({ length: 32 }, (_, i) => `w${i}`).join(' ');
const LongWord = 'x'.repeat(300);

const long = (q) => ({
  id: 'ws-long', name: 'Long', endpoint: 'search', params: { q },
  assertions: [{ type: 'status', op: 'eq', value: 200 }],
});
const setupOf = (requests) => ({
  version: 1, mode: 'functional', options: {}, sequence: requests.map((request) => ({ enabled: true, request })),
});

let unsubscribe = null;

function boot({ setup, saved } = {}) {
  if (setup) localStorage.setItem(SETUP, typeof setup === 'string' ? setup : JSON.stringify(setup));
  if (saved) localStorage.setItem(WORKSPACE, typeof saved === 'string' ? saved : JSON.stringify({ version: 1, requests: saved }));
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  runner.init({ refresh: async () => {}, edit: (key) => editor.editQueued(key, (name) => set({ activeTab: name })) });
  sidebar.init({
    select: (request) => { editor.onSelect(); sidebar.selectRequest(request); },
    add: (request) => runner.add(request),
    addAll: (collection) => runner.addAll(collection),
  });
  unsubscribe = subscribe((state) => { sidebar.render(state); editor.render(state); runner.render(state); });
  set({ endpoints });
}

// reload is a fresh page over what this browser stored.
function reload(t) {
  const setup = localStorage.peek(SETUP);
  const saved = localStorage.peek(WORKSPACE);
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
  resetBrowser();
  resetState();
  t.mock.method(console, 'warn', () => {});
  boot({ setup, saved });
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
const stored = () => JSON.parse(localStorage.peek(WORKSPACE)).requests;
const valueBox = () => byId('param-rows').querySelector('.param-value');

for (const [what, value, cut] of [
  ['40 words', FortyWords, ThirtyTwoWords],
  ['300 characters', LongWord, 'x'.repeat(256)],
]) {
  test(`a saved request holding ${what}, queued and reloaded, opens from its row with no copy and is never shortened by opening and saving it`, async (t) => {
    boot({ saved: [long(value)], setup: setupOf([long(value)]) });
    reload(t);
    assert.ok(get().sequence[0].request.params.q === cut, 'the run setup was not cut as the server cuts');
    assert.ok(stored()[0].params.q === value, 'the saved request was cut on reload');

    editOf(0).click();
    assert.equal(get().draft && get().draft.id, 'ws-long', 'the queued row opened a copy');
    assert.equal(stored().length, 1, 'a copy was made');
    assert.ok(valueBox().value === value, 'the editor shows the cut value, not the saved one');

    byId('save-request').click();
    assert.equal(stored().length, 1);
    assert.ok(stored()[0].params.q === value, 'opening and saving shortened the saved request');

    // A keystroke elsewhere in the request writes it whole, too.
    typeInto(byId('editor-name'), 'Long 2');
    assert.ok(stored()[0].params.q === value, 'a keystroke in another field shortened the saved value');
    byId('save-request').click();

    // What goes on the wire is cut by the server to what the run setup holds.
    fetchStub.respond('/api/send', { status: 200, body: { status: 200, passed: true, endpoint: 'search', query: '?q=x', latency_ms: 1, size_bytes: 2, body: '{}', assertions: [], truncated: ['params.q'] } }, { method: 'POST' });
    byId('send-request').click();
    await flush();
    const sentQ = fetchStub.calls.filter((c) => c.url === '/api/send').at(-1).json().params.q;
    assert.ok(cutParamValue(sentQ) === cut, 'Send carried a value the server would cut differently');
    fetchStub.respond('/api/runs', { status: 202, body: { run_id: 'run-long', truncated: ['sequence[0].params.q'] } }, { method: 'POST' });
    byId('start-run').click();
    await flush();
    const ranQ = fetchStub.calls.filter((c) => c.url === '/api/runs' && c.method === 'POST').at(-1).json().sequence[0].params.q;
    assert.ok(cutParamValue(ranQ) === cut, 'Start carried a value the server would cut differently');

    // And again after another reload: still one request, still whole.
    set({ status: { running: false } });
    reload(t);
    editOf(0).click();
    assert.equal(get().draft && get().draft.id, 'ws-long', 'the second reload made the row a copy');
    assert.equal(stored().length, 1);
    assert.ok(stored()[0].params.q === value);
    assert.ok(valueBox().value === value);
    assert.deepEqual(listenerErrors, []);
  });
}

test('a queued copy that differs from its saved request only by the word cut is the same request; one that differs past it is not', (t) => {
  const otherTail = `${ThirtyTwoWords} different words after the cut`;
  boot({ saved: [long(otherTail)], setup: setupOf([long(FortyWords)]) });
  reload(t);
  editOf(0).click();
  assert.equal(get().draft.id, 'ws-long', 'words past the 32nd made the two different requests');
  assert.equal(stored().length, 1);

  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
  resetBrowser();
  resetState();
  t.mock.method(console, 'warn', () => {});
  boot({ saved: [long(`${ThirtyTwoWords.replace('w31', 'w31x')} tail`)], setup: setupOf([long(FortyWords)]) });
  reload(t);
  editOf(0).click();
  assert.notEqual(get().draft.id, 'ws-long', 'a request that differs inside the cut was taken for the same one');
  assert.equal(stored().length, 2);
  assert.deepEqual(listenerErrors, []);
});
