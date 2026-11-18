// What a run sends and what a reload gives back, for requests built the way
// the page builds them, and the run panel's behaviour when a request cannot
// be shown or sent.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, fetchStub, flush, typeInto, listenerErrors } from './shim.mjs';
import { resetState, get, set } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';
import * as runner from '../js/render-runner.js';

const SETUP = 'courier.runner.v1';
const SAVED = 'courier.collections.v1';
const WORKSPACE = 'courier.workspace.v1';
const byId = (id) => document.getElementById(id);

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
  set({ endpoints: [{ id: 'search', label: 'Search', params: ['q', 'page'] }, { id: 'healthz', label: 'Health', params: [] }] });
  runner.init({});
  runner.savedCollections.init();
});

// ------------------------------------------------------------------ what the server's decoder accepts

const KEYS = {
  run: ['mode', 'options', 'sequence'],
  options: ['concurrency', 'delay_ms', 'duration_secs', 'stop_on_failure'],
  request: ['assertions', 'endpoint', 'id', 'name', 'params'],
};
const ASSERTION_KEYS = ['op', 'path', 'type', 'value'];

// checkBody holds one POST /api/runs body to the strict decoder: only these
// keys at each level, and option values that are integers inside the limits.
function checkBody(body, where) {
  assert.deepEqual(Object.keys(body).sort(), KEYS.run, `${where}: run keys`);
  assert.ok(['functional', 'performance'].includes(body.mode), where);
  assert.deepEqual(Object.keys(body.options).sort(), KEYS.options, `${where}: option keys`);
  assert.equal(typeof body.options.stop_on_failure, 'boolean', where);
  for (const [k, lo, hi] of [['delay_ms', 0, 1000], ['concurrency', 1, 50], ['duration_secs', 1, 30]]) {
    assert.ok(Number.isInteger(body.options[k]) && body.options[k] >= lo && body.options[k] <= hi, `${where}: ${k}=${body.options[k]}`);
  }
  assert.ok(body.sequence.length >= 1 && body.sequence.length <= 50, where);
  for (const r of body.sequence) {
    assert.deepEqual(Object.keys(r).sort(), KEYS.request, `${where}: request keys`);
    for (const k of ['id', 'name', 'endpoint']) assert.equal(typeof r[k], 'string', `${where}: ${k}`);
    for (const v of Object.values(r.params)) assert.equal(typeof v, 'string', `${where}: param`);
    for (const a of r.assertions) {
      for (const k of Object.keys(a)) assert.ok(ASSERTION_KEYS.includes(k), `${where}: assertion key ${k}`);
      assert.ok(Object.hasOwn(a, 'type') && Object.hasOwn(a, 'op'), where);
    }
  }
}

async function startAndRead() {
  const before = fetchStub.calls.filter((c) => c.url === '/api/runs').length;
  fetchStub.respond('/api/runs', { status: 400, body: { error: 'x', field: 'sequence' } }, { method: 'POST' });
  runner.render(get());
  byId('start-run').click();
  await flush();
  assert.deepEqual(listenerErrors, []);
  const calls = fetchStub.calls.filter((c) => c.url === '/api/runs');
  assert.equal(calls.length, before + 1);
  return calls[calls.length - 1].json();
}

// A request carrying everything a stored request could carry that the wire
// has no field for.
const loaded = (n) => ({
  id: `h${n}`,
  name: `Hostile ${n}`,
  endpoint: 'search',
  url: 'http://192.0.2.10/',
  method: 'DELETE',
  headers: { Authorization: 'Bearer 0000000000000000' },
  body: 'x',
  params: { q: 'pikachu', page: '2' },
  assertions: [
    { type: 'json', path: '$.total', op: 'gt', value: 1, url: 'http://192.0.2.10/a', host: '192.0.2.10', method: 'POST', headers: { A: 'b' } },
    { type: 'status', op: 'eq', value: 200, path: '$.not.allowed', extra: { deep: [[[]]] } },
  ],
});

test('a run started from a restored setup sends only the keys the server decodes, at every level', async () => {
  const raw = JSON.stringify({
    version: 1,
    sequence: [{ enabled: true, request: loaded(1), extra: 1 }, { enabled: false, request: loaded(2) }, { enabled: true, request: loaded(3) }],
    mode: 'performance',
    options: { stop_on_failure: true, delay_ms: '7', concurrency: 1e9, duration_secs: [3], extra: 1 },
    extra: 1,
  });
  localStorage.setItem(SETUP, raw);
  runner.restore();
  const body = await startAndRead();
  checkBody(body, 'restored');
  assert.equal(body.sequence.length, 2);
  assert.deepEqual(body.options, { stop_on_failure: true, delay_ms: 7, concurrency: 50, duration_secs: 10 });
  // A status assertion's stored path is not the page's to send either.
  assert.deepEqual(body.sequence[0].assertions, [{ type: 'json', path: '$.total', op: 'gt', value: 1 }, { type: 'status', op: 'eq', value: 200 }]);
});

test('Add all on a stored collection sends only the keys the server decodes, at every level', async () => {
  localStorage.setItem(SAVED, JSON.stringify({ version: 1, collections: [{ id: 'wc-1', name: 'Mine', requests: [loaded(1), loaded(2)], url: 'http://192.0.2.10/' }] }));
  runner.savedCollections.init();
  runner.addAll(get().savedCollections[0]);
  const body = await startAndRead();
  checkBody(body, 'collection');
  assert.equal(body.sequence.length, 2);
});

test('a request queued by hand from a saved request sends the five request keys and the four assertion fields, and Start is not wedged by it', async () => {
  runner.add(loaded(1));
  const body = await startAndRead();
  checkBody(body, 'hand-queued');
  assert.deepEqual(Object.keys(body.sequence[0].assertions[0]).sort(), ['op', 'path', 'type', 'value']);
  assert.equal(byId('start-run').textContent, 'Start run');
  assert.equal(byId('start-run').disabled, false);
});

// ------------------------------------------------------------------ built the way the page builds them

const paint = () => { sidebar.render(get()); editor.render(get()); runner.render(get()); };

function openWorkspaceRequest(id) {
  const stored = JSON.parse(localStorage.peek(WORKSPACE) || '{"version":1,"requests":[]}');
  stored.requests.push({ id, name: `Built ${id}`, endpoint: 'search', params: { q: 'pikachu' }, assertions: [] });
  localStorage.setItem(WORKSPACE, JSON.stringify(stored));
  workspace.init();
  editor.init();
  editor.onSelect();
  sidebar.selectRequest(workspace.find(id));
  paint();
}

const rows = () => [...byId('assertion-rows').querySelectorAll('.assert-row')];
function choose(select, value) {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  paint();
}

// addAssertion builds one assertion through the editor's own controls.
function addAssertion(type, op, path, text) {
  byId('add-assertion').click();
  paint();
  const n = rows().length - 1;
  choose(rows()[n].querySelector('.assert-type'), type);
  choose(rows()[n].querySelector('.assert-op'), op);
  if (type === 'json' && path !== null) typeInto(rows()[n].querySelector('.assert-path'), path);
  const input = rows()[n].querySelector('.assert-value');
  if (input && text !== null) typeInto(input, text);
  paint();
}

const PAIRS = [
  ['status', 'eq'], ['status', 'neq'], ['latency', 'lt'],
  ['json', 'eq'], ['json', 'neq'], ['json', 'gt'], ['json', 'lt'], ['json', 'exists'], ['json', 'contains'], ['json', 'count'],
  ['body_contains', 'contains'],
];
const TEXTS = ['200', 'abc', '', '3.5', '-1', '1e3', '0x10', ' 7 ', 'ünï ☃ \u{1F600}', 'q'.repeat(500)];
const PATHS = ['$', '', '$.results[0].name', `$.${'p'.repeat(498)}`];

test('a request built in the editor with every assertion type and operator reloads exactly as queued, and saving it again changes nothing', () => {
  const ids = [];
  TEXTS.forEach((text, i) => {
    const id = `ws-built-${i}`;
    ids.push(id);
    openWorkspaceRequest(id);
    PAIRS.forEach(([type, op], j) => addAssertion(type, op, PATHS[(i + j) % PATHS.length], text));
    assert.equal(get().draft.assertions.length, PAIRS.length);
    runner.add(workspace.find(id));
  });
  assert.deepEqual(listenerErrors, []);
  assert.equal(get().sequence.length, TEXTS.length);

  const queued = get().sequence.map((e) => JSON.parse(JSON.stringify(e.request)));
  const text1 = localStorage.peek(SETUP);
  const fresh = runner.createRunSetup(localStorage).load();
  assert.deepEqual(fresh.sequence.map((e) => e.request), queued);

  // Saving what was restored writes the same bytes: no drift on every reload.
  assert.equal(runner.createRunSetup(localStorage).save(fresh).ok, true);
  assert.equal(localStorage.peek(SETUP), text1);

  // The same through a saved collection.
  byId('save-sequence-name').value = 'Everything';
  byId('save-sequence').click();
  const saved1 = localStorage.peek(SAVED);
  runner.savedCollections.init();
  assert.deepEqual(get().savedCollections[0].requests, queued);
  const second = runner.savedCollections.save(get().savedCollections[0]);
  assert.equal(second.ok, true);
  assert.equal(localStorage.peek(SAVED), saved1);
});

test('a JSON path or assertion value the editor accepts at 600 characters is not changed by a reload without the page saying so', async () => {
  openWorkspaceRequest('ws-long');
  const long = 'L'.repeat(600);
  addAssertion('json', 'contains', `$.${long}`, long);
  addAssertion('body_contains', 'contains', null, long);
  const typed = JSON.parse(JSON.stringify(get().draft.assertions));
  assert.equal(typed[0].path.length, 602, 'the editor took the whole path');
  assert.equal(typed[1].value.length, 600, 'the editor took the whole value');

  // The server at this point accepts them: Send posts them whole.
  fetchStub.respond('/api/send', { status: 200, body: { status: 200, headers: {}, body: '', assertions: [] } }, { method: 'POST' });
  byId('send-request').click();
  await flush();
  const posted = fetchStub.calls.find((c) => c.url === '/api/send').json();
  assert.equal(posted.assertions[0].path.length, 602);
  assert.equal(posted.assertions[1].value.length, 600);

  runner.add(workspace.find('ws-long'));
  runner.render(get());
  const note = byId('sequence-note');
  const said = !note.hidden && note.textContent !== '';
  const restored = runner.createRunSetup(localStorage).load().sequence[0].request.assertions;
  assert.ok(said || JSON.stringify(restored) === JSON.stringify(typed), `reload changed what the page accepted: path ${restored[0] && restored[0].path.length}, value ${restored[1] && restored[1].value && restored[1].value.length}, dropped ${typed.length - restored.length}`);
});

// ------------------------------------------------------------------ fail-safes

function unshowable() {
  // A row whose name cannot be read, however it came to be in the page.
  const r = { id: 'bad', name: 'Bad', endpoint: 'search', params: {}, assertions: [] };
  Object.defineProperty(r, 'name', { enumerable: true, get() { throw new Error('unreadable'); } });
  return r;
}
const plain = (n) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [{ type: 'status', op: 'eq', value: 200 }] });

test('after the row that cannot be shown or sent is removed, Start sends the rest, and a reload holds only the rest', async () => {
  set({ sequence: [{ key: 'q1', enabled: true, request: plain(1) }, { key: 'q2', enabled: true, request: unshowable() }, { key: 'q3', enabled: true, request: plain(3) }] });
  runner.render(get());
  assert.equal(byId('sequence-list').querySelectorAll('.seq-row').length, 3);

  byId('start-run').click();
  await flush();
  assert.deepEqual(listenerErrors, []);
  assert.equal(fetchStub.calls.length, 0, 'nothing was sent');
  assert.equal(byId('start-run').textContent, 'Start run');
  assert.equal(byId('start-run').disabled, false);
  assert.match(byId('start-note').textContent, /^Could not start the run - /);

  const remove = [...byId('sequence-list').querySelectorAll('.seq-row')[1].querySelectorAll('button')].find((b) => b.title === 'Remove from the run');
  remove.click();
  runner.render(get());
  assert.equal(byId('sequence-list').querySelectorAll('.seq-row').length, 2);
  assert.equal(byId('sequence-note').hidden, true, 'removing it left no refused-write note');
  assert.deepEqual(runner.createRunSetup(localStorage).load().sequence.map((e) => e.request.id), ['r1', 'r3']);

  const body = await startAndRead();
  checkBody(body, 'after removal');
  assert.deepEqual(body.sequence.map((r) => r.id), ['r1', 'r3']);
});

test('a network failure while starting is reported as one, and Start comes back', async () => {
  runner.add(plain(1));
  runner.render(get());
  fetchStub.reject('/api/runs', new TypeError('Failed to fetch'), { method: 'POST' });
  byId('start-run').click();
  await flush();
  runner.render(get());
  assert.deepEqual(listenerErrors, []);
  assert.equal(byId('start-run').textContent, 'Start run');
  assert.equal(byId('start-run').disabled, false);
  assert.equal(byId('start-note').hidden, false);
  assert.doesNotMatch(byId('start-note').textContent, /queued request/, 'the request was fine; the network was not');
});

test('a request that cannot be sent does not block a later Start from sending once it is removed, even after a network failure first', async () => {
  runner.add(plain(1));
  runner.render(get());
  fetchStub.reject('/api/runs', new TypeError('Failed to fetch'), { method: 'POST' });
  byId('start-run').click();
  await flush();
  const body = await startAndRead();
  checkBody(body, 'second start');
  assert.equal(fetchStub.calls.length, 2);
});
