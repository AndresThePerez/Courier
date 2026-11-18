// The rules for following a run, as live.js states them, exercised directly:
// step folds one event into the tab's live state, decideSync reads a status
// against it. Neither touches the document, a timer or the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import './shim.mjs';
import { initialLive, step, reduce, decideSync } from '../js/live.js';

const ev = (type, id, data = {}) => ({ type, run_id: id, data });
const row = (id, index, extra = {}) => ev('request_result', id, { index, name: `${id}#${index}`, passed: true, ...extra });
const running = (id, mode = 'functional') => ({ running: true, run_id: id, mode, started_at: '2026-11-17T12:00:00Z' });
const idleStatus = { running: false };
const report = (id, status = 'completed', rows = []) => ({ id, mode: 'functional', status, duration_ms: 900, entries: [], functional: { results: rows, verdict: 'PASS' } });

// run folds a list of events and returns the last state plus every effect.
function run(events, from = initialLive()) {
  let live = from;
  const effects = [];
  for (const e of events) {
    const out = step(live, e);
    live = out.live;
    effects.push(...out.effects);
  }
  return { live, effects };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const attachedTo = (id) => run([{ type: 'status', status: running(id) }]).live;
const finished = (id, status = 'completed') => run([
  { type: 'status', status: running(id) },
  ev('run_started', id, { mode: 'functional', total: 2 }),
  row(id, 0),
  ev('run_finished', id, { status, duration_ms: 900 }),
]).live;

test('a tab showing nothing attaches to the run status reports', () => {
  const fresh = initialLive();
  assert.deepEqual(decideSync(fresh, running('a')), { action: 'attach', runId: 'a', mode: 'functional', startedAt: '2026-11-17T12:00:00Z' });
  assert.deepEqual(decideSync(fresh, idleStatus), { action: 'none' });
  assert.deepEqual(decideSync(fresh, null), { action: 'none' });
  assert.deepEqual(decideSync(fresh, { running: true }), { action: 'none' }, 'a live run with no id cannot be followed');

  const live = attachedTo('a');
  assert.equal(live.attached, 'a');
  assert.equal(live.run.id, 'a');
  assert.equal(live.run.mode, 'functional');
  assert.equal(live.spectator, false);
  assert.deepEqual(decideSync(live, running('a')), { action: 'none' });
});

test('a request_result before run_started is kept, and a late run_started does not wipe it', () => {
  const { live } = run([row('a', 0), row('a', 1), ev('run_started', 'a', { mode: 'functional', total: 5, config: { delay_ms: 3 } })], attachedTo('a'));
  assert.deepEqual(live.results.map((r) => r.index), [0, 1]);
  assert.equal(live.run.total, 5);
  assert.deepEqual(live.run.config, { delay_ms: 3 });

  // A second run_started for the same run changes nothing that arrived.
  const again = reduce(reduce(live, row('a', 2)), ev('run_started', 'a', { mode: 'functional', total: 5 }));
  assert.deepEqual(again.results.map((r) => r.index), [0, 1, 2]);
});

test('a row delivered twice is one row, and the later copy is the one kept', () => {
  const { live } = run([row('a', 0), row('a', 1), row('a', 0, { body_preview: 'full' })], attachedTo('a'));
  assert.deepEqual(live.results.map((r) => r.index), [0, 1]);
  assert.equal(live.results[0].body_preview, 'full');
});

test('events of another run are ignored while one is attached, and all events while none is', () => {
  const base = reduce(reduce(attachedTo('a'), ev('run_started', 'a', { mode: 'functional', total: 2 })), row('a', 0));
  const foreign = [ev('run_started', 'b', { mode: 'performance' }), row('b', 0), ev('progress', 'b', { requests: 9 }), ev('run_finished', 'b', { status: 'completed' }), { type: 'request_result', data: { index: 7 } }];
  const { live, effects } = run(foreign, base);
  assert.deepEqual(live, base);
  assert.deepEqual(effects, []);

  const nothing = run([ev('run_started', 'a'), row('a', 0), ev('run_finished', 'a', { status: 'completed' })]);
  assert.deepEqual(nothing.live, initialLive());
  assert.deepEqual(nothing.effects, []);
});

test('run_finished ends the attachment once: one report fetch, and nothing after it is applied', () => {
  const before = run([ev('run_started', 'a', { mode: 'performance' }), ev('progress', 'a', { requests: 10 })], attachedTo('a')).live;
  const done = step(before, ev('run_finished', 'a', { status: 'cancelled', duration_ms: 400, verdict: 'N/A' }));
  assert.deepEqual(done.effects, [{ type: 'report', runId: 'a' }]);
  assert.equal(done.live.attached, '');
  assert.deepEqual(done.live.outcome, { run_id: 'a', status: 'cancelled', duration_ms: 400, verdict: 'N/A' });
  assert.equal(done.live.run.id, 'a', 'the run stays on screen');

  const late = run([ev('run_finished', 'a', { status: 'completed' }), ev('progress', 'a', { requests: 99 }), row('a', 5), ev('run_started', 'a', {})], done.live);
  assert.deepEqual(late.live, done.live);
  assert.deepEqual(late.effects, [], 'a duplicate run_finished asks for no second report');
});

test('the finished report is applied to the run it belongs to, and to nothing else', () => {
  const done = finished('a');
  const withReport = reduce(done, { type: 'report', run_id: 'a', report: report('a', 'completed', [{ index: 0, body_preview: 'x' }]) });
  assert.equal(withReport.report.id, 'a');
  assert.equal(withReport.results[0].body_preview, 'x');

  // A report that fails to arrive leaves what run_finished said.
  const failed = reduce(done, { type: 'report_failed', run_id: 'a' });
  assert.equal(failed.report, null);
  assert.equal(failed.outcome.status, 'completed');
  assert.equal(failed.outcome.report, 'failed');

  // The visitor moved on before the report came back: it is dropped.
  const moved = reduce(done, { type: 'start', run_id: 'b', mode: 'functional' });
  assert.deepEqual(reduce(moved, { type: 'report', run_id: 'a', report: report('a') }), moved);
  // A report still marked running is not a finished report.
  assert.deepEqual(reduce(done, { type: 'report', run_id: 'a', report: report('a', 'running') }), done);
});

test('a tab showing a finished run does not attach to another visitor\'s run; a status alone never replaces it', () => {
  for (const [name, live] of [
    ['its own finished run, report in hand', reduce(finished('a'), { type: 'report', run_id: 'a', report: report('a') })],
    ['a finished run whose report never arrived', finished('a', 'expired')],
    ['a report reopened from history', run([{ type: 'open', run_id: 'h' }, { type: 'opened', run_id: 'h', report: report('h') }]).live],
  ]) {
    assert.deepEqual(decideSync(live, running('b')), { action: 'none' }, name);
    const out = step(live, { type: 'status', status: running('b') });
    assert.deepEqual(out.live, live, name);
    assert.deepEqual(out.effects, [], name);
  }
});

test('a run this tab watched end is not attached again, whatever status says', () => {
  const done = finished('a');
  const emptied = { ...done, run: null, results: [], outcome: null };
  assert.deepEqual(decideSync(emptied, running('a')), { action: 'none' });
  const watched = step(done, { type: 'watch', run_id: 'a', mode: 'functional' });
  assert.equal(watched.live.attached, '');
  assert.deepEqual(watched.effects, [{ type: 'status' }], 'the stale status is read again instead');
});

test('Start always attaches, and replaces whatever was shown', () => {
  const shown = reduce(finished('a'), { type: 'report', run_id: 'a', report: report('a') });
  const live = reduce({ ...shown, spectator: true }, { type: 'start', run_id: 'b', mode: 'performance' });
  assert.equal(live.attached, 'b');
  assert.deepEqual([live.run.id, live.run.mode], ['b', 'performance']);
  assert.deepEqual([live.report, live.outcome, live.progress, live.results.length, live.spectator], [null, null, null, 0, false]);

  // Status reached the tab first and it was already following: nothing received is thrown away.
  const early = run([row('c', 0)], attachedTo('c')).live;
  const kept = reduce(early, { type: 'start', run_id: 'c', mode: 'functional' });
  assert.equal(kept.results.length, 1);
  assert.equal(kept.attached, 'c');
  assert.deepEqual(reduce(shown, { type: 'start', run_id: '' }), shown, 'a 202 with no id starts nothing');
});

test('Watch attaches and clears the old report; Watch on the run already followed keeps its rows', () => {
  const shown = reduce(finished('a'), { type: 'report', run_id: 'a', report: report('a') });
  const live = reduce(shown, { type: 'watch', run_id: 'b', mode: 'functional', started_at: 't' });
  assert.equal(live.attached, 'b');
  assert.equal(live.spectator, true);
  assert.deepEqual([live.run.id, live.report, live.outcome, live.results.length], ['b', null, null, 0]);

  const following = run([row('c', 0), row('c', 1)], attachedTo('c')).live;
  const watched = reduce(following, { type: 'watch', run_id: 'c', mode: 'functional' });
  assert.equal(watched.results.length, 2);
  assert.equal(watched.spectator, true);
});

test('the spectator mark goes when the watched run ends, when history is opened, and when this tab starts a run', () => {
  const watching = reduce(attachedTo('a'), { type: 'watch', run_id: 'a', mode: 'functional' });
  assert.equal(watching.spectator, true);
  assert.equal(reduce(watching, ev('run_finished', 'a', { status: 'completed' })).spectator, false);
  assert.equal(reduce(watching, { type: 'start', run_id: 'b', mode: 'functional' }).spectator, false);
  const opened = run([{ type: 'open', run_id: 'h' }, { type: 'opened', run_id: 'h', report: report('h') }], watching).live;
  assert.equal(opened.spectator, false);
  assert.equal(opened.attached, '', 'opening history stops following the live run');
  assert.equal(opened.report.id, 'h');
});

test('a history entry replaces the view only when it arrives, and only if it is still the one asked for', () => {
  const following = run([row('a', 0)], attachedTo('a')).live;
  const asked = step(following, { type: 'open', run_id: 'h1' });
  assert.deepEqual(asked.effects, [{ type: 'history', runId: 'h1' }]);
  assert.equal(asked.live.attached, 'a', 'still following until the report is here');
  assert.equal(asked.live.results.length, 1);

  // A second click wins over the first, whichever answer lands first.
  const second = reduce(asked.live, { type: 'open', run_id: 'h2' });
  assert.equal(reduce(second, { type: 'opened', run_id: 'h1', report: report('h1') }).attached, 'a');
  assert.equal(reduce(second, { type: 'opened', run_id: 'h2', report: report('h2') }).report.id, 'h2');

  // Start after the click: the late history report does not replace the new run.
  const started = reduce(asked.live, { type: 'start', run_id: 'b', mode: 'functional' });
  assert.deepEqual(reduce(started, { type: 'opened', run_id: 'h1', report: report('h1') }), started);

  // A failed open changes nothing shown, and a tab showing nothing may attach again.
  const failed = reduce(reduce(initialLive(), { type: 'open', run_id: 'h1' }), { type: 'open_failed', run_id: 'h1' });
  assert.deepEqual(failed, initialLive());
  assert.deepEqual(decideSync(reduce(initialLive(), { type: 'open', run_id: 'h1' }), running('a')), { action: 'none' }, 'not while the visitor waits for a report');
});

test('when status says the attached run is not the live one, that run is read once', () => {
  const live = attachedTo('a');
  const out = step(live, { type: 'status', status: idleStatus });
  assert.deepEqual(out.effects, [{ type: 'probe', runId: 'a' }]);
  assert.equal(out.live.attached, 'a', 'still attached: the read decides');
  assert.deepEqual(step(out.live, { type: 'status', status: idleStatus }).effects, [], 'once per disagreement');
  assert.deepEqual(step(out.live, { type: 'status', status: running('b') }).effects, [{ type: 'probe', runId: 'a' }], 'a different answer is a new disagreement');

  // Agreement in between makes the next disagreement new again.
  const agreed = reduce(out.live, { type: 'status', status: running('a') });
  assert.deepEqual(step(agreed, { type: 'status', status: idleStatus }).effects, [{ type: 'probe', runId: 'a' }]);
});

test('step never changes the state or the event it was given', () => {
  const states = [
    initialLive(),
    attachedTo('a'),
    run([row('a', 0), ev('progress', 'a', { requests: 1 })], attachedTo('a')).live,
    finished('a'),
    reduce(finished('a'), { type: 'report', run_id: 'a', report: report('a') }),
    reduce(attachedTo('a'), { type: 'open', run_id: 'h' }),
  ];
  const events = [
    { type: 'status', status: running('a') }, { type: 'status', status: running('b') }, { type: 'status', status: idleStatus },
    { type: 'start', run_id: 'b', mode: 'functional' }, { type: 'watch', run_id: 'a', mode: 'functional' }, { type: 'watch', run_id: 'b', mode: 'functional' },
    ev('run_started', 'a', { mode: 'functional' }), row('a', 0), row('a', 1), ev('progress', 'a', { requests: 2 }), ev('run_finished', 'a', { status: 'completed' }),
    { type: 'open', run_id: 'h' }, { type: 'opened', run_id: 'h', report: report('h') }, { type: 'open_failed', run_id: 'h' },
    { type: 'report', run_id: 'a', report: report('a') }, { type: 'report_failed', run_id: 'a' },
    { type: 'nonsense' }, {},
  ];
  for (const state of states) {
    for (const event of events) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(state)));
      assert.doesNotThrow(() => step(frozen, deepFreeze(JSON.parse(JSON.stringify(event)))), `${event.type} on ${JSON.stringify(state).slice(0, 80)}`);
    }
  }
});

// ------------------------------------------------------------------ a run that is gone

const gone = (live, id) => step(live, { type: 'gone', run_id: id });

test('a run that answered 404 ends the attachment, asks for status once, and is not shown as running', () => {
  const watching = run([ev('run_started', 'a', { mode: 'functional' }), row('a', 0)], reduce(attachedTo('a'), { type: 'watch', run_id: 'a' })).live;
  const out = gone(watching, 'a');
  assert.deepEqual(out.effects, [{ type: 'status' }]);
  assert.equal(out.live.attached, '');
  assert.deepEqual(out.live.gone, ['a']);
  assert.equal(out.live.spectator, false);
  assert.deepEqual(out.live.outcome, { run_id: 'a', status: 'unavailable', duration_ms: null, verdict: '' });
  assert.equal(out.live.results.length, 1, 'what arrived stays on screen');

  // Nothing had arrived: there is nothing to keep, and the tab shows nothing again.
  const empty = gone(attachedTo('a'), 'a').live;
  assert.deepEqual([empty.run, empty.outcome, empty.results.length, empty.gone], [null, null, 0, ['a']]);

  // Only the attached run can be reported gone.
  assert.deepEqual(gone(watching, 'b').live, watching);
  assert.deepEqual(gone(initialLive(), 'a'), { live: initialLive(), effects: [] });
});

test('a gone run is not attached again until status reports a different run or none', () => {
  const lost = gone(attachedTo('a'), 'a').live;
  assert.equal(lost.run, null);

  // Status keeps naming it, as a server that restarted behind a stale answer would.
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(decideSync(lost, running('a')), { action: 'none' });
    assert.deepEqual(step(lost, { type: 'status', status: running('a') }), { live: lost, effects: [] });
  }
  // Watch does not attach to it either; it reads status again.
  const watched = step(lost, { type: 'watch', run_id: 'a', mode: 'functional' });
  assert.equal(watched.live.attached, '');
  assert.deepEqual(watched.effects, [{ type: 'status' }]);
  // A live run that is not named, or no status at all, changes nothing.
  assert.deepEqual(reduce(lost, { type: 'status', status: { running: true } }).gone, ['a']);
  assert.deepEqual(reduce(lost, { type: 'status', status: null }).gone, ['a']);

  // No run: the id is forgotten, and if the server names it again it is a new fact.
  const cleared = reduce(lost, { type: 'status', status: idleStatus });
  assert.deepEqual(cleared.gone, []);
  assert.equal(reduce(cleared, { type: 'status', status: running('a') }).attached, 'a');

  // A different run: forgotten, and a tab showing nothing follows the new one.
  const moved = reduce(lost, { type: 'status', status: running('b') });
  assert.deepEqual(moved.gone, []);
  assert.equal(moved.attached, 'b');

  // This tab's own Start is never refused.
  assert.equal(reduce(lost, { type: 'start', run_id: 'a', mode: 'functional' }).attached, 'a');
});

test('a tab still showing rows of a gone run keeps them when another run starts', () => {
  const lost = gone(run([row('a', 0)], attachedTo('a')).live, 'a').live;
  const next = step(lost, { type: 'status', status: running('b') });
  assert.equal(next.live.attached, '');
  assert.equal(next.live.run.id, 'a');
  assert.deepEqual(next.live.gone, []);
});

// Found by the seeded model: with one slot for the gone run, a second run
// going the same way made the tab forget the first while status still named it.
test('two runs gone in a row are both held: the first is not attached again while status names it', () => {
  let live = gone(attachedTo('a'), 'a').live;
  live = reduce(live, { type: 'watch', run_id: 'b', mode: 'functional' });
  assert.equal(live.attached, 'b');
  live = gone(live, 'b').live;

  const named = step(live, { type: 'status', status: running('a') });
  assert.equal(named.live.attached, '', 'status naming the first gone run does not attach it');
  const watched = step(named.live, { type: 'watch', run_id: 'a', mode: 'functional' });
  assert.equal(watched.live.attached, '');
  assert.deepEqual(watched.effects, [{ type: 'status' }]);

  // Status naming a now forgets b, which it no longer names, and only b.
  assert.equal(reduce(named.live, { type: 'watch', run_id: 'b', mode: 'functional' }).attached, 'b');
});
