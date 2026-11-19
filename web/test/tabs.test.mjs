// The three panel tabs by keyboard, as the ARIA tabs pattern has them: the
// arrows move to the next or previous tab and select it, Home and End to the
// first and last, and only the selected tab is in the tab order. The skip link
// takes focus to the working column without touching which tab is shown.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, keydown, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as tabs from '../js/tabs.js';

const byId = (id) => document.getElementById(id);
const names = ['runner', 'editor', 'results'];
const tab = (name) => byId(`tab-${name}`);

let unsubscribe = null;

function boot(hash = '') {
  if (hash) location.hash = hash;
  tabs.init();
  unsubscribe = subscribe((state) => tabs.renderTabs(state));
  set({ activeTab: tabs.initialTab() });
}

beforeEach(() => {
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
});

// painted is what the tab strip says, per tab: selected, in the tab order,
// and its panel shown.
const painted = () => names.map((name) => ({
  name,
  selected: tab(name).getAttribute('aria-selected'),
  tabindex: tab(name).getAttribute('tabindex'),
  shown: byId(`panel-${name}`).classList.contains('is-active'),
}));
const only = (active) => names.map((name) => ({
  name,
  selected: name === active ? 'true' : 'false',
  tabindex: name === active ? '0' : '-1',
  shown: name === active,
}));

test('only the selected tab is in the tab order, and aria-selected follows it', () => {
  boot();
  assert.deepEqual(painted(), only('runner'));
  tab('results').click();
  assert.equal(get().activeTab, 'results');
  assert.deepEqual(painted(), only('results'));
  assert.deepEqual(listenerErrors, []);
});

test('ArrowRight and ArrowLeft move focus to the next and previous tab, select it, and wrap at the ends', () => {
  boot();
  tab('runner').focus();
  const steps = [
    ['ArrowRight', 'editor'],
    ['ArrowRight', 'results'],
    ['ArrowRight', 'runner'],
    ['ArrowLeft', 'results'],
    ['ArrowLeft', 'editor'],
  ];
  for (const [key, want] of steps) {
    const event = keydown(document.activeElement, key);
    assert.equal(event.defaultPrevented, true, `${key} scrolled the page as well`);
    assert.ok(document.activeElement === tab(want), `${key} left focus off ${want}`);
    assert.equal(get().activeTab, want);
    assert.deepEqual(painted(), only(want));
  }
  assert.deepEqual(listenerErrors, []);
});

test('Home and End move focus to the first and last tab and select it', () => {
  boot('#editor');
  tab('editor').focus();
  keydown(tab('editor'), 'End');
  assert.ok(document.activeElement === tab('results'));
  assert.deepEqual(painted(), only('results'));
  keydown(tab('results'), 'Home');
  assert.ok(document.activeElement === tab('runner'));
  assert.deepEqual(painted(), only('runner'));
  assert.deepEqual(listenerErrors, []);
});

test('other keys on a tab, and arrows anywhere else, are left alone', () => {
  boot();
  tab('runner').focus();
  const other = keydown(tab('runner'), 'ArrowDown');
  assert.equal(other.defaultPrevented, false);
  assert.equal(get().activeTab, 'runner');
  const outside = keydown(byId('save-sequence-name'), 'ArrowRight');
  assert.equal(outside.defaultPrevented, false);
  assert.equal(get().activeTab, 'runner');
  assert.deepEqual(listenerErrors, []);
});

test('the skip link moves focus to the working column instead of following its link', () => {
  boot('#editor');
  const link = document.querySelector('.skip-link');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'the link was followed');
  assert.ok(document.activeElement === byId('panel-main'), 'focus is not on the working column');
  assert.equal(get().activeTab, 'editor', 'the skip link changed the tab');
  assert.equal(location.hash, '#editor');
  assert.deepEqual(listenerErrors, []);
});

test('a hashchange to #panel-main leaves the shown tab as it was', () => {
  boot('#results');
  assert.equal(get().activeTab, 'results');
  location.hash = '#panel-main';
  assert.equal(get().activeTab, 'results');
  location.hash = '#editor';
  assert.equal(get().activeTab, 'editor', 'a hash naming a tab no longer selects it');
  assert.deepEqual(listenerErrors, []);
});

test('a page opened on an address naming no tab starts on the runner', () => {
  boot('#panel-main');
  assert.equal(get().activeTab, 'runner');
  assert.deepEqual(painted(), only('runner'));
});
