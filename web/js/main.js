// main.js — bootstrap. Restores the workspace and the run setup, wires the
// tabs and the render modules, and hands the rest to live.js: the catalog, the
// one status poll the whole page shares, and the run being followed.

import { get, set, subscribe, renderAll } from './store.js';
import { byId } from './dom.js';
import * as api from './api.js';
import { createLive } from './live.js';
import * as workspace from './workspace.js';
import * as sidebar from './render-sidebar.js';
import * as editor from './render-editor.js';
import * as runner from './render-runner.js';
import * as results from './render-results.js';
import * as tabs from './tabs.js';

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

// page owns the live transport, the status poll and every other request the
// page makes on its own (live.js).
const { showTab } = tabs;
const page = createLive({ api, get, set, showTab });

function render(state) {
  renderAll([tabs.renderTabs, renderTopbar, sidebar.render, editor.render, runner.render, results.render], state);
  page.scheduleSync();
}

async function boot() {
  workspace.init();
  runner.savedCollections.init();
  runner.restore();

  editor.init();
  runner.init({
    ...page.hooks.runner,
    // A queued row's Edit: the editor opens that entry, and its Save is what
    // puts the fix back into the run.
    edit: (key) => editor.editQueued(key, showTab),
  });
  sidebar.init({
    select: (request) => {
      // The editor clears the previous request's notes and response first, so
      // nothing left on screen belongs to a request that is no longer open.
      editor.onSelect();
      sidebar.selectRequest(request);
      showTab('editor');
    },
    add: (request) => runner.add(request),
    addAll: (collection) => runner.addAll(collection),
    ...page.hooks.sidebar,
  });

  tabs.init();

  subscribe(render);
  set({ activeTab: tabs.initialTab() });

  await page.boot();
}

boot();
