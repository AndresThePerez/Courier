// Which user actions write the run setup, and which renders, polls and loads
// must not: a setup written in a loop, or by a poll, would hammer storage and
// overwrite another tab's last word.
//
// The knee buttons are built on the first render of a page, and this file's
// first test renders the runner before it clicks one.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, typeInto, listenerErrors } from './shim.mjs';
import { resetState, get, set } from '../js/store.js';
import * as runner from '../js/render-runner.js';

const KEY = 'courier.runner.v1';
const byId = (id) => document.getElementById(id);
const req = (n, extra = {}) => ({ id: `h${n}`, name: `Hostile ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [{ type: 'status', op: 'eq', value: 200 }], ...extra });
const valid = (sequence, extra = {}) => JSON.stringify({ version: 1, sequence, mode: 'functional', options: {}, ...extra });

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

function countingStorage() {
  const writes = [];
  const real = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => { writes.push([k, v]); return real(k, v); };
  return {
    writes,
    done() { delete localStorage.setItem; },
  };
}

test('restoring, rendering and ten status polls write nothing, and every user change writes exactly once, matching the page', () => {
  localStorage.setItem(KEY, valid([{ enabled: true, request: req(1) }, { enabled: true, request: req(2) }]));
  const spy = countingStorage();
  try {
    runner.init({});
    runner.restore();
    runner.render(get());
    for (let i = 0; i < 10; i += 1) {
      set({ status: { running: false, budget_balance: 1500 - i } });
      runner.render(get());
    }
    byId('concurrency').dispatchEvent(new Event('blur'));
    assert.equal(spy.writes.length, 0, 'no write without a user change');

    const changes = [
      ['add', () => runner.add(req(3))],
      ['uncheck', () => byId('sequence-list').querySelectorAll('input[type="checkbox"]')[0].click()],
      ['move down', () => [...byId('sequence-list').querySelectorAll('button')].find((b) => b.title === 'Move Hostile 2 down').click()],
      ['remove', () => [...byId('sequence-list').querySelectorAll('button')].find((b) => b.title === 'Remove from the run').click()],
      ['mode', () => byId('mode-performance').click()],
      ['concurrency', () => typeInto(byId('concurrency'), '33')],
      ['duration', () => typeInto(byId('duration-secs'), '12')],
      ['delay', () => typeInto(byId('delay-ms'), '40')],
      ['stop on failure', () => byId('stop-on-failure').click()],
      ['select all', () => byId('select-all').click()],
      ['deselect all', () => byId('deselect-all').click()],
      ['knee preset', () => {
        set({ collections: [{ id: 'search-basics', name: 'Search', requests: [req(21), req(22)] }] });
        runner.render(get());
        [...byId('knee-buttons').querySelectorAll('button')][3].click();
      }],
      ['clear the sequence', () => { while (get().sequence.length) [...byId('sequence-list').querySelectorAll('button')].find((b) => b.title === 'Remove from the run').click(); }],
    ];
    for (const [label, change] of changes) {
      const before = spy.writes.length;
      runner.render(get());
      change();
      const n = spy.writes.length - before;
      if (label === 'clear the sequence') assert.ok(n >= 1, label);
      else assert.equal(n, 1, `${label} writes exactly once (wrote ${n})`);
      const stored = JSON.parse(localStorage.peek(KEY));
      assert.deepEqual(stored.sequence.map((e) => [e.enabled, e.request.id]), get().sequence.map((e) => [e.enabled, e.request.id]), label);
      assert.equal(stored.mode, get().mode, label);
      assert.deepEqual(stored.options, get().options, label);
    }
    assert.deepEqual(listenerErrors, [], 'a handler threw');
    assert.deepEqual(get().sequence, []);
    assert.equal(JSON.parse(localStorage.peek(KEY)).mode, 'performance');
    assert.equal(JSON.parse(localStorage.peek(KEY)).options.concurrency, 50, 'the 50-worker preset');
  } finally {
    spy.done();
  }
});
