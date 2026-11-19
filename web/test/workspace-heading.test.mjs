// The My Workspace heading: its name is the section's name, the "saved in
// this browser only" badge sits in it beside that name, and Reset is a
// control of its own beside the heading rather than part of it, still
// opening the same inline confirm.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';

let unsubscribe = null;

beforeEach(() => {
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
});

const heading = () => byId('workspace-tree').parentNode.querySelector('h2');

// nameOf is a heading's accessible name as far as this page uses the rules:
// aria-labelledby when it is set, else the text inside.
function nameOf(node) {
  const by = node.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => byId(id).textContent.trim()).join(' ');
  return node.textContent.replace(/\s+/g, ' ').trim();
}

test('the My Workspace heading is named My Workspace and holds the badge, not the Reset control', () => {
  const h = heading();
  assert.equal(nameOf(h), 'My Workspace');
  const badge = [...h.querySelectorAll('.badge')];
  assert.equal(badge.length, 1, 'the badge left the heading');
  assert.equal(badge[0].textContent, 'Saved in this browser only');
  assert.equal(h.querySelector('button'), null, 'a control inside the heading becomes part of its name');

  const reset = byId('reset-workspace');
  assert.equal(reset.localName, 'button');
  assert.equal(reset.getAttribute('type'), 'button');
  assert.equal(reset.textContent.trim(), 'Reset');
  assert.ok(reset.parentNode === h.parentNode, 'Reset is not beside the heading');
});

test('Reset beside the heading still opens the inline confirm, and its Reset workspace still clears it', () => {
  localStorage.setItem(WORKSPACE, JSON.stringify({
    version: 1,
    requests: [{ id: 'ws-a', name: 'Find', endpoint: 'search', params: {}, assertions: [] }],
  }));
  workspace.init();
  sidebar.init({});
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({});
  assert.equal(get().workspace.length, 1);

  const confirm = byId('reset-confirm');
  assert.equal(confirm.hidden, true);
  byId('reset-workspace').click();
  assert.equal(confirm.hidden, false);
  assert.match(confirm.textContent, /Clear every saved request in My Workspace/);
  [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Reset workspace').click();
  assert.equal(confirm.hidden, true);
  assert.equal(get().workspace.length, 0);
  assert.deepEqual(listenerErrors, []);
});
