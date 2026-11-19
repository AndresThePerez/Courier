// A line of text with no break opportunity in it (a 256-character parameter
// value with no space, 32 words joined by +, an 80-character field name the
// page does not know) wraps inside its box rather than widening the pane it
// sits in. Layout itself is checked in a browser; this holds the elements to
// their class and the stylesheet to the rule that wraps them.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetBrowser, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const long = 'x'.repeat(256);
const joined = Array.from({ length: 32 }, (_, i) => `w${i}`).join('+');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// rule is the body of the stylesheet's rule whose selector list names sel.
function rule(sel) {
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (m[1].split(',').map((s) => s.trim()).includes(sel)) return m[2];
  }
  return null;
}

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  if (unsubscribe) unsubscribe();
  resetBrowser();
  resetState();
  workspace.init();
  set({ endpoints });
  editor.init();
  runner.init({ refresh: async () => {} });
  unsubscribe = subscribe((state) => { editor.render(state); runner.render(state); });
});

for (const [what, q] of [['a 256-character value with no space', long], ['32 words joined by +', joined]]) {
  test(`the request line of a Send answer, for ${what}, is the line that wraps anywhere`, async () => {
    sidebar.selectRequest({ id: 'ws-long', name: 'Long', endpoint: 'search', params: { q }, assertions: [] });
    fetchStub.respond('/api/send', { status: 200, body: { status: 200, passed: true, endpoint: 'search', query: `?q=${q}`, latency_ms: 1, size_bytes: 2, body: '{}', assertions: [] } }, { method: 'POST' });
    byId('send-request').click();
    await flush();
    const line = [...byId('send-response').querySelectorAll('p')].find((p) => p.textContent === `GET /search?q=${q}`);
    assert.ok(line, 'the request line is not drawn; the case proves nothing');
    assert.ok(line.classList.contains('sent-line'), `the request line's classes are "${line.className}"`);
    assert.ok(line.classList.contains('note') && line.classList.contains('mono'), 'the line no longer looks like a note');
    assert.deepEqual(listenerErrors, []);
  });
}

test('the stylesheet wraps the request line and both cut sentences anywhere, and no other note', () => {
  for (const sel of ['.note.sent-line', '#send-cut', '#start-cut']) {
    const body = rule(sel);
    assert.ok(body !== null, `no rule names ${sel}`);
    assert.match(body, /overflow-wrap:\s*anywhere/, `${sel} does not wrap anywhere`);
  }
  assert.equal(rule('.note'), ' color: var(--muted); font-size: 11px; line-height: 1.45; ', 'the rule every note shares changed');
});
