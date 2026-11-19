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
  const rule = markRule();
  assert.ok(rule.selectors.includes('.res-mark') && rule.selectors.includes(`.${s[1]}`), `the column is held by ${rule.selectors.join(', ')}`);
  assert.match(rule.body, /flex:\s*0 0 [\d.]+rem/, 'the mark column neither grows nor shrinks');
  assert.deepEqual(listenerErrors, []);
});

// markRule is the stylesheet rule that sizes the mark column: its selectors
// and its declarations, comments left out.
function markRule() {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)]
    .map((m) => ({ selectors: m[1].split(',').map((x) => x.trim()), body: m[2] }))
    .filter((r) => r.selectors.includes('.res-mark'));
  assert.equal(rules.length, 1, `rules for .res-mark: ${rules.length}`);
  return rules[0];
}

// The mark holds one line on every row: the longest mark the page draws,
// "no checks", fits its column at the 14px root without wrapping, so every
// row of a run that asserted nothing is as tall as one that passed. A
// character of the monospace font the mark is set in is under 0.65em wide.
test('every mark, PASS, FAIL or no checks, fits its column on one line', () => {
  live([
    row(0),
    row(1, { passed: false, assertions: [{ assertion: { type: 'status', op: 'eq', value: 201 }, passed: false, expected: '201', actual: '200' }] }),
    row(2, { assertions: [] }),
  ]);
  const marks = [...byId('results-rows').querySelectorAll('.res-head')].map((h) => h.children[1]);
  assert.deepEqual(marks.map((m) => m.textContent), ['PASS', 'FAIL', 'no checks'], 'the marks are not the case');
  for (const m of marks) assert.ok(m.classList.contains('res-mark') && m.classList.contains('mono'), `mark classes "${m.className}"`);

  const rule = markRule();
  assert.match(rule.body, /white-space:\s*nowrap/, 'the mark may wrap');
  const basis = /flex:\s*0 0 ([\d.]+)rem/.exec(rule.body);
  const font = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(rule.body);
  assert.ok(basis && font, `the column's width or the mark's font size is not where the estimate reads it: ${rule.body}`);
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rootRule = /(?:^|\})\s*html\s*,\s*body\s*\{([^}]*)\}/.exec(css);
  const root = rootRule && /font:\s*(\d+(?:\.\d+)?)px/.exec(rootRule[1]);
  assert.ok(root, 'the root font size is not set in px');
  const longest = Math.max(...marks.map((m) => m.textContent.length));
  const needed = (longest * 0.65 * Number(font[1])) / Number(root[1]);
  assert.ok(Number(basis[1]) >= needed, `${basis[1]}rem is under the ${needed.toFixed(2)}rem "no checks" needs`);
  assert.deepEqual(listenerErrors, []);
});

// The status pill holds one column on every row, so the method and the name
// after it start at the same place whatever the pill says. The column is wide
// enough for the longest text the page draws there: an upper-case letter of
// the pill font is under 0.8em wide with its 0.06em letter spacing, and the
// pill adds its padding a side and a 1px border. A rem is the root's font
// size, which the stylesheet sets on html, so every size is read from it.
test('every row\'s status pill, a code, no response or skipped, holds one column wide enough for the longest of them', () => {
  live([
    row(0),
    row(1, { status: 0, passed: false, error: 'could not connect to the target', error_kind: 'connection', assertions: [] }),
    row(2, { status: 0, passed: false, skipped: true, assertions: [] }),
  ]);
  const pills = [...byId('results-rows').querySelectorAll('.res-head')].map((h) => h.children[2]);
  assert.deepEqual(pills.map((p) => p.textContent), ['200', 'no response', 'skipped'], 'the pills are not the case');
  for (const p of pills) assert.ok(p.classList.contains('pill') && p.classList.contains('res-status'), `pill classes "${p.className}"`);

  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const m = /(?:^|\})\s*\.pill\.res-status\s*\{([^}]*)\}/.exec(css);
  assert.ok(m, 'no rule for .pill.res-status');
  const basis = /flex:\s*0 0 ([\d.]+)rem/.exec(m[1]);
  assert.ok(basis, `the column neither grows nor shrinks: ${m[1]}`);
  const longest = Math.max(...pills.map((p) => p.textContent.length));
  const rootRule = /(?:^|\})\s*html\s*,\s*body\s*\{([^}]*)\}/.exec(css);
  assert.ok(rootRule, 'no rule for html, body');
  const root = /font:\s*(\d+(?:\.\d+)?)px/.exec(rootRule[1]);
  assert.ok(root, `the root font size is not set in px: ${rootRule[1]}`);
  const pillRule = /(?:^|\})\s*\.pill\s*\{([^}]*)\}/.exec(css);
  assert.ok(pillRule, 'no rule for .pill');
  const pillFont = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(pillRule[1]);
  const pad = /padding:\s*[\d.]+rem\s+([\d.]+)rem/.exec(pillRule[1]);
  assert.ok(pillFont && pad, `the pill's font size or padding is not where the estimate reads it: ${pillRule[1]}`);
  const rem = Number(root[1]);
  const needed = (longest * 0.8 * Number(pillFont[1]) + 2 * Number(pad[1]) * rem + 2) / rem;
  assert.ok(Number(basis[1]) >= needed, `${basis[1]}rem is under the ${needed.toFixed(2)}rem "${'x'.repeat(longest)}" needs`);
  assert.match(m[1], /text-align:\s*center/);
  assert.deepEqual(listenerErrors, []);
});
