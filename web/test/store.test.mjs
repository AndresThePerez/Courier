import { test } from 'node:test';
import assert from 'node:assert/strict';
import './shim.mjs';
import * as store from '../js/store.js';

test('resetState puts the state back to how the page starts', () => {
  assert.equal(typeof store.resetState, 'function', 'store.js exports resetState');

  const state = store.get();
  store.set({
    sequence: [{ key: 'seq-1', enabled: true, request: { id: 'r1' } }],
    mode: 'performance',
    options: { ...state.options, concurrency: 50 },
    transport: 'sse',
  });
  assert.equal(store.get().sequence.length, 1);

  store.resetState();

  assert.deepEqual(store.get().sequence, []);
  assert.equal(store.get().mode, 'functional');
  assert.deepEqual(store.get().options, { stop_on_failure: false, delay_ms: 0, concurrency: 10, duration_secs: 10 });
  assert.equal(store.get().transport, 'idle');
  assert.ok(store.get() === state, 'the state object keeps its identity, so held references stay live');
});

test('resetState hands out fresh nested defaults, not the ones a test mutated', () => {
  store.resetState();
  store.get().options.concurrency = 3;
  store.get().workspace.push({ id: 'ws-1' });
  store.resetState();
  assert.equal(store.get().options.concurrency, 10);
  assert.deepEqual(store.get().workspace, []);
});

test('resetState drops keys a test added', () => {
  store.set({ extra: true });
  store.resetState();
  assert.equal('extra' in store.get(), false);
});

// topLevelKeys lists the keys an object literal names at its own level, from
// the text just inside its opening brace: nested brackets and strings are
// skipped, and spread and computed keys name nothing here.
function topLevelKeys(text, from) {
  const keys = [];
  let depth = 1;
  let part = '';
  const close = () => {
    const m = /^\s*(\w+)\s*(?::|$)/.exec(part);
    if (m) keys.push(m[1]);
    part = '';
  };
  for (let i = from; i < text.length && depth > 0; i += 1) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      let end = i + 1;
      while (end < text.length && text[end] !== c) end += text[end] === '\\' ? 2 : 1;
      i = end;
      if (depth === 1) part += 'S';
      continue;
    }
    if ('{[('.includes(c)) depth += 1;
    else if ('}])'.includes(c)) depth -= 1;
    if (depth === 0) break;
    if (depth === 1 && c === ',') close();
    else if (depth === 1 && !'}])'.includes(c)) part += c;
  }
  close();
  return keys;
}

// Every key a page module puts into the state through set() is declared in
// initialState, with the value the page starts from, so a reader of store.js
// sees the whole state and resetState gives a test the page's first state.
test('every key a page module sets is declared in the initial state', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../js/', import.meta.url);
  store.resetState();
  const declared = new Set(Object.keys(store.get()));
  const undeclared = new Set();
  let seen = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    for (const m of text.matchAll(/\b(?:set|storeSet)\(\{/g)) {
      for (const key of topLevelKeys(text, m.index + m[0].length)) {
        seen += 1;
        if (!declared.has(key)) undeclared.add(`${f} ${key}`);
      }
    }
  }
  assert.ok(seen > 40, `only ${seen} keys were found: the scan reads nothing`);
  assert.deepEqual([...undeclared].sort(), []);
});

test('the history keys start as a page that has not yet asked for history', () => {
  store.set({ historyLoaded: true, historyNotice: 'Could not load history from the server.', historyLoading: true });
  store.resetState();
  assert.equal(store.get().historyLoaded, false);
  assert.equal(store.get().historyNotice, '');
  assert.equal(store.get().historyLoading, false);
});
