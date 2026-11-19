// Over generated sequences of edits, refusals and repaints, each value box's
// aria-describedby holds exactly the ids of the notes that apply to it now:
// "param-cut-note" while its value will be cut, "param-error" while a refusal
// mark describes it, each once, and no attribute when neither applies.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import { cutParamValue } from '../js/storage.js';

const byId = (id) => document.getElementById(id);
const Long = 'x'.repeat(300);
const Wordy = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');

let unsubscribe = null;

function boot(keys) {
  if (unsubscribe) unsubscribe();
  resetBrowser();
  resetState();
  workspace.init();
  set({ endpoints: [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: keys }] });
  editor.init();
  runner.init({ refresh: async () => {} });
  unsubscribe = subscribe((state) => { editor.render(state); runner.render(state); });
  const params = Object.fromEntries(keys.map((k) => [k, 'a']));
  sidebar.selectRequest({ id: 'ws-g', name: 'G', endpoint: 'search', params, assertions: [] });
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
});

const boxes = () => [...byId('param-rows').querySelectorAll('.param-value')];
const ids = (control) => {
  const raw = control.getAttribute('aria-describedby');
  if (raw === '') assert.fail('aria-describedby is present but empty');
  return raw === null ? [] : raw.split(' ');
};

// check holds every box to the notes that apply: the cut note by the page's
// own cut, the refusal by the mark the page shows (aria-invalid on the box,
// or an error at the end of the table, which describes every box).
const seen = { cut: 0, boxMark: 0, tableMark: 0, both: 0 };

function check(keys, what) {
  const tableMark = [...byId('param-rows').children].some((c) => c.classList.contains('field-error'));
  const params = get().draft.params;
  boxes().forEach((box, i) => {
    const want = [];
    const v = params[keys[i]];
    if (typeof v === 'string' && cutParamValue(v) !== v) want.push('param-cut-note');
    if (tableMark || box.getAttribute('aria-invalid') === 'true') want.push('param-error');
    if (want.includes('param-cut-note')) seen.cut += 1;
    if (box.getAttribute('aria-invalid') === 'true') seen.boxMark += 1;
    if (tableMark) seen.tableMark += 1;
    if (want.length === 2) seen.both += 1;
    const got = ids(box);
    assert.equal(new Set(got).size, got.length, `${what}: box ${keys[i]} names an id twice: ${got.join(' ')}`);
    assert.deepEqual([...got].sort(), want.sort(), `${what}: box ${keys[i]}`);
    for (const id of got) assert.ok(byId(id), `${what}: box ${keys[i]} is described by ${id}, which is not on the page`);
  });
}

async function run(keys, seed, steps) {
  boot(keys);
  for (const k of Object.keys(seen)) seen[k] = 0;
  let s = seed;
  const next = (n) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    // The high bits: the low bits of this generator repeat with a short period.
    return Math.floor(s / 65536) % n;
  };
  for (let step = 0; step < steps; step += 1) {
    const op = next(5);
    const what = `seed ${seed}, step ${step}, op ${op}`;
    if (op <= 1) {
      const key = keys[next(keys.length)];
      const box = boxes()[keys.indexOf(key)];
      typeInto(box, ['a', Long, Wordy, 'b'.repeat(256), `${Long}y`, ''][next(6)]);
    } else if (op === 2) {
      const field = [...keys.map((k) => `params.${k}`), 'params', 'params.unlisted'][next(keys.length + 2)];
      fetchStub.respond('/api/send', { status: 400, body: { error: 'refused', field } }, { method: 'POST' });
      byId('send-request').click();
      await flush();
    } else if (op === 3) {
      set({ status: { running: false, budget_balance: 10 + step } });
    } else {
      fetchStub.respond('/api/send', { status: 200, body: { status: 200, passed: true, endpoint: 'search', query: '?q=x', latency_ms: 1, size_bytes: 2, body: '{}', assertions: [] } }, { method: 'POST' });
      byId('send-request').click();
      await flush();
    }
    check(keys, what);
  }
  for (const [k, n] of Object.entries(seen)) assert.ok(n > 0, `the sequence never reached a state with ${k}; it proves less than it says`);
  assert.deepEqual(listenerErrors, []);
}

for (const seed of [1, 2, 3, 5, 8]) {
  test(`generated edits, refusals and repaints keep each box described by exactly the notes that apply (seed ${seed})`, async () => {
    await run(['q', 'page'], seed, 120);
  });
}

test('boxes whose names are inherited property names or markup are described the same way', async () => {
  await run(['__proto__', 'constructor', '<img src=x onerror=1>'], 13, 120);
  assert.equal(byId('param-rows').querySelectorAll('img').length, 0, 'a name was drawn as markup');
});
