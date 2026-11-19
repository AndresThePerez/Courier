// A run sequence saved as a collection in this browser: saving it, listing it
// under My Workspace, adding it back to the run, deleting it, and what other
// tabs and a refusing or garbled storage do to the list.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage, StorageEvent, localStorage, typeInto } from './shim.mjs';
import { resetState, get, set } from '../js/store.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import { createSavedCollections } from '../js/run-config.js';

const SAVED_LIST = 'courier.collections.v1';
const WRITE_REFUSED = 'Could not save - this browser refused the write (storage full or disabled). The change stays on this page until you reload.';

const req = (n, extra = {}) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [], ...extra });
const stored = () => JSON.parse(localStorage.peek(SAVED_LIST));
const byId = (id) => document.getElementById(id);
const saved = () => byId('saved-collections').querySelectorAll('details[data-id]');
const buttonsOf = (node) => [...node.querySelectorAll('button')];
const buttonNamed = (node, text) => buttonsOf(node).find((b) => b.textContent === text);
const deleteButton = (node) => buttonsOf(node).find((b) => (b.getAttribute('aria-label') || '').startsWith('Delete saved collection'));

function paint() {
  runner.render(get());
  sidebar.render(get());
}

function queue(...ns) {
  for (const n of ns) runner.add(req(n));
}

function saveAs(name) {
  paint();
  typeInto(byId('save-sequence-name'), name);
  byId('save-sequence').click();
  paint();
}

const seedCollections = (collections) => localStorage.setItem(SAVED_LIST, JSON.stringify({ version: 1, collections }));

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
  runner.init({});
  sidebar.init({ addAll: (c) => runner.addAll(c) });
});

// ---------------------------------------------------------------- saving

test('saving the queued requests stores them, in order, as a collection with a wc- id', () => {
  runner.savedCollections.init();
  queue(1, 2, 3);
  saveAs('My run');

  const value = stored();
  assert.equal(value.version, 1);
  assert.equal(value.collections.length, 1);
  const [c] = value.collections;
  assert.match(c.id, /^wc-./);
  assert.equal(c.name, 'My run');
  assert.deepEqual(c.requests, [req(1), req(2), req(3)]);
  assert.deepEqual(Object.keys(c).sort(), ['id', 'name', 'requests']);

  assert.equal(byId('sequence-note').textContent, 'Saved "My run" with 3 requests to My Workspace.');
  assert.equal(byId('save-sequence-name').value, '', 'the name is cleared for the next one');
  assert.equal(get().savedCollections.length, 1);
  assert.equal(get().sequence.length, 3, 'saving leaves the sequence queued');
});

test('a saved collection is listed under My Workspace with Add all N to run and a delete control, and Add all re-queues it in order', () => {
  runner.savedCollections.init();
  queue(1, 2, 3);
  paint();
  // The second one unchecked: a saved collection keeps every queued request.
  byId('sequence-list').querySelectorAll('input[type="checkbox"]')[1].click();
  saveAs('My run');
  set({ sequence: [] });
  paint();

  const nodes = saved();
  assert.equal(nodes.length, 1);
  const node = nodes[0];
  assert.equal(node.querySelector('.collection-name').textContent, 'My run');
  assert.ok(buttonNamed(node, 'Add all 3 to run'), 'an Add all control naming the count');
  const del = deleteButton(node);
  assert.ok(del, 'a delete control with an accessible name');
  assert.equal(del.getAttribute('aria-label'), 'Delete saved collection "My run"');
  for (const b of buttonsOf(node)) assert.ok(b.textContent.trim() || b.getAttribute('aria-label'), 'every control has a name');

  buttonNamed(node, 'Add all 3 to run').click();
  assert.deepEqual(get().sequence.map((e) => e.request.id), ['r1', 'r2', 'r3']);
  assert.deepEqual(get().sequence.map((e) => e.enabled), [true, true, true]);
  // What is queued is a copy: changing it leaves the saved collection alone.
  get().sequence[0].request.name = 'changed';
  assert.equal(get().savedCollections[0].requests[0].name, 'Request 1');
});

test('an empty name, or one of spaces, saves nothing and says why', () => {
  runner.savedCollections.init();
  queue(1);
  for (const name of ['', '   ']) {
    saveAs(name);
    assert.equal(byId('sequence-note').textContent, 'Name the collection before saving it.');
    assert.equal(localStorage.peek(SAVED_LIST), null);
    assert.deepEqual(get().savedCollections, []);
  }
});

test('an empty sequence cannot be saved', () => {
  runner.savedCollections.init();
  paint();
  assert.equal(byId('save-sequence').disabled, true);
  typeInto(byId('save-sequence-name'), 'Nothing');
  byId('save-sequence').click();
  assert.equal(localStorage.peek(SAVED_LIST), null);
});

test('a long name is cut to 120 characters and a name with markup is shown as text', () => {
  runner.savedCollections.init();
  queue(1);
  saveAs('n'.repeat(500));
  assert.equal(stored().collections[0].name, 'n'.repeat(120));

  const markup = '<img src=x onerror=alert(1)><b>bold</b>';
  saveAs(markup);
  const node = [...saved()].find((d) => d.querySelector('.collection-name').textContent === markup);
  assert.ok(node, 'the markup is the visible text');
  assert.equal(node.querySelector('.collection-name').children.length, 0, 'no element was made from the name');
  assert.equal(node.querySelectorAll('img').length, 0);
});

test('a refused write says so and keeps the collection on this page', () => {
  runner.savedCollections.init();
  queue(1, 2);
  localStorage.failOn('setItem');
  saveAs('Kept here');
  assert.ok(byId('sequence-note').textContent.includes(WRITE_REFUSED));
  assert.equal(get().savedCollections.length, 1);
  assert.equal(saved().length, 1);
});

test('a refused read at load lists nothing, throws nothing, and a save while reads are refused is not written', () => {
  seedCollections([{ id: 'wc-1', name: 'One', requests: [req(1)] }]);
  localStorage.failOn('getItem');
  assert.doesNotThrow(() => runner.savedCollections.init());
  assert.deepEqual(get().savedCollections, []);
  queue(1);
  saveAs('Two');
  assert.ok(byId('sequence-note').textContent.includes(WRITE_REFUSED));
  assert.deepEqual(stored().collections.map((c) => c.id), ['wc-1'], 'nothing is merged into a value this tab could not read');
});

test('fifty saved collections is the cap for saving another', () => {
  seedCollections(Array.from({ length: 50 }, (_, i) => ({ id: `wc-${i}`, name: `C${i}`, requests: [req(i)] })));
  runner.savedCollections.init();
  queue(1);
  saveAs('One more');
  assert.equal(byId('sequence-note').textContent, '50 saved collections is the cap - delete one before saving another.');
  assert.equal(stored().collections.length, 50);
});

// ---------------------------------------------------------------- deleting

test('deleting a saved collection offers it back inline, and Undo restores it', () => {
  runner.savedCollections.init();
  queue(1, 2);
  saveAs('My run');
  const id = get().savedCollections[0].id;

  deleteButton(saved()[0]).click();
  paint();
  assert.equal(saved().length, 0);
  assert.deepEqual(stored().collections, []);
  const note = byId('workspace-note');
  assert.equal(note.hidden, false);
  assert.equal(note.getAttribute('role'), 'status');
  assert.equal(note.textContent, 'Deleted "My run". Undo');

  buttonNamed(note, 'Undo').click();
  paint();
  assert.equal(note.hidden, true);
  assert.deepEqual(stored().collections.map((c) => c.id), [id]);
  assert.equal(saved().length, 1);
});

test('deleting a saved collection leaves the queued sequence as it is', () => {
  runner.savedCollections.init();
  queue(1, 2);
  saveAs('My run');
  set({ sequence: [] });
  paint();
  buttonNamed(saved()[0], 'Add all 2 to run').click();
  paint();
  deleteButton(saved()[0]).click();
  assert.deepEqual(get().sequence.map((e) => e.request.id), ['r1', 'r2']);
});

test('Add all from a saved collection near the cap adds what fits and the cap note says how far', () => {
  seedCollections([{ id: 'wc-5', name: 'Five', requests: [1, 2, 3, 4, 5].map((n) => req(n)) }]);
  runner.savedCollections.init();
  set({ sequence: Array.from({ length: 48 }, (_, i) => ({ key: `k${i}`, enabled: true, request: req(100 + i) })) });
  paint();
  buttonNamed(saved()[0], 'Add all 5 to run').click();
  paint();
  assert.equal(get().sequence.length, 50);
  assert.deepEqual(get().sequence.slice(48).map((e) => e.request.id), ['r1', 'r2']);
  assert.equal(byId('sequence-note').textContent, 'Added 2 of 5 - 50 requests is the cap.');

  buttonNamed(saved()[0], 'Add all 5 to run').click();
  paint();
  assert.equal(byId('sequence-note').textContent, '50 requests is the cap - remove one before adding another.');
});

// ---------------------------------------------------------------- other tabs

function tab(shared) {
  let state = { savedCollections: [] };
  const target = new EventTarget();
  const store = createSavedCollections({ storage: shared, get: () => state, set: (p) => { state = { ...state, ...p }; }, target, maxRequests: 50 });
  store.init();
  return {
    store,
    get list() { return state.savedCollections.map((c) => c.id).sort(); },
    hear: () => target.dispatchEvent(new StorageEvent('storage', { key: SAVED_LIST, newValue: shared.peek(SAVED_LIST), storageArea: shared })),
  };
}

test('saved collections merge by id across tabs, and one deleted in another tab disappears here', () => {
  const shared = new FakeStorage();
  const a = tab(shared);
  const b = tab(shared);

  const one = a.store.create('One', [req(1)]).collection;
  // B saves before it hears of A's: both are kept.
  const two = b.store.create('Two', [req(2)]).collection;
  assert.deepEqual(JSON.parse(shared.peek(SAVED_LIST)).collections.map((c) => c.id).sort(), [one.id, two.id].sort());
  a.hear();
  b.hear();
  assert.deepEqual(a.list, [one.id, two.id].sort());
  assert.deepEqual(b.list, [one.id, two.id].sort());

  b.store.remove(one.id);
  a.hear();
  assert.deepEqual(a.list, [two.id]);

  // An Undo from A of nothing it deleted cannot bring it back: the delete wins.
  const back = a.store.save(one);
  assert.equal(back.deleted, true);
  assert.deepEqual(JSON.parse(shared.peek(SAVED_LIST)).collections.map((c) => c.id), [two.id]);
});

test('a saved collection deleted in another tab leaves this page\'s list, and its open state goes with it', () => {
  seedCollections([{ id: 'wc-1', name: 'One', requests: [req(1)] }, { id: 'wc-2', name: 'Two', requests: [req(2)] }]);
  runner.savedCollections.init();
  paint();
  saved()[0].open = true;
  localStorage.writeFromAnotherTab(SAVED_LIST, JSON.stringify({ version: 1, collections: [{ id: 'wc-2', name: 'Two', requests: [req(2)] }] }));
  paint();
  assert.deepEqual([...saved()].map((d) => d.dataset.id), ['wc-2']);
  assert.equal(saved()[0].open, false);
});

test('a saved collection added in another tab appears here, and an open one stays open', () => {
  seedCollections([{ id: 'wc-1', name: 'One', requests: [req(1)] }]);
  runner.savedCollections.init();
  paint();
  saved()[0].open = true;
  localStorage.writeFromAnotherTab(SAVED_LIST, JSON.stringify({ version: 1, collections: [{ id: 'wc-1', name: 'One', requests: [req(1)] }, { id: 'wc-2', name: 'Two', requests: [req(2)] }] }));
  paint();
  assert.deepEqual([...saved()].map((d) => [d.dataset.id, d.open]), [['wc-1', true], ['wc-2', false]]);
});

// ---------------------------------------------------------------- bad values

test('a wrong-version or garbage value, at load or by storage event, lists nothing and throws nothing', () => {
  for (const raw of ['{bad', 'null', '[]', '7', JSON.stringify({ version: 2, collections: [{ id: 'wc-1', name: 'x', requests: [] }] }), JSON.stringify({ version: 1, collections: 'x' })]) {
    resetState();
    localStorage.setItem(SAVED_LIST, raw);
    assert.doesNotThrow(() => runner.savedCollections.init());
    assert.deepEqual(get().savedCollections, [], raw);
  }

  resetState();
  seedCollections([{ id: 'wc-1', name: 'One', requests: [req(1)] }]);
  runner.savedCollections.init();
  assert.equal(get().savedCollections.length, 1);
  assert.doesNotThrow(() => localStorage.writeFromAnotherTab(SAVED_LIST, '{bad'));
  assert.deepEqual(get().savedCollections, []);
  queue(1);
  saveAs('After');
  assert.deepEqual(stored().collections.map((c) => c.name), ['After']);
});

test('malformed saved collections are dropped, malformed requests inside one are dropped, and one holds at most 50 requests', () => {
  seedCollections([
    null, 5, 'wc-x', [],
    { id: 7, name: 'number id', requests: [] },
    { id: '', name: 'empty id', requests: [] },
    { id: 'wc-noname', requests: [] },
    { id: 'wc-badname', name: { x: 1 }, requests: [] },
    { id: 'wc-norequests', name: 'no requests' },
    { id: 'wc-good', name: 'Good', extra: 'dropped', requests: [req(1, { url: 'http://192.0.2.10/', method: 'DELETE' }), null, { id: 'x' }, req(2, { params: { q: 3 } }), req(3)] },
    { id: 'wc-big', name: 'Big', requests: Array.from({ length: 500 }, (_, i) => req(i)) },
  ]);
  runner.savedCollections.init();
  const list = get().savedCollections;
  assert.deepEqual(list.map((c) => c.id), ['wc-good', 'wc-big']);
  assert.deepEqual(list[0], { id: 'wc-good', name: 'Good', requests: [req(1), req(3)] });
  assert.equal(list[1].requests.length, 50);
});

test('a 5 MB stored value loads with its name cut, and a thousand saved collections render', () => {
  seedCollections([{ id: 'wc-huge', name: 'x'.repeat(5 * 1024 * 1024), requests: [req(1)] }]);
  runner.savedCollections.init();
  assert.equal(get().savedCollections[0].name.length, 120);

  resetState();
  seedCollections(Array.from({ length: 1000 }, (_, i) => ({ id: `wc-${i}`, name: `C${i}`, requests: [req(i)] })));
  runner.savedCollections.init();
  paint();
  assert.equal(saved().length, 1000);
});

// ---------------------------------------------------------------- the label

test('the My Workspace heading says its contents are saved in this browser only', () => {
  const heading = byId('workspace-tree').parentNode.querySelector('h2');
  assert.ok(heading.textContent.includes('My Workspace'));
  const row = heading.parentNode;
  const siblings = [...row.parentNode.children];
  const label = siblings[siblings.indexOf(row) + 1];
  assert.ok(label && label.textContent === 'Saved in this browser only', 'the exact words sit right under the heading row');
});

test('the saved collections list is a labelled group, so its label is announced', () => {
  const list = byId('saved-collections');
  assert.equal(list.getAttribute('role'), 'group');
  assert.equal(list.getAttribute('aria-label'), 'Saved collections');
});
