// live.js — which run this page follows, and everything the page asks the
// server for on its own: the status poll, the history, the catalog, a report.
//
// It is a module of its own so that it can be loaded without starting the
// page: main.js boots on import, and nothing that decides what a visitor is
// shown should be reachable only through a boot.

// StatusPollMs is stated once, here, so N idle tabs share one cadence instead
// of each inventing their own. 3s is the documented figure; a competing 5s
// figure was not adopted, because the documented one is authoritative (see docs/deviations.md N26).
export const StatusPollMs = 3000;

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

// createLive builds the page's one owner of the live transport. api.js knows
// how to stream and how to poll; this is the one place that decides which run
// the page is following, and its reducer is the only thing that turns events
// into state. Every render module reads the result and none of them can tell
// the two transports apart — which is the property the whole fallback rests
// on.
//
// The store (get, set), the api module and the tab switch are passed in, and
// nothing here touches the document.
export function createLive({ api, get, set, showTab = () => {} }) {
  let live = null; // { runId, stop }
  let lastFinished = ''; // never re-attach to a run we watched end
  let pinnedRunId = ''; // a run reopened from history holds the view
  let syncQueued = false;

  async function refreshStatus() {
    try {
      set({ status: await api.getStatus() });
    } catch (err) {
      console.warn('status poll failed', err);
    }
  }

  async function refreshHistory() {
    try {
      const body = await api.getHistory();
      set({ history: (body && body.runs) || [] });
    } catch (err) {
      console.warn('history fetch failed', err);
    }
  }

  // refresh is what a module calls after it changed the run state itself (a
  // start, a cancel) rather than waiting up to StatusPollMs for the poll to
  // catch up.
  function refresh() {
    return Promise.all([refreshStatus(), refreshHistory()]);
  }

  async function loadCatalog() {
    try {
      const body = await api.getCollections();
      set({
        collections: (body && body.collections) || [],
        endpoints: (body && body.endpoints) || [],
        target: (body && body.target) || '',
      });
    } catch (err) {
      console.error('could not load /api/collections', err);
      set({ notice: 'Could not load collections from the server.' });
    }
  }

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

    await refresh();
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
  // all three arrivals: this tab started the run, this tab
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

  // started is api.js's hook for this tab's own 202. Every tab attaches to a
  // live run; only the tab that pressed Start follows it to the Results tab.
  // Hijacking a spectator's tab because somebody else started a run would be
  // the wrong half of that.
  function started(id) {
    attach(id);
    showTab('results');
  }

  // boot loads what the page shows first and starts the one status poll the
  // whole page shares.
  async function boot() {
    api.onRunStarted(started);
    await loadCatalog();
    await refresh();
    setInterval(() => {
      // Only poll while nothing live is attached: a run being streamed reports
      // its own state, and the poll exists for the idle case. The gate is the
      // transport rather than state.run, because a run can be adopted (Watch,
      // history) before — or without — a transport ever attaching to it, and a
      // page with neither a stream nor a poll would never learn the run ended.
      if (get().transport === 'idle') refreshStatus();
    }, StatusPollMs);
  }

  return {
    boot,
    scheduleSync,
    // The hooks each render module is initialised with, so the page and its
    // tests wire the same functions under the same names.
    hooks: {
      runner: { refresh, showTab },
      sidebar: { openRun: (id) => { void openRun(id); } },
    },
  };
}
