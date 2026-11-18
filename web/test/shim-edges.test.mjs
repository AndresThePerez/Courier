// More browser rules the fake DOM collections, listener removal and fetch
// aborts must keep. Each test names the rule; a shim that bends it lets a
// frontend change pass here and misbehave on the page.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, NodeList, HTMLCollection } from './shim.mjs';

beforeEach(() => {
  resetBrowser();
});

function host(n = 0) {
  const ul = document.createElement('ul');
  document.body.appendChild(ul);
  for (let i = 0; i < n; i += 1) {
    const li = document.createElement('li');
    li.id = `item-${i}`;
    ul.appendChild(li);
  }
  return ul;
}

// ---------------------------------------------------------------- collections

test('children and childNodes grabbed before an append see it; a querySelectorAll result does not', () => {
  const ul = host(1);
  const kids = ul.children;
  const nodes = ul.childNodes;
  const found = ul.querySelectorAll('li');
  ul.appendChild(document.createElement('li'));
  ul.appendChild(document.createTextNode('tail'));
  assert.equal(kids.length, 2, 'children is live and counts elements only');
  assert.equal(nodes.length, 3, 'childNodes is live and counts text nodes');
  assert.equal(found.length, 1, 'querySelectorAll is a snapshot');
  assert.ok(kids instanceof HTMLCollection);
  assert.ok(nodes instanceof NodeList);
  assert.ok(found instanceof NodeList);
});

test('reading past the end gives undefined by index and null from item()', () => {
  const ul = host(2);
  for (const list of [ul.children, ul.childNodes, ul.querySelectorAll('li')]) {
    assert.equal(list[2], undefined);
    assert.equal(list.item(2), null);
    assert.equal(list.item(-1), null);
    assert.equal('2' in list, false);
    assert.equal('1' in list, true);
    assert.equal(list[1].id, 'item-1');
  }
  const empty = host(0);
  assert.equal(empty.children.length, 0);
  assert.equal(empty.children[0], undefined);
  assert.equal(empty.children.item(0), null);
});

test('removing while walking a live collection by index skips every other node, as a browser does', () => {
  const ul = host(4);
  const seen = [];
  for (const li of ul.children) {
    seen.push(li.id);
    li.remove();
  }
  assert.deepEqual(seen, ['item-0', 'item-2'], 'a live HTMLCollection shifts under its iterator');
  assert.equal(ul.children.length, 2);

  const ol = host(4);
  const fromSnapshot = [];
  ol.querySelectorAll('li').forEach((li) => {
    fromSnapshot.push(li.id);
    li.remove();
  });
  assert.deepEqual(fromSnapshot, ['item-0', 'item-1', 'item-2', 'item-3'], 'a static NodeList keeps every node');
  assert.equal(ol.children.length, 0);
});

test('spread, Array.from and for...of work on both list types and yield nodes in order', () => {
  const ul = host(3);
  const ids = (list) => list.map((n) => n.id);
  assert.deepEqual(ids([...ul.children]), ['item-0', 'item-1', 'item-2']);
  assert.deepEqual(ids(Array.from(ul.childNodes)), ['item-0', 'item-1', 'item-2']);
  const viaFor = [];
  for (const n of ul.querySelectorAll('li')) viaFor.push(n.id);
  assert.deepEqual(viaFor, ['item-0', 'item-1', 'item-2']);
  assert.deepEqual([...ul.querySelectorAll('li').keys()], [0, 1, 2]);
  assert.deepEqual(Object.keys(ul.children), ['0', '1', '2']);
});

test('index slots of a collection are read-only', () => {
  const ul = host(2);
  const kids = ul.children;
  const other = document.createElement('li');
  kids[0] = other;
  assert.equal(kids[0].id, 'item-0', 'assigning to an index changes nothing');
  assert.equal(ul.firstElementChild.id, 'item-0');
});

test('options of a select drop the selected option when it is removed and the select falls back to the first', () => {
  const select = document.createElement('select');
  document.body.appendChild(select);
  for (const v of ['a', 'b', 'c']) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    select.appendChild(o);
  }
  const options = select.options;
  select.selectedIndex = 2;
  assert.equal(select.value, 'c');
  options[2].remove();
  assert.equal(options.length, 2, 'options is live');
  assert.equal(options[2], undefined);
  assert.equal(select.selectedIndex, 0);
  assert.equal(select.value, 'a');
  assert.equal(options.forEach, undefined, 'an options collection has no forEach');
});

// ---------------------------------------------------------------- listeners

test('a listener added during dispatch does not run in that dispatch, but runs in the next', () => {
  const button = document.createElement('button');
  document.body.appendChild(button);
  const ran = [];
  const late = () => ran.push('late');
  button.addEventListener('click', () => {
    ran.push('first');
    button.addEventListener('click', late);
  });
  button.click();
  assert.deepEqual(ran, ['first']);
  button.click();
  assert.deepEqual(ran, ['first', 'first', 'late']);
});

test('a listener removed and re-added by an earlier listener does not run in that dispatch', () => {
  const button = document.createElement('button');
  document.body.appendChild(button);
  const ran = [];
  const second = () => ran.push('second');
  let swapped = false;
  button.addEventListener('click', () => {
    ran.push('first');
    if (swapped) return;
    swapped = true;
    button.removeEventListener('click', second);
    button.addEventListener('click', second);
  });
  button.addEventListener('click', second);
  button.click();
  assert.deepEqual(ran, ['first'], 'the re-added listener is a new registration, not in the running list');
  ran.length = 0;
  button.click();
  assert.deepEqual(ran, ['first', 'second']);
});

test('removing the capture registration leaves the bubble registration of the same function', () => {
  const outer = document.createElement('div');
  const inner = document.createElement('button');
  outer.appendChild(inner);
  document.body.appendChild(outer);
  const ran = [];
  const fn = (e) => ran.push(e.eventPhase);
  outer.addEventListener('click', fn, true);
  outer.addEventListener('click', fn, false);
  outer.addEventListener('click', () => outer.removeEventListener('click', fn, false), true);
  inner.click();
  assert.deepEqual(ran, [1], 'capture ran; the bubble one was removed before bubbling reached it');

  ran.length = 0;
  outer.removeEventListener('click', fn, { capture: true });
  inner.click();
  assert.deepEqual(ran, []);
});

test('removing a listener that already ran in this dispatch leaves the later ones running', () => {
  const button = document.createElement('button');
  document.body.appendChild(button);
  const ran = [];
  const first = () => ran.push('first');
  button.addEventListener('click', first);
  button.addEventListener('click', () => {
    ran.push('second');
    button.removeEventListener('click', first);
  });
  button.addEventListener('click', () => ran.push('third'));
  button.click();
  assert.deepEqual(ran, ['first', 'second', 'third']);
  ran.length = 0;
  button.click();
  assert.deepEqual(ran, ['second', 'third']);
});

// ---------------------------------------------------------------- fetch aborts

test('an abort with a custom reason rejects with that reason, up front and while pending', async () => {
  const reason = new Error('superseded');
  fetchStub.respond('/api/status', { status: 200, body: {} });
  const early = new AbortController();
  early.abort(reason);
  await assert.rejects(fetch('/api/status', { signal: early.signal }), (err) => err === reason);
  assert.deepEqual(fetchStub.pending(), ['* /api/status'], 'an aborted call uses up no answer');

  fetchStub.defer('/api/runs/r1');
  const late = new AbortController();
  const pending = fetch('/api/runs/r1', { signal: late.signal });
  late.abort(reason);
  await assert.rejects(pending, (err) => err === reason);
});

test('aborting after the response has settled is a no-op and does not throw', async () => {
  fetchStub.respond('/api/status', { status: 200, body: { ok: true } });
  const controller = new AbortController();
  const res = await fetch('/api/status', { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.doesNotThrow(() => controller.abort());
  await flush();

  fetchStub.reject('/api/b');
  const second = new AbortController();
  await assert.rejects(fetch('/api/b', { signal: second.signal }), (err) => err.name === 'TypeError');
  assert.doesNotThrow(() => second.abort());
});

test('one controller shared by two pending fetches rejects both on abort', async () => {
  fetchStub.defer('/api/a');
  fetchStub.defer('/api/b');
  const controller = new AbortController();
  const out = [];
  const a = fetch('/api/a', { signal: controller.signal }).then(() => out.push('a ok'), (e) => out.push(`a ${e.name}`));
  const b = fetch('/api/b', { signal: controller.signal }).then(() => out.push('b ok'), (e) => out.push(`b ${e.name}`));
  controller.abort();
  await Promise.all([a, b]);
  assert.deepEqual(out.sort(), ['a AbortError', 'b AbortError']);
});

test('a deferred fetch the server answers after the abort stays rejected', async () => {
  const handle = fetchStub.defer('/api/runs/r1');
  const controller = new AbortController();
  let outcome = 'pending';
  fetch('/api/runs/r1', { signal: controller.signal }).then(
    () => { outcome = 'resolved'; },
    (err) => { outcome = err.name; },
  );
  await flush();
  assert.equal(handle.requested, true);
  controller.abort();
  handle.resolve({ status: 200, body: { id: 'r1' } });
  await flush();
  assert.equal(outcome, 'AbortError');
});

test('aborting after the headers arrived makes reading the body reject with AbortError', async () => {
  // Fetch standard: an abort after the response promise fulfilled errors the
  // body stream, so res.json() rejects instead of handing over stale data.
  fetchStub.respond('/api/runs/r1', { status: 200, body: { id: 'r1' } });
  const controller = new AbortController();
  const res = await fetch('/api/runs/r1', { signal: controller.signal });
  controller.abort();
  await assert.rejects(res.json(), (err) => err.name === 'AbortError');
});

// ---------------------------------------------------------------- isolation

test('resetBrowser leaves no collection or listener from an earlier test behind', () => {
  const ul = host(2);
  const kids = ul.children;
  let clicks = 0;
  document.body.addEventListener('click', () => { clicks += 1; });
  resetBrowser();
  assert.equal(document.body.contains(ul), false);
  assert.equal(kids.length, 2, 'an old collection still reads its own detached parent');
  const button = document.createElement('button');
  document.body.appendChild(button);
  button.click();
  assert.equal(clicks, 0, 'a body listener from before the reset is gone');
});
