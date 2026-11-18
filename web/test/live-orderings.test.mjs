// Every order one run's events can arrive in, through the rules alone: the
// reducer must end in the same place whichever order and however many times,
// ask for the finished report once, and drop what is not this run's or is
// not an event at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialLive, step } from '../js/live.js';

const ID = 'run-a';
const row = (index, id = ID) => ({ index, run: id, name: `${id}#${index}`, passed: true });
const EVENTS = [
  { type: 'run_started', run_id: ID, data: { mode: 'functional', total: 3, started_at: '2026-11-17T12:00:00Z', config: { delay_ms: 0 } } },
  { type: 'request_result', run_id: ID, data: row(0) },
  { type: 'request_result', run_id: ID, data: row(1) },
  { type: 'request_result', run_id: ID, data: row(2) },
  { type: 'progress', run_id: ID, data: { requests: 3 } },
  { type: 'run_finished', run_id: ID, data: { status: 'completed', duration_ms: 9, verdict: 'PASS' } },
];
const REPORT = {
  id: ID, mode: 'functional', status: 'completed', started_at: '2026-11-17T12:00:00Z', duration_ms: 9, config: { delay_ms: 0 },
  entries: [{}, {}, {}], functional: { results: [row(0), row(1), row(2)], verdict: 'PASS' },
};

function* permutations(list) {
  if (list.length <= 1) {
    yield list.slice();
    return;
  }
  for (let i = 0; i < list.length; i += 1) {
    const rest = list.slice(0, i).concat(list.slice(i + 1));
    for (const p of permutations(rest)) yield [list[i], ...p];
  }
}

// attachedTo is a tab that pressed Start on ID and has been sent nothing yet.
const attachedTo = () => step(initialLive(), { type: 'start', run_id: ID, mode: 'functional' }).live;

const VIEW = ['run', 'results', 'report', 'spectator', 'outcome', 'attached', 'ended', 'gone', 'opening'];
const viewOf = (live) => JSON.stringify(VIEW.map((k) => live[k]));

// fold runs a sequence and checks the rules after every step.
function fold(sequence, where) {
  let live = attachedTo();
  const reports = [];
  for (const event of sequence) {
    const before = live;
    const out = step(before, event);
    live = out.live;
    for (const e of out.effects) if (e.type === 'report') reports.push(e.runId);
    for (const r of live.results) assert.equal(r.run, ID, `${where}: a row of another run`);
    if (before.attached && live.attached === before.attached) {
      assert.ok(live.results.length >= before.results.length, `${where}: rows were removed by ${event.type}`);
    }
    if (before.outcome) {
      assert.equal(live, before, `${where}: ${event.type} was applied after the terminal event`);
    }
  }
  return { live, reports };
}

test('all 720 orders of one run\'s events end the same, once the report is in, and ask for the report exactly once', () => {
  const ends = new Set();
  let n = 0;
  for (const order of permutations(EVENTS)) {
    n += 1;
    const where = order.map((e) => (e.type === 'request_result' ? `row${e.data.index}` : e.type)).join(',');
    const { live, reports } = fold(order, where);
    assert.deepEqual(reports, [ID], `${where}: report asked for ${reports.length} times`);
    assert.equal(live.attached, '', where);
    assert.deepEqual(live.ended, [ID], where);
    assert.deepEqual(live.outcome, { run_id: ID, status: 'completed', duration_ms: 9, verdict: 'PASS' }, where);
    assert.equal(live.run.id, ID, where);

    // What arrived before the end is all there, in arrival order, each once.
    const cut = order.findIndex((e) => e.type === 'run_finished');
    const arrived = order.slice(0, cut).filter((e) => e.type === 'request_result').map((e) => e.data.index);
    assert.deepEqual(live.results.map((r) => r.index), arrived, where);
    if (order.slice(0, cut).some((e) => e.type === 'run_started')) {
      assert.equal(live.run.total, 3, `${where}: run_started filled in the run`);
      assert.equal(live.run.mode, 'functional', where);
    }

    const done = step(live, { type: 'report', run_id: ID, report: REPORT });
    assert.equal(done.effects.length, 0, where);
    ends.add(viewOf(done.live));
  }
  assert.equal(n, 720);
  assert.equal(ends.size, 1, `${ends.size} different end states`);
});

test('every event delivered twice in a row, in all 720 orders, changes nothing but the order rows arrived in', () => {
  const ends = new Set();
  for (const order of permutations(EVENTS)) {
    const doubled = order.flatMap((e) => [e, e]);
    const where = doubled.map((e) => e.type).join(',');
    const once = fold(order, where);
    const twice = fold(doubled, where);
    assert.deepEqual(twice.reports, [ID], `${where}: report asked for ${twice.reports.length} times`);
    assert.equal(viewOf(twice.live), viewOf(once.live), `${where}: a duplicate changed the end`);
    ends.add(viewOf(step(twice.live, { type: 'report', run_id: ID, report: REPORT }).live));
  }
  assert.equal(ends.size, 1);
});

test('events of no run, of another run, with no data, or of no known type change nothing on an attached tab', () => {
  let live = attachedTo();
  live = step(live, EVENTS[1]).live;
  const junk = [
    { type: 'request_result', data: row(1) },
    { type: 'request_result', run_id: '', data: row(1) },
    { type: 'request_result', run_id: 'run-b', data: row(1, 'run-b') },
    { type: 'run_finished', run_id: 'run-b', data: { status: 'completed' } },
    { type: 'progress', run_id: 'run-b', data: { requests: 9 } },
    { type: 'run_started', run_id: 'run-b', data: { mode: 'performance', total: 9 } },
    { type: 'heartbeat', run_id: ID, data: {} },
    { type: 'ping' },
    {},
    null,
    undefined,
  ];
  for (const event of junk) {
    const out = step(live, event);
    assert.equal(out.live, live, `${JSON.stringify(event)} changed the state`);
    assert.deepEqual(out.effects, [], JSON.stringify(event));
  }
});

test('a run_started with no data, or a terminal event with no status, never shows the run as running or loses a row', () => {
  let live = attachedTo();
  live = step(live, EVENTS[1]).live;
  live = step(live, { type: 'run_started', run_id: ID }).live;
  assert.equal(live.results.length, 1);
  assert.equal(live.run.id, ID);
  const out = step(live, { type: 'run_finished', run_id: ID });
  assert.equal(out.live.attached, '');
  assert.notEqual(out.live.outcome.status, 'running');
  assert.ok(out.live.outcome.status);
  assert.deepEqual(out.effects, [{ type: 'report', runId: ID }]);
  assert.equal(out.live.results.length, 1);
});

test('a progress after the terminal event, and the terminal event of a run already over, are dropped', () => {
  let live = attachedTo();
  live = step(live, EVENTS[4]).live;
  live = step(live, EVENTS[5]).live;
  const after = step(live, { type: 'progress', run_id: ID, data: { requests: 99 } });
  assert.equal(after.live, live);
  const again = step(live, { type: 'run_finished', run_id: ID, data: { status: 'cancelled' } });
  assert.equal(again.live, live);
  assert.deepEqual(again.effects, []);
  assert.equal(live.progress.requests, 3);
  assert.equal(live.outcome.status, 'completed');
});

test('a report that arrives twice, or a running report, does not replace the finished one', () => {
  let live = attachedTo();
  live = step(live, EVENTS[5]).live;
  live = step(live, { type: 'report', run_id: ID, report: REPORT }).live;
  const second = { ...REPORT, status: 'cancelled' };
  assert.equal(step(live, { type: 'report', run_id: ID, report: second }).live, live);
  let fresh = attachedTo();
  fresh = step(fresh, EVENTS[5]).live;
  assert.equal(step(fresh, { type: 'report', run_id: ID, report: { ...REPORT, status: 'running' } }).live, fresh);
});
