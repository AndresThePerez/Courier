// render-runner.js — the run sequence, the run-config rail, and the three run
// controls (Start, Watch, Cancel).
//
// Everything visible here is a function of one fact: `state.status`, the
// server's own answer about whether a run is live and when the load budget will
// let the next one start. The page never decides that for itself — a 409 is not
// an error here, it is the server correcting an optimistic click, and the UI
// simply moves into the state the 409 describes.
//
// The single piece of local timekeeping is the cooldown countdown, which ticks
// a deadline the server handed over once. Asking the server what second it is,
// once a second, would be a poll — and there is exactly one poll on this page.

import { get, set, deepCopy } from './store.js';
import { el, replace, byId, fmtMs, fmtTime } from './dom.js';
import * as api from './api.js';
import { createRunConfig, createSavedCollections, SETUP_REFUSED } from './run-config.js';
import { WRITE_REFUSED } from './workspace.js';
import {
  requestPayload, runPayload, runProblem, runField, refusedText, capitalized, clampSetting, isQueueable, cutText,
} from './request-model.js';

// MaxSequence and Limits mirror internal/sandbox's caps and clamps. The server
// enforces them either way; matching them here means a visitor meets a cap as a
// disabled control and a sentence rather than as a 400 after the fact.
const MaxSequence = 50;

// The asymmetry is sandbox.clampOptions': under the floor falls back to the
// default, over the cap is pulled down to the cap.
const Limits = {
  delay_ms: { lo: 0, hi: 1000, fallback: 0 },
  concurrency: { lo: 1, hi: 50, fallback: 10 },
  duration_secs: { lo: 1, hi: 30, fallback: 10 },
};

// createRunSetup is the run setup's storage under this runner's caps. The
// page keeps one over localStorage; tests build fresh ones over the same
// storage to stand for a reload.
export function createRunSetup(area) {
  return createRunConfig({ storage: area, limits: Limits, maxSequence: MaxSequence });
}

const setup = createRunSetup(() => globalThis.localStorage);

// savedCollections is the page's list of sequences saved as collections. The
// sidebar lists them; this module saves them, because what is saved is the
// sequence it owns.
export const savedCollections = createSavedCollections({
  storage: () => globalThis.localStorage,
  get,
  set,
  target: globalThis,
  maxRequests: MaxSequence,
});

// MaxSavedCollections is where Save sequence stops saving more: it bounds
// what this tab adds, not what is stored or listed. Another tab saving at the
// same moment can take the list past it, and the sidebar lists every saved
// collection that is stored. The server never sees any of them.
const MaxSavedCollections = 50;

const optionOf = {
  'delay-ms': 'delay_ms',
  concurrency: 'concurrency',
  'duration-secs': 'duration_secs',
};

const modeNotes = {
  functional: 'Runs the checked requests once, in order, and evaluates every assertion.',
  performance: 'Holds the workers against the target for the full duration, closed-loop. Assertions are not evaluated.',
};

// ---------------------------------------------------------------- knee demo
//
// KneePoints is the measured saturation series, run through
// this API on the DEPLOY host against PokéSearch milestone-3 over the
// 20,324-document index as it stood on the date below, and the internal Docker
// network: 1 / 10 / 25 / 50
// workers, 10s each, measured at deploy calibration (2026-08-22). docs/knee.md
// carries this series plus the earlier dev-workstation one for the hardware
// comparison.
//
// They are constants rather than a fetch on purpose. This is a *record* of a
// measurement taken on known hardware against a known corpus, not a live
// reading — a number that quietly changed with the weather would make the
// panel's claim unfalsifiable. The buttons are how a visitor takes their own
// reading and compares.
const KneeDuration = 10;
const KneeCollection = 'search-basics';
const KneePoints = [
  { workers: 1, rps: 46.4, p50: 29.24, p95: 38.64, errPct: 0 },
  { workers: 10, rps: 154.1, p50: 70.36, p95: 118.8, errPct: 0, knee: true },
  { workers: 25, rps: 166.5, p50: 147.85, p95: 262.24, errPct: 0 },
  { workers: 50, rps: 174.8, p50: 281.83, p95: 407.93, errPct: 0 },
];

// refresh / showTab are wired by main.js, which owns the status poll and the
// tab routing. Reaching into main.js from here would be an import cycle.
// edit opens a queued entry in the editor, by its key.
let hooks = { refresh: async () => {}, showTab: () => {}, watch: () => {}, over: () => false, edit: () => {} };

// Module-local render memory and notes, the same arrangement render-editor.js
// uses: none of this is application state, it is what this module has last
// painted and what it last has to say.
let counter = 0;
let lastSignature = null;
let lastEndpoints = null;
let sequenceNote = '';
let setupNote = '';
let startNote = '';
let cancelNote = '';
let cancelNoteRun = ''; // the run a failed cancel was for; its note goes when that run does
let starting = false;
let cancelling = false;
let startedRunId = '';
let ticker = null;
let lastPhase = null;
let lastLive = ''; // the run last seen live in this tab's status or view
let kneeNote = '';
// addNote is what the add-note live region says about the last add, and
// addNoteCount the number queued it states: a note whose count is no longer
// true is not left on screen.
let addNote = '';
let addNoteCount = -1;
// refusal is the queued request the server (or the same checks, run here
// first) last refused, held by the entry's key so its mark follows that entry
// through a reorder: { key, assertion, part, param, label, message }, param
// present only when a parameter was refused. The note's row
// number is read from where the entry is now, never from where it was.
let refusal = null;
// cut is what the server cut from the run this tab last started: the fields
// of its 202's `truncated`, with the queued entries the run was sent from, so
// the sentence names each request by the row it is in now. The next Start
// takes it away.
let cut = null; // { list, keys }
// settingNotes says, per run setting, what the run will use when that is not
// what was typed. Each is written when the visitor types, never by a render,
// so a poll cannot announce it again.
const settingNotes = { delay_ms: '', concurrency: '', duration_secs: '' };

export function init(h) {
  hooks = { ...hooks, ...h };
  sayAdded('', -1);

  byId('select-all').addEventListener('click', () => setAllEnabled(true));
  byId('save-sequence').addEventListener('click', saveSequence);
  byId('deselect-all').addEventListener('click', () => setAllEnabled(false));

  byId('mode-functional').addEventListener('change', () => setMode('functional'));
  byId('mode-performance').addEventListener('change', () => setMode('performance'));

  byId('stop-on-failure').addEventListener('change', (e) => setOption('stop_on_failure', e.target.checked));
  for (const [id, key] of Object.entries(optionOf)) {
    const input = byId(id);
    input.addEventListener('input', (e) => {
      const read = clampSetting(Limits[key], e.target.value, Boolean(e.target.validity && e.target.validity.badInput));
      settingNotes[key] = read.note;
      setOption(key, read.value);
    });
    // Repaint on blur so a field the visitor cleared, or pushed past its cap,
    // comes back showing the number the run will actually use.
    input.addEventListener('blur', () => render(get()));
  }

  byId('start-run').addEventListener('click', start);
  byId('cancel-run').addEventListener('click', cancel);
  byId('watch-run').addEventListener('click', watch);
}

// ---------------------------------------------------------------- method badges

// methodBadge is a request's method, read from the endpoint catalog by the
// request's endpoint id: the catalog is the one place a method is stated, so
// a list that wrote its own would be wrong the day a POST endpoint exists.
// GET and POST are coloured; any other method is muted; a request whose
// endpoint the page does not know (one stored for an endpoint that is gone, or
// any request before the catalog has loaded) shows a muted placeholder rather
// than a guess. Every list of requests on the page uses this one.
export function methodBadge(endpoints, endpointId) {
  const ep = Array.isArray(endpoints) ? endpoints.find((e) => e && e.id === endpointId) : null;
  const method = ep && typeof ep.method === 'string' ? ep.method.trim().toUpperCase().slice(0, 7) : '';
  if (!method) {
    return el('span', {
      class: 'method method-none',
      text: '---',
      title: 'This request\'s endpoint is not in the catalog the page has loaded',
      attrs: { 'aria-label': 'Method unknown' },
    });
  }
  const tone = method === 'GET' ? 'method-get' : method === 'POST' ? 'method-post' : 'method-other';
  return el('span', { class: `method ${tone}`, text: method });
}

// ---------------------------------------------------------------- the setup

// restore puts back the run setup this browser kept, at page load only.
export function restore() {
  sayAdded('', -1);
  for (const key of Object.keys(settingNotes)) settingNotes[key] = '';
  set(setup.load());
}

// setSetup is every change to the sequence, the mode or the options: it
// stores the setup whole, then shows it. A refused write keeps the change on
// this page and says so beside the sequence until a write is accepted.
function setSetup(patch) {
  setupNote = setup.save({ ...get(), ...patch }).ok ? '' : SETUP_REFUSED;
  set(patch);
}

// ---------------------------------------------------------------- the sequence

// entryFor snapshots a request into the sequence. The deep copy is the point:
// queueing a request captures it as it is now, so editing it afterwards — or
// deleting it from My Workspace — cannot silently rewrite a run that is already
// configured.
function entryFor(request) {
  counter += 1;
  return { key: `seq-${counter}`, enabled: true, request: deepCopy(request) };
}

// sayAdded sets what the add-note live region says. The `+` and "Add all"
// are pressed in the sidebar, usually with the Request tab showing and the
// sequence out of sight, so this sentence and the count on the Runner tab are
// the only places the visitor learns the press did anything.
function sayAdded(text, count) {
  addNote = text;
  addNoteCount = count;
}

// nameOf is how a note names a request or a collection: by name, else by id.
function nameOf(thing, fallback) {
  const name = thing && typeof thing.name === 'string' && thing.name ? thing.name : '';
  const id = thing && typeof thing.id === 'string' ? thing.id : '';
  return name || id || fallback;
}

const capReached = (name) => `Could not add "${name}" - the run already holds ${MaxSequence} requests, the cap.`;

// queueable answers whether a request may join the run: one the server would
// refuse is never queued, so the run's note never has to name a row the page
// let in knowing it was wrong.
function queueable(request) {
  try {
    return isQueueable(request);
  } catch (error) {
    console.warn('queued request not checked', error);
    return false;
  }
}

// refuseAdd says, once and in both places a press is answered, that nothing
// was added and why.
function refuseAdd(name, count) {
  const said = `"${name}" has an invalid assertion - fix it in the editor before queuing it.`;
  sequenceNote = said;
  sayAdded(said, count);
  render(get());
}

// add is main.js's sidebar hook for the per-request `+` button.
export function add(request) {
  const list = get().sequence;
  if (!queueable(request)) {
    refuseAdd(nameOf(request, 'that request'), list.length);
    return;
  }
  if (list.length >= MaxSequence) {
    sequenceNote = `${MaxSequence} requests is the cap - remove one before adding another.`;
    sayAdded(capReached(nameOf(request, 'that request')), list.length);
    render(get());
    return;
  }
  sequenceNote = '';
  sayAdded(`Added "${nameOf(request, 'that request')}" to the run - ${list.length + 1} queued.`, list.length + 1);
  setSetup({ sequence: [...list, entryFor(request)] });
}

// addAll is the "Add all to run" hook. A collection that does not fit is added
// as far as it goes and the note says how far: silently dropping the tail, or
// refusing the whole collection over the cap, would both be worse than saying
// what happened. A collection holding a request the server would refuse is
// another matter: adding the rest would queue a run other than the one the
// collection describes, so none of it is added, and the note names the one.
export function addAll(collection) {
  const list = get().sequence;
  const requests = (collection && collection.requests) || [];
  const invalid = requests.find((r) => !queueable(r));
  if (invalid) {
    refuseAdd(nameOf(invalid, 'a request'), list.length);
    return;
  }
  const taken = requests.slice(0, Math.max(MaxSequence - list.length, 0));

  const name = nameOf(collection, 'that collection');

  if (taken.length === 0) {
    sequenceNote = requests.length === 0
      ? 'That collection has no requests.'
      : `${MaxSequence} requests is the cap - remove one before adding another.`;
    sayAdded(requests.length === 0 ? `Nothing added - "${name}" has no requests.` : capReached(name), list.length);
    render(get());
    return;
  }
  const total = list.length + taken.length;
  sequenceNote = taken.length < requests.length
    ? `Added ${taken.length} of ${requests.length} - ${MaxSequence} requests is the cap.`
    : '';
  sayAdded(taken.length < requests.length
    ? `Added ${taken.length} of the ${requests.length} requests in "${name}" to the run - ${total} queued, the cap.`
    : `Added the ${taken.length} request${taken.length === 1 ? '' : 's'} in "${name}" to the run - ${total} queued.`, total);
  setSetup({ sequence: [...list, ...taken.map((r) => entryFor(r))] });
}

// queuedEntry is the entry a key names, or null.
export function queuedEntry(key) {
  return get().sequence.find((e) => e.key === key) || null;
}

// queuedPosition is the 1-based row an entry is in now, or 0 when it is gone.
export function queuedPosition(key) {
  return get().sequence.findIndex((e) => e.key === key) + 1;
}

// repoint replaces the request one queued entry holds, keeping its key, its
// position and whether it is checked: the editor's Save of a request opened
// from that row, and the copy a curated request is forked into. A refusal of
// that entry goes with a fix (fixed), and stays across a fork, which changes
// nothing the server would read. Answers whether the entry was still there.
export function repoint(key, request, { fixed = true } = {}) {
  const list = get().sequence;
  if (!list.some((e) => e.key === key)) return false;
  if (fixed && refusal && refusal.key === key) refusal = null;
  setSetup({ sequence: list.map((e) => (e.key === key ? { ...e, request: deepCopy(request) } : e)) });
  return true;
}

// move is the whole reordering story: drag-and-drop is deliberately absent, and
// the arrows were always going to be the accessible path anyway. Focus follows
// the row by its stable key, so a keyboard visitor can press the same button
// twice.
function move(index, delta) {
  const list = get().sequence.slice();
  const to = index + delta;
  if (to < 0 || to >= list.length) return;
  [list[index], list[to]] = [list[to], list[index]];
  setSetup({ sequence: list });
}

function removeAt(index) {
  sequenceNote = '';
  sayAdded('', -1);
  setSetup({ sequence: get().sequence.filter((_, i) => i !== index) });
}

function setEnabled(key, on) {
  setSetup({ sequence: get().sequence.map((e) => (e.key === key ? { ...e, enabled: on } : e)) });
}

function setAllEnabled(on) {
  setSetup({ sequence: get().sequence.map((e) => (e.enabled === on ? e : { ...e, enabled: on })) });
}

// saveSequence saves every queued request, checked or not, in order, as a
// collection in this browser.
function saveSequence() {
  const list = get().sequence;
  const input = byId('save-sequence-name');
  const name = input.value.trim();
  if (list.length === 0) {
    sequenceNote = 'Queue at least one request before saving the sequence.';
  } else if (!name) {
    sequenceNote = 'Name the collection before saving it.';
  } else if (get().savedCollections.length >= MaxSavedCollections) {
    sequenceNote = `${MaxSavedCollections} saved collections is the cap - delete one before saving another.`;
  } else {
    const { ok, collection } = savedCollections.create(name, list.map((e) => e.request));
    const n = collection.requests.length;
    sequenceNote = ok
      ? `Saved "${collection.name}" with ${n} request${n === 1 ? '' : 's'} to My Workspace.`
      : WRITE_REFUSED;
    input.value = '';
  }
  render(get());
}

// ---------------------------------------------------------------- knee demo

// preloadKnee is the whole one-click promise: it replaces the sequence, the
// mode and both performance knobs in a single set(), so the page repaints once
// and the visitor's next act is pressing Start.
//
// Replacing rather than appending is the point. Adding to whatever was already
// queued would reproduce a *different* run than the one the table measured,
// and the table would then be describing something the button does not do.
//
// Replacing is also why the note says what went: a visitor who had queued
// requests of their own would otherwise find them gone without a word.
function preloadKnee(workers) {
  const state = get();
  const collections = state.collections || [];
  const collection = collections.find((c) => c.id === KneeCollection);
  const requests = (collection && collection.requests) || [];
  if (requests.length === 0) {
    kneeNote = kneeUnavailable(state, collections);
    render(get());
    return;
  }
  sequenceNote = '';
  startNote = '';
  settingNotes.concurrency = '';
  settingNotes.duration_secs = '';
  sayAdded('', -1);
  const at = `at ${workers} worker${workers === 1 ? '' : 's'} for ${KneeDuration}s`;
  const queued = state.sequence.length;
  const press = 'Press Start run to take your own reading.';
  if (queued === 0) {
    kneeNote = `Loaded ${requests.length} search requests ${at}. ${press}`;
  } else {
    const switched = state.mode === 'performance' ? '' : ' and switched to Performance';
    kneeNote = `Replaced the ${queued} queued request${queued === 1 ? '' : 's'} with the`
      + ` ${requests.length} ${KneeCollection} requests ${at}${switched}. ${press}`;
  }
  setSetup({
    sequence: requests.map((r) => entryFor(r)),
    mode: 'performance',
    options: { ...get().options, concurrency: workers, duration_secs: KneeDuration },
  });
}

// kneeUnavailable says why a preset replaced nothing. preloadKnee reads the
// catalog, which is empty while it loads and after a load failed, and the two
// call for different things from the visitor.
function kneeUnavailable(state, collections) {
  if (collections.length > 0) {
    return `The ${KneeCollection} collection is not in the catalog the server sent - nothing was replaced.`;
  }
  if (state.notice) {
    return 'The curated collections could not be loaded - press Retry under Collections, then try a preset again. Nothing was replaced.';
  }
  return 'The curated collections have not loaded yet - give the page a moment and try again.';
}

function renderKnee(state) {
  const note = byId('knee-note');
  note.hidden = !kneeNote;
  setText(note, kneeNote);

  // The table and the buttons are constants, so they are built once per page.
  // Rebuilding them on every status poll would take focus off a button
  // mid-keyboard-press for no gain, the same reason renderSequence keeps a
  // signature.
  if (byId('knee-buttons').firstChild) return;

  const head = el('tr', {}, [
    el('th', { text: 'workers' }),
    el('th', { text: 'req/s' }),
    el('th', { text: 'p50' }),
    el('th', { text: 'p95' }),
    el('th', { text: 'errors' }),
  ]);
  const rows = KneePoints.map((p) => {
    const tr = el('tr', {}, [
      el('td', { text: String(p.workers) }),
      el('td', { text: p.rps.toFixed(1) }),
      el('td', { text: fmtMs(p.p50) }),
      el('td', { text: fmtMs(p.p95) }),
      el('td', { text: `${p.errPct.toFixed(2)}%` }),
    ]);
    if (p.knee) tr.className = 'is-knee';
    return tr;
  });
  replace(byId('knee-table'), [
    el('table', { class: 'data-table' }, [el('thead', {}, [head]), el('tbody', {}, rows)]),
    el('p', {
      class: 'note',
      text: 'Ten workers already deliver 88% of everything this target ever gives up. Going to'
        + ' 25 buys 8% more throughput for double the median latency, and 50 buys 5% more for'
        + ' double again. That is the knee: past it the queue is growing, not the work getting'
        + ' done.',
    }),
  ]);

  replace(byId('knee-buttons'), KneePoints.map((p) => el('button', {
    class: `btn btn-mini${p.knee ? ' btn-primary' : ''}`,
    type: 'button',
    text: `${p.workers} worker${p.workers === 1 ? '' : 's'}${p.knee ? ' - the knee' : ''}`,
    title: `Load a ${KneeDuration}s performance run at ${p.workers} worker${p.workers === 1 ? '' : 's'}`
      + ` over the ${KneeCollection} collection (measured: ${p.rps.toFixed(1)} req/s, p50 ${fmtMs(p.p50)})`,
    on: { click: () => preloadKnee(p.workers) },
  })));
}

// ---------------------------------------------------------------- run config

function setMode(mode) {
  if (get().mode === mode) return;
  startNote = '';
  setSetup({ mode });
}

function setOption(key, value) {
  setSetup({ options: { ...get().options, [key]: value } });
}

// ---------------------------------------------------------------- run controls

async function start() {
  if (starting) return;
  const state = get();
  const entries = state.sequence.filter((e) => e.enabled);
  if (entries.length === 0) {
    startNote = 'Nothing is checked - a run needs at least one request.';
    render(get());
    return;
  }

  starting = true;
  startNote = '';
  cancelNote = '';
  cut = null;
  render(get());

  // Deliberately not gated on the phase this module last rendered: the button
  // being disabled is the affordance, the server is the authority. A click that
  // slips through between the run ending and the poll noticing gets a 409 and
  // lands in the right state.
  // Whatever building or sending the payload throws, Start must come back:
  // a button left on "Starting..." can only be cleared by a reload. Only a
  // payload this page could not build or encode is blamed on a queued
  // request; a request that was built and then failed on the way is not.
  let outcome;
  try {
    let payload = null;
    try {
      payload = runPayload(state.mode, entries.map((e) => e.request), state.options);
      // Encoded once here so a payload that cannot be encoded fails as one,
      // rather than inside the request.
      JSON.stringify(payload);
    } catch (error) {
      console.warn('run not sent', error);
      payload = null;
      outcome = { ok: false, kind: 'error', error: 'a queued request could not be sent from this page.' };
    }
    // What the server would refuse is refused here, the same way and by the
    // same field, without a round trip.
    const problem = payload && runProblem(payload);
    if (problem) {
      outcome = { ok: false, kind: 'invalid', error: problem.message, field: problem.field, part: problem.part };
      payload = null;
    }
    if (payload) outcome = await api.startRun(payload);
  } catch (error) {
    console.warn('run not started', error);
    outcome = { ok: false, kind: 'network' };
  } finally {
    starting = false;
  }
  applyStartOutcome(outcome, state.mode, entries);
  // Through the store rather than this module's render alone: a refusal
  // marks the editor too, when the refused request is open there.
  set({});
  await hooks.refresh();
  render(get());
}

function applyStartOutcome(outcome, mode, entries) {
  if (outcome.ok) {
    startNote = '';
    refusal = null;
    cut = { list: outcome.truncated, keys: entries.map((e) => e.key) };
    startedRunId = outcome.runId;
    // A 202 read after this tab saw its run end says nothing about now.
    if (hooks.over(outcome.runId)) return;
    adoptStatus({
      running: true,
      run_id: outcome.runId,
      mode,
      started_at: new Date().toISOString(),
    });
    return;
  }
  if (outcome.kind === 'busy') {
    // Someone else got there first. Not an error — an invitation to watch.
    startNote = '';
    adoptStatus(outcome.runId ? { running: true, run_id: outcome.runId } : { running: true });
    return;
  }
  if (outcome.kind === 'cooling') {
    startNote = '';
    adoptStatus({ running: false, cooldown_until: outcome.cooldownUntil });
    return;
  }
  if (outcome.kind === 'network') {
    startNote = 'Could not reach Courier - the run was not started.';
    return;
  }
  if (outcome.kind === 'invalid') {
    refuse(outcome, entries);
    return;
  }
  if (outcome.kind === 'overloaded') {
    // The server was momentarily full: nothing about this run was refused.
    startNote = `Busy - ${outcome.error}`;
    return;
  }
  startNote = `Could not start the run - ${outcome.error}`;
}

// refuse reads a refused field back to what the visitor sees. The server
// numbers the payload, which holds only the checked requests, so its index is
// read through the entries that were sent to the queued entry it names. A
// field the page cannot place (past the end of what was sent, or a name it
// does not know) is shown as it came and marks nothing: a raw index relabelled
// as a row would point at the wrong one.
function refuse(outcome, entries) {
  refusal = null;
  startNote = '';
  const at = runField(outcome.field);
  if (!at) {
    startNote = refusedText(outcome.field, outcome.error);
    return;
  }
  if (at.index === undefined) {
    startNote = refusedText(capitalized(at.label), outcome.error);
    return;
  }
  const entry = entries[at.index];
  if (!entry) {
    startNote = refusedText(outcome.field, outcome.error);
    return;
  }
  if (!get().sequence.some((e) => e.key === entry.key)) {
    startNote = refusedText('a request since removed from the run', outcome.error);
    return;
  }
  refusal = {
    key: entry.key,
    assertion: at.where.assertion,
    part: at.where.part || outcome.part || '',
    param: at.where.param,
    label: at.where.label,
    message: outcome.error,
  };
}

// refusalText is the run's note for the refused entry, numbered from where
// the entry is now.
function refusalText(state) {
  if (!refusal) return '';
  const i = state.sequence.findIndex((e) => e.key === refusal.key);
  if (i < 0) return '';
  return refusedText(`Request ${i + 1}${refusal.label ? `, ${refusal.label}` : ''}`, refusal.message);
}

// refusalIn is the refusal's own sentence beside its row.
const refusalIn = (r) => (r.label ? `${capitalized(r.label)}: ${r.message}` : r.message);

// refusedAssertion is the editor's half of a refusal: which assertion of the
// request it has open is the refused one, or null. It is that request only
// while it is the same request with the refused assertion as it was sent,
// however it was opened: an assertion edited since is no longer the one the
// server refused, and typed back to that, it is again.
export function refusedAssertion(draft) {
  if (!refusal || refusal.assertion === null || !draft) return null;
  const entry = get().sequence.find((e) => e.key === refusal.key);
  if (!entry) return null;
  const j = refusal.assertion;
  const mark = { assertion: j, part: refusal.part, message: refusal.message };
  if (!entry.request || entry.request.id !== draft.id) return null;
  try {
    const sent = requestPayload(entry.request).assertions;
    const open = requestPayload(draft).assertions;
    if (!Array.isArray(sent) || !Array.isArray(open) || j >= open.length) return null;
    return JSON.stringify(sent[j]) === JSON.stringify(open[j]) ? mark : null;
  } catch {
    return null;
  }
}

// refusedParam is the same for a refused parameter: { param, message } while
// the request open is the refused one and that parameter (or, with param '',
// the whole table) is as it was sent, or null.
export function refusedParam(draft) {
  if (!refusal || refusal.param === undefined || !draft) return null;
  const entry = get().sequence.find((e) => e.key === refusal.key);
  if (!entry || !entry.request || entry.request.id !== draft.id) return null;
  try {
    const sent = requestPayload(entry.request).params;
    const open = requestPayload(draft).params;
    const key = refusal.param;
    const same = key === ''
      ? JSON.stringify(sent) === JSON.stringify(open)
      : Object.hasOwn(open, key) && JSON.stringify(sent[key]) === JSON.stringify(open[key]);
    return same ? { param: key, message: refusal.message } : null;
  } catch {
    return null;
  }
}

// adoptStatus folds a server-reported fact into state.status. A 409 body comes
// from the same manager the status poll reads, so it is just as authoritative,
// and adopting it is what makes the UI flip states without a round trip. The
// next poll corrects it if the moment has already passed.
function adoptStatus(patch) {
  set({ status: { ...(get().status || {}), ...patch } });
}

async function cancel() {
  const id = (get().status || {}).run_id;
  if (!id || cancelling) return;

  cancelling = true;
  cancelNote = '';
  render(get());

  // Cancel comes back on every outcome, as Start does.
  let outcome;
  try {
    outcome = await api.cancelRun(id);
  } catch (error) {
    console.warn('cancel not sent', error);
    outcome = { ok: false, kind: 'network' };
  } finally {
    cancelling = false;
  }
  // A 404 means the run finished on its own between the click and the request.
  // From here that is the same fact as a successful cancel: there is nothing
  // left to stop.
  if (outcome.ok || outcome.gone) cancelNote = '';
  else if (outcome.kind === 'network') cancelNote = 'Could not reach Courier - the run was not cancelled.';
  else cancelNote = `Could not cancel - ${outcome.error}`;
  cancelNoteRun = id;
  render(get());
  await hooks.refresh();
  render(get());
}

// watch is spectator mode's entry point. main.js's live module owns which run
// this tab follows and what following it does to the view; what belongs here
// is the button.
function watch() {
  if (!(get().status || {}).run_id) return;
  startNote = '';
  hooks.watch();
  hooks.showTab('results');
}

// ---------------------------------------------------------------- run phase

function cooldownMsLeft(state) {
  const until = state.status && state.status.cooldown_until;
  if (!until) return 0;
  const ms = new Date(until).getTime() - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function runPhase(state) {
  if (state.status && state.status.running) return 'running';
  if (cooldownMsLeft(state) > 0) return 'cooling';
  return 'idle';
}

// The countdown is a local 1s tick against a deadline, never a request. It
// re-enables Start the instant the deadline passes instead of up to one poll
// interval later, and it stops itself the moment there is nothing left to count.
function ensureTicker(active) {
  if (active && ticker === null) ticker = setInterval(tick, 1000);
  else if (!active && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

// A tick repaints this module and nothing else — no other view depends on the
// second-by-second count. The last second is the exception: the phase is about
// to change, and the topbar renders the phase too, so those ticks go through
// the store and everybody repaints together.
//
// The threshold is a whole second rather than zero on purpose. Branching on
// "has the deadline passed" would read the clock once here and again inside the
// render, and a tick landing between the two reads would repaint this module
// as idle while leaving "cooling down" in the topbar until the next poll.
function tick() {
  if (cooldownMsLeft(get()) > 1000) render(get());
  else set({});
}

// ---------------------------------------------------------------- render

// runnerTabLabel is what the Runner tab reads: the number of requests queued,
// checked or not, since an unchecked request is still in the sequence and
// still counts against the cap. Nothing queued reads plain "Runner".
export function runnerTabLabel(sequence) {
  const n = Array.isArray(sequence) ? sequence.length : 0;
  return n === 0 ? 'Runner' : `Runner (${n})`;
}

// renderTabLabel puts that count on the tab, which is the one part of the
// runner a visitor can see from the Request and Results tabs.
function renderTabLabel(state) {
  setText(byId('tab-runner'), runnerTabLabel(state.sequence));
}

function renderAddNote(state) {
  // Only a note that is still true stays: removing a request, a knee preset
  // or a restored setup changes the count it states.
  if (addNote && addNoteCount !== state.sequence.length) sayAdded('', -1);
  setText(byId('add-note'), addNote);
}

export function render(state) {
  renderTabLabel(state);
  renderAddNote(state);
  renderKnee(state);
  renderSequence(state);
  renderConfig(state);
  renderControls(state);
  renderLedger(state);
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function renderSequence(state) {
  const list = state.sequence;
  const on = list.filter((e) => e.enabled).length;
  setText(byId('sequence-count'), `${list.length} of ${MaxSequence} - ${on} selected`);

  const note = byId('sequence-note');
  const noteText = [sequenceNote, setupNote].filter(Boolean).join(' ');
  note.hidden = !noteText;
  setText(note, noteText);

  byId('select-all').disabled = list.length === 0;
  byId('deselect-all').disabled = list.length === 0;
  byId('save-sequence').disabled = list.length === 0;

  // Rebuild only when something a row paints changed. The 3s status poll
  // notifies every render module; rebuilding this list on each one would take
  // the focus out from under a visitor reordering rows with the keyboard. The
  // signature holds each entry's whole request, not only its key: a request is
  // replaced under the same key (Save through a row's Edit, the copy Edit
  // makes), and a key-only signature would leave the row showing a request
  // the run no longer holds.
  // The catalog arriving is a change too: it is what the badges are read from.
  if (refusal && !list.some((e) => e.key === refusal.key)) refusal = null;
  const refusedSig = refusal ? `${refusal.key}\n${refusal.label}\n${refusal.message}` : '';
  const sig = `${list.map(entrySignature).join('\u0001')}#${refusedSig}`;
  if (sig === lastSignature && state.endpoints === lastEndpoints) return;
  lastSignature = sig;
  lastEndpoints = state.endpoints;

  const focus = focusKey();
  const rows = byId('sequence-list');
  if (list.length === 0) {
    replace(rows, [el('div', {
      class: 'rows-empty',
      text: 'Nothing queued. Add a request with + in the sidebar, or add a whole collection with "Add all to run".',
    })]);
  } else {
    replace(rows, list.map((entry, i) => shownRow(entry, i, list.length, state.endpoints)));
  }
  restoreFocus(focus);
}

// entrySignature is everything one row is drawn from. A request JSON cannot
// encode (a BigInt, nesting too deep) is still a row that must be shown and
// removable, so it is told apart by its identity instead: replacing it still
// repaints its row.
const unencodable = new WeakMap();
let unencodableCount = 0;

function entrySignature(entry) {
  try {
    return JSON.stringify([entry.key, Boolean(entry.enabled), entry.request]);
  } catch {
    if (!unencodable.has(entry.request)) {
      unencodableCount += 1;
      unencodable.set(entry.request, unencodableCount);
    }
    return `${entry.key}:${entry.enabled ? 1 : 0}:#${unencodable.get(entry.request)}`;
  }
}

// Assertion chips teach that assertions exist without opening the editor: each
// row wears its checks. Labels are compressed to fit a chip - the editor
// remains the place to read them in full, and the results pane the place to see
// how they went.
const opGlyph = { eq: '=', neq: '≠', gt: '>', lt: '<', contains: '~', count: '#' };

function chipLabel(a) {
  switch (a.type) {
    case 'status': return `status ${opGlyph[a.op] || a.op} ${a.value}`;
    // lt is the only operator assert.opsByType allows on latency, so the
    // glyph is a constant rather than a lookup that can only ever answer "<".
    case 'latency': return `< ${a.value}ms`;
    case 'json':
      if (a.op === 'exists') return `${a.path} exists`;
      return `${a.path} ${opGlyph[a.op] || a.op} ${JSON.stringify(a.value)}`;
    case 'body_contains': return `body ~ ${JSON.stringify(a.value)}`;
    default: return a.type;
  }
}

// Returns null for a request with no assertions: a plain probe wears no chips
// rather than an empty strip of padding. el() skips null children.
function assertionChips(assertions) {
  if (!assertions || assertions.length === 0) return null;
  return el('span', { class: 'seq-chips' },
    assertions.map((a) => el('span', { class: 'chip mono', text: chipLabel(a) })));
}

function sequenceRow(entry, index, total, endpoints) {
  const r = entry.request;
  const query = Object.entries(r.params || {}).map(([k, v]) => `${k}=${v}`).join('&');

  const check = el('input', {
    class: 'seq-check',
    type: 'checkbox',
    attrs: {
      name: `seq-check-${entry.key}`,
      'aria-label': `Include ${r.name || r.id} in the run`,
      'data-focus-key': `seq-check:${entry.key}`,
    },
    on: { change: (e) => setEnabled(entry.key, e.target.checked) },
  });
  check.checked = entry.enabled;

  const refused = refusal && refusal.key === entry.key ? refusal : null;
  const errorId = `seq-error-${entry.key}`;
  if (refused) check.setAttribute('aria-describedby', errorId);

  return el('div', { class: `row seq-row${entry.enabled ? '' : ' is-off'}${refused ? ' is-invalid' : ''}` }, [
    el('span', { class: 'seq-index mono', text: String(index + 1) }),
    check,
    methodBadge(endpoints, r.endpoint),
    el('span', { class: 'seq-body' }, [
      el('span', { class: 'seq-name', text: r.name || r.id }),
      el('span', { class: 'seq-target mono', text: `${r.endpoint}${query ? `?${query}` : ''}` }),
      assertionChips(r.assertions),
      refused && el('span', { class: 'seq-error fail', text: refusalIn(refused), attrs: { id: errorId } }),
    ]),
    el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: 'Edit',
      title: 'Open this queued request in the editor',
      attrs: { 'aria-label': `Edit ${r.name || r.id}`, 'data-focus-key': `seq-edit:${entry.key}` },
      on: { click: () => hooks.edit(entry.key) },
    }),
    arrow('↑', `Move ${r.name || r.id} up`, `seq-up:${entry.key}`, index === 0, () => move(index, -1)),
    arrow('↓', `Move ${r.name || r.id} down`, `seq-down:${entry.key}`, index === total - 1, () => move(index, 1)),
    el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: 'x',
      title: 'Remove from the run',
      attrs: { 'aria-label': `Remove ${r.name || r.id} from the run` },
      on: { click: () => removeAt(index) },
    }),
  ]);
}

// shownRow keeps one queued request the page cannot draw from taking the
// whole list with it: that row is shown without its details, and can still
// be removed.
function shownRow(entry, index, total, endpoints) {
  try {
    return sequenceRow(entry, index, total, endpoints);
  } catch (error) {
    console.warn('queued request not shown', error);
    return el('div', { class: 'row seq-row is-off' }, [
      el('span', { class: 'seq-index mono', text: String(index + 1) }),
      el('span', { class: 'seq-body' }, [el('span', { class: 'seq-name', text: 'This queued request cannot be shown.' })]),
      el('button', {
        class: 'btn btn-mini',
        type: 'button',
        text: 'x',
        title: 'Remove from the run',
        attrs: { 'aria-label': `Remove request ${index + 1} from the run` },
        on: { click: () => removeAt(index) },
      }),
    ]);
  }
}

function arrow(glyph, label, key, disabled, onClick) {
  const btn = el('button', {
    class: 'btn btn-mini',
    type: 'button',
    text: glyph,
    title: label,
    attrs: { 'aria-label': label, 'data-focus-key': key },
    on: { click: onClick },
  });
  btn.disabled = disabled;
  return btn;
}

function renderConfig(state) {
  byId('mode-functional').checked = state.mode === 'functional';
  byId('mode-performance').checked = state.mode === 'performance';
  byId('functional-options').hidden = state.mode !== 'functional';
  byId('performance-options').hidden = state.mode !== 'performance';
  setText(byId('mode-note'), modeNotes[state.mode] || '');

  byId('stop-on-failure').checked = Boolean(state.options.stop_on_failure);
  for (const [id, key] of Object.entries(optionOf)) {
    setNumber(id, state.options[key]);
    const note = byId(`${id}-note`);
    note.hidden = !settingNotes[key];
    setText(note, settingNotes[key]);
  }
}

// setNumber never writes over the field the visitor is typing into: assigning a
// value moves the caret to the end, and a half-typed "5" on its way to "50"
// would be clamped back under their fingers.
function setNumber(id, value) {
  const input = byId(id);
  if (document.activeElement === input) return;
  const text = String(value);
  if (input.value !== text) input.value = text;
}

function renderControls(state) {
  const phase = runPhase(state);
  const runId = (state.status || {}).run_id || '';
  const selected = state.sequence.filter((e) => e.enabled).length;

  const startBtn = byId('start-run');
  startBtn.disabled = phase !== 'idle' || selected === 0 || starting;
  setText(startBtn, starting ? 'Starting...' : 'Start run');

  const watchBtn = byId('watch-run');
  watchBtn.hidden = phase !== 'running' || !runId;
  watchBtn.title = runId ? `Follow run ${runId} in the Results tab` : '';

  const cancelBtn = byId('cancel-run');
  // Any visitor may cancel, spectators included: cancelling only ever reduces
  // load, and a visitor watching a run they cannot stop is the worse of the
  // two. What changes here is only the presentation, because the button said
  // nothing about whose measurement it ends.
  const mine = Boolean(runId) && runId === startedRunId;
  cancelBtn.hidden = phase !== 'running' || !runId;
  cancelBtn.disabled = cancelling;
  setText(cancelBtn, mine ? 'Cancel run' : 'Cancel this run');
  cancelBtn.title = !runId ? ''
    : mine ? `Stop run ${runId}`
    : `Stop run ${runId}, which another visitor started`;

  const banner = byId('run-status-banner');
  const bannerText = bannerFor(state, phase);
  banner.hidden = !bannerText;
  banner.className = `banner${phase === 'running' ? ' is-live' : ''}`;
  setText(banner, bannerText);

  const countdown = byId('cooldown-countdown');
  const left = cooldownMsLeft(state);
  countdown.hidden = phase !== 'cooling';
  setText(countdown, left > 0 ? `Start unlocks in ${Math.ceil(left / 1000)}s` : '');
  // One beat past the deadline as well as during it. Whichever render noticed
  // the cooldown end may have straddled it — main.js reads the clock again for
  // the topbar — so the extra tick repaints the page once more and settles
  // everyone on the same phase a second later rather than a poll later.
  ensureTicker(phase === 'cooling' || lastPhase === 'cooling');
  lastPhase = phase;

  // Start and Cancel each say their own piece, so neither request settling
  // can wipe what the other reported. A failed cancel is about one run, and
  // its note leaves with that run. What a Start said is about a run that did
  // not start, and goes when a run goes live: this tab's own whose 202 was
  // lost, or another visitor's.
  if (cancelNote && runId !== cancelNoteRun) cancelNote = '';
  const live = phase === 'running' ? runId || 'running'
    : (state.transport !== 'idle' && state.run ? state.run.id : '');
  if (!starting) {
    if (live && live !== lastLive) startNote = '';
    lastLive = live;
  }
  const cutNote = byId('start-cut');
  const cutSaid = cut ? cutText(cut.list, (i) => {
    if (i >= cut.keys.length) return '';
    const at = state.sequence.findIndex((e) => e.key === cut.keys[i]);
    return at >= 0 ? `Request ${at + 1}` : 'a request since removed from the run';
  }) : '';
  cutNote.hidden = !cutSaid;
  setText(cutNote, cutSaid);

  const note = byId('start-note');
  const said = [
    starting ? 'Starting...' : startNote || refusalText(state),
    cancelling ? 'Cancelling...' : cancelNote,
  ].filter(Boolean).join(' ');
  const noteText = said
    || (phase === 'idle' && selected === 0 ? 'Check at least one request to enable Start.' : '');
  note.hidden = !noteText;
  setText(note, noteText);
}

// Ledger. The three numbers are already public on /api/status and /metrics, so
// drawing them changes nothing about exposure and a great deal about what a
// visitor understands: the cooldown stops reading as a sleep and starts reading
// as a balance. The two constants mirror internal/budget, the same way the
// sequence caps above mirror internal/sandbox; the server is authoritative and
// the page only has to draw what it was told.
const BudgetRefill = 5;
const BudgetBurst = 1500;

function renderLedger(state) {
  const s = state.status || {};
  const balance = typeof s.budget_balance === 'number' ? s.budget_balance : null;
  const fill = byId('ledger-fill');
  const value = byId('ledger-value');
  const note = byId('ledger-note');
  if (balance === null) {
    fill.style.width = '0%';
    fill.className = 'bar-fill';
    setText(value, '-');
    setText(note, 'Waiting for the server to report the balance.');
    return;
  }
  const pct = Math.min(Math.max((100 * balance) / BudgetBurst, 0), 100);
  fill.style.width = `${pct}%`;
  // Below zero the bucket is in debt and the next run waits for it to refill,
  // which is the state the countdown above is already counting through.
  fill.className = `bar-fill${balance <= 0 ? ' is-fail' : (pct < 25 ? ' is-warn' : '')}`;
  setText(value, `${Math.round(balance)} w-s`);
  setText(note, `${Math.round(balance)} of ${BudgetBurst} worker-seconds, refilling ${BudgetRefill}/s`);
}

// LiveElsewhere is the banner of a tab that is showing something else while a
// run is live: its own view is left alone, so the banner is where it learns
// of the run and of the way in.
const LiveElsewhere = 'A run is live - Watch to follow it.';

function bannerFor(state, phase) {
  const s = state.status || {};
  if (phase === 'running') {
    const following = state.transport !== 'idle' && Boolean(state.run) && state.run.id === s.run_id;
    if (s.run_id && !following) return LiveElsewhere;
    const what = s.mode ? `A ${s.mode} run` : 'A run';
    const when = s.started_at ? ` Started ${fmtTime(s.started_at)}.` : '';
    return `${what} is in progress. Courier runs one at a time, so a second run can never contaminate the first one's measurements.${when}`;
  }
  if (phase === 'cooling') {
    return 'That run has been charged to Courier\'s load budget. The next one waits for the budget to refill - which is what keeps a public demo from being a public load generator.';
  }
  return '';
}

// ---------------------------------------------------------------- focus

// Rebuilding the list throws away whatever the visitor had focused, which for
// the reorder arrows means every second press lands on nothing. Entry keys are
// stable across a move, so focus follows the row rather than the position.
// Only the list's own keys are read: focus elsewhere on the page is not this
// render's to move, and a key is compared as a string, never put into a
// selector, because a key can carry an id holding any character.
function focusKey() {
  const node = document.activeElement;
  if (!node || !node.dataset || !node.dataset.focusKey) return null;
  return byId('sequence-list').contains(node) ? node.dataset.focusKey : null;
}

function restoreFocus(key) {
  if (!key) return;
  const node = [...byId('sequence-list').querySelectorAll('[data-focus-key]')].find((n) => n.dataset.focusKey === key);
  if (node && node !== document.activeElement && !node.disabled) node.focus();
}
