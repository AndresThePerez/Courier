// The drawer below 900px at its edges: a window narrowed with focus in the
// sidebar, the request already selected picked again, a history run opened,
// open-pick-open in quick succession, and a window widened with the drawer
// shut. Focus is never left inside an inert subtree, and the sidebar is never
// inert while it is a visible pane.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, media, localStorage, listenerErrors } from './shim.mjs';
import { resetState, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const NARROW = '(max-width: 900px)';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const req = (id, name) => ({ id, name, endpoint: 'search', params: { q: 'a' }, assertions: [] });
const collections = [{ id: 'c1', name: 'Basics', description: '', requests: [req('b1', 'Find'), req('b2', 'Look')] }];
const run = { id: 'run-1', mode: 'functional', status: 'completed', started_at: '2026-11-16T14:03:22Z', duration_ms: 120, summary: '3 passed' };

let unsubscribe = null;
let picked = [];
let opened = [];

function boot({ narrow }) {
  media.set(NARROW, narrow);
  picked = [];
  opened = [];
  sidebar.init({
    select: (request) => { picked.push(request.id); set({ selectedId: request.id }); },
    openRun: (id) => opened.push(id),
  });
  unsubscribe = subscribe((state) => sidebar.render(state));
  set({ collections, endpoints, history: [run], historyLoaded: true });
}

beforeEach(() => {
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  localStorage.heal();
  workspace.stop();
});

const drawer = () => byId('panel-sidebar');
const shut = () => ({ open: byId('app').classList.contains('sidebar-open'), inert: Boolean(drawer().inert), hidden: drawer().getAttribute('aria-hidden') });
const CLOSED = { open: false, inert: true, hidden: 'true' };
const OPEN = { open: true, inert: false, hidden: null };
const row = (title) => [...byId('collections-tree').querySelectorAll('.req-open')].find((b) => b.title === title);

test('a window narrowed with focus in the sidebar and the drawer shut takes focus out before the sidebar goes inert', () => {
  boot({ narrow: false });
  const button = row('Find');
  button.focus();
  assert.ok(document.activeElement === button, 'the button did not take focus; the case proves nothing');
  media.set(NARROW, true);
  assert.deepEqual(shut(), CLOSED);
  assert.ok(!drawer().contains(document.activeElement), 'focus was left inside the inert drawer');
  assert.ok(document.activeElement !== document.body, 'focus was dropped to the page');
  assert.deepEqual(listenerErrors, []);
});

test('a window widened with the drawer shut makes the sidebar a pane again, not inert and not hidden', () => {
  boot({ narrow: true });
  assert.deepEqual(shut(), CLOSED);
  media.set(NARROW, false);
  assert.equal(Boolean(drawer().inert), false);
  assert.equal(drawer().getAttribute('aria-hidden'), null);
  media.set(NARROW, true);
  assert.deepEqual(shut(), CLOSED, 'narrowed again, the shut drawer is reachable');
});

test('below 900px, picking the request that is already selected still closes the drawer and takes focus out of it', () => {
  boot({ narrow: true });
  byId('sidebar-toggle').click();
  row('Find').click();
  assert.deepEqual(shut(), CLOSED);
  byId('sidebar-toggle').click();
  assert.deepEqual(shut(), OPEN);
  const again = row('Find');
  again.focus();
  again.click();
  assert.deepEqual(picked, ['b1', 'b1']);
  assert.deepEqual(shut(), CLOSED);
  assert.ok(!drawer().contains(document.activeElement), 'focus was left inside the inert drawer');
  assert.deepEqual(listenerErrors, []);
});

test('below 900px, opening a history run leaves the drawer open and its button focused', () => {
  boot({ narrow: true });
  byId('sidebar-toggle').click();
  const button = byId('history-list').querySelector('button');
  button.focus();
  button.click();
  assert.deepEqual(opened, ['run-1']);
  assert.deepEqual(shut(), OPEN);
  assert.ok(document.activeElement === button);
});

test('open, pick, open, pick in quick succession ends shut, and the toggle\'s expanded state follows every step', () => {
  boot({ narrow: true });
  const expanded = () => byId('sidebar-toggle').getAttribute('aria-expanded');
  for (const title of ['Find', 'Look', 'Find', 'Look']) {
    byId('sidebar-toggle').click();
    assert.deepEqual(shut(), OPEN);
    assert.equal(expanded(), 'true');
    const button = row(title);
    button.focus();
    button.click();
    assert.deepEqual(shut(), CLOSED);
    assert.equal(expanded(), 'false');
    assert.ok(!drawer().contains(document.activeElement), `focus was left inside the inert drawer after ${title}`);
  }
  assert.deepEqual(picked, ['b1', 'b2', 'b1', 'b2']);
  assert.deepEqual(listenerErrors, []);
});

test('the toggle shutting the drawer with focus inside it takes focus out first', () => {
  boot({ narrow: true });
  byId('sidebar-toggle').click();
  row('Look').focus();
  byId('sidebar-toggle').click();
  assert.deepEqual(shut(), CLOSED);
  assert.ok(!drawer().contains(document.activeElement), 'focus was left inside the inert drawer');
});

test('below 900px, a confirmed Reset inside the open drawer leaves focus on Reset and the drawer open', () => {
  localStorage.setItem('courier.workspace.v1', JSON.stringify({ version: 1, requests: [req('ws-a', 'Mine')] }));
  workspace.init();
  boot({ narrow: true });
  byId('sidebar-toggle').click();
  byId('reset-workspace').click();
  byId('reset-workspace').click();
  const buttons = [...byId('reset-confirm').querySelectorAll('button')];
  assert.equal(buttons.length, 2, 'opening the confirm twice drew it twice');
  const confirm = buttons.find((b) => b.textContent === 'Reset workspace');
  confirm.focus();
  confirm.click();
  assert.deepEqual(shut(), OPEN);
  assert.ok(document.activeElement === byId('reset-workspace'));
  assert.deepEqual(listenerErrors, []);
});
