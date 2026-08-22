// store.js — the single state object plus subscribe/set.
//
// No other module mutates state directly: render modules read `get()` and
// every change goes through `set(patch)`, which notifies every subscriber.
// That is the whole contract, and it is what lets the SSE reducer and the
// polling reducer feed identical renders without either knowing the other
// exists.

const state = {
  // catalog, from GET /api/collections
  collections: [],
  endpoints: [],
  target: '',

  // sidebar / editor selection
  workspace: [],
  selectedId: null,
  draft: null, // the request the editor is editing (a copy, never a catalog object)
  send: null, // the editor's last Send: { pending, result, kind, error, field }

  // runner
  sequence: [], // [{ key, enabled, request }]
  mode: 'functional',
  options: { stop_on_failure: false, delay_ms: 0, concurrency: 10, duration_secs: 10 },

  // server-reported run state, from GET /api/status
  status: null,

  // the run currently being watched (live or reopened from history)
  run: null, // { id, mode, total, started_at, config, entries }
  results: [], // report.RequestResult rows, in arrival order
  progress: null, // the latest performance-mode progress payload
  report: null, // the full report once finished, or when reopened
  spectator: false,
  transport: 'idle', // idle | sse | polling

  history: [],
  activeTab: 'runner',
  notice: null,
};

const subscribers = [];

export function get() {
  return state;
}

export function set(patch) {
  Object.assign(state, patch);
  notify();
}

export function subscribe(fn) {
  subscribers.push(fn);
  return () => {
    const i = subscribers.indexOf(fn);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

function notify() {
  for (const fn of subscribers) {
    // One render module throwing must not stop the others from painting; a
    // half-rendered page with a console error is recoverable, a frozen one is
    // not.
    try {
      fn(state);
    } catch (err) {
      console.error('render failed', err);
    }
  }
}

// deepCopy is the one place a catalog object becomes an editable one. The
// curated collections are handed out by the server as a deep copy already;
// this keeps the same guarantee inside the page, where the same object would
// otherwise be shared between the sidebar tree, the editor, and the sequence.
export function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}
