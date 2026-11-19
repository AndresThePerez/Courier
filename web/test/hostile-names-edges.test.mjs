// Text the page did not write, read where it now names things: an assertion
// type it does not know, the fields of the cut sentence, a history verdict.
// Inherited property names, values that are not text, very long text and
// markup are all said as clipped text, never drawn, never looked up through
// an object's prototype.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';
import { cutText, unknownTypeNote } from '../js/request-model.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const inherited = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__lookupSetter__'];

let unsubscribe = null;

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

function openAssertions(assertions) {
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: [
    { id: 'ws-a', name: 'A', endpoint: 'search', params: { q: 'x' }, assertions },
  ] }));
  workspace.init();
  editor.init();
  unsubscribe = subscribe((state) => editor.render(state));
  set({ endpoints });
  sidebar.selectRequest(workspace.find('ws-a'));
}

const rows = () => [...byId('assertion-rows').querySelectorAll('.assert-row')];
const noteOf = (row) => row.querySelector('.field-note');

test('every inherited property name, as an assertion type, gets the unknown-type note naming it as text', () => {
  openAssertions(inherited.map((type) => ({ type, op: 'eq', value: 1 })));
  rows().forEach((row, i) => {
    const note = noteOf(row);
    assert.ok(note, `no note for type ${inherited[i]}`);
    assert.equal(note.textContent, `Unknown assertion type "${inherited[i]}" - choose one of the listed types.`);
    assert.equal(note.children.length, 0);
    assert.equal(row.querySelector('.assert-type').getAttribute('aria-describedby'), note.id);
  });
  assert.equal(new Set(rows().map((r) => noteOf(r).id)).size, inherited.length, 'two notes share an id');
  assert.deepEqual(listenerErrors, []);
});

test('a type of 5,000 characters of markup, null, true, an array naming a listed type, or a nested object is clipped or unnamed', () => {
  const huge = '<script>x</script>'.repeat(300);
  const types = [huge, null, true, ['status'], { type: 'status' }, -0];
  const scripts = document.querySelectorAll('script').length;
  openAssertions(types.map((type) => ({ type, op: 'eq', value: 1 })));
  const notes = rows().map(noteOf);
  assert.equal(notes.length, types.length);
  notes.forEach((n, i) => assert.ok(n, `no note for type ${JSON.stringify(types[i])}`));
  assert.ok(notes[0].textContent.length < 200, `the note of a 5,000 character type is ${notes[0].textContent.length} long`);
  assert.match(notes[0].textContent, /^Unknown assertion type "<script>x<\/script>.*\.\.\." - choose one of the listed types\.$/);
  for (const n of notes) assert.equal(n.children.length, 0, 'text became elements');
  for (const n of notes.slice(1, 5)) assert.equal(n.textContent, 'Unknown assertion type - choose one of the listed types.');
  assert.equal(notes[5].textContent, 'Unknown assertion type "0" - choose one of the listed types.');
  assert.equal(document.querySelectorAll('script').length, scripts, 'the type was drawn as a script element');
  assert.deepEqual(listenerErrors, []);
});

test('choosing a listed type for a __proto__ row clears its note and leaves the other row\'s note in place', () => {
  openAssertions([{ type: '__proto__', op: 'eq', value: 1 }, { type: 'constructor', op: 'eq', value: 1 }]);
  const select = rows()[0].querySelector('.assert-type');
  select.value = 'latency';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(get().draft.assertions[0].type, 'latency');
  assert.equal(noteOf(rows()[0]), null);
  assert.equal(rows()[0].querySelector('.assert-type').hasAttribute('aria-describedby'), false);
  assert.equal(noteOf(rows()[1]).textContent, 'Unknown assertion type "constructor" - choose one of the listed types.');
  assert.equal(rows()[1].querySelector('.assert-type').getAttribute('aria-describedby'), noteOf(rows()[1]).id);
  assert.deepEqual(listenerErrors, []);
});

test('unknownTypeNote never reads through the prototype of what it is given', () => {
  const sneaky = Object.create({ toString: () => 'status' });
  assert.equal(unknownTypeNote(sneaky), 'Unknown assertion type - choose one of the listed types.');
  assert.equal(unknownTypeNote(Object.assign(Object.create(null), { a: 1 })), 'Unknown assertion type - choose one of the listed types.');
});

const field = (i) => `params.p${i}`;
const phrase = (i) => `parameter p${i} (256 characters, 32 words at most)`;

test('the cut sentence for none, one, exactly five, one more, and a hundred fields', () => {
  assert.equal(cutText([]), '');
  assert.equal(cutText(['', null, 3, {}]), '');
  assert.equal(cutText([field(0)]), `Cut to fit: ${phrase(0)}.`);
  const five = [0, 1, 2, 3, 4];
  assert.equal(cutText(five.map(field)), `Cut to fit: ${five.map(phrase).join('; ')}.`);
  assert.equal(cutText([...five, 5].map(field)), `Cut to fit: ${five.map(phrase).join('; ')}; and 1 more.`);
  const hundred = Array.from({ length: 100 }, (_, i) => field(i));
  assert.equal(cutText(hundred), `Cut to fit: ${five.map(phrase).join('; ')}; and 95 more.`);
  assert.equal(cutText([...hundred].reverse().concat(hundred)), `Cut to fit: ${[99, 98, 97, 96, 95].map(phrase).join('; ')}; and 95 more.`,
    'a field listed twice was counted twice');
});

test('the cut sentence takes only a list, and says inherited names and markup once each as text', () => {
  assert.equal(cutText('params.q'), '');
  assert.equal(cutText({ length: 2, 0: 'params.q', 1: 'name' }), '');
  assert.equal(cutText(null), '');
  const said = cutText(['__proto__', 'constructor', '__proto__', '<img src=x>', 'constructor']);
  assert.equal(said, 'Cut to fit: __proto__; constructor; <img src=x>.');
  const label = (i) => `Request ${i + 1}`;
  assert.equal(cutText(['sequence[0].__proto__', 'sequence[0].__proto__'], label), 'Cut to fit: Request 1, __proto__.');
  const long = cutText([`params.${'k'.repeat(5000)}`]);
  assert.ok(long.length < 300, `a 5,000 character field made a sentence of ${long.length}`);
});

test('a history verdict of any inherited name, or not text, is muted and puts nothing else in the class', () => {
  sidebar.init({});
  unsubscribe = subscribe((state) => sidebar.render(state));
  const verdicts = [...inherited, 'PASS ', 'pass', 'fail'];
  set({ history: verdicts.map((verdict, i) => ({
    id: `run-${i}`, mode: 'functional', status: 'completed', verdict,
    started_at: '2026-11-16T14:03:22Z', duration_ms: 100, summary: '1 passed',
  })) });
  const spans = [...byId('history-list').querySelectorAll('.history-verdict')];
  assert.equal(spans.length, verdicts.length);
  spans.forEach((span, i) => {
    assert.deepEqual(span.className.split(/\s+/), ['history-verdict', 'mono', 'muted'], `verdict ${JSON.stringify(verdicts[i])}`);
    assert.equal(span.textContent, verdicts[i]);
  });
  assert.deepEqual(listenerErrors, []);
});
