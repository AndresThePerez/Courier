// store.js — the single state object plus subscribe/set.
//
// No other module mutates state directly: render modules read `get()` and
// every change goes through `set(patch)`, which notifies every subscriber.
// That is the whole contract, and it is what lets the SSE reducer and the
// polling reducer feed identical renders without either knowing the other
// exists.

// initialState builds the page's starting state. It is a function so every
// call hands out fresh arrays and objects: resetState must not hand back a
// default that something already mutated.
const initialState = () => ({
  // catalog, from GET /api/collections
  collections: [],
  endpoints: [],
  target: '',

  // sidebar / editor selection
  workspace: [],
  savedCollections: [], // run sequences saved as collections in this browser
  selectedId: null,
  draft: null, // the request the editor is editing (a copy, never a catalog object)
  editorNotice: '', // why the editor closed a request it had open, until another is opened
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
});

const state = initialState();

const subscribers = [];

// resetState puts the state back to initialState in place, without notifying.
// It keeps the object's identity, so a module holding the value get() returned
// still reads the live state. The page itself never calls it: it exists so the
// frontend tests can start each case from a fresh page in one process.
export function resetState() {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, initialState());
}

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
