// Below 900px the sidebar is a drawer over the page. Picking a request in it
// closes it, so the request just opened is what the visitor sees, and a
// closed drawer is out of the tab order and out of the accessibility tree.
// Above 900px the sidebar is a pane and is never taken out of either.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, media, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const NARROW = '(max-width: 900px)';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const req = (id, name) => ({ id, name, endpoint: 'search', params: { q: 'a' }, assertions: [] });
const collections = [{ id: 'c1', name: 'Basics', description: '', requests: [req('b1', 'Find'), req('b2', 'Look')] }];

let unsubscribe = null;
let picked = [];

function boot({ narrow }) {
  media.set(NARROW, narrow);
  picked = [];
  sidebar.init({ select: (request) => picked.push(request.id) });
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({ collections, endpoints, workspace: [req('ws-1', 'Mine')] });
}

beforeEach(() => {
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
});

const drawer = () => byId('panel-sidebar');
const isOpen = () => byId('app').classList.contains('sidebar-open');
const closed = () => ({ open: isOpen(), inert: Boolean(drawer().inert), hidden: drawer().getAttribute('aria-hidden'), expanded: byId('sidebar-toggle').getAttribute('aria-expanded') });
const row = (tree, title) => [...byId(tree).querySelectorAll('.req-open')].find((b) => b.title === title);

test('below 900px, picking a request in the open drawer closes it, makes it inert and hides it, and opening it again reverses both', () => {
  boot({ narrow: true });
  assert.deepEqual(closed(), { open: false, inert: true, hidden: 'true', expanded: 'false' });

  byId('sidebar-toggle').click();
  assert.deepEqual(closed(), { open: true, inert: false, hidden: null, expanded: 'true' });

  const find = row('collections-tree', 'Find');
  find.focus();
  assert.ok(document.activeElement === find, 'the row did not take focus; the check below would prove nothing');
  find.click();
  assert.deepEqual(picked, ['b1']);
  assert.deepEqual(closed(), { open: false, inert: true, hidden: 'true', expanded: 'false' });
  assert.ok(!drawer().contains(document.activeElement), 'focus was left inside the closed drawer');
  assert.ok(document.activeElement === byId('sidebar-toggle'), 'focus did not go to the drawer\'s toggle');

  byId('sidebar-toggle').click();
  assert.deepEqual(closed(), { open: true, inert: false, hidden: null, expanded: 'true' });

  row('workspace-tree', 'Mine').click();
  assert.deepEqual(picked, ['b1', 'ws-1']);
  assert.deepEqual(closed(), { open: false, inert: true, hidden: 'true', expanded: 'false' });
  assert.deepEqual(listenerErrors, []);
});

test('above 900px, picking a request leaves the sidebar where it is and never inert', () => {
  boot({ narrow: false });
  assert.equal(Boolean(drawer().inert), false);
  assert.equal(drawer().getAttribute('aria-hidden'), null);

  row('collections-tree', 'Find').click();
  assert.deepEqual(picked, ['b1']);
  assert.equal(Boolean(drawer().inert), false);
  assert.equal(drawer().getAttribute('aria-hidden'), null);

  byId('sidebar-toggle').click();
  row('collections-tree', 'Look').click();
  assert.equal(Boolean(drawer().inert), false);
  assert.equal(drawer().getAttribute('aria-hidden'), null);
  assert.deepEqual(listenerErrors, []);
});

test('a drawer left open at 900px or less and then widened is never inert after a request is picked', () => {
  boot({ narrow: true });
  byId('sidebar-toggle').click();
  media.set(NARROW, false);
  row('collections-tree', 'Find').click();
  assert.equal(Boolean(drawer().inert), false);
  assert.equal(drawer().getAttribute('aria-hidden'), null);
  assert.deepEqual(listenerErrors, []);
});
