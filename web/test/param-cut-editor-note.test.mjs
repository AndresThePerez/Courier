// A parameter value can be typed whatever its length: the value box carries
// no maxlength, which a browser counts in UTF-16 units and would stop at 128
// characters outside the BMP, or freeze a stored value already over it.
// Instead a note under the parameter table says, before anything is sent,
// which value the server will cut, by the page's own cut (cutParamValue). It
// changes only when a value crosses the limit, so it is announced once per
// crossing, not on every keystroke.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as sidebar from '../js/render-sidebar.js';
import { cutParamValue } from '../js/storage.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q', 'page'] }];
const request = (params) => ({ id: 'ws-p', name: 'P', endpoint: 'search', params, assertions: [] });

let unsubscribe = null;

function open(params) {
  localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: [request(params)] }));
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
const box = (i = 0) => byId('param-rows').querySelectorAll('.param-value')[i];
const one = (key) => `Parameter ${key} is longer than 256 characters or 32 words - it will be cut to fit when sent.`;
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const Emoji = '\u{1F600}';

test('the value box carries no maxlength', () => {
  open({ q: 'a' });
  assert.equal(box().hasAttribute('maxlength'), false, `maxlength="${box().getAttribute('maxlength')}"`);
});

test('the note appears when a value crosses either limit, and goes when it fits again', () => {
  open({ q: 'a' });
  const n = noteEl();
  assert.equal(n.getAttribute('role'), 'status');
  assert.equal(note(), '');

  typeInto(box(), 'a'.repeat(256));
  assert.equal(note(), '', '256 characters fit');
  typeInto(box(), 'a'.repeat(257));
  assert.equal(note(), one('q'));
  assert.equal(get().draft.params.q, 'a'.repeat(257), 'the value typed is kept whole');

  typeInto(box(), words(32));
  assert.equal(note(), '', '32 words fit');
  typeInto(box(), words(33));
  assert.equal(note(), one('q'));

  typeInto(box(), 'short');
  assert.equal(note(), '');
  assert.equal(noteEl().hidden, true);
  assert.deepEqual(listenerErrors, []);
});

test('typing on past the limit does not rewrite the note, so it is not announced again', () => {
  open({ q: 'a'.repeat(300) });
  const said = noteEl().firstChild;
  assert.ok(said, 'no note for a stored value over the limit');
  typeInto(box(), 'a'.repeat(301));
  typeInto(box(), `${'a'.repeat(301)} b`);
  assert.ok(noteEl().firstChild === said, 'the note was rewritten on a keystroke that did not cross the limit');
  assert.equal(note(), one('q'));
});

test('characters outside the BMP count as one each, as the server counts them', () => {
  open({ q: '' });
  typeInto(box(), Emoji.repeat(256));
  assert.equal(note(), '', '256 emoji are 512 UTF-16 units but 256 characters');
  assert.equal(get().draft.params.q, Emoji.repeat(256));
  typeInto(box(), Emoji.repeat(257));
  assert.equal(note(), one('q'));
});

test('the note follows the page\'s own cut, case by case', () => {
  open({ q: '' });
  const cases = ['', ' '.repeat(300), `${words(32)}   `, `   ${words(32)}`, `${words(32)}\u00a0w`, `${words(32)}\u200bw`, 'x'.repeat(255) + Emoji];
  for (const value of cases) {
    typeInto(box(), value);
    const cut = cutParamValue(value) !== value;
    assert.equal(note(), cut ? one('q') : '', `${JSON.stringify(value.slice(0, 40))}...`);
  }
});

test('a stored value over the limit says so as soon as it is opened, and names every value that will be cut', () => {
  open({ q: words(40), page: 'x'.repeat(300) });
  assert.equal(note(), 'Parameters q and page are longer than 256 characters or 32 words - they will be cut to fit when sent.');
  typeInto(box(1), '2');
  assert.equal(note(), one('q'));
});

test('a parameter name is shown as text and clipped', () => {
  const key = `<b>${'k'.repeat(200)}</b>`;
  open({ [key]: 'x'.repeat(300) });
  assert.equal(noteEl().children.length, 0, 'the name was drawn as markup');
  assert.match(note(), /^Parameter <b>k+\.\.\. is longer than/);
  assert.ok(note().length < 200, `the note is ${note().length} characters long`);
});
