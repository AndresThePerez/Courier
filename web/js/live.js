// live.js — which run this tab follows, what it shows of it, and everything
// the page asks the server for on its own: the status poll, the history, the
// catalog, a report.
//
// The rules. They are constraints on what a visitor can ever see, and
// web/test/live-model.test.mjs checks them after every step of seeded
// interleavings of visitors, streams, failures and restarts:
//
//   1. What a tab shows of a run that has ended (its report, or its rows and
//      how it ended) is replaced only by this tab's visitor: Start, Watch,
//      opening a history entry, or a reload. Nothing the server says about
//      another run replaces it.
//   2. A tab showing nothing follows the run the server reports as live
//      without being asked. That is what repaints a tab reloaded mid-run.
//   3. Events are applied only for the run the tab is attached to. Events of
//      any other run, and any event while nothing is attached, are dropped.
//   4. Nothing is applied after a run's terminal event. The terminal event
//      ends the attachment and asks for the finished report once, and that
//      run is never attached again.
//   5. Events may arrive in any order and more than once: rows are keyed by
//      their index, and run_started never removes a row that came before it.
//   6. An answer that arrives after the visitor asked for something else is
//      dropped: a history report after a later Start, Watch or history click,
//      a finished report after the view moved on.
//   7. At most one stream is open and at most one status request is in
//      flight at any time, and an answer written before something this tab
//      knows of happened is not applied.
//   8. A run that answered 404 is not attached again until status reports a
//      different run or no run, however long status goes on naming it. One
//      stream and one poll is all a vanished run ever costs.
//
// The rules live in two pure functions, step and decideSync, over one plain
// object; they touch no document, timer or network. createLive is the only
// thing that does, and it does nothing the rules did not ask for.
//
// It is a module of its own so that it can be loaded without starting the
// page: main.js boots on import, and nothing that decides what a visitor is
// shown should be reachable only through a boot.

// StatusPollMs is stated once, here, so N idle tabs share one cadence instead
// of each inventing their own. 3s is the documented figure; a competing 5s
// figure was not adopted, because the documented one is authoritative (see docs/deviations.md N26).
export const StatusPollMs = 3000;

// MaxEnded bounds the memory of runs this tab watched end or lose. The server
// keeps 20 runs; an id older than that can no longer be reported as live.
const MaxEnded = 32;

// ---------------------------------------------------------------- the rules

// VIEW_KEYS is the half of the live state a visitor sees. It is kept in the
// store under these names, where the render modules read it.
export const VIEW_KEYS = ['run', 'results', 'progress', 'report', 'spectator', 'outcome'];

// TRACK_KEYS is the other half: what the tab is following.
const TRACK_KEYS = ['attached', 'ended', 'gone', 'opening', 'checked'];

export function initialLive() {
  return {
    run: null, // { id, mode, total, started_at, config, entries }
    results: [],
    progress: null,
    report: null,
    spectator: false,
    // How the shown run ended: { run_id, status, duration_ms, verdict } from its
    // terminal event, or status 'unavailable' for a run the server lost.
    outcome: null,

    attached: '', // the run whose events are applied; '' when none
    ended: [], // runs this tab saw end
    gone: [], // runs that answered 404, each until status stops naming it
    opening: '', // the history entry the visitor asked for and is waiting on
    checked: '', // the last disagreement between status and the attachment that was looked into
  };
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

const same = (live) => ({ live, effects: [] });
const none = () => ({ action: 'none' });

// liveId is the run a status reports as live, or '' for none (or for a live
// run it does not name, which cannot be followed).
const liveId = (status) => (status && status.running ? status.run_id || '' : '');

// decideSync reads one status against the tab's live state and answers what
// following it would take:
//
//   { action: 'attach', runId, mode, startedAt }  nothing is shown and a run is live (rule 2)
//   { action: 'check', runId }                    status says the attached run is not the live one
//   { action: 'none' }
//
// 'check' is not a detach. The server ends a run before it publishes the
// terminal event, so status can be a moment ahead of the stream; and a stream
// that went quiet without an error would otherwise never learn the run ended.
// Reading that run's report once settles both: it is either still running,
// finished, or gone.
export function decideSync(live, status) {
  if (!status) return none();
  const id = liveId(status);
  if (live.attached) {
    if (id === live.attached) return none();
    if (status.running && !id) return none();
    if (live.checked === `${live.attached}>${id}`) return none();
    return { action: 'check', runId: live.attached };
  }
  if (!id || live.gone.includes(id) || live.ended.includes(id)) return none();
  // Rule 1: anything on screen, or a report the visitor is waiting for, holds
  // the view.
  if (live.run || live.report || live.opening) return none();
  return { action: 'attach', runId: id, mode: status.mode || '', startedAt: status.started_at || '' };
}

// follow starts the view over on one run and attaches to it.
function follow(live, id, mode, startedAt, spectator) {
  return {
    ...live,
    run: runShape(id, { mode, started_at: startedAt }),
    results: [],
    progress: null,
    report: null,
    outcome: null,
    spectator,
    attached: id,
    opening: '',
    checked: '',
    ended: live.ended.filter((x) => x !== id),
    gone: live.gone.includes(id) ? live.gone.filter((x) => x !== id) : live.gone,
  };
}

// forgetGone is the second half of rule 8: an id is held only while status
// goes on naming it. A status naming another run, or none, releases it; a
// live run status does not name says nothing either way.
function forgetGone(live, status) {
  if (live.gone.length === 0 || !status) return live;
  if (status.running && !status.run_id) return live;
  const kept = status.running ? live.gone.filter((x) => x === status.run_id) : [];
  return kept.length === live.gone.length ? live : { ...live, gone: kept };
}

function onStatus(before, status) {
  const live = forgetGone(before, status);
  const decision = decideSync(live, status);
  if (decision.action === 'attach') {
    return same(follow(live, decision.runId, decision.mode, decision.startedAt, false));
  }
  if (decision.action === 'check') {
    return {
      live: { ...live, checked: `${live.attached}>${liveId(status)}` },
      effects: [{ type: 'probe', runId: live.attached }],
    };
  }
  // Agreement makes the next disagreement a new one.
  if (live.checked && live.attached && liveId(status) === live.attached) return same({ ...live, checked: '' });
  return same(live);
}

// onStart is this tab's own 202. The visitor asked, so it attaches whatever
// the tab was showing, with the one exception rule 4 makes for everything.
function onStart(live, e) {
  const id = e.run_id;
  if (!id) return same(live);
  // Status can report the run before the 202 is read, and a tab showing
  // nothing is then already following it; what arrived is kept. It can even
  // have followed the run to its end by then: the 202 is old news, the end is
  // on screen, and attaching again would take it away to fetch it back.
  if (live.attached === id || live.ended.includes(id)) {
    if (!live.spectator && !live.opening) return same(live);
    return same({ ...live, spectator: false, opening: '' });
  }
  return same(follow(live, id, e.mode || '', e.started_at || '', false));
}

function onWatch(live, e) {
  const id = e.run_id;
  if (!id) return same(live);
  // Rules 4 and 8: a status that still names a run this tab saw end, or one
  // the server no longer has, is stale. Read it again rather than follow it.
  if (live.gone.includes(id) || live.ended.includes(id)) return { live, effects: [{ type: 'status' }] };
  // Already following: the replay has arrived and does not arrive twice, so
  // the only thing left to say is that this tab is a spectator.
  if (live.attached === id) return same({ ...live, spectator: true, opening: '' });
  return same(follow(live, id, e.mode || '', e.started_at || '', true));
}

// onOpened shows a stored run the visitor asked for. Rule 6: only the entry
// asked for last, and only if nothing was asked for since.
function onOpened(live, e) {
  const rep = e.report;
  if (!e.run_id || live.opening !== e.run_id || !rep) return same(live);
  return same({
    ...live,
    run: runShape(rep.id || e.run_id, { ...rep, total: (rep.entries || []).length }),
    report: rep,
    results: (rep.functional && rep.functional.results) || [],
    progress: null,
    spectator: false,
    outcome: null,
    attached: '',
    opening: '',
    checked: '',
  });
}

// showsEndOf says whether the tab is still showing the end of run id with no
// report yet: the only state a finished report may land in (rule 6).
const showsEndOf = (live, id) => Boolean(id && live.outcome && live.outcome.run_id === id && live.run && live.run.id === id && !live.report);

function onReport(live, e) {
  const rep = e.report;
  if (!showsEndOf(live, e.run_id) || !rep || rep.id !== e.run_id || rep.status === 'running') return same(live);
  return same({
    ...live,
    run: runShape(rep.id, { ...rep, total: (rep.entries || []).length }),
    report: rep,
    // The report is where the body previews live: a row that arrived over
    // the polling fallback has none, so the rows are re-seeded from it.
    results: (rep.functional && rep.functional.results) || live.results,
  });
}

function onRunEvent(live, e) {
  // Rule 3.
  const id = e.run_id;
  if (!live.attached || id !== live.attached) return same(live);
  const data = e.data || {};

  // Attaching put this run on screen. Should anything else be there, the view
  // starts over rather than mix two runs.
  let base = live;
  if (!base.run || base.run.id !== id) {
    base = { ...base, run: runShape(id, {}), results: [], progress: null, report: null, outcome: null };
  }

  switch (e.type) {
    case 'run_started': {
      // Rule 5: this fills in what the run is. It may come after rows, or
      // twice, and removes nothing.
      const was = base.run;
      return same({
        ...base,
        run: {
          id,
          mode: data.mode || was.mode,
          total: data.total || was.total,
          started_at: data.started_at || was.started_at,
          config: data.config || was.config,
          entries: data.entries || was.entries,
        },
      });
    }

    case 'request_result': {
      // Replace-by-index rather than append: a stream and a fallback that
      // re-reads the whole report can both deliver a row, and a duplicated
      // row is a result the run never produced.
      const rows = base.results.slice();
      const at = rows.findIndex((r) => r.index === data.index);
      if (at >= 0) rows[at] = data;
      else rows.push(data);
      return same({ ...base, results: rows });
    }

    case 'progress':
      return same({ ...base, progress: data });

    case 'run_finished':
      // Rule 4.
      return {
        live: {
          ...base,
          attached: '',
          checked: '',
          spectator: false,
          outcome: {
            run_id: id,
            status: data.status || 'finished',
            duration_ms: Number.isFinite(data.duration_ms) ? data.duration_ms : null,
            verdict: data.verdict || '',
          },
          ended: [...base.ended.filter((x) => x !== id), id].slice(-MaxEnded),
        },
        effects: [{ type: 'report', runId: id }],
      };

    default:
      return same(live);
  }
}

// onGone is rule 8's first half. What had arrived stays on screen, marked as
// a run the server no longer has; a tab that had been sent nothing has nothing
// to keep, and goes back to showing nothing so it can follow the next run.
function onGone(live, e) {
  const id = e.run_id;
  if (!id || live.attached !== id) return same(live);
  const gone = [...live.gone.filter((x) => x !== id), id].slice(-MaxEnded);
  let next = { ...live, attached: '', checked: '', gone, spectator: false };
  if (next.run && next.run.id === id) {
    if (next.results.length === 0 && !next.progress) {
      next = { ...next, run: null, results: [], progress: null, report: null, outcome: null };
    } else {
      next = { ...next, outcome: { run_id: id, status: 'unavailable', duration_ms: null, verdict: '' } };
    }
  }
  return { live: next, effects: [{ type: 'status' }] };
}

// step folds one event into the live state and answers { live, effects }. It
// never changes what it was given; when nothing changed, live is the object
// that came in.
//
// Events:
//   run_started, request_result, progress, run_finished   { run_id, data } from either transport
//   status { status }             a status the page holds (rule 2, and the check)
//   start { run_id, mode }        this tab's Start was accepted
//   watch { run_id, mode, started_at }   the visitor pressed Watch
//   open { run_id }               the visitor clicked a history entry
//   opened { run_id, report } / open_failed { run_id }
//   report { run_id, report } / report_failed { run_id }  the finished report of a run that ended
//   gone { run_id }               the attached run answered 404
//
// Effects are what the caller must now do: { type: 'report', runId } fetch a
// finished report, { type: 'history', runId } fetch a stored one,
// { type: 'status' } read status again, { type: 'probe', runId } read the
// attached run once. Opening and closing the transport is not an effect: the
// caller keeps one open for `attached` and none otherwise.
export function step(live, event) {
  const e = event || {};
  switch (e.type) {
    case 'run_started':
    case 'request_result':
    case 'progress':
    case 'run_finished':
      return onRunEvent(live, e);

    case 'status':
      return onStatus(live, e.status);

    case 'start':
      return onStart(live, e);

    case 'watch':
      return onWatch(live, e);

    case 'open':
      if (!e.run_id) return same(live);
      return { live: { ...live, opening: e.run_id }, effects: [{ type: 'history', runId: e.run_id }] };

    case 'opened':
      return onOpened(live, e);

    case 'open_failed':
      if (!e.run_id || live.opening !== e.run_id) return same(live);
      return same({ ...live, opening: '' });

    case 'report':
      return onReport(live, e);

    case 'report_failed':
      if (!showsEndOf(live, e.run_id)) return same(live);
      return same({ ...live, outcome: { ...live.outcome, report: 'failed' } });

    case 'gone':
      return onGone(live, e);

    default:
      return same(live);
  }
}

export function reduce(live, event) {
  return step(live, event).live;
}

// ---------------------------------------------------------------- the page

// historyRefusal is what the history rail says when an entry could not be
// opened. A 404 is the run having aged out of the server's ring of 20.
function historyRefusal(res) {
  if (res.kind === 'network') return 'Could not open that run - Could not reach Courier.';
  if (res.status === 404) return 'That run is no longer stored on the server.';
  return `Could not open that run - ${res.error}`;
}

// oneAtATime keeps a repeated read to one request in flight (rule 7).
//
// poll() is for a timer: it starts a request only when none is out, so a slow
// answer is waited for rather than raced. refresh() is for a caller that
// knows something just changed: an answer already on its way may have been
// written before the change, so it is dropped when it lands and the read is
// made again. Either way apply sees one answer at a time, in the order the
// requests were made.
function oneAtATime(read, apply) {
  let flight = null;
  let stale = false;

  async function run() {
    try {
      for (;;) {
        stale = false;
        const res = await read();
        if (stale) continue;
        apply(res);
        return;
      }
    } finally {
      flight = null;
    }
  }

  return {
    poll() {
      if (!flight) flight = run();
      return flight;
    },
    refresh() {
      if (flight) stale = true;
      else flight = run();
      return flight;
    },
  };
}

function pick(from, keys) {
  const out = {};
  for (const key of keys) out[key] = from[key];
  return out;
}

// createLive builds the page's one owner of the live transport and of every
// request the page makes on its own. api.js knows how to stream and how to
// poll; the rules above decide which run is followed and what each event
// does; this wires the two to the store. Every render module reads the result
// and none of them can tell the two transports apart — which is the property
// the whole fallback rests on.
//
// The store (get, set), the api module and the tab switch are passed in, and
// nothing here touches the document.
export function createLive({ api, get, set, showTab = () => {} }) {
  // The view half of the live state is the store's, read back before every
  // step, so there is one copy of what the visitor sees. This is the rest.
  let track = pick(initialLive(), TRACK_KEYS);
  let conn = null; // the one open transport: { runId, stop }
  let syncQueued = false;
  let poller = null;

  // dispatch is the only way anything here changes the live state.
  function dispatch(event) {
    const before = { ...pick(get(), VIEW_KEYS), ...track };
    const { live, effects } = step(before, event);
    if (live !== before) {
      track = pick(live, TRACK_KEYS);
      const patch = {};
      for (const key of VIEW_KEYS) {
        if (live[key] !== before[key]) patch[key] = live[key];
      }
      if (Object.keys(patch).length > 0) set(patch);
    }
    reconcile();
    for (const effect of effects) perform(effect, event);
  }

  // reconcile keeps one transport open for the attached run and none
  // otherwise (rule 7). A transport that is no longer the current one cannot
  // speak: its late events and its closing 'idle' are dropped.
  function reconcile() {
    const want = track.attached;
    if (conn && conn.runId === want) return;
    if (conn) {
      const old = conn;
      conn = null;
      old.stop();
    }
    if (!want) {
      // docs/deviations.md N27: the idle status poll is gated on state.transport, so the
      // reset back to 'idle' is what lets the page start polling status again
      // once the run is over.
      if (get().transport !== 'idle') set({ transport: 'idle' });
      return;
    }
    const mine = { runId: want, stop: () => {} };
    conn = mine;
    mine.stop = api.openLive(want, {
      event: (e) => {
        if (conn === mine) dispatch(e);
      },
      transport: (kind) => {
        if (conn !== mine) return;
        if (kind === 'idle') {
          // It stopped by itself with the run neither ended nor reported
          // gone. Whatever the reason, there is nothing to follow, and
          // treating it as gone is what cannot loop.
          dispatch({ type: 'gone', run_id: want });
          return;
        }
        set({ transport: kind });
      },
      gone: () => {
        if (conn === mine) dispatch({ type: 'gone', run_id: want });
      },
    });
  }

  function perform(effect, event) {
    if (effect.type === 'report') void finishRun(effect.runId, event.data || {});
    else if (effect.type === 'history') void fetchStored(effect.runId);
    else if (effect.type === 'status') void status.refresh();
    else if (effect.type === 'probe' && conn && conn.runId === effect.runId && conn.stop.probe) conn.stop.probe();
  }

  const status = oneAtATime(api.getStatus, (res) => {
    if (res.ok) set({ status: res.body });
    else console.warn('status poll failed', res.error);
  });

  const history = oneAtATime(api.getHistory, (res) => {
    if (res.ok) set({ history: (res.body && res.body.runs) || [] });
    else console.warn('history fetch failed', res.error);
  });

  // refresh is what a module calls after it changed the run state itself (a
  // start, a cancel) rather than waiting up to StatusPollMs for the poll to
  // catch up.
  function refresh() {
    return Promise.all([status.refresh(), history.refresh()]);
  }

  // loadCatalog fetches the curated collections, at load and on Retry. A
  // failure is a state of the page, not a pause: the sidebar says so and
  // offers Retry, and one load is out at a time.
  let catalogFlight = null;

  function loadCatalog() {
    if (!catalogFlight) {
      catalogFlight = readCatalog().finally(() => {
        catalogFlight = null;
      });
    }
    return catalogFlight;
  }

  async function readCatalog() {
    set({ catalogLoading: true });
    const res = await api.getCollections();
    if (!res.ok) {
      console.warn('could not load /api/collections', res.error);
      set({ catalogLoading: false, notice: 'Could not load collections from the server.' });
      return;
    }
    const body = res.body || {};
    set({
      catalogLoading: false,
      notice: null,
      collections: body.collections || [],
      endpoints: body.endpoints || [],
      target: body.target || '',
    });
  }

  // finishRun fetches the finished report the moment the run says it is done.
  //
  // That is race-free because the manager publishes run_finished *after* the
  // report is stamped, stored, and charged to the budget (docs/deviations.md N12) — without
  // that ordering this fetch could read `status: running` from a run it was just
  // told had ended. Status and history are read again beside it, not after it:
  // the cooldown the terminal event carries can be absent, and a report that is
  // slow or lost must not hold Start back.
  async function finishRun(runId, data) {
    const held = get().status || {};
    // Only the run status last named, or none: a status already naming a
    // later run knows more than this event does.
    if (!held.run_id || held.run_id === runId) {
      set({
        status: {
          ...held,
          running: false,
          run_id: '',
          cooldown_until: data.cooldown_until || held.cooldown_until,
        },
      });
    }

    const [res] = await Promise.all([api.getRun(runId), refresh()]);
    if (res.ok) {
      dispatch({ type: 'report', run_id: runId, report: res.body });
    } else {
      console.warn('could not fetch the finished report', res.error);
      dispatch({ type: 'report_failed', run_id: runId });
    }
  }

  // openRun reopens a stored run from the history rail. History is kept to the
  // five most recent runs, list and click-to-reopen only. Whatever the tab was
  // showing or following stays until the report is here: a click that fails
  // must not cost the visitor the run they were watching.
  function openRun(id) {
    showTab('results');
    if (get().historyNote) set({ historyNote: '' });
    dispatch({ type: 'open', run_id: id });
  }

  async function fetchStored(id) {
    const res = await api.getRun(id);
    if (res.ok) {
      dispatch({ type: 'opened', run_id: id, report: res.body });
      return;
    }
    console.warn('could not reopen run', id, res.error);
    // Only the entry still being waited for may say it failed.
    const wanted = track.opening === id;
    dispatch({ type: 'open_failed', run_id: id });
    if (wanted) set({ historyNote: historyRefusal(res) });
  }

  // watch is the Watch button: follow the run status names, as a spectator.
  function watch() {
    const s = get().status || {};
    dispatch({ type: 'watch', run_id: s.run_id || '', mode: s.mode || '', started_at: s.started_at || '' });
  }

  // started is api.js's hook for this tab's own 202. Only the tab that pressed
  // Start follows its run to the Results tab: moving a spectator's tab because
  // somebody else started a run would be the wrong half of that.
  function started(id, mode) {
    if (!id) return;
    // The 202 is the server saying this run is live. Status says so in the
    // same turn, so nothing reads the attachment against a status from before
    // the run existed.
    set({
      status: {
        ...(get().status || {}),
        running: true,
        run_id: id,
        mode: mode || '',
        started_at: new Date().toISOString(),
      },
    });
    dispatch({ type: 'start', run_id: id, mode: mode || '' });
    showTab('results');
  }

  // scheduleSync reads the status the page holds against the live state, out
  // of the notify loop: attaching sets state, and setting state from inside a
  // render is how a page gets a re-entrant render. Any module may have put
  // that status there, which is why this follows a render rather than a fetch.
  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      dispatch({ type: 'status', status: get().status });
    });
  }

  // boot loads what the page shows first and starts the one status poll the
  // whole page shares.
  async function boot() {
    api.onRunStarted(started);
    await loadCatalog();
    await refresh();
    poller = setInterval(() => {
      // Only poll while nothing live is attached: a run being streamed reports
      // its own state, and the poll exists for the idle case. The gate is the
      // transport rather than state.run, because a run can be shown (history,
      // a finished report) with no transport attached to it, and a page with
      // neither a stream nor a poll would never learn the next run started.
      if (get().transport === 'idle') void status.poll();
    }, StatusPollMs);
  }

  // stop ends the poll and the transport. The page itself never calls it: it
  // exists so a test can start another page in the same process.
  function stop() {
    if (poller !== null) clearInterval(poller);
    poller = null;
    track = { ...track, attached: '' };
    reconcile();
  }

  return {
    boot,
    stop,
    scheduleSync,
    // The hooks each render module is initialised with, so the page and its
    // tests wire the same functions under the same names.
    hooks: {
      runner: { refresh, showTab, watch },
      sidebar: {
        openRun,
        retryCatalog: () => { void loadCatalog(); },
      },
    },
  };
}
