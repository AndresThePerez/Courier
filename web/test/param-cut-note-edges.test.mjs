// The will-be-cut note against the cut itself, over generated values built
// from the characters the rule treats specially, and in the editor: a stored
// value far over the limit still takes typing, and the note is rewritten only
// when a keystroke crosses the limit.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';
import { cutParamValue, MaxParamValue, MaxParamWords } from '../js/storage.js';
import { paramCutNote } from '../js/request-model.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];

let unsubscribe = null;

function open(q) {
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: [
    { id: 'ws-p', name: 'P', endpoint: 'search', params: { q }, assertions: [] },
  ] }));
  workspace.init();
  editor.init();
  unsubscribe = subscribe((state) => editor.render(state));
  set({ endpoints });
  sidebar.selectRequest(workspace.find('ws-p'));
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

const noteEl = () => byId('param-cut-note');
const note = () => (noteEl().hidden ? '' : noteEl().textContent);
const box = () => byId('param-rows').querySelector('.param-value');
const one = `Parameter q is longer than ${MaxParamValue} characters or ${MaxParamWords} words - it will be cut to fit when sent.`;

// Every white-space character Go's unicode.IsSpace knows, the ones it does not
// that JavaScript's \s does, and characters that are one code point but two
// UTF-16 units, combining, or lone halves of a pair.
const spaces = ['\t', '\n', '\u000b', '\u000c', '\r', ' ', '\u0085', '\u00a0', '\u1680',
  '\u2000', '\u2005', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000'];
const lookalikes = ['\ufeff', '\u200b', '\u180e'];
const others = ['a', 'Z', '\u{1F600}', '\u{1F469}\u200d\u{1F4BB}', 'e\u0301', '\u0301', '\ud800', '\udfff', '\u4e00'];

function generated() {
  let seed = 11;
  const next = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pools = [spaces, lookalikes, others, others, others];
  const values = [];
  for (let i = 0; i < 400; i += 1) {
    // Lengths cluster around both limits: 30 to 34 words, 250 to 262 code points.
    const target = [MaxParamValue - 6 + next(13), 60 + next(40), 2 * MaxParamWords + next(10)][next(3)];
    let v = '';
    while (Array.from(v).length < target) {
      const pool = pools[next(pools.length)];
      v += pool[next(pool.length)];
    }
    values.push(v);
  }
  return values;
}

test('over generated values near both limits, the note is shown exactly when the cut changes the value', () => {
  let cut = 0;
  for (const v of generated()) {
    const changes = cutParamValue(v) !== v;
    if (changes) cut += 1;
    assert.equal(paramCutNote({ q: v }), changes ? one : '', JSON.stringify(v.slice(0, 60)));
  }
  assert.ok(cut > 20 && cut < 380, `${cut} of 400 generated values are cut; the cases do not straddle the limits`);
});

test('in the editor too, keystroke by keystroke over generated values, the note follows the cut', () => {
  open('');
  for (const v of generated().slice(0, 120)) {
    typeInto(box(), v);
    assert.equal(note(), cutParamValue(v) !== v ? one : '', JSON.stringify(v.slice(0, 60)));
    assert.equal(get().draft.params.q, v, 'the value typed was not kept whole');
  }
  assert.deepEqual(listenerErrors, []);
});

test('a stored value of 5,000 characters takes typing, keeps every character, and says it will be cut', () => {
  const stored = 'x'.repeat(5000);
  open(stored);
  assert.equal(box().value, stored);
  assert.equal(note(), one);
  typeInto(box(), `${stored}y`);
  assert.equal(get().draft.params.q, `${stored}y`);
  typeInto(box(), `\u{1F600}${stored}`);
  assert.equal(get().draft.params.q, `\u{1F600}${stored}`);
  assert.equal(note(), one);
  typeInto(box(), stored.slice(0, MaxParamValue));
  assert.equal(note(), '');
  assert.equal(noteEl().hidden, true);
  assert.deepEqual(listenerErrors, []);
});

test('the note is rewritten once per crossing across many keystrokes on either side of the limit', () => {
  open('');
  const el = noteEl();
  const proto = Object.getPrototypeOf(el);
  let owner = proto;
  while (owner && !Object.getOwnPropertyDescriptor(owner, 'textContent')) owner = Object.getPrototypeOf(owner);
  const real = Object.getOwnPropertyDescriptor(owner, 'textContent');
  let writes = 0;
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get() { return real.get.call(this); },
    set(v) { writes += 1; real.set.call(this, v); },
  });

  let value = '';
  const type = (v) => { value = v; typeInto(box(), value); };
  for (let i = 0; i < MaxParamValue; i += 1) type(`${value}a`);
  assert.equal(writes, 0, 'the note was written while every value fitted');
  for (let i = 0; i < 40; i += 1) type(`${value}b`);
  assert.equal(writes, 1, 'the note was written more than once while over the limit');
  for (let i = 0; i < 40; i += 1) type(value.slice(0, -1));
  assert.equal(writes, 2, 'coming back under the limit was not one write');
  for (let i = 0; i < 20; i += 1) type(value.slice(0, -1));
  assert.equal(writes, 2, 'the note was written again under the limit');
  assert.equal(note(), '');
  assert.deepEqual(listenerErrors, []);
});
