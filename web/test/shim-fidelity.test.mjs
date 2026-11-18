// Edge cases where a fake browser is most tempted to differ from a real one.
// Each test states the browser rule it holds the shim to: a frontend fix
// test-driven against a shim that bends one of these rules can pass here and
// break on the page.

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetBrowser, localStorage, fetchStub, eventSources, flush,
} from './shim.mjs';
import { get, set, subscribe, resetState } from '../js/store.js';

beforeEach(() => {
  resetBrowser();
  resetState();
});

// ---------------------------------------------------------------- storage

test('a write from this tab fires no storage event; a write from another tab reaches every listener', () => {
  const seen = [];
  window.addEventListener('storage', (e) => seen.push(['a', e.key, e.newValue, e.oldValue]));
  window.addEventListener('storage', (e) => seen.push(['b', e.key, e.newValue, e.oldValue]));

  localStorage.setItem('courier.workspace.v1', 'mine');
  localStorage.removeItem('courier.workspace.v1');
  localStorage.setItem('courier.workspace.v1', 'mine');
  assert.deepEqual(seen, [], 'a browser never fires storage in the tab that wrote');

  localStorage.writeFromAnotherTab('courier.workspace.v1', 'theirs');
  assert.deepEqual(seen, [
    ['a', 'courier.workspace.v1', 'theirs', 'mine'],
    ['b', 'courier.workspace.v1', 'theirs', 'mine'],
  ]);
  assert.equal(localStorage.getItem('courier.workspace.v1'), 'theirs');
});

test('a refused setItem leaves the value that was there before', () => {
  localStorage.setItem('k', 'old');
  localStorage.failOn('setItem');
  assert.throws(() => localStorage.setItem('k', 'new'), (err) => err.name === 'QuotaExceededError');
  localStorage.heal('setItem');
  assert.equal(localStorage.getItem('k'), 'old');
});

// ---------------------------------------------------------------- DOM

test('querySelectorAll is a static list in document order', () => {
  const host = document.getElementById('sequence-note').parentNode;
  const first = document.createElement('span');
  first.setAttribute('data-focus-key', 'a');
  const second = document.createElement('span');
  second.setAttribute('data-focus-key', 'b');
  host.appendChild(second);
  host.insertBefore(first, second);

  const list = document.querySelectorAll('[data-focus-key]');
  assert.deepEqual([...list].map((n) => n.dataset.focusKey), ['a', 'b']);

  const third = document.createElement('span');
  third.setAttribute('data-focus-key', 'c');
  host.appendChild(third);
  assert.equal(list.length, 2, 'a querySelectorAll result does not grow with the document');
});

test('querySelectorAll and children are DOM collections, not arrays', () => {
  // A NodeList has forEach and item but no map, filter or find; an
  // HTMLCollection has neither forEach nor map. Client code that calls an
  // array method on one throws on the page, so the fake must not offer it.
  const nodes = document.querySelectorAll('input');
  assert.ok(nodes.length > 0);
  assert.equal(typeof nodes.item, 'function', 'NodeList.item');
  assert.equal(typeof nodes.forEach, 'function', 'NodeList.forEach');
  assert.equal(Array.isArray(nodes), false, 'querySelectorAll returns a NodeList');
  assert.equal(nodes.map, undefined, 'NodeList has no map');
  assert.equal(nodes.find, undefined, 'NodeList has no find');

  const kids = document.body.children;
  assert.equal(Array.isArray(kids), false, 'children is an HTMLCollection');
  assert.equal(kids.forEach, undefined, 'HTMLCollection has no forEach');
});

test('a page element removed from the document is no longer found by id', () => {
  const note = document.getElementById('sequence-note');
  note.remove();
  assert.equal(document.getElementById('sequence-note'), null);
  assert.equal(note.isConnected, false);
});

test('focus on a removed or disabled control leaves activeElement where it was', () => {
  const name = document.getElementById('editor-name');
  name.focus();
  assert.equal(document.activeElement, name);

  const loose = document.createElement('input');
  loose.focus();
  assert.equal(document.activeElement, name, 'a detached input cannot take focus');

  const button = document.createElement('button');
  button.disabled = true;
  name.parentNode.appendChild(button);
  button.focus();
  assert.equal(document.activeElement, name, 'a disabled button cannot take focus');
});

test('replacing the focused node with an equivalent one drops focus to body', () => {
  const name = document.getElementById('editor-name');
  name.focus();
  const twin = document.createElement('input');
  twin.id = 'editor-name';
  name.parentNode.replaceChild(twin, name);
  assert.equal(document.activeElement, document.body, 'focus does not follow an id onto a new node');
  assert.notEqual(document.activeElement, twin);
});

test('a cancelled checkbox click stays unchecked and fires neither input nor change', () => {
  const box = document.createElement('input');
  box.type = 'checkbox';
  document.body.appendChild(box);
  const fired = [];
  box.addEventListener('input', () => fired.push('input'));
  box.addEventListener('change', () => fired.push('change'));
  box.addEventListener('click', (e) => {
    assert.equal(box.checked, true, 'listeners see the toggled state');
    e.preventDefault();
  });
  assert.equal(box.click(), false);
  assert.equal(box.checked, false);
  assert.deepEqual(fired, []);
});

test('a listener removed by an earlier listener of the same event does not run', () => {
  // DOM spec, inner invoke: a listener whose removed flag is set is skipped,
  // even though it was registered when the dispatch began.
  const button = document.createElement('button');
  document.body.appendChild(button);
  const ran = [];
  const second = () => ran.push('second');
  button.addEventListener('click', () => {
    ran.push('first');
    button.removeEventListener('click', second);
  });
  button.addEventListener('click', second);
  button.click();
  assert.deepEqual(ran, ['first']);
});

test('a once listener is gone even when it throws', () => {
  const button = document.createElement('button');
  document.body.appendChild(button);
  let calls = 0;
  button.addEventListener('click', () => { calls += 1; throw new Error('boom'); }, { once: true });
  button.click();
  button.click();
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------- fetch

test('fetch with an already aborted signal rejects with AbortError', async () => {
  fetchStub.respond('/api/status', { status: 200, body: {} });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetch('/api/status', { signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
});

test('aborting a pending fetch rejects it with AbortError, also from a mocked timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  fetchStub.defer('/api/runs/r1');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5000);

  let outcome = 'pending';
  fetch('/api/runs/r1', { signal: controller.signal }).then(
    () => { outcome = 'resolved'; },
    (err) => { outcome = err.name; },
  );
  await flush();
  assert.equal(outcome, 'pending');
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(outcome, 'AbortError');
});

test('deferred fetches settle in the order the test settles them, and a rejection surfaces', async () => {
  const one = fetchStub.defer('/api/a');
  const two = fetchStub.defer('/api/b');
  const order = [];
  fetch('/api/a').then((r) => order.push(`a${r.status}`));
  fetch('/api/b').then(() => order.push('b'), (e) => order.push(`b:${e.name}`));
  two.reject();
  await flush();
  one.resolve({ status: 200 });
  await flush();
  assert.deepEqual(order, ['b:TypeError', 'a200']);
});

// ---------------------------------------------------------------- EventSource

test('a closed EventSource delivers nothing and fires no error', () => {
  const source = new EventSource('/api/runs/r1/stream');
  const got = [];
  source.onmessage = (e) => got.push(['message', e.data]);
  source.onerror = () => got.push(['error']);
  source.addEventListener('run_started', (e) => got.push(['run_started', e.data, e.lastEventId]));

  source.emit('run_started', { id: 'r1' }, { lastEventId: '7' });
  source.emit('message', 'plain');
  source.close();
  assert.equal(source.emit('run_started', { id: 'r1' }), false);
  assert.equal(source.emit('message', 'late'), false);
  assert.equal(source.fail(), false);

  assert.deepEqual(got, [['run_started', '{"id":"r1"}', '7'], ['message', 'plain']],
    'a named event does not reach onmessage, and nothing arrives after close');
  assert.equal(eventSources.closed, 1);
  source.close();
  assert.equal(eventSources.closed, 1, 'closing twice counts once');
});

// ---------------------------------------------------------------- isolation

test('resetBrowser drops scripted fetches, event sources and armed storage failures', async () => {
  fetchStub.respond('/api/status', { status: 200, body: {} });
  const source = new EventSource('/api/runs/r1/stream');
  localStorage.failOn('setItem');
  localStorage.failOn('getItem');

  resetBrowser();

  await assert.rejects(fetch('/api/status'), /nothing scripted/);
  assert.equal(eventSources.instances.length, 0);
  assert.equal(eventSources.opened, 0);
  assert.equal(eventSources.latest(), null);
  assert.ok(source, 'the old instance is simply forgotten');
  localStorage.setItem('k', 'v');
  assert.equal(localStorage.getItem('k'), 'v');
});

// ---------------------------------------------------------------- store

test('resetState hands out fresh nested defaults every time and notifies nobody', () => {
  let notified = 0;
  subscribe(() => { notified += 1; });

  get().options.concurrency = 49;
  get().sequence.push({ key: 'x' });
  resetState();
  get().options.delay_ms = 999;
  resetState();

  assert.deepEqual(get().options, { stop_on_failure: false, delay_ms: 0, concurrency: 10, duration_secs: 10 });
  assert.deepEqual(get().sequence, []);
  assert.equal(notified, 0, 'resetState does not notify');
  set({ mode: 'performance' });
  assert.equal(notified, 1, 'subscribers survive a reset');
});
