// tabs.js — the three panel tabs: which one the address names, how the strip
// is painted, the keyboard on it, and the skip link past the sidebar. It lives
// apart from main.js because main.js boots on import, and this is behaviour a
// test has to reach.

import { set } from './store.js';
import { byId } from './dom.js';

const TABS = ['runner', 'editor', 'results'];

// currentTab is the tab the address names, or null when it names none: the
// skip link's #panel-main is an address too, and reading it as "no tab, so
// the runner" would switch the panel under a visitor who only skipped ahead.
function currentTab() {
  const hash = (location.hash || '').replace('#', '');
  return TABS.includes(hash) ? hash : null;
}

export function initialTab() {
  return currentTab() || 'runner';
}

// renderTabs keeps the look, aria-selected and the tab order in one place so
// they cannot drift: a tab that looks selected and reports otherwise is worse
// than no role at all. Only the selected tab is a Tab stop; the arrows reach
// the others.
export function renderTabs(state) {
  for (const name of TABS) {
    const active = state.activeTab === name;
    const tab = byId(`tab-${name}`);
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.setAttribute('tabindex', active ? '0' : '-1');
    byId(`panel-${name}`).classList.toggle('is-active', active);
  }
}

export function showTab(name) {
  if (!TABS.includes(name)) return;
  if (location.hash !== `#${name}`) location.hash = `#${name}`;
  else set({ activeTab: name });
}

// onTabKeydown is the tabs pattern's keyboard: the arrows step to the next or
// previous tab and wrap, Home and End go to the ends, and a tab reached this
// way is selected as well as focused. preventDefault keeps an arrow from also
// scrolling the page.
function onTabKeydown(event) {
  const at = TABS.findIndex((name) => byId(`tab-${name}`) === event.target);
  if (at < 0) return;
  const last = TABS.length - 1;
  const to = {
    ArrowRight: at === last ? 0 : at + 1,
    ArrowLeft: at === 0 ? last : at - 1,
    Home: 0,
    End: last,
  }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  byId(`tab-${TABS[to]}`).focus();
  showTab(TABS[to]);
}

// onSkipLink takes focus to the working column without following the link:
// the link's address names no tab, and the column it skips to is whichever
// panel is showing.
function onSkipLink(event) {
  event.preventDefault();
  byId('panel-main').focus();
}

function onHashChange() {
  const tab = currentTab();
  if (tab) set({ activeTab: tab });
}

export function init() {
  for (const name of TABS) {
    byId(`tab-${name}`).addEventListener('click', () => showTab(name));
  }
  byId('tabs').addEventListener('keydown', onTabKeydown);
  document.querySelector('.skip-link').addEventListener('click', onSkipLink);
  window.addEventListener('hashchange', onHashChange);
}
