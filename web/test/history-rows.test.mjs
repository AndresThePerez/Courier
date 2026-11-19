// The history list: every run the server keeps, each with the day as well as
// the time it started, and the verdict it earned.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as sidebar from '../js/render-sidebar.js';
import { fmtDateTime, fmtTime } from '../js/dom.js';

const byId = (id) => document.getElementById(id);
const flat = (s) => s.replace(/\s/g, ' ');

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

const entry = (n, extra = {}) => ({
  id: `run-${n}`, mode: 'functional', status: 'completed',
  started_at: `2026-11-${String(10 + (n % 10)).padStart(2, '0')}T14:03:${String(n).padStart(2, '0')}Z`,
  duration_ms: 100 + n, summary: `${n} passed`, ...extra,
});
const rows = () => [...byId('history-list').querySelectorAll('.req-open')];

test('the date formatter writes the month, the day and the time in the zone and locale it is given', () => {
  const at = '2026-11-16T14:03:22Z';
  assert.equal(flat(fmtDateTime(at, { locale: 'en-US', timeZone: 'UTC' })), 'Nov 16, 2:03:22 PM');
  assert.equal(flat(fmtDateTime(at, { locale: 'en-GB', timeZone: 'UTC' })), '16 Nov, 14:03:22');
  assert.equal(flat(fmtDateTime(at, { locale: 'en-US', timeZone: 'America/New_York' })), 'Nov 16, 9:03:22 AM');
  assert.equal(flat(fmtDateTime('2026-11-16T23:30:00Z', { locale: 'en-GB', timeZone: 'Asia/Tokyo' })), '17 Nov, 8:30:00', 'the day is not the zone\'s');
});

test('the date formatter answers a dash for a time it cannot read', () => {
  assert.equal(fmtDateTime(''), '-');
  assert.equal(fmtDateTime(undefined), '-');
  assert.equal(fmtDateTime('not a time'), '-');
});

test('the visitor\'s own locale and zone are used when none is given', () => {
  const at = '2026-11-16T14:03:22Z';
  const own = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(at));
  assert.equal(fmtDateTime(at), own);
});

test('a history row shows the day as well as the time its run started', () => {
  set({ history: [entry(1)] });
  const text = rows()[0].textContent;
  assert.ok(text.includes(fmtDateTime(entry(1).started_at)), `"${text}" has no date`);
  assert.notEqual(fmtDateTime(entry(1).started_at), fmtTime(entry(1).started_at));
  assert.deepEqual(listenerErrors, []);
});

test('every run the server returns is listed, twenty of them included, in the order it gave', () => {
  const list = Array.from({ length: 20 }, (_, i) => entry(i + 1));
  set({ history: list });
  assert.deepEqual(rows().map((r) => r.title), list.map((e) => `${e.id} - ${e.summary}`));
});

test('a row shows the verdict its run earned, coloured by it, and nothing when there is none', () => {
  set({ history: [entry(1, { verdict: 'PASS' }), entry(2, { verdict: 'FAIL' }), entry(3, { verdict: 'N/A' }), entry(4)] });
  const marks = rows().map((r) => {
    const v = r.querySelector('.history-verdict');
    return v ? [v.textContent, ['pass', 'fail', 'muted'].filter((c) => v.classList.contains(c))] : null;
  });
  assert.deepEqual(marks, [['PASS', ['pass']], ['FAIL', ['fail']], ['N/A', ['muted']], null]);
});
