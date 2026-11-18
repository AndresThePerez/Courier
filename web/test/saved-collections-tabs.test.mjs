// Saved collections against a second tab and a hostile store: sequences a
// browser can produce (storage changes first, its event arrives later, or never)
// built by hand around the page's own sidebar and runner, so what the visitor
// is told and what stays queued can be checked as well as what is stored.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, StorageEvent, localStorage, typeInto, listenerErrors } from './shim.mjs';
import { resetState, get, set } from '../js/store.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import { createSavedCollections } from '../js/run-config.js';

const SAVED = 'courier.collections.v1';
const SETUP = 'courier.runner.v1';
const byId = (id) => document.getElementById(id);
const req = (n, extra = {}) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [], ...extra });
const col = (id, n = 1, name = id) => ({ id, name, requests: Array.from({ length: n }, (_, i) => req(i + 1)) });
const stored = () => JSON.parse(localStorage.peek(SAVED)).collections;
const storedIds = () => stored().map((c) => c.id);
const seed = (collections) => localStorage.setItem(SAVED, JSON.stringify({ version: 1, collections }));
const nodes = () => [...byId('saved-collections').querySelectorAll('details[data-id]')];
const button = (node, text) => [...node.querySelectorAll('button')].find((b) => b.textContent === text);
const deleteButton = (node) => [...node.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Delete saved collection'));
const paint = () => { runner.render(get()); sidebar.render(get()); };

// The page's own event, as the browser queues it for this tab after another
// tab changed the shared value.
const deliver = () => window.dispatchEvent(new StorageEvent('storage', { key: SAVED, newValue: localStorage.peek(SAVED), storageArea: localStorage }));

// otherTab is a second page over the same storage: its own state, its own
// merge bookkeeping, and no event reaching either page until deliver().
function otherTab() {
  let state = { savedCollections: [] };
  const store = createSavedCollections({ storage: localStorage, get: () => state, set: (p) => { state = { ...state, ...p }; }, target: new EventTarget(), maxRequests: 50 });
  store.init();
  return { store, get ids() { return state.savedCollections.map((c) => c.id); } };
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
  runner.init({});
  sidebar.init({ addAll: (c) => runner.addAll(c) });
});

// ---------------------------------------------------------------- deleted while shown

test('Add all on a collection another tab has just deleted queues copies, says nothing untrue, and the queue survives the event', () => {
  seed([col('wc-1', 2, 'Shared'), col('wc-2', 1, 'Other')]);
  runner.savedCollections.init();
  paint();
  const b = otherTab();
  b.store.remove('wc-1');
  assert.deepEqual(storedIds(), ['wc-2']);

  // This tab has not heard: the collection is still on screen and clickable.
  button(nodes()[0], 'Add all 2 to run').click();
  paint();
  assert.deepEqual(get().sequence.map((e) => e.request.id), ['r1', 'r2']);
  assert.equal(byId('sequence-note').hidden, true, 'no message about the add that is untrue');

  deliver();
  paint();
  assert.deepEqual(nodes().map((n) => n.dataset.id), ['wc-2']);
  assert.deepEqual(get().sequence.map((e) => e.request.id), ['r1', 'r2'], 'the queued copies are not taken back');
  assert.deepEqual(JSON.parse(localStorage.peek(SETUP)).sequence.map((e) => e.request.id), ['r1', 'r2']);
  assert.deepEqual(storedIds(), ['wc-2'], 'adding to the run never stores the deleted collection again');
});

test('deleting a collection, or saving another, never touches the queued sequence or its stored setup', () => {
  seed([col('wc-1', 3, 'Three')]);
  runner.savedCollections.init();
  paint();
  button(nodes()[0], 'Add all 3 to run').click();
  paint();
  const setupBefore = localStorage.peek(SETUP);
  const queueBefore = JSON.stringify(get().sequence);

  deleteButton(nodes()[0]).click();
  paint();
  assert.equal(nodes().length, 0);
  assert.equal(localStorage.peek(SETUP), setupBefore, 'the run setup was not rewritten');
  assert.equal(JSON.stringify(get().sequence), queueBefore);

  // Editing the source request in My Workspace after queueing it leaves the queue alone too.
  set({ workspace: [req(1, { name: 'renamed' })] });
  paint();
  assert.equal(get().sequence[0].request.name, 'Request 1');
});

test('a collection deleted here and re-created by another tab under the same id comes back here, and a later delete of it holds', () => {
  seed([col('wc-1', 1, 'Same')]);
  runner.savedCollections.init();
  paint();
  const b = otherTab();
  const original = get().savedCollections[0];

  deleteButton(nodes()[0]).click();
  paint();
  assert.deepEqual(storedIds(), []);

  // B undoes a delete it made of the same collection: the same id is stored again.
  b.store.remove('wc-1');
  assert.equal(b.store.save(original).ok, true);
  assert.deepEqual(storedIds(), ['wc-1']);
  deliver();
  paint();
  assert.deepEqual(nodes().map((n) => n.dataset.id), ['wc-1'], 'a current read lists it, so it is back here');

  deleteButton(nodes()[0]).click();
  paint();
  deliver();
  paint();
  assert.deepEqual(storedIds(), []);
  assert.equal(nodes().length, 0);
});

test('this tab\'s Undo of a delete another tab already made brings the collection back, and the other tab\'s own delete still wins over its stale edit', () => {
  seed([col('wc-1', 1, 'Mine')]);
  runner.savedCollections.init();
  paint();
  const b = otherTab();

  deleteButton(nodes()[0]).click();
  button(byId('workspace-note'), 'Undo').click();
  assert.deepEqual(storedIds(), ['wc-1']);
  assert.equal(byId('workspace-note').hidden, true);

  // B, which had not heard of any of this, deletes it: the delete wins everywhere.
  b.store.remove('wc-1');
  deliver();
  paint();
  assert.deepEqual(storedIds(), []);
  assert.equal(nodes().length, 0);
  // And an Undo from here of something it did not delete is refused, with its message.
  const back = runner.savedCollections.save(col('wc-1'));
  assert.equal(back.deleted, true);
  assert.deepEqual(storedIds(), []);
});

// ---------------------------------------------------------------- the cap of fifty

test('the cap is read from what this tab shows: a delete elsewhere frees a slot only once its event is heard', () => {
  seed(Array.from({ length: 50 }, (_, i) => col(`wc-${i}`, 1)));
  runner.savedCollections.init();
  paint();
  otherTab().store.remove('wc-0');
  assert.equal(stored().length, 49);

  set({ sequence: [{ key: 'q1', enabled: true, request: req(1) }] });
  paint();
  typeInto(byId('save-sequence-name'), 'Late');
  byId('save-sequence').click();
  assert.equal(byId('sequence-note').textContent, '50 saved collections is the cap - delete one before saving another.');
  assert.equal(stored().length, 49, 'a refused save stores nothing');

  deliver();
  paint();
  typeInto(byId('save-sequence-name'), 'Late');
  byId('save-sequence').click();
  assert.equal(stored().length, 50);
  assert.equal(stored().at(-1).name, 'Late');
});

test('another tab filling the list while this one saw room can store a fifty-first, and every one of them still renders and deletes', () => {
  seed(Array.from({ length: 49 }, (_, i) => col(`wc-${i}`, 1)));
  runner.savedCollections.init();
  paint();
  otherTab().store.create('Filler', [req(9)]);
  assert.equal(stored().length, 50);

  set({ sequence: [{ key: 'q1', enabled: true, request: req(1) }] });
  paint();
  typeInto(byId('save-sequence-name'), 'Fifty-first');
  assert.doesNotThrow(() => byId('save-sequence').click());
  paint();
  assert.equal(stored().length, 51, 'the cap is checked in this tab when saving');
  assert.equal(nodes().length, 51);
  assert.equal(byId('sequence-note').textContent.startsWith('Saved "Fifty-first"'), true);

  // Over the cap, the visitor is told to delete, and deleting works down to where saving is allowed again.
  typeInto(byId('save-sequence-name'), 'Fifty-second');
  byId('save-sequence').click();
  assert.equal(byId('sequence-note').textContent, '50 saved collections is the cap - delete one before saving another.');
  deleteButton(nodes()[0]).click();
  paint();
  deleteButton(nodes()[0]).click();
  paint();
  assert.equal(stored().length, 49);
  typeInto(byId('save-sequence-name'), 'Fifty-second');
  byId('save-sequence').click();
  assert.equal(stored().length, 50);
});

// ---------------------------------------------------------------- big and odd stored lists

test('a thousand stored collections render, and the first, a middle one and the last can each be deleted and put back', () => {
  seed(Array.from({ length: 1000 }, (_, i) => col(`wc-${i}`, 1, `C${i}`)));
  runner.savedCollections.init();
  paint();
  assert.equal(nodes().length, 1000);
  for (const id of ['wc-0', 'wc-500', 'wc-999']) {
    const node = nodes().find((n) => n.dataset.id === id);
    deleteButton(node).click();
    paint();
    assert.equal(nodes().some((n) => n.dataset.id === id), false, `${id} is gone`);
    assert.equal(stored().some((c) => c.id === id), false);
    button(byId('workspace-note'), 'Undo').click();
    paint();
    assert.equal(nodes().some((n) => n.dataset.id === id), true, `${id} is back`);
  }
  assert.equal(stored().length, 1000);
  assert.deepEqual(new Set(storedIds()).size, 1000);
});

test('a collection with no requests lists as Add all 0, adds nothing, says so, and writes no setup', () => {
  seed([{ id: 'wc-empty', name: 'Empty', requests: [] }, { id: 'wc-junk', name: 'Junk', requests: [null, 5, { id: 'x' }, req(1, { params: { q: 1 } })] }]);
  runner.savedCollections.init();
  paint();
  assert.equal(nodes().length, 2);
  for (const node of nodes()) {
    button(node, 'Add all 0 to run').click();
    paint();
    assert.equal(byId('sequence-note').textContent, 'That collection has no requests.');
  }
  assert.deepEqual(get().sequence, []);
  assert.equal(localStorage.peek(SETUP), null);
});

test('Add all from a collection at 48, 49 and 50 queued never goes past fifty and says how far it got', () => {
  seed([col('wc-3', 3, 'Three')]);
  runner.savedCollections.init();
  const want = { 48: 'Added 2 of 3 - 50 requests is the cap.', 49: 'Added 1 of 3 - 50 requests is the cap.', 50: '50 requests is the cap - remove one before adding another.' };
  for (const queued of [48, 49, 50]) {
    set({ sequence: Array.from({ length: queued }, (_, i) => ({ key: `fill-${queued}-${i}`, enabled: true, request: req(100 + i) })) });
    paint();
    button(nodes()[0], 'Add all 3 to run').click();
    paint();
    assert.equal(get().sequence.length, 50, `from ${queued}`);
    assert.equal(byId('sequence-note').textContent, want[queued]);
    assert.equal(byId('sequence-count').textContent, '50 of 50 - 50 selected');
    assert.ok(JSON.parse(localStorage.peek(SETUP)).sequence.length <= 50 || queued === 50);
  }
});

// ---------------------------------------------------------------- names

test('a name of markup, spaces, or exactly 120 or 121 characters is stored as text and cut at 120, and no note or label grows an element', () => {
  seed([]);
  runner.savedCollections.init();
  set({ sequence: [{ key: 'q1', enabled: true, request: req(1) }] });
  paint();
  const save = (name) => {
    typeInto(byId('save-sequence-name'), name);
    byId('save-sequence').click();
    paint();
  };

  save('a'.repeat(120));
  save('b'.repeat(121));
  assert.deepEqual(stored().map((c) => c.name.length), [120, 120]);

  const markup = '<img src=x onerror=alert(1)>';
  save(markup);
  assert.equal(stored().at(-1).name, markup);
  const note = byId('sequence-note');
  assert.equal(note.textContent, `Saved "${markup}" with 1 request to My Workspace.`);
  assert.equal(note.querySelectorAll('img').length, 0);
  assert.equal(note.children.length, 0);

  const node = nodes().at(-1);
  assert.equal(node.querySelectorAll('img').length, 0);
  assert.equal(deleteButton(node).getAttribute('aria-label'), `Delete saved collection "${markup}"`);
  deleteButton(node).click();
  const undo = byId('workspace-note');
  assert.equal(undo.querySelectorAll('img').length, 0);
  assert.equal(undo.children.length, 2, 'the sentence and the Undo button, nothing else');
  assert.equal(undo.firstChild.textContent, `Deleted "${markup}". `);

  const before = stored().length;
  save('   ');
  save('');
  assert.equal(stored().length, before, 'a blank name stores nothing');
  assert.equal(byId('sequence-note').textContent, 'Name the collection before saving it.');
});

// ---------------------------------------------------------------- hostile stored collections

test('a stored collection holding a 10,000-deep assertion does not stop the visitor saving, adding or deleting anything', () => {
  const depth = 10000;
  const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`;
  localStorage.setItem(SAVED, `{"version":1,"collections":[{"id":"wc-deep","name":"Deep","requests":[{"id":"d","endpoint":"search","params":{},"assertions":[{"type":"json","path":"a","op":"eq","value":${nested}}]}]},{"id":"wc-ok","name":"Fine","requests":[${JSON.stringify(req(1))}]}]}`);
  assert.doesNotThrow(() => runner.savedCollections.init());
  assert.doesNotThrow(() => paint());

  set({ sequence: [{ key: 'q1', enabled: true, request: req(5) }] });
  paint();
  typeInto(byId('save-sequence-name'), 'New');
  byId('save-sequence').click();
  assert.deepEqual(listenerErrors, [], 'saving beside a collection the page cannot encode threw');
  assert.ok(stored().some((c) => c.name === 'New'), 'the new collection was stored');

  const fine = nodes().find((n) => n.dataset.id === 'wc-ok');
  button(fine, 'Add all 1 to run').click();
  assert.deepEqual(listenerErrors, [], 'Add all threw');
  deleteButton(fine).click();
  assert.deepEqual(listenerErrors, [], 'delete threw');
});

test('a stored collection whose requests carry keys the page never sends does not hand them to a run queued from it', () => {
  seed([{ id: 'wc-x', name: 'X', requests: [req(1, { url: 'http://192.0.2.10/', method: 'DELETE', headers: { A: '1' }, assertions: [{ type: 'status', op: 'eq', value: 200, url: 'http://192.0.2.10/y' }] })] }]);
  runner.savedCollections.init();
  paint();
  button(nodes()[0], 'Add all 1 to run').click();
  const [entry] = get().sequence;
  assert.deepEqual(Object.keys(entry.request).sort(), ['assertions', 'endpoint', 'id', 'name', 'params']);
  for (const a of entry.request.assertions) {
    for (const k of Object.keys(a)) assert.ok(['type', 'op', 'value', 'path'].includes(k), `assertion key ${k} survives into the queue`);
  }
});
