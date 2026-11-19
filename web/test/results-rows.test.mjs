// A functional run's result rows, read as painted: a row delivered again
// under the same index shows what it now holds, and a render that changes
// nothing a row shows leaves the rows as they are.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as results from '../js/render-results.js';

const byId = (id) => document.getElementById(id);
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];

let unsubscribe = null;
let seq = 0;

beforeEach(() => {
  resetBrowser();
  resetState();
  unsubscribe = subscribe((state) => results.render(state));
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
});

const row = (index, extra = {}) => ({
  index, name: `R${index}`, endpoint: 'search', query: '?q=a', status: 200, latency_ms: 4, size_bytes: 10, passed: true, skipped: false,
  assertions: [{ assertion: { type: 'status', op: 'eq', value: 200 }, passed: true, expected: '200', actual: '200' }], ...extra,
});

// live puts a functional run on screen as the live state holds one before
// its report: the run, and the rows delivered so far.
function live(rows) {
  seq += 1;
  const id = `run-${seq}`;
  set({ endpoints, transport: 'sse', run: { id, mode: 'functional', total: rows.length, started_at: '2026-11-18T10:00:00Z', config: {}, entries: [] }, report: null, results: rows });
  return id;
}

const shown = () => [...byId('results-rows').querySelectorAll('.res-row')];
const bodyNote = (r) => [...r.querySelectorAll('.res-detail > .note')].map((n) => n.textContent).join(' ');

test('a row delivered again under the same index paints what it now holds', () => {
  // The polling fallback delivers a row without its body preview; the stream
  // then delivers the same row with it.
  live([row(0), row(1)]);
  shown()[1].open = true;
  shown()[1].dispatchEvent(new Event('toggle'));
  assert.match(bodyNote(shown()[1]), /arrives with the finished report/, 'the case starts without a preview');

  const rows = get().results.slice();
  rows[1] = row(1, { body_preview: '{"total":3}' });
  set({ results: rows });

  const after = shown();
  assert.equal(after.length, 2);
  assert.doesNotMatch(bodyNote(after[1]), /arrives with the finished report/, 'the row still says its body is to come');
  assert.match(after[1].querySelector('.res-detail').textContent, /total/);
  assert.equal(after[1].open, true, 'the row the visitor opened was closed');
  assert.deepEqual(listenerErrors, []);
});

test('a render that changes no row leaves the very same row nodes in place', () => {
  live([row(0), row(1)]);
  const before = shown();
  set({ status: { running: true, run_id: get().run.id } });
  set({ progress: null });
  const after = shown();
  assert.equal(after.length, 2);
  after.forEach((r, i) => assert.ok(r === before[i], `row ${i + 1} was rebuilt`));
  assert.deepEqual(listenerErrors, []);
});

// cellsOf is a row head's cells by their first class, in order.
const cellsOf = (head) => [...head.children].map((c) => c.className.split(' ')[0]);

test('a skipped row has the same head cells in the same order as a passed one, its mark cell empty and silent', () => {
  live([row(0), row(1, { status: 0, passed: false, skipped: true, assertions: [] })]);
  const [passed, skipped] = [...byId('results-rows').querySelectorAll('.res-head')];
  const p = cellsOf(passed);
  const s = cellsOf(skipped);
  assert.equal(s.length, p.length, `cells: ${s.join(', ')} against ${p.join(', ')}`);
  assert.deepEqual(s.filter((_, i) => i !== 1), p.filter((_, i) => i !== 1), 'the cells around the mark moved');
  assert.equal(p[1], 'res-mark');

  const empty = skipped.children[1];
  assert.equal(empty.textContent, '', 'a skipped row wears a mark');
  assert.equal(empty.getAttribute('aria-hidden'), 'true', 'the empty cell is announced');
  assert.equal(skipped.querySelector('.res-mark'), null, 'a skipped row counts as marked');

  // The empty cell holds the mark's column: it takes the mark's own width.
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const rule = css.match(/([^{}]*)\{[^}]*flex: 0 0 4\.2rem[^}]*\}/);
  assert.ok(rule, 'the mark column rule');
  const selectors = rule[1].split(',').map((x) => x.trim().split('\n').pop().trim());
  assert.ok(selectors.includes('.res-mark') && selectors.includes(`.${s[1]}`), `the column is held by ${selectors.join(', ')}`);
  assert.deepEqual(listenerErrors, []);
});
