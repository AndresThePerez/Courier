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
// KneePoints is the measured saturation series (Addendum Task 33), run through
// this API on the DEPLOY host against Pokesearch milestone-3 over the pinned
// 20,324-document index and the internal Docker network: 1 / 10 / 25 / 50
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
let hooks = { refresh: async () => {}, showTab: () => {} };

// Module-local render memory and notes, the same arrangement render-editor.js
// uses: none of this is application state, it is what this module has last
// painted and what it last has to say.
let counter = 0;
let lastSignature = null;
let sequenceNote = '';
let startNote = '';
let starting = false;
let cancelling = false;
let ticker = null;
let lastPhase = null;
let kneeNote = '';
let kneeBuilt = false;

export function init(h) {
  hooks = { ...hooks, ...h };

  byId('select-all').addEventListener('click', () => setAllEnabled(true));
  byId('deselect-all').addEventListener('click', () => setAllEnabled(false));

  byId('mode-functional').addEventListener('change', () => setMode('functional'));
  byId('mode-performance').addEventListener('change', () => setMode('performance'));

  byId('stop-on-failure').addEventListener('change', (e) => setOption('stop_on_failure', e.target.checked));
  for (const [id, key] of Object.entries(optionOf)) {
    const input = byId(id);
    input.addEventListener('input', (e) => setOption(key, clampOption(key, e.target.value)));
    // Repaint on blur so a field the visitor cleared, or pushed past its cap,
    // comes back showing the number the run will actually use.
    input.addEventListener('blur', () => render(get()));
  }

  byId('start-run').addEventListener('click', start);
  byId('cancel-run').addEventListener('click', cancel);
  byId('watch-run').addEventListener('click', watch);
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

// add is main.js's sidebar hook for the per-request `+` button.
export function add(request) {
  const list = get().sequence;
  if (list.length >= MaxSequence) {
    sequenceNote = `${MaxSequence} requests is the cap - remove one before adding another.`;
    render(get());
    return;
  }
  sequenceNote = '';
  set({ sequence: [...list, entryFor(request)] });
}

// addAll is the "Add all to run" hook. A collection that does not fit is added
// as far as it goes and the note says how far: silently dropping the tail, or
// refusing the whole collection over one request, would both be worse than
// saying what happened.
export function addAll(collection) {
  const list = get().sequence;
  const requests = (collection && collection.requests) || [];
  const taken = requests.slice(0, Math.max(MaxSequence - list.length, 0));

  if (taken.length === 0) {
    sequenceNote = requests.length === 0
      ? 'That collection has no requests.'
      : `${MaxSequence} requests is the cap - remove one before adding another.`;
    render(get());
    return;
  }
  sequenceNote = taken.length < requests.length
    ? `Added ${taken.length} of ${requests.length} - ${MaxSequence} requests is the cap.`
    : '';
  set({ sequence: [...list, ...taken.map((r) => entryFor(r))] });
}

// move is the whole reordering story: Addendum A3 defers drag-and-drop, and the
// arrows were always going to be the accessible path anyway. Focus follows the
// row by its stable key, so a keyboard visitor can press the same button twice.
function move(index, delta) {
  const list = get().sequence.slice();
  const to = index + delta;
  if (to < 0 || to >= list.length) return;
  [list[index], list[to]] = [list[to], list[index]];
  set({ sequence: list });
}

function removeAt(index) {
  sequenceNote = '';
  set({ sequence: get().sequence.filter((_, i) => i !== index) });
}

function setEnabled(key, on) {
  set({ sequence: get().sequence.map((e) => (e.key === key ? { ...e, enabled: on } : e)) });
}

function setAllEnabled(on) {
  set({ sequence: get().sequence.map((e) => (e.enabled === on ? e : { ...e, enabled: on })) });
}

// ---------------------------------------------------------------- knee demo

// preloadKnee is the whole one-click promise: it replaces the sequence, the
// mode and both performance knobs in a single set(), so the page repaints once
// and the visitor's next act is pressing Start.
//
// Replacing rather than appending is the point. Adding to whatever was already
// queued would reproduce a *different* run than the one the table measured,
// and the table would then be describing something the button does not do.
function preloadKnee(workers) {
  const collection = (get().collections || []).find((c) => c.id === KneeCollection);
  const requests = (collection && collection.requests) || [];
  if (requests.length === 0) {
    kneeNote = 'The curated collections have not loaded yet - give the page a moment and try again.';
    render(get());
    return;
  }
  sequenceNote = '';
  startNote = '';
  kneeNote = `Loaded ${requests.length} search requests at ${workers} worker${workers === 1 ? '' : 's'}`
    + ` for ${KneeDuration}s. Press Start run to take your own reading.`;
  set({
    sequence: requests.map((r) => entryFor(r)),
    mode: 'performance',
    options: { ...get().options, concurrency: workers, duration_secs: KneeDuration },
  });
}

function renderKnee(state) {
  const note = byId('knee-note');
  note.hidden = !kneeNote;
  setText(note, kneeNote);

  // The table and the buttons are constants, so they are built once. Rebuilding
  // them on every status poll would take focus off a button mid-keyboard-press
  // for no gain, the same reason renderSequence keeps a signature.
  if (kneeBuilt) return;
  kneeBuilt = true;

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
  set({ mode });
}

function setOption(key, value) {
  set({ options: { ...get().options, [key]: value } });
}

function clampOption(key, raw) {
  const { lo, hi, fallback } = Limits[key];
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < lo) return fallback;
  return n > hi ? hi : n;
}

// requestPayload is the sandbox.Request shape POST /api/runs validates. The
// sequence already holds requests in that shape — curated ones arrive from the
// server that way, and a workspace request is a fork of one — so this only
// unaliases the objects the page is still holding.
function requestPayload(r) {
  return {
    id: r.id,
    name: r.name || '',
    endpoint: r.endpoint,
    params: { ...(r.params || {}) },
    assertions: (r.assertions || []).map((a) => ({ ...a })),
  };
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
  startNote = 'Starting...';
  render(get());

  // Deliberately not gated on the phase this module last rendered: the button
  // being disabled is the affordance, the server is the authority. A click that
  // slips through between the run ending and the poll noticing gets a 409 and
  // lands in the right state, which is exactly what step 5 asks for.
  const outcome = await api.startRun({
    mode: state.mode,
    sequence: entries.map((e) => requestPayload(e.request)),
    options: { ...state.options },
  });

  starting = false;
  applyStartOutcome(outcome, state.mode);
  await hooks.refresh();
  render(get());
}

function applyStartOutcome(outcome, mode) {
  if (outcome.ok) {
    startNote = '';
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
  if (outcome.kind === 'invalid') {
    // The sandbox refused the payload. Naming the field is the whole value of
    // the 400: it is where a visitor learns the validation is real.
    startNote = outcome.field
      ? `Refused - ${outcome.field}: ${outcome.error}`
      : `Refused - ${outcome.error}`;
    return;
  }
  startNote = `Could not start the run - ${outcome.error}`;
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
  startNote = 'Cancelling...';
  render(get());

  const outcome = await api.cancelRun(id);
  cancelling = false;
  // A 404 means the run finished on its own between the click and the request.
  // From here that is the same fact as a successful cancel: there is nothing
  // left to stop.
  startNote = outcome.ok || outcome.gone ? '' : `Could not cancel - ${outcome.error}`;
  await hooks.refresh();
  render(get());
}

// watch is spectator mode's entry point. main.js owns the live transport; what
// belongs here is the decision — which run this page is watching, and that it
// is watching rather than driving it.
//
// The page attaches to a live run on its own (that is what makes a mid-run
// reload repaint from the replay log), so by the time Watch is pressed this tab
// is usually already following the run. Clearing the results in that case would
// throw away a replay that has already arrived and does not arrive twice; the
// only thing left to say is that this tab is a spectator.
function watch() {
  const state = get();
  const s = state.status || {};
  if (!s.run_id) return;
  startNote = '';
  const following = state.run && state.run.id === s.run_id;
  set(following ? { spectator: true } : {
    run: { id: s.run_id, mode: s.mode || '', started_at: s.started_at || '' },
    spectator: true,
    results: [],
    progress: null,
    report: null,
  });
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

export function render(state) {
  renderKnee(state);
  renderSequence(state);
  renderConfig(state);
  renderControls(state);
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function renderSequence(state) {
  const list = state.sequence;
  const on = list.filter((e) => e.enabled).length;
  setText(byId('sequence-count'), `${list.length} of ${MaxSequence} - ${on} selected`);

  const note = byId('sequence-note');
  note.hidden = !sequenceNote;
  setText(note, sequenceNote);

  byId('select-all').disabled = list.length === 0;
  byId('deselect-all').disabled = list.length === 0;

  // Rebuild only when the sequence itself changed. The 3s status poll notifies
  // every render module; rebuilding this list on each one would take the focus
  // out from under a visitor reordering rows with the keyboard.
  const sig = list.map((e) => `${e.key}:${e.enabled ? 1 : 0}`).join('|');
  if (sig === lastSignature) return;
  lastSignature = sig;

  const focus = focusKey();
  const rows = byId('sequence-list');
  if (list.length === 0) {
    replace(rows, [el('div', {
      class: 'rows-empty',
      text: 'Nothing queued. Add a request with + in the sidebar, or add a whole collection with "Add all to run".',
    })]);
  } else {
    replace(rows, list.map((entry, i) => sequenceRow(entry, i, list.length)));
  }
  restoreFocus(focus);
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

function sequenceRow(entry, index, total) {
  const r = entry.request;
  const query = Object.entries(r.params || {}).map(([k, v]) => `${k}=${v}`).join('&');

  const check = el('input', {
    class: 'seq-check',
    type: 'checkbox',
    attrs: {
      'aria-label': `Include ${r.name || r.id} in the run`,
      'data-focus-key': `seq-check:${entry.key}`,
    },
    on: { change: (e) => setEnabled(entry.key, e.target.checked) },
  });
  check.checked = entry.enabled;

  return el('div', { class: `row seq-row${entry.enabled ? '' : ' is-off'}` }, [
    el('span', { class: 'seq-index mono', text: String(index + 1) }),
    check,
    el('span', { class: 'seq-body' }, [
      el('span', { class: 'seq-name', text: r.name || r.id }),
      el('span', { class: 'seq-target mono', text: `${r.endpoint}${query ? `?${query}` : ''}` }),
      assertionChips(r.assertions),
    ]),
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
  for (const [id, key] of Object.entries(optionOf)) setNumber(id, state.options[key]);
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
  // load, and a visitor watching a run they cannot stop is the worse of the two.
  cancelBtn.hidden = phase !== 'running' || !runId;
  cancelBtn.disabled = cancelling;
  cancelBtn.title = runId ? `Stop run ${runId}` : '';

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

  const note = byId('start-note');
  const noteText = startNote
    || (phase === 'idle' && selected === 0 ? 'Check at least one request to enable Start.' : '');
  note.hidden = !noteText;
  setText(note, noteText);
}

function bannerFor(state, phase) {
  const s = state.status || {};
  if (phase === 'running') {
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
function focusKey() {
  const node = document.activeElement;
  return node && node.dataset ? node.dataset.focusKey || null : null;
}

function restoreFocus(key) {
  if (!key) return;
  const node = document.querySelector(`[data-focus-key="${key}"]`);
  if (node && node !== document.activeElement && !node.disabled) node.focus();
}
