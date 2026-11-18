import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser } from './shim.mjs';
import { resetState, get, set } from '../js/store.js';
import * as runner from '../js/render-runner.js';

const req = (n) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: {}, assertions: [] });

function collection(size) {
  return { id: 'c', name: 'C', requests: Array.from({ length: size }, (_, i) => req(i + 1)) };
}

function queue(size) {
  set({ sequence: Array.from({ length: size }, (_, i) => ({ key: `seed-${i}`, enabled: true, request: req(100 + i) })) });
}

beforeEach(() => {
  resetBrowser();
  resetState();
});

test('a collection that does not fit is added up to the cap and the note says how far', () => {
  queue(48);
  runner.addAll(collection(5));
  runner.render(get());

  assert.equal(get().sequence.length, 50);
  const note = document.getElementById('sequence-note');
  assert.equal(note.textContent, 'Added 2 of 5 - 50 requests is the cap.');
  assert.equal(note.hidden, false);
  assert.equal(document.getElementById('sequence-count').textContent, '50 of 50 - 50 selected');
});

test('a full sequence refuses another request and says why', () => {
  queue(50);
  runner.add(req(1));

  assert.equal(get().sequence.length, 50);
  assert.equal(document.getElementById('sequence-note').textContent,
    '50 requests is the cap - remove one before adding another.');
});

test('a collection that fits is added whole with no note', () => {
  queue(45);
  runner.addAll(collection(5));
  runner.render(get());

  assert.equal(get().sequence.length, 50);
  assert.equal(document.getElementById('sequence-note').hidden, true);
});
