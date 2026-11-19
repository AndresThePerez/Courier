// "Copied to My Workspace" is said only while the copy is in storage,
// whichever write the browser refuses: the copy's own, the save after it, only
// the saved requests' key, or any keystroke's at random. What was typed stays
// on the page throughout.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe, renderAll } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const req = (id, name) => ({ id, name, endpoint: 'search', params: { q: 'a' }, assertions: [] });
const builtIn = req('pokemon-search', 'Find a Pokemon');

let unsubscribe = null;

function boot(queued) {
  localStorage.setItem(SETUP, JSON.stringify({ version: 1, mode: 'functional', options: {}, sequence: queued.map((request) => ({ enabled: true, request })) }));
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: [] }));
  const showTab = (name) => set({ activeTab: name });
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  runner.init({ edit: (key) => editor.editQueued(key, showTab) });
  sidebar.init({});
  unsubscribe = subscribe((state) => renderAll([sidebar.render, editor.render, runner.render], state));
  set({ endpoints });
}

// refuse makes setItem throw, as a full store does, whenever refuses(key, n)
// says so; n counts the writes of that key since refuse was called.
function refuse(t, refuses) {
  const original = localStorage.setItem;
  const counts = new Map();
  t.mock.method(localStorage, 'setItem', function setItem(key, value) {
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    if (refuses(String(key), n)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return original.call(this, key, value);
  });
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  localStorage.heal();
  workspace.stop();
});

const note = () => (byId('editor-note').hidden ? '' : byId('editor-note').textContent);
const storedRequests = () => {
  const raw = localStorage.peek(WORKSPACE);
  return raw ? JSON.parse(raw).requests : [];
};
const editOf = (i) => [...byId('sequence-list').querySelectorAll('.seq-row')][i].querySelectorAll('button')[0];

// honest fails when the note claims a copy that storage does not hold, or the
// page has lost what was typed.
function honest(typed, what) {
  const m = /^Copied to My Workspace as "(.*)"/s.exec(note());
  if (m) {
    const draft = get().draft;
    assert.ok(storedRequests().some((r) => r.id === draft.id),
      `${what}: the note says ${JSON.stringify(note())} but storage holds no request ${draft.id}`);
  }
  assert.equal(get().draft.name, typed, `${what}: the typing was lost from the draft`);
  assert.equal(byId('editor-name').value, typed, `${what}: the typing was lost from the field`);
}

test('the copy refused and the save after it taken: whatever is said is true, and the copy is stored', (t) => {
  boot([]);
  sidebar.selectRequest(builtIn);
  refuse(t, (key, n) => key === WORKSPACE && n === 0);
  typeInto(byId('editor-name'), 'Typed');
  honest('Typed', 'first keystroke');
  assert.ok(storedRequests().some((r) => r.name === 'Typed'), 'the accepted save did not store the copy');
  assert.deepEqual(listenerErrors, []);
});

test('the copy taken and the save after it refused: "Copied" is not said, and the copy stored is the one made', (t) => {
  boot([]);
  sidebar.selectRequest(builtIn);
  refuse(t, (key, n) => key === WORKSPACE && n === 1);
  typeInto(byId('editor-name'), 'Typed');
  assert.equal(note(), workspace.WRITE_REFUSED);
  honest('Typed', 'first keystroke');
  typeInto(byId('editor-name'), 'Typed more');
  honest('Typed more', 'second keystroke');
  assert.ok(storedRequests().some((r) => r.name === 'Typed more'));
  assert.deepEqual(listenerErrors, []);
});

test('only the saved requests\' key refused: neither the built-in copy nor the queued one claims to be stored', (t) => {
  boot([req('pokemon-search', 'Find')]);
  refuse(t, (key) => key === WORKSPACE);
  editOf(0).click();
  assert.doesNotMatch(note(), /Copied/);
  typeInto(byId('editor-name'), 'Queued typed');
  assert.equal(note(), workspace.WRITE_REFUSED);
  honest('Queued typed', 'queued copy');

  sidebar.selectRequest(builtIn);
  typeInto(byId('editor-name'), 'Built-in typed');
  assert.equal(note(), workspace.WRITE_REFUSED);
  honest('Built-in typed', 'built-in copy');
  assert.deepEqual(storedRequests(), []);
  assert.deepEqual(listenerErrors, []);
});

test('refused from the start, then taken again: "Copied" comes back only once the copy is stored', (t) => {
  boot([]);
  sidebar.selectRequest(builtIn);
  let refusing = true;
  refuse(t, (key) => refusing && key === WORKSPACE);
  for (const typed of ['T', 'Ty', 'Typ']) {
    typeInto(byId('editor-name'), typed);
    assert.equal(note(), workspace.WRITE_REFUSED, typed);
    honest(typed, typed);
  }
  refusing = false;
  typeInto(byId('editor-name'), 'Type');
  honest('Type', 'after storage recovered');
  assert.equal(storedRequests().length, 1);
  assert.equal(storedRequests()[0].name, 'Type');
  assert.deepEqual(listenerErrors, []);
});

test('fast typing with writes refused at random on built-in and queued copies never claims a copy that is not stored', (t) => {
  boot([req('pokemon-search', 'Find'), req('pokemon-search', 'Find again')]);
  let seed = 7;
  const coin = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % 3 === 0;
  };
  refuse(t, () => coin());
  const opens = [() => sidebar.selectRequest(builtIn), () => editOf(0).click(), () => editOf(1).click()];
  let typed = '';
  for (let round = 0; round < 3; round += 1) {
    for (const open of opens) {
      open();
      if (!get().draft) continue;
      typed = get().draft.name;
      for (let i = 0; i < 25; i += 1) {
        typed += String.fromCharCode(97 + (i % 26));
        typeInto(byId('editor-name'), typed);
        honest(typed, `round ${round}, keystroke ${i}`);
      }
    }
  }
  assert.deepEqual(listenerErrors, []);
});
