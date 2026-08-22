// main.js — bootstrap. Loads the catalog, restores the workspace, wires the
// tabs, and starts the one status poll the whole page shares.

import { get, set, subscribe } from './store.js';
import { byId } from './dom.js';
import * as api from './api.js';
import * as workspace from './workspace.js';
import * as sidebar from './render-sidebar.js';
import * as editor from './render-editor.js';

const TABS = ['runner', 'editor', 'results'];

// StatusPollMs is stated once, here, so N idle tabs share one cadence instead
// of each inventing their own. The Design Spec sets it at 3s; the plan's
// Task 17 said 5s and the spec is authoritative (see NOTE.md N26).
const StatusPollMs = 3000;

function currentTab() {
  const hash = (location.hash || '').replace('#', '');
  return TABS.includes(hash) ? hash : 'runner';
}

function renderTabs(state) {
  for (const name of TABS) {
    byId(`tab-${name}`).classList.toggle('is-active', state.activeTab === name);
    byId(`panel-${name}`).classList.toggle('is-active', state.activeTab === name);
  }
}

export function showTab(name) {
  if (!TABS.includes(name)) return;
  if (location.hash !== `#${name}`) location.hash = `#${name}`;
  else set({ activeTab: name });
}

function renderTopbar(state) {
  const node = byId('run-state');
  const s = state.status;
  let text = '';
  if (s && s.running) text = `run in progress - ${s.mode}`;
  else if (s && s.cooldown_until && new Date(s.cooldown_until) > new Date()) text = 'cooling down';
  else if (s) text = 'idle';
  node.classList.toggle('is-live', Boolean(s && s.running));
  if (node.textContent !== text) node.textContent = text;
}

export async function refreshStatus() {
  try {
    set({ status: await api.getStatus() });
  } catch (err) {
    console.warn('status poll failed', err);
  }
}

export async function refreshHistory() {
  try {
    const body = await api.getHistory();
    set({ history: (body && body.runs) || [] });
  } catch (err) {
    console.warn('history fetch failed', err);
  }
}

async function loadCatalog() {
  const body = await api.getCollections();
  set({
    collections: (body && body.collections) || [],
    endpoints: (body && body.endpoints) || [],
    target: (body && body.target) || '',
  });
}

function render(state) {
  renderTabs(state);
  renderTopbar(state);
  sidebar.render(state);
  editor.render(state);
}

async function boot() {
  workspace.init();

  editor.init();
  sidebar.init({
    select: (request) => {
      // The editor clears the previous request's notes and response first, so
      // nothing left on screen belongs to a request that is no longer open.
      editor.onSelect();
      sidebar.selectRequest(request);
      showTab('editor');
    },
    add: () => {},
    addAll: () => {},
    openRun: () => {},
  });

  for (const name of TABS) {
    byId(`tab-${name}`).addEventListener('click', () => showTab(name));
  }
  window.addEventListener('hashchange', () => set({ activeTab: currentTab() }));

  subscribe(render);
  set({ activeTab: currentTab() });

  try {
    await loadCatalog();
  } catch (err) {
    console.error('could not load /api/collections', err);
    set({ notice: 'Could not load collections from the server.' });
  }

  await Promise.all([refreshStatus(), refreshHistory()]);
  setInterval(() => {
    // Only poll while there is nothing live to watch: a run being streamed
    // reports its own state, and the poll exists for the idle case.
    if (!get().run) refreshStatus();
  }, StatusPollMs);
}

boot();
