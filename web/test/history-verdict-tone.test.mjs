// A history row's verdict is coloured by the verdicts the page knows, and
// only by those: a verdict named like a property every object inherits is
// muted like any other it does not know, never coloured by that property.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);

let unsubscribe = null;

beforeEach(() => {
  resetBrowser();
  resetState();
  sidebar.init({});
  unsubscribe = subscribe((state) => sidebar.render(state));
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
});

const entry = (n, verdict) => ({
  id: `run-${n}`, mode: 'functional', status: 'completed', verdict,
  started_at: '2026-11-16T14:03:22Z', duration_ms: 100, summary: '1 passed',
});
const classesOf = (i) => [...byId('history-list').querySelectorAll('.history-verdict')][i].className.split(/\s+/);

test('a verdict named like an inherited property is muted and puts nothing else in the class', () => {
  const names = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
  set({ history: names.map((v, i) => entry(i + 1, v)) });
  names.forEach((v, i) => {
    assert.deepEqual(classesOf(i), ['history-verdict', 'mono', 'muted'], `verdict ${v}`);
  });
  assert.deepEqual(listenerErrors, []);
});

test('the three verdicts the server sends keep their colours', () => {
  set({ history: [entry(1, 'PASS'), entry(2, 'FAIL'), entry(3, 'N/A')] });
  assert.deepEqual(classesOf(0), ['history-verdict', 'mono', 'pass']);
  assert.deepEqual(classesOf(1), ['history-verdict', 'mono', 'fail']);
  assert.deepEqual(classesOf(2), ['history-verdict', 'mono', 'muted']);
});
