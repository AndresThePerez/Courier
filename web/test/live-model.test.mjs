// Seeded interleavings of everything that can happen to a tab following runs:
// this visitor's actions, another visitor's runs, slow, failed and timed-out
// requests, stream frames in and out of order, a server that restarts. After
// every step the rules at the top of web/js/live.js are checked as invariants.
//
// The sequences come from a small generator with fixed seeds, never from
// Math.random, so a failure names a seed and prints its steps.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, eventSources, flush, listenerErrors, localStorage } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as api from '../js/api.js';
import { createLive, initialLive, step, decideSync } from '../js/live.js';
import * as sidebar from '../js/render-sidebar.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as results from '../js/render-results.js';

const SETUP_KEY = 'courier.runner.v1';
const byId = (id) => document.getElementById(id);
const req = (n) => ({ id: `r${n}`, name: `Request ${n}`, endpoint: 'search', params: { q: `q${n}` }, assertions: [] });

// mulberry32: small, seedable, and the same on every machine.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
});

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

// ------------------------------------------------------------------ the rules alone

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const RUN_EVENTS = ['run_started', 'request_result', 'progress', 'run_finished'];
const VISITOR = ['start', 'watch', 'opened'];
const EFFECTS = ['report', 'history', 'status', 'probe'];
const shownEnd = (live) => (live.run && (live.report || live.outcome) ? live.run.id : null);
const named = (status) => (status && status.running ? status.run_id || '' : '');

// nextEvent makes one event: mostly what a real page would see next, and
// often enough something it should never act on.
function nextEvent(rnd, live, world) {
  const ids = ['a', 'b', 'c', 'd'];
  const other = () => pick(rnd, ids.filter((x) => x !== live.attached));
  const target = () => (live.attached && rnd() < 0.75 ? live.attached : other());
  const rep = (id, status) => ({ id, mode: 'functional', status, duration_ms: 5, entries: [], functional: { results: [{ index: 0, run: id }], verdict: 'PASS' } });
  const roll = rnd();
  if (roll < 0.18) {
    const truth = world.live ? { running: true, run_id: world.live, mode: 'functional', started_at: 't' } : { running: false };
    // Sometimes the truth; sometimes a stale or foreign answer, one naming a run this tab already saw end or lose included.
    const old = [...live.ended, ...live.gone];
    const status = pick(rnd, [truth, truth, truth, { running: true, run_id: pick(rnd, ids), mode: 'performance' }, { running: true, run_id: pick(rnd, old.length ? old : ids), mode: 'functional' }, { running: false }, { running: true }, null]);
    return { type: 'status', status };
  }
  if (roll < 0.24) {
    world.next += 1;
    world.live = `n${world.next}`;
    return rnd() < 0.5 ? { type: 'start', run_id: world.live, mode: 'functional' } : { type: 'status', status: { running: true, run_id: world.live, mode: 'functional' } };
  }
  if (roll < 0.30) return { type: 'watch', run_id: pick(rnd, [world.live, world.live, live.attached, pick(rnd, ids), '']), mode: 'functional' };
  if (roll < 0.36) return { type: 'run_started', run_id: target(), data: pick(rnd, [{ mode: 'functional', total: 3 }, {}, { mode: 'performance' }]) };
  if (roll < 0.54) {
    const id = target();
    return { type: 'request_result', run_id: id, data: { index: Math.floor(rnd() * 4), run: id, passed: rnd() < 0.5 } };
  }
  if (roll < 0.60) return { type: 'progress', run_id: target(), data: { requests: Math.floor(rnd() * 100) } };
  if (roll < 0.70) {
    const id = target();
    if (id === world.live) world.live = '';
    return { type: 'run_finished', run_id: id, data: pick(rnd, [{ status: 'completed', duration_ms: 9, verdict: 'PASS' }, { status: 'cancelled' }, { status: 'expired', cooldown_until: null }, {}]) };
  }
  if (roll < 0.75) {
    const id = target();
    if (id === world.live && rnd() < 0.5) world.live = '';
    return { type: 'gone', run_id: id };
  }
  if (roll < 0.80) return { type: 'open', run_id: pick(rnd, ['h1', 'h2', ...live.ended.slice(-1)]) };
  if (roll < 0.86) {
    const id = pick(rnd, [live.opening, live.opening, 'h1', 'h2', 'a']);
    return rnd() < 0.8 ? { type: 'opened', run_id: id, report: rep(id || 'h1', 'completed') } : { type: 'open_failed', run_id: id };
  }
  if (roll < 0.94) {
    const id = pick(rnd, [live.outcome && live.outcome.run_id, live.run && live.run.id, pick(rnd, ids), ...live.ended.slice(-2)].filter(Boolean).concat('a'));
    if (rnd() < 0.25) return { type: 'report_failed', run_id: id };
    return { type: 'report', run_id: id, report: rep(pick(rnd, [id, id, id, 'zz']), pick(rnd, ['completed', 'completed', 'cancelled', 'running'])) };
  }
  return pick(rnd, [{ type: 'nonsense' }, {}, null, undefined, { type: 'run_finished' }, { type: 'request_result', data: { index: 0, run: 'nobody' } }, { type: 'status' }]);
}

test('the rules hold for every step of seeded event sequences, in any order and any number of times', () => {
  const SEQUENCES = 500;
  const STEPS_EACH = 40;
  const seen = { attach: 0, auto: 0, ended: 0, gone: 0, opened: 0, reports: 0, ignored: 0, probes: 0, heldAgainstLiveRun: 0 };

  for (let seed = 1; seed <= SEQUENCES; seed += 1) {
    const rnd = prng(seed * 7919);
    const world = { live: '', next: 0 };
    const log = [];
    let live = deepFreeze(initialLive());
    const reportsAsked = new Map();
    const blocked = new Set(); // gone, and status has not yet stopped naming it
    const fail = (why) => assert.fail(`seed ${seed}: ${why}\nsteps:\n  ${log.join('\n  ')}`);

    for (let i = 0; i < STEPS_EACH; i += 1) {
      const event = deepFreeze(nextEvent(rnd, live, world));
      log.push(JSON.stringify(event));
      const before = live;
      let out;
      // The state and the event are frozen: a rule that wrote to either would throw here.
      try {
        out = step(before, event);
      } catch (error) {
        fail(`step threw: ${error.stack}`);
      }
      const after = out.live;
      const type = event && event.type;
      const id = event && event.run_id;
      deepFreeze(after);
      live = after;

      for (const effect of out.effects) {
        if (!EFFECTS.includes(effect.type)) fail(`unknown effect ${JSON.stringify(effect)}`);
      }

      // Rule 3: only the attached run's events are applied.
      if (RUN_EVENTS.includes(type) && (!before.attached || id !== before.attached)) {
        if (after !== before || out.effects.length) fail(`a ${type} of "${id}" changed a tab attached to "${before.attached}"`);
        seen.ignored += 1;
      }

      // Everything shown belongs to one run.
      if (after.run) {
        for (const row of after.results) {
          if (row.run !== after.run.id) fail(`a row of ${row.run} is shown under ${after.run.id}`);
        }
        if (after.report && after.report.id !== after.run.id) fail(`the report of ${after.report.id} is shown under ${after.run.id}`);
        if (after.outcome && after.outcome.run_id !== after.run.id) fail(`the outcome of ${after.outcome.run_id} is shown under ${after.run.id}`);
      } else if (after.results.length || after.report || after.outcome || after.progress) {
        fail('something is shown with no run');
      }

      // Rule 1: the end of a run stays on screen until the visitor replaces it.
      const held = shownEnd(before);
      if (held !== null && shownEnd(after) !== held && !VISITOR.includes(type)) fail(`a ${type} replaced the view of ${held}`);
      if (before.report && after.report !== before.report && !VISITOR.includes(type)) fail(`a ${type} replaced the report of ${before.report.id}`);
      if (held !== null && type === 'status' && named(event.status) && named(event.status) !== held) seen.heldAgainstLiveRun += 1;

      // Rule 5: while a run is followed, what arrived is never taken away.
      if (before.attached && after.attached === before.attached && after.results.length < before.results.length) fail(`a ${type} removed rows`);
      if (before.attached && after.attached === before.attached && before.progress && !after.progress) fail(`a ${type} removed the progress`);

      // Attaching: who may, and to what.
      if (after.attached && after.attached !== before.attached) {
        seen.attach += 1;
        if (!['start', 'watch', 'status'].includes(type)) fail(`a ${type} attached the tab to ${after.attached}`);
        if (type !== 'start') {
          if (before.ended.includes(after.attached)) fail(`${after.attached} was attached again after it ended (rule 4)`);
          if (blocked.has(after.attached)) fail(`${after.attached} was attached again while status still named it (rule 8)`);
        }
        if (type === 'status') {
          seen.auto += 1;
          if (before.run || before.report || before.opening) fail('a tab that was showing or waiting for something attached by itself (rule 1)');
          if (after.spectator) fail('a tab that attached by itself calls itself a spectator');
        }
        if (after.run.id !== after.attached) fail('attached to one run while showing another');
      }
      if (after.attached && before.attached && after.attached !== before.attached && type === 'status') fail('a status moved the attachment from one run to another');

      // Rule 4: the terminal event ends the attachment and asks for the report once.
      if (type === 'run_finished' && id && id === before.attached) {
        seen.ended += 1;
        if (after.attached) fail('still attached after the terminal event');
        if (!after.ended.includes(id)) fail('the ended run was not remembered');
        if (!after.outcome || after.outcome.run_id !== id || after.outcome.status === 'running') fail('the end of the run is not shown');
        if (after.spectator) fail('still a spectator after the watched run ended');
      }
      for (const effect of out.effects) {
        if (effect.type === 'report') {
          reportsAsked.set(effect.runId, (reportsAsked.get(effect.runId) || 0) + 1);
          if (reportsAsked.get(effect.runId) > 1) fail(`the report of ${effect.runId} was asked for twice`);
        }
        if (effect.type === 'probe') {
          seen.probes += 1;
          if (effect.runId !== after.attached) fail('a probe for a run that is not attached');
        }
      }
      if (after.report !== before.report && after.report) seen.reports += 1;

      // Rule 8.
      if (type === 'gone' && id && id === before.attached) {
        seen.gone += 1;
        blocked.add(id);
        if (after.attached) fail('still attached to a run that is gone');
        if (!out.effects.some((e) => e.type === 'status')) fail('status was not read again after a run was gone');
        if (after.run && after.run.id === id && (!after.outcome || after.outcome.status !== 'unavailable')) fail('a gone run is still shown as running');
      }
      if (type === 'status' && event.status) {
        const s = event.status;
        for (const lost of [...blocked]) {
          if (!s.running || (s.run_id && s.run_id !== lost)) blocked.delete(lost);
        }
      }
      if (type === 'start' && id) blocked.delete(id);

      // The badge: gone after an end, a history entry, or this tab's own start.
      if (['start', 'opened'].includes(type) && after !== before && after.spectator) fail(`a spectator after ${type}`);
      if (type === 'opened' && after !== before) {
        seen.opened += 1;
        if (after.attached) fail('still attached after a history entry was opened');
        if (before.opening !== id) fail('a history entry that was not the one asked for was shown (rule 6)');
      }
      if (type === 'report' && after !== before && (before.report || !before.outcome || before.outcome.run_id !== id || event.report.status === 'running' || event.report.id !== id)) {
        fail('a finished report was applied where it does not belong (rule 6)');
      }

      // Reading the same status again changes nothing more: a render can do it any number of times.
      if (type === 'status') {
        const again = step(after, event);
        if (again.live !== after || again.effects.length) fail('the same status acted twice');
        const decision = decideSync(after, event.status);
        if (decision.action !== 'none') fail(`decideSync still answers ${decision.action} after the status was applied`);
      }
    }
  }

  // The sequences did reach the cases the rules are about.
  for (const [what, n] of Object.entries(seen)) assert.ok(n >= 50, `only ${n} cases of "${what}" in ${SEQUENCES} sequences`);
});

// ------------------------------------------------------------------ the wired page

const streamOf = (id) => `${location.origin}/api/runs/${id}/stream`;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete localStorage.setItem;
  api.onRunStarted(() => {});
});

// makeWorld is one tab and the Courier it talks to. The server is an object
// every route answers from as it is when the request arrives; streams are the
// shim's, and the world delivers their frames.
function makeWorld(seed) {
  const world = {
    seed,
    log: [],
    status: { running: false, budget_balance: 1500 },
    history: [],
    reports: new Map(),
    frames: new Map(), // run id -> the frames the server has published for it
    down: new Set(),
    gates: new Map(), // route key -> [release, ...] for answers being held
    inFlight: new Map(), // route kind -> how many requests are unanswered
    maxStatusInFlight: 0,
    opens: new Map(), // run id -> EventSources the page has opened for it
    grants: new Map(), // run id -> opens the visitor or the server allowed
    next: 1,
    setupWrites: 0,
    tokens: 0, // visitor actions whose effect on the view may still arrive
    stats: null,
  };

  const kindOf = (method, url) => {
    if (url === '/api/status') return 'status';
    if (url === '/api/runs' && method === 'POST') return 'start';
    if (url === '/api/send') return 'send';
    if (method === 'DELETE') return 'cancel';
    return 'other';
  };
  globalThis.fetch = (input, init = {}) => {
    const kind = kindOf(String(init.method || 'GET').toUpperCase(), String(input));
    world.inFlight.set(kind, (world.inFlight.get(kind) || 0) + 1);
    if (kind === 'status') world.maxStatusInFlight = Math.max(world.maxStatusInFlight, world.inFlight.get(kind));
    // A request is in flight until its answer has been read or refused, which
    // is when the page can act on it.
    const settled = () => world.inFlight.set(kind, world.inFlight.get(kind) - 1);
    return realFetch(input, init).then((res) => {
      const text = res.text.bind(res);
      let read = false;
      res.text = () => {
        const p = text();
        if (!read) {
          read = true;
          p.then(settled, settled);
        }
        return p;
      };
      return res;
    }, (err) => {
      settled();
      throw err;
    });
  };

  // A held answer is written when the request arrives and delivered when it
  // is released, as a slow connection would: by then it may be out of date.
  const route = (url, method, answer) => {
    fetchStub.serve(url, async (call) => {
      const key = `${method} ${typeof url === 'string' ? url : 'run'}`;
      if (world.down.has('*') || world.down.has(key)) throw new TypeError('Failed to fetch');
      if (!world.gates.has(key)) return answer(call);
      const written = answer(call);
      await new Promise((resolve) => { world.gates.get(key).push(resolve); });
      return written;
    }, { method });
  };
  const idOf = (call) => decodeURIComponent(call.url.split('/')[3]);

  route('/api/collections', 'GET', () => ({
    status: 200,
    body: { collections: [{ id: 'c1', name: 'One', requests: [req(1), req(2)] }], endpoints: [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }], target: 't' },
  }));
  route('/api/status', 'GET', () => ({ status: 200, body: world.status }));
  route('/api/runs', 'GET', () => ({ status: 200, body: { runs: world.history } }));
  route('/api/runs', 'POST', (call) => {
    if (world.status.running) return { status: 409, body: { error: 'busy', run_id: world.status.run_id } };
    const id = begin(call.json().mode);
    grant(id);
    return { status: 202, body: { run_id: id } };
  });
  route(/^\/api\/runs\/[^/]+$/, 'GET', (call) => {
    const rep = world.reports.get(idOf(call));
    return rep ? { status: 200, body: JSON.parse(JSON.stringify(rep)) } : { status: 404, body: { error: `no run "${idOf(call)}"` } };
  });
  route(/^\/api\/runs\/[^/]+$/, 'DELETE', (call) => {
    if (!world.status.running || world.status.run_id !== idOf(call) || !world.reports.has(idOf(call))) return { status: 404, body: { error: 'not running' } };
    finish('cancelled', 'frame');
    return { status: 204 };
  });
  // A Send answer names the request it was for, so one shown under another request is visible.
  route('/api/send', 'POST', (call) => ({ status: 200, body: { status: 200, passed: true, latency_ms: 1, size_bytes: 2, body: call.json().id, assertions: [] } }));

  function grant(id) {
    world.grants.set(id, (world.grants.get(id) || 0) + 1);
  }

  function publish(id, type, data) {
    const frame = { type, run_id: id, data };
    world.frames.get(id).push(frame);
    return frame;
  }

  function begin(mode = 'functional') {
    const id = `run-${world.next}`;
    world.next += 1;
    world.reports.set(id, {
      id, mode, status: 'running', started_at: '2026-11-17T12:00:00Z', config: {}, entries: [],
      ...(mode === 'functional' ? { functional: { total: 3, results: [] } } : { performance: { verdict: 'N/A', overall: { requests: 0 }, per_request: [] } }),
    });
    world.frames.set(id, []);
    world.status = { ...world.status, running: true, run_id: id, mode, started_at: '2026-11-17T12:00:00Z' };
    publish(id, 'run_started', { mode, total: 3, started_at: '2026-11-17T12:00:00Z', config: {}, entries: [] });
    return id;
  }

  // liveStreams is the page's open streams for one run, each remembering how
  // much of the run it has been sent.
  const liveStreams = (id) => eventSources.live().filter((s) => s.url === streamOf(id));

  // deliver sends a stream everything published that it has not had yet, the
  // way a subscriber gets the replay and then the live events.
  function deliver(id, { shuffle = null } = {}) {
    for (const s of liveStreams(id)) {
      const frames = world.frames.get(id) || [];
      let fresh = frames.slice(s.sent || 0);
      s.sent = frames.length;
      if (shuffle) fresh = shuffle(fresh);
      for (const f of fresh) s.emit(f.type, f, { lastEventId: frames.indexOf(f) + 1 });
    }
  }

  function work(rnd) {
    const id = world.status.run_id;
    const rep = id && world.reports.get(id);
    if (!world.status.running || !rep) return 'no live run';
    if (rep.functional) {
      const index = rep.functional.results.length;
      if (index >= 3) return 'no more rows';
      const row = { index, name: `${id}#${index}`, run: id, endpoint: 'search', status: 200, passed: rnd() < 0.8, assertions: [] };
      rep.functional.results.push(row);
      publish(id, 'request_result', row);
      return `row ${index} of ${id}`;
    }
    rep.performance.overall.requests += 10;
    publish(id, 'progress', { elapsed_ms: rep.performance.overall.requests * 10, requests: rep.performance.overall.requests, errors: 0, aborted: 0, rps: 100, avg_latency_ms: 5 });
    return `progress of ${id}`;
  }

  // finish ends the live run on the server. how: 'frame' publishes the
  // terminal event for the stream to carry; 'drop' ends the stream without it.
  function finish(status, how) {
    const id = world.status.run_id;
    const rep = world.reports.get(id);
    if (!world.status.running || !rep) return 'no live run';
    rep.status = status;
    rep.duration_ms = 1200;
    rep.finished_at = '2026-11-17T12:00:02Z';
    if (rep.functional) rep.functional.verdict = status === 'completed' ? 'PASS' : 'N/A';
    else rep.performance.verdict = 'N/A';
    world.history.unshift({ id, mode: rep.mode, status, started_at: rep.started_at, duration_ms: 1200, summary: 'done' });
    world.status = { running: false, budget_balance: world.status.budget_balance };
    if (how === 'frame') {
      publish(id, 'run_finished', { status, duration_ms: 1200, verdict: 'N/A' });
      deliver(id);
    }
    // The server ends the stream either way.
    for (const s of liveStreams(id)) s.fail();
    return `${id} ${status} (${how})`;
  }

  Object.assign(world, { begin, grant, deliver, work, finish, liveStreams });
  return world;
}

function countOpens(world) {
  world.opens = new Map();
  for (const s of eventSources.instances) {
    const id = decodeURIComponent(new URL(s.url).pathname.split('/')[3]);
    world.opens.set(id, (world.opens.get(id) || 0) + 1);
  }
}

const idle = (world, kind) => (world.inFlight.get(kind) || 0) === 0;
const nothingInFlight = (world) => [...world.inFlight.values()].every((n) => n === 0);

// held is the run a tab is showing the end of: a view only the visitor may
// replace.
function held() {
  const s = get();
  return s.run && (s.report || s.outcome) ? s.run.id : null;
}

function checkInvariants(world, before, fail) {
  const s = get();
  if (listenerErrors.length) fail(`a handler threw: ${listenerErrors[0] && listenerErrors[0].stack}`);
  if (eventSources.live().length > 1) fail(`${eventSources.live().length} live streams`);
  // An open stream is the one for the run on screen, and a tab following nothing has none.
  for (const stream of eventSources.live()) {
    if (s.transport !== 'sse') fail(`a stream is open for ${stream.url} while the transport is ${s.transport}`);
    if (!s.run || stream.url !== streamOf(s.run.id)) fail(`a stream is open for ${stream.url} while the tab shows ${s.run && s.run.id}`);
  }
  if (world.maxStatusInFlight > 1) fail(`${world.maxStatusInFlight} status requests in flight at once`);

  countOpens(world);
  for (const [id, n] of world.opens) {
    const allowed = 1 + (world.grants.get(id) || 0);
    if (n > allowed) fail(`${n} streams opened for ${id}, ${allowed} allowed`);
  }

  // A view of a finished run changes only when the visitor asked for it.
  if (before.held !== null && held() !== before.held) {
    if (world.tokens <= 0) fail(`the view of ${before.held} was replaced by ${held()} without a visitor action`);
    world.tokens -= 1;
  } else if (before.report && s.report !== before.report) {
    if (world.tokens <= 0) fail(`the report of ${before.report.id} was replaced without a visitor action`);
    world.tokens -= 1;
  }
  if (nothingInFlight(world)) world.tokens = 0;

  // Everything shown belongs to one run.
  if (s.run) {
    for (const row of s.results) {
      if (row.run !== s.run.id) fail(`a row of ${row.run} is shown under ${s.run.id}`);
    }
    if (s.report && s.report.id !== s.run.id) fail(`the report of ${s.report.id} is shown under ${s.run.id}`);
    if (s.outcome && s.outcome.run_id !== s.run.id) fail(`the outcome of ${s.outcome.run_id} is shown under ${s.run.id}`);
  } else if (s.results.length || s.report) {
    fail('rows or a report are shown with no run');
  }

  // No control is left busy once its request has been answered or given up.
  if (idle(world, 'start') && byId('start-run').textContent !== 'Start run') fail(`Start reads "${byId('start-run').textContent}" with no request in flight`);
  if (idle(world, 'cancel') && byId('cancel-run').disabled) fail('Cancel is disabled with no request in flight');
  if (idle(world, 'send') && get().draft && byId('send-request').disabled) fail('Send is disabled with no request in flight');
  if (idle(world, 'send') && get().draft && byId('send-status').textContent === 'Sending...') fail('Send reads "Sending..." with no request in flight');

  if (world.setupWrites > 0) fail(`the run setup was written ${world.setupWrites} time(s) with no change to it`);

  // A tab following the live run, with no status request out, knows it is
  // live: an answer written before the run started was not left standing.
  const liveNow = world.status.running && world.reports.has(world.status.run_id) ? world.status.run_id : '';
  if (liveNow && s.transport !== 'idle' && s.run && s.run.id === liveNow && idle(world, 'status')) {
    if (!s.status || !s.status.running || s.status.run_id !== liveNow) fail(`the tab follows ${liveNow} while its status says ${JSON.stringify(s.status)}`);
  }

  // A Send answer is shown only under the request it was asked for.
  if (s.send && s.send.result && s.draft && s.send.result.body !== s.draft.id) fail(`the answer for ${s.send.result.body} is shown under ${s.draft.id}`);

  // While the same run is followed, rows that arrived are not taken away.
  if (before.following && s.run && s.run.id === before.following && s.transport !== 'idle' && s.results.length < before.rows) fail(`rows of ${before.following} were removed`);

  // What the sequences reached, for the check that they reach anything.
  const stats = world.stats;
  if (s.report && s.report !== before.report) stats.reportsShown += 1;
  if (s.outcome && s.outcome.status === 'unavailable') stats.unavailable += 1;
  if (s.transport === 'polling') stats.polling += 1;
  if (held() !== null && world.status.running && world.status.run_id !== held()) stats.heldAgainstLiveRun += 1;
  if (s.outcome && s.outcome.report === 'failed') stats.reportLost += 1;
  if (s.send && s.send.kind === 'network') stats.sendUnreachable += 1;
  if (/Could not reach Courier/.test(byId('start-note').textContent)) stats.controlUnreachable += 1;
  if (s.spectator) stats.spectating += 1;
}

// snapshot is what a step is compared against.
function snapshot() {
  const s = get();
  return { held: held(), report: s.report, following: s.transport !== 'idle' && s.run ? s.run.id : null, rows: s.results.length };
}

// STEPS is everything that can happen, by name. Each returns a line for the
// step list, or null when it had nothing to do.
const STEPS = {
  async wait(world, rnd, t) {
    const ms = pick(rnd, [100, 500, 1000, 3000, 5000, 10000, 20000]);
    for (let left = ms; left > 0; left -= 500) {
      t.mock.timers.tick(Math.min(left, 500));
      await flush(2);
    }
    return `wait ${ms}ms`;
  },
  otherVisitorStarts(world, rnd) {
    if (world.status.running) return null;
    return `another visitor starts ${world.begin(pick(rnd, ['functional', 'performance']))}`;
  },
  pressStart(world) {
    const btn = byId('start-run');
    if (btn.disabled) return null;
    world.tokens += 1;
    btn.click();
    return 'press Start';
  },
  pressStartTwice(world) {
    const btn = byId('start-run');
    if (btn.disabled) return null;
    world.tokens += 1;
    btn.click();
    btn.click();
    return 'press Start twice';
  },
  pressWatch(world) {
    const btn = byId('watch-run');
    if (btn.hidden) return null;
    const id = (get().status || {}).run_id;
    if (id) world.grant(id);
    world.tokens += 1;
    btn.click();
    return `press Watch (${id})`;
  },
  pressCancel() {
    const btn = byId('cancel-run');
    if (btn.hidden || btn.disabled) return null;
    btn.click();
    return 'press Cancel';
  },
  openHistory(world, rnd) {
    const rows = [...byId('history-list').querySelectorAll('button')];
    if (rows.length === 0) return null;
    world.tokens += 1;
    const row = pick(rnd, rows);
    row.click();
    return `open history "${row.title}"`;
  },
  serverWorks(world, rnd) {
    const said = world.work(rnd);
    world.deliver(world.status.run_id);
    return `server: ${said}`;
  },
  serverWorksQuietly(world, rnd) {
    return `server (not yet delivered): ${world.work(rnd)}`;
  },
  deliverOutOfOrder(world) {
    const id = world.status.run_id;
    if (!id) return null;
    world.deliver(id, { shuffle: (frames) => frames.slice().reverse() });
    return `deliver ${id} newest first`;
  },
  deliverTwice(world) {
    const id = world.status.run_id;
    if (!id) return null;
    world.deliver(id);
    for (const s of world.liveStreams(id)) {
      for (const f of world.frames.get(id) || []) s.emit(f.type, f);
    }
    return `deliver ${id}, then all of it again`;
  },
  foreignFrames(world) {
    const live = eventSources.live();
    if (live.length === 0) return null;
    for (const s of live) {
      s.emit('run_started', { type: 'run_started', run_id: 'run-foreign', data: { mode: 'functional', total: 1 } });
      s.emit('request_result', { type: 'request_result', run_id: 'run-foreign', data: { index: 0, run: 'run-foreign', name: 'foreign' } });
      s.emit('progress', { type: 'progress', run_id: 'run-foreign', data: { requests: 1 } });
      s.emit('run_finished', { type: 'run_finished', run_id: 'run-foreign', data: { status: 'completed' } });
    }
    return 'frames of another run arrive on the open stream';
  },
  runFinishes(world, rnd) {
    if (!world.status.running) return null;
    return `server: ${world.finish(pick(rnd, ['completed', 'cancelled', 'expired']), 'frame')}`;
  },
  runFinishesStreamDrops(world, rnd) {
    if (!world.status.running) return null;
    return `server: ${world.finish(pick(rnd, ['completed', 'expired']), 'drop')}`;
  },
  streamErrors() {
    const live = eventSources.live();
    if (live.length === 0) return null;
    for (const s of live) s.fail();
    return 'the stream errors';
  },
  serverRestarts(world) {
    world.reports.clear();
    world.frames.clear();
    world.history = [];
    world.status = { running: false, budget_balance: 1500 };
    for (const s of eventSources.live()) s.fail();
    return 'the server restarts and remembers nothing';
  },
  runVanishesStatusStale(world) {
    const id = world.status.run_id;
    if (!world.status.running) return null;
    world.reports.delete(id);
    world.frames.delete(id);
    for (const s of eventSources.live()) s.fail();
    return `${id} vanishes while status still reports it`;
  },
  statusMovesOn(world) {
    const id = world.status.run_id;
    if (!world.status.running || world.reports.has(id)) return null;
    world.status = { running: false, budget_balance: 1500 };
    return `status stops reporting ${id}`;
  },
  networkDown(world, rnd) {
    const what = pick(rnd, ['*', 'GET /api/status', 'GET run', 'POST /api/runs', 'DELETE run', 'POST /api/send', 'GET /api/runs']);
    world.down.add(what);
    return `network down for ${what}`;
  },
  networkUp(world) {
    if (world.down.size === 0) return null;
    world.down.clear();
    return 'network up';
  },
  holdAnswers(world, rnd) {
    const what = pick(rnd, ['GET /api/status', 'GET run', 'POST /api/runs', 'DELETE run', 'POST /api/send']);
    if (world.gates.has(what)) return null;
    world.gates.set(what, []);
    return `answers to ${what} are held`;
  },
  releaseAnswers(world) {
    if (world.gates.size === 0) return null;
    const waiting = [...world.gates.values()].flat();
    world.gates.clear();
    for (const release of waiting) release();
    return 'held answers are released';
  },
  pressSend() {
    if (!get().draft || byId('send-request').disabled) return null;
    byId('send-request').click();
    return 'press Send';
  },
  // The two orderings a random walk rarely lines up by itself.
  async lateSendAnswer(world, rnd) {
    const rows = [...byId('collections-tree').querySelectorAll('button')].filter((b) => b.classList.contains('req-open'));
    if (rows.length < 2 || world.gates.has('POST /api/send') || world.down.size > 0) return null;
    rows[0].click();
    if (byId('send-request').disabled) return null;
    world.gates.set('POST /api/send', []);
    byId('send-request').click();
    await flush(2);
    rows[1].click();
    if (rnd() < 0.5) byId('send-request').click();
    await flush(2);
    const waiting = world.gates.get('POST /api/send') || [];
    world.gates.delete('POST /api/send');
    for (const release of waiting) release();
    world.stats.lateSendAnswers += 1;
    return 'Send for one request, select another, then the first answer arrives';
  },
  async statusAnswerFromBeforeStart(world, rnd, t) {
    if (byId('start-run').disabled || get().transport !== 'idle' || world.gates.has('GET /api/status') || world.down.size > 0) return null;
    world.gates.set('GET /api/status', []);
    t.mock.timers.tick(3000);
    await flush(2);
    if ((world.gates.get('GET /api/status') || []).length === 0) {
      world.gates.delete('GET /api/status');
      return null;
    }
    world.tokens += 1;
    byId('start-run').click();
    await flush(2);
    const waiting = world.gates.get('GET /api/status') || [];
    world.gates.delete('GET /api/status');
    for (const release of waiting) release();
    world.stats.staleStatusAnswers += 1;
    return 'a status poll is out, Start is pressed, then the old status answer arrives';
  },
  selectRequest(world, rnd) {
    const rows = [...byId('collections-tree').querySelectorAll('button')].filter((b) => b.classList.contains('req-open'));
    if (rows.length === 0) return null;
    const row = pick(rnd, rows);
    row.click();
    return `select "${row.title}"`;
  },
};

const WEIGHTED = [
  'wait', 'wait', 'wait', 'wait',
  'otherVisitorStarts', 'otherVisitorStarts',
  'pressStart', 'pressStart', 'pressStartTwice',
  'pressWatch', 'pressWatch', 'pressCancel', 'openHistory', 'openHistory',
  'serverWorks', 'serverWorks', 'serverWorks', 'serverWorksQuietly',
  'deliverOutOfOrder', 'deliverTwice', 'foreignFrames',
  'runFinishes', 'runFinishes', 'runFinishesStreamDrops',
  'streamErrors', 'serverRestarts', 'runVanishesStatusStale', 'statusMovesOn',
  'networkDown', 'networkUp', 'networkUp', 'holdAnswers', 'releaseAnswers', 'releaseAnswers',
  'pressSend', 'selectRequest', 'lateSendAnswer', 'statusAnswerFromBeforeStart',
];

async function bootWorld(t, seed) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  resetBrowser();
  resetState();
  const world = makeWorld(seed);

  const showTab = (name) => set({ activeTab: name });
  const page = createLive({ api, get, set, showTab });
  editor.init();
  runner.init(page.hooks.runner);
  sidebar.init({
    select: (request) => {
      editor.onSelect();
      sidebar.selectRequest(request);
      showTab('editor');
    },
    add: (request) => runner.add(request),
    addAll: (collection) => runner.addAll(collection),
    ...page.hooks.sidebar,
  });
  const unsubscribe = subscribe((state) => {
    sidebar.render(state);
    editor.render(state);
    runner.render(state);
    results.render(state);
    page.scheduleSync();
  });
  world.end = () => {
    unsubscribe();
    if (page.stop) page.stop();
  };
  set({ activeTab: 'runner' });
  runner.add(req(1));

  // From here on nothing changes the run setup, so nothing may write it.
  const realSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === SETUP_KEY) world.setupWrites += 1;
    return realSet(key, value);
  };
  return { world, page };
}

// settle lets everything the sequence left unfinished come to rest: the
// network is back, and streams of runs that are over end. Answers still held
// are never given: the page has to give up on those by itself.
async function settle(world, t) {
  world.down.clear();
  world.gates.clear();
  for (let i = 0; i < 16; i += 1) {
    for (const s of eventSources.live()) {
      const id = decodeURIComponent(new URL(s.url).pathname.split('/')[3]);
      if (world.status.run_id !== id || !world.reports.has(id)) s.fail();
      else world.deliver(id);
    }
    t.mock.timers.tick(3000);
    await flush(3);
  }
}

function checkAtRest(world, fail) {
  const s = get();
  if (!nothingInFlight(world)) fail(`requests still in flight at rest: ${JSON.stringify([...world.inFlight])}`);
  const live = world.status.running && world.reports.has(world.status.run_id) ? world.status.run_id : '';
  if (Boolean(s.status && s.status.running) !== world.status.running) fail(`the page says running=${s.status && s.status.running}, the server ${world.status.running}`);
  for (const stream of eventSources.live()) {
    if (stream.url !== streamOf(live)) fail(`a stream is still open for ${stream.url} at rest`);
  }
  const pill = byId('results-summary').querySelector('.pill');
  if (pill && pill.textContent === 'running') {
    if (!s.run || s.run.id !== live) fail(`${s.run && s.run.id} is shown as running; the live run is "${live}"`);
    if (s.transport === 'idle') fail(`${s.run.id} is shown as running with nothing following it`);
  }
}

test('a tab keeps its rules through seeded interleavings of visitors, streams, failures and restarts', async (t) => {
  const SEQUENCES = 120;
  const STEPS_EACH = 30;
  const stats = { reportsShown: 0, unavailable: 0, polling: 0, heldAgainstLiveRun: 0, reportLost: 0, sendUnreachable: 0, controlUnreachable: 0, spectating: 0, lateSendAnswers: 0, staleStatusAnswers: 0, streams: 0, steps: 0 };
  for (let seed = 1; seed <= SEQUENCES; seed += 1) {
    const rnd = prng(seed);
    const { world, page } = await bootWorld(t, seed);
    world.stats = stats;
    const fail = (why) => {
      world.end();
      assert.fail(`seed ${seed}: ${why}\nsteps:\n  ${world.log.join('\n  ')}`);
    };

    // Half the tabs load while a run is already live.
    if (rnd() < 0.5) world.log.push(`before load: another visitor starts ${world.begin('functional')}`);
    await page.boot();
    await flush(3);
    checkInvariants(world, snapshot(), fail);

    for (let i = 0; i < STEPS_EACH; i += 1) {
      const before = snapshot();
      const name = pick(rnd, WEIGHTED);
      const said = await STEPS[name](world, rnd, t);
      if (said === null) continue;
      world.log.push(said);
      stats.steps += 1;
      await flush(3);
      checkInvariants(world, before, fail);
    }

    const before = snapshot();
    await settle(world, t);
    world.log.push('settle');
    checkInvariants(world, before, fail);
    checkAtRest(world, fail);
    stats.streams += eventSources.opened;
    world.end();
  }

  // The sequences did reach the cases the rules are about.
  for (const [what, n] of Object.entries(stats)) assert.ok(n >= 10, `only ${n} cases of "${what}" in ${SEQUENCES} sequences`);
});
