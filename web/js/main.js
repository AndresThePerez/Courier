// main.js — bootstrap. Loads the catalog, restores the workspace, wires the
// tabs, and starts the one status poll the whole page shares.

import { get, set, subscribe } from './store.js';
import { byId } from './dom.js';
import * as api from './api.js';
import * as workspace from './workspace.js';
import * as sidebar from './render-sidebar.js';
import * as editor from './render-editor.js';
import * as runner from './render-runner.js';
import * as results from './render-results.js';

const TABS = ['runner', 'editor', 'results'];

// StatusPollMs is stated once, here, so N idle tabs share one cadence instead
// of each inventing their own. 3s is the documented figure; a competing 5s
// figure was not adopted, because the documented one is authoritative (see docs/deviations.md N26).
const StatusPollMs = 3000;

function currentTab() {
  const hash = (location.hash || '').replace('#', '');
  return TABS.includes(hash) ? hash : 'runner';
}

function renderTabs(state) {
  for (const name of TABS) {
    const active = state.activeTab === name;
    const tab = byId(`tab-${name}`);
    tab.classList.toggle('is-active', active);
    // aria-selected is the accessible half of is-active. Both are set in one
    // place so they cannot drift: a tab that looks selected and reports
    // otherwise is worse than no role at all.
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    byId(`panel-${name}`).classList.toggle('is-active', active);
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

// ---------------------------------------------------------------- live runs

// The live transport's owner. api.js knows how to stream and how to poll;
// main.js is the one place that decides which run this page is following, and
// the reducer below is the only thing that turns events into state. Every
// render module reads the result and none of them can tell the two transports
// apart — which is the property the whole fallback rests on.
let live = null; // { runId, stop }
let lastFinished = ''; // never re-attach to a run we watched end
let pinnedRunId = ''; // a run reopened from history holds the view
let syncQueued = false;

function attach(runId) {
  if (!runId || (live && live.runId === runId)) return;
  if (live) live.stop();
  pinnedRunId = '';
  const stop = api.openLive(runId, {
    event: onLiveEvent,
    transport: (kind) => {
      // docs/deviations.md N27: the idle status poll is gated on state.transport, so the
      // reset back to 'idle' is what lets the page start polling status again
      // once the run is over.
      if (kind === 'idle' && live && live.runId === runId) live = null;
      set({ transport: kind });
    },
  });
  live = { runId, stop };
}

// onLiveEvent is the reducer. Both transports feed it, and it is deliberately
// dumb: fold the event into state, notify, and let the render modules decide
// what any of it looks like.
function onLiveEvent(event) {
  const data = event.data || {};
  switch (event.type) {
    case 'run_started':
      set({
        run: runShape(event.run_id, data),
        results: [],
        progress: null,
        report: null,
      });
      break;

    case 'request_result': {
      // Replace-by-index rather than append: a stream that drops a subscriber
      // and a fallback that re-reads the whole report can both deliver a row
      // twice, and a duplicated row is a result the run never produced.
      const rows = get().results.slice();
      const at = rows.findIndex((r) => r.index === data.index);
      if (at >= 0) rows[at] = data;
      else rows.push(data);
      set({ results: rows });
      break;
    }

    case 'progress':
      set({ progress: data });
      break;

    case 'run_finished':
      lastFinished = event.run_id;
      void finishRun(event.run_id, data);
      break;

    default:
      break;
  }
}

function runShape(id, data) {
  return {
    id,
    mode: data.mode || '',
    total: data.total || 0,
    started_at: data.started_at || '',
    config: data.config || {},
    entries: data.entries || [],
  };
}

// finishRun fetches the finished report the moment the run says it is done.
//
// That is race-free because the manager publishes run_finished *after* the
// report is stamped, stored, and charged to the budget (docs/deviations.md N12) — without
// that ordering this fetch could read `status: running` from a run it was just
// told had ended. The report is also where the body previews live: a partial
// report fetched mid-run carries none, so the rows are re-seeded from it.
async function finishRun(runId, data) {
  const status = get().status || {};
  set({
    status: {
      ...status,
      running: false,
      run_id: '',
      cooldown_until: data.cooldown_until || status.cooldown_until,
    },
  });

  try {
    const rep = await api.getRun(runId);
    set({
      run: runShape(rep.id, { ...rep, total: (rep.entries || []).length }),
      report: rep,
      results: (rep.functional && rep.functional.results) || get().results,
    });
  } catch (err) {
    console.warn('could not fetch the finished report', err);
  }

  await Promise.all([refreshStatus(), refreshHistory()]);
}

// openRun reopens a stored run from the history rail. History is kept to the
// five most recent runs, list and click-to-reopen only.
async function openRun(id) {
  showTab('results');
  if (live) {
    live.stop();
    live = null;
  }
  pinnedRunId = id;
  try {
    const rep = await api.getRun(id);
    set({
      run: runShape(rep.id, { ...rep, total: (rep.entries || []).length }),
      report: rep,
      results: (rep.functional && rep.functional.results) || [],
      progress: null,
      spectator: false,
    });
  } catch (err) {
    console.warn('could not reopen run', id, err);
  }
}

// scheduleSync defers the attach decision out of the notify loop: attaching
// sets state, and setting state from inside a render is how a page gets a
// re-entrant render.
function scheduleSync() {
  if (syncQueued || live) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    syncLive(get());
  });
}

// syncLive attaches to whatever run the server says is live. One rule covers
// all three arrivals the plan asks for: this tab started the run, this tab
// pressed Watch, or this tab reloaded while a run was already going — in every
// case the server reports a live run and the replay log makes the view whole.
function syncLive(state) {
  if (live) return;
  const s = state.status || {};
  const id = s.running ? s.run_id || '' : '';
  if (!id || id === lastFinished) return;
  // A run reopened from history keeps the view until the visitor asks for the
  // live one back — Watch sets state.run to it, which clears the pin.
  if (pinnedRunId && (!state.run || state.run.id === pinnedRunId)) return;
  attach(id);
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
  runner.render(state);
  results.render(state);
  scheduleSync();
}

async function boot() {
  workspace.init();

  editor.init();
  runner.init({
    // The runner drives its own refresh after a start or a cancel rather than
    // waiting up to StatusPollMs for the poll to catch up.
    refresh: () => Promise.all([refreshStatus(), refreshHistory()]),
    showTab,
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
    openRun: (id) => { void openRun(id); },
  });

  // Every tab attaches to a live run; only the tab that pressed Start follows
  // it to the Results tab. Hijacking a spectator's tab because somebody else
  // started a run would be the wrong half of that.
  api.onRunStarted((id) => {
    attach(id);
    showTab('results');
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
    // Only poll while nothing live is attached: a run being streamed reports
    // its own state, and the poll exists for the idle case. The gate is the
    // transport rather than state.run, because a run can be adopted (Watch,
    // history) before — or without — a transport ever attaching to it, and a
    // page with neither a stream nor a poll would never learn the run ended.
    if (get().transport === 'idle') refreshStatus();
  }, StatusPollMs);
}

boot();
