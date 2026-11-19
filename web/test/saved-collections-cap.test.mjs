// The saved-collections cap stops Save sequence in this tab; it does not cut
// what is stored, and the sidebar lists every stored collection, however many
// another tab put there.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, typeInto } from './shim.mjs';
import { resetState, get } from '../js/store.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const SAVED_LIST = 'courier.collections.v1';
const byId = (id) => document.getElementById(id);
const req = (n) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [] });
const collection = (n) => ({ id: `wc-${n}`, name: `Saved ${n}`, requests: [req(n)] });

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
  runner.init({});
  sidebar.init({ addAll: (c) => runner.addAll(c) });
});

test('more stored collections than the cap are all listed, and Save sequence saves no more', () => {
  localStorage.setItem(SAVED_LIST, JSON.stringify({ version: 1, collections: Array.from({ length: 53 }, (_, i) => collection(i + 1)) }));
  runner.savedCollections.init();
  sidebar.render(get());
  assert.equal(byId('saved-collections').querySelectorAll('details[data-id]').length, 53, 'every stored collection is listed');

  runner.add(req(1));
  runner.render(get());
  typeInto(byId('save-sequence-name'), 'One more');
  byId('save-sequence').click();
  assert.equal(byId('sequence-note').textContent, '50 saved collections is the cap - delete one before saving another.');
  assert.equal(JSON.parse(localStorage.getItem(SAVED_LIST)).collections.length, 53, 'nothing was saved, and nothing was cut');
});
