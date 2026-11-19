// A stored assertion whose type the page does not know shows a blank type
// select; a short note beside it says the type is unknown, names it as text,
// clipped, and describes the select. Choosing a listed type clears it.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors, flush, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];

let unsubscribe = null;

function open(assertions) {
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: [
    { id: 'ws-a', name: 'A', endpoint: 'search', params: { q: 'x' }, assertions },
  ] }));
  workspace.init();
  editor.init();
  unsubscribe = subscribe((state) => editor.render(state));
  set({ endpoints });
  sidebar.selectRequest(workspace.find('ws-a'));
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

const rows = () => [...byId('assertion-rows').querySelectorAll('.assert-row')];
const noteOf = (row) => row.querySelector('.field-note');
const said = (type) => `Unknown assertion type "${type}" - choose one of the listed types.`;

for (const type of ['regex', 'constructor', '__proto__', 'toString']) {
  test(`a stored assertion of type ${type} is explained beside its select`, () => {
    open([{ type: 'status', op: 'eq', value: 200 }, { type, op: 'eq', value: 1 }]);
    const [known, odd] = rows();
    assert.equal(noteOf(known), null, 'a known type got a note');
    const note = noteOf(odd);
    assert.ok(note, 'no note beside the unknown type');
    assert.equal(note.textContent, said(type));
    assert.equal(note.children.length, 0);
    const select = odd.querySelector('.assert-type');
    assert.ok(note.id !== '' && select.getAttribute('aria-describedby') === note.id, 'the select is not described by the note');
    assert.ok(byId(note.id) === note, 'the note id does not lead to the note');
    assert.deepEqual(listenerErrors, []);
  });
}

test('a type that is not text, or is long or markup, is named as text and clipped', () => {
  const long = `<img src=x>${'t'.repeat(200)}`;
  open([{ type: long, op: 'eq', value: 1 }, { type: 7, op: 'eq', value: 1 }, { type: { a: 1 }, op: 'eq', value: 1 }]);
  const [first, second, third] = rows().map(noteOf);
  assert.match(first.textContent, /^Unknown assertion type "<img src=x>t+\.\.\." - choose one of the listed types\.$/);
  assert.ok(first.textContent.length < 160, `${first.textContent.length} characters`);
  assert.equal(first.children.length, 0);
  assert.equal(second.textContent, said('7'));
  assert.equal(third.textContent, 'Unknown assertion type - choose one of the listed types.');
  const ids = rows().map((r) => r.querySelector('.assert-type').getAttribute('aria-describedby'));
  assert.equal(new Set(ids).size, 3, 'two rows share one note id');
});

test('choosing a listed type clears the note and its description', () => {
  open([{ type: 'regex', op: 'eq', value: 1 }]);
  const select = rows()[0].querySelector('.assert-type');
  select.value = 'status';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(get().draft.assertions[0].type, 'status');
  const row = rows()[0];
  assert.equal(noteOf(row), null);
  assert.equal(row.querySelector('.assert-type').hasAttribute('aria-describedby'), false);
  assert.deepEqual(listenerErrors, []);
});

test('a refusal marked on the select and then cleared gives the note back as its description', async () => {
  open([{ type: 'status', op: 'eq', value: 200 }, { type: 'regex', op: 'eq', value: 1 }]);
  byId('send-request').click();
  await flush();
  assert.match(byId('send-status').textContent, /^Refused - Assertion 2: unknown assertion type/);
  const select = () => rows()[1].querySelector('.assert-type');
  const marked = select().getAttribute('aria-describedby');
  assert.equal(marked, 'assertion-error', 'the refusal was not marked on the select; the case proves nothing');
  typeInto(rows()[0].querySelector('.assert-value'), '201');
  assert.ok(noteOf(rows()[1]), 'the note went away with the refusal');
  assert.equal(select().getAttribute('aria-describedby'), noteOf(rows()[1]).id, `described by ${select().getAttribute('aria-describedby')} (was ${marked} while marked)`);
  assert.deepEqual(listenerErrors, []);
});
