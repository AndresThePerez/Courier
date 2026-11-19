// render-results.js — the Results tab: the functional walk, the performance
// live phase, and the performance dashboard.
//
// This module is a pure function of state and knows nothing about how that
// state arrived. That is the whole point of the transport seam in api.js: a run
// streamed over SSE and a run polled at 500ms produce byte-identical renders,
// because both feed the same reducer and this module reads only what the
// reducer wrote. The one place the transport is visible at all is
// `transport-note`, which reports it as a fact about the connection rather than
// as a difference in the results.
//
// Everything here goes in through textContent. Every string on this page is a
// visitor's own input or a response body from the target.

import { el, replace, byId, fmtMs, fmtBytes, fmtTime } from './dom.js';
import { jsonView } from './json-view.js';
import { methodBadge } from './render-runner.js';

// The filter is All/Passed/Failed/Skipped as four plain buttons. Filter-tab
// chrome is deliberately absent, so this is a button row and nothing more.
const Filters = ['all', 'passed', 'failed', 'skipped'];

// Module-local view state: what this module has last painted and what the
// visitor has last asked it to show. None of it is application state, so none
// of it belongs in the store.
let filter = 'all';
let openRows = new Set();
let sortKey = 'index'; // index | p95
let sortDesc = true;
let lastRunId = null;
let lastRowSignature = null;
let lastRowEndpoints = null;
let lastRows = [];
let lastReport = null;

// Throttle state for the summary, which is the page's one live region. A
// performance run emits a progress event every 250ms (internal/runner/perf.go),
// and a polite queue cannot drain announcements at that rate: the reader speaks
// numbers over everything else and keeps going after the run ends. So the
// summary's DOM is replaced the moment the run's state changes and otherwise at
// most once every SummaryThrottleMs while a performance run is still running.
// The functional path is untouched: it ticks once per result row.
const SummaryThrottleMs = 5000;
let lastSummaryRunId = null;
let lastSummaryStatus = null;
let lastSummaryAt = 0;
let lastSummaryDrawn = null;
let lastSummaryNode = null;

export function render(state) {
  const rep = state.report;
  const run = state.run;
  const mode = (rep && rep.mode) || (run && run.mode) || '';

  // A new run resets the view: a filter or an expanded row from the last run
  // has nothing to say about this one.
  const runId = (rep && rep.id) || (run && run.id) || null;
  if (runId !== lastRunId) {
    lastRunId = runId;
    filter = 'all';
    openRows = new Set();
    sortKey = 'index';
    sortDesc = true;
    lastRowSignature = null;
    lastReport = null;
  }

  byId('results-empty').hidden = Boolean(mode);
  byId('functional-results').hidden = mode !== 'functional';
  byId('perf-live').hidden = mode !== 'performance' || Boolean(rep);
  byId('perf-dashboard').hidden = mode !== 'performance' || !rep;

  renderTransport(state);
  renderSummary(state, rep, run, mode);

  if (mode === 'functional') renderFunctional(state, rep);
  if (mode === 'performance' && !rep) renderLive(state);
  if (mode === 'performance' && rep) renderDashboard(rep);
}

// ---------------------------------------------------------------- header

function renderTransport(state) {
  const node = byId('transport-note');
  if (state.transport === 'polling') {
    node.hidden = false;
    node.className = 'note is-degraded';
    node.textContent =
      'Live updates degraded - polling. The event stream stopped delivering, so Courier is reading the run report every 500ms instead. The results below are the same either way.';
    return;
  }
  if (state.transport === 'sse') {
    node.hidden = false;
    node.className = 'note';
    node.textContent = 'Live updates streaming.';
    return;
  }
  node.hidden = true;
  node.textContent = '';
}

function renderSummary(state, rep, run, mode) {
  const node = byId('results-summary');
  const pdf = byId('download-pdf');

  if (!mode) {
    replace(node, []);
    lastSummaryRunId = null;
    lastSummaryStatus = null;
    lastSummaryDrawn = null;
    pdf.hidden = true;
    return;
  }

  const id = (rep && rep.id) || (run && run.id) || '';
  // A run that ended is never shown as running: when its report has not
  // arrived, or never does, the terminal event's own word stands.
  const outcome = endOf(state, id);
  const status = rep ? rep.status : (outcome ? outcome.status : 'running');
  const startedAt = (rep && rep.started_at) || (run && run.started_at) || '';
  const config = (rep && rep.config) || (run && run.config) || {};

  const bits = [];
  if (id) bits.push(id);
  if (startedAt) bits.push(fmtTime(startedAt));
  bits.push(durationText(state, rep, outcome));
  bits.push(configText(mode, config));

  if (mode === 'functional') {
    const c = counts(state.results);
    // The report's own counters are json:"-" (docs/deviations.md N6) — they are derivable
    // from the results array, and one source of truth beats two.
    bits.push(`${c.passed} passed / ${c.failed} failed / ${c.skipped} skipped of ${c.total}`);
  } else {
    const overall = (rep && rep.performance && rep.performance.overall) || null;
    if (overall) bits.push(`${overall.requests} requests`, `${(overall.requests_per_sec || 0).toFixed(1)} req/s`);
    else if (state.progress) bits.push(`${state.progress.requests} requests`);
  }

  // A new run id or a new status (started, completed, cancelled, expired) is
  // announced straight away; a run that is merely still running waits out the
  // interval. Nothing here leaves the module, so no store state is involved.
  // What the run is counts as its state too: a tab attaches before run_started
  // arrives, so the first paint has no start time and no config, and the one
  // that fills them in must not wait out the interval. These change once per
  // run; the counters, which the interval exists for, are not part of it.
  const judged = mode === 'functional' ? functionalVerdict(state, rep, outcome, status) : null;

  const shown = [
    status,
    outcome && outcome.report === 'failed' ? 'no report' : '',
    startedAt,
    configText(mode, config),
    judged ? judged.text : '',
  ].join('|');
  const stateChanged = id !== lastSummaryRunId || shown !== lastSummaryStatus;
  const now = Date.now();
  const throttled =
    mode === 'performance' && status === 'running' && !stateChanged && now - lastSummaryAt < SummaryThrottleMs;
  // The summary is the page's live region, so a render that would draw it
  // exactly as it stands (a status poll, a keystroke elsewhere) leaves it be:
  // replacing it would announce it again.
  const drawn = [shown, bits.filter(Boolean).join('  ·  '), state.spectator ? 'spectating' : ''].join('|');
  const unchanged = node === lastSummaryNode && id === lastSummaryRunId && drawn === lastSummaryDrawn;

  if (!throttled && !unchanged) {
    lastSummaryRunId = id;
    lastSummaryStatus = shown;
    lastSummaryDrawn = drawn;
    lastSummaryNode = node;
    lastSummaryAt = now;
    replace(node, [
      el('div', { class: 'results-title' }, [
        el('span', { text: `${mode} run` }),
        el('span', { class: `pill${statusClass(status)}`, text: status }),
        judged && el('span', { class: `pill run-verdict${judged.tone}`, title: 'Verdict', text: judged.text }),
        state.spectator && el('span', { class: 'badge', text: 'spectating' }),
      ]),
      el('div', { class: 'results-meta mono', text: bits.filter(Boolean).join('  ·  ') }),
      !rep && outcome && outcome.status === 'unavailable' && el('p', {
        class: 'note',
        text: 'This run is no longer on the server.',
      }),
      !rep && outcome && outcome.report === 'failed' && el('p', {
        class: 'note',
        text: 'The finished report could not be loaded - open it from History.',
      }),
    ]);
  }

  // The button points at the route shape the PDF renderer serves.
  pdf.hidden = !rep;
  if (rep) {
    pdf.href = `/api/runs/${encodeURIComponent(rep.id)}/report.pdf`;
    pdf.title = `Download the ${rep.mode} report for ${rep.id} as a PDF`;
  }
}

// endOf is how the shown run ended, when its terminal event has arrived.
function endOf(state, id) {
  const outcome = state.outcome;
  return outcome && id && outcome.run_id === id ? outcome : null;
}

function durationText(state, rep, outcome) {
  if (rep) return fmtMs(rep.duration_ms);
  if (outcome) return outcome.duration_ms === null || outcome.duration_ms === undefined ? '' : fmtMs(outcome.duration_ms);
  if (state.progress) return fmtMs(state.progress.elapsed_ms);
  return 'running';
}

function configText(mode, config) {
  if (mode === 'performance') {
    return `${config.concurrency || 0} workers x ${config.duration_secs || 0}s`;
  }
  const parts = [];
  if (config.delay_ms) parts.push(`${config.delay_ms}ms delay`);
  if (config.stop_on_failure) parts.push('stop on first failure');
  return parts.join(', ');
}

// A completed run is only a run that finished: whether it passed is the
// verdict's to say, and a green "completed" beside a red FAIL would say both.
function statusClass(status) {
  if (status === 'completed') return '';
  if (status === 'running') return ' is-live';
  return ' is-warn';
}

const Verdicts = ['PASS', 'FAIL', 'N/A'];

// functionalVerdict is a functional run's PASS, FAIL or N/A, by the rule the
// PDF of the same run applies (internal/pdf/report.go, verdictOf), so the
// page and the report a visitor downloads never disagree. A run still going
// has earned no judgement, and neither has one the server lost. A verdict the
// run carries is taken; one it does not carry in a form the server sends is
// worked out from the rows as internal/report.FunctionalVerdict does.
function functionalVerdict(state, rep, outcome, status) {
  if (status === 'running' || status === 'unavailable') return null;
  if (status === 'cancelled' || status === 'expired') return { text: 'N/A - partial data', tone: '' };
  const carried = rep ? rep.functional && rep.functional.verdict : outcome && outcome.verdict;
  const verdict = Verdicts.includes(carried) ? carried : verdictOfRows(state.results);
  if (verdict === 'FAIL') return { text: 'FAIL', tone: ' is-fail' };
  if (verdict === 'PASS') return { text: 'PASS', tone: ' is-pass' };
  return { text: 'N/A - nothing was asserted', tone: '' };
}

function verdictOfRows(rows) {
  let passed = false;
  for (const r of rows) {
    if (r.skipped) continue;
    if (!r.passed) return 'FAIL';
    passed = true;
  }
  return passed ? 'PASS' : 'N/A';
}

function counts(results) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.skipped) skipped += 1;
    else if (r.passed) passed += 1;
    else failed += 1;
  }
  return { passed, failed, skipped, total: results.length };
}

// ---------------------------------------------------------------- functional

function renderFunctional(state, rep) {
  const c = counts(state.results);
  replace(byId('results-filter'), Filters.map((name) => filterButton(name, c, state)));

  // Rebuilding on every notify would collapse a row the visitor just opened —
  // a live run notifies several times a second. The signature covers everything
  // that changes what a row says, the final report included: its rows carry the
  // body previews a mid-run partial report deliberately omits.
  // The catalog arriving is a change as well: the method badges are read from it.
  // So is a row delivered again under the same index (the stream and the
  // polling fallback can both deliver one): the count alone would not show it.
  const signature = `${filter}|${state.results.length}|${rep ? `${rep.id}:${rep.status}` : 'live'}`;
  const sameRows = state.results.length === lastRows.length && state.results.every((r, i) => r === lastRows[i]);
  if (signature === lastRowSignature && state.endpoints === lastRowEndpoints && sameRows) return;
  lastRowSignature = signature;
  lastRowEndpoints = state.endpoints;
  lastRows = state.results.slice();

  const rows = state.results.filter(matchesFilter);
  const box = byId('results-rows');
  if (state.results.length === 0) {
    replace(box, [el('div', { class: 'rows-empty', text: 'Waiting for the first result...' })]);
    return;
  }
  if (rows.length === 0) {
    replace(box, [el('div', { class: 'rows-empty', text: `No ${filter} requests in this run.` })]);
    return;
  }
  replace(box, rows.map((r) => resultRow(r, Boolean(rep), state.endpoints)));
}

function filterButton(name, c, state) {
  const n = name === 'all' ? c.total : c[name];
  const btn = el('button', {
    class: `btn btn-mini${filter === name ? ' is-on' : ''}`,
    type: 'button',
    text: `${name} ${n}`,
    attrs: { 'aria-pressed': filter === name ? 'true' : 'false' },
    on: {
      click: () => {
        filter = name;
        lastRowSignature = null;
        renderFunctional(state, state.report);
      },
    },
  });
  return btn;
}

function matchesFilter(r) {
  if (filter === 'all') return true;
  if (filter === 'skipped') return Boolean(r.skipped);
  if (filter === 'passed') return !r.skipped && Boolean(r.passed);
  return !r.skipped && !r.passed;
}

function resultRow(r, finished, endpoints) {
  const outcomes = r.assertions || [];
  const passed = outcomes.filter((o) => o.passed).length;

  const head = el('summary', { class: 'res-head' }, [
    el('span', { class: 'res-index mono', text: String((r.index || 0) + 1) }),
    rowMark(r, outcomes),
    el('span', { class: `pill${r.skipped ? ' is-muted' : ''}`, text: pillText(r) }),
    methodBadge(endpoints, r.endpoint),
    el('span', { class: 'res-body' }, [
      el('span', { class: 'res-name', text: r.name || r.endpoint }),
      el('span', { class: 'res-target mono', text: `${r.endpoint}${r.query || ''}` }),
    ]),
    el('span', { class: 'res-num mono', text: r.skipped ? '-' : fmtMs(r.latency_ms) }),
    el('span', { class: 'res-num mono', text: r.skipped ? '-' : fmtBytes(r.size_bytes) }),
    el('span', {
      class: `res-num mono ${outcomes.length && passed === outcomes.length ? 'pass' : ''}`,
      text: `${passed}/${outcomes.length} assertions`,
    }),
  ]);

  // Three states, three edges. A pass has none, a failure takes --fail, and a
  // skipped row takes the muted line colour: it shared is-off with a failure
  // until now, which painted a skip in the failure's red and contradicted the
  // copy five lines down insisting a skip is never counted as a failure.
  const edge = r.skipped ? ' is-skipped' : (r.passed ? '' : ' is-off');
  const details = el('details', { class: `res-row${edge}` }, [
    head,
    el('div', { class: 'res-detail' }, [
      r.skipped && el('p', {
        class: 'note',
        text: 'Skipped. Either the walk stopped before this request went out, or Courier aborted it mid-flight - a skipped request is never counted as a failure, because the target never earned one.',
      }),
      r.error && el('p', {
        class: 'note fail',
        text: `${r.error_kind ? `${r.error_kind}: ` : ''}${r.error}`,
      }),
      outcomes.length > 0 && el('div', { class: 'outcomes' }, outcomes.map(outcomeRow)),
      !r.skipped && bodySection(r, finished),
    ]),
  ]);

  details.open = openRows.has(r.index);
  details.addEventListener('toggle', () => {
    if (details.open) openRows.add(r.index);
    else openRows.delete(r.index);
  });
  return details;
}

function pillText(r) {
  if (r.skipped) return 'skipped';
  if (r.status > 0) return String(r.status);
  return 'no response';
}

// rowMark says whether a row's assertions held, apart from its status code:
// a 400 a request expected is a pass, and a 200 it did not expect a failure,
// so the code itself is never coloured. A skipped row was not checked and has
// no mark; one that passed with nothing to check says so rather than wearing
// a green PASS nobody earned. A failure without a response is still a FAIL:
// the server failed every check it could not make.
function rowMark(r, outcomes) {
  if (r.skipped) return null;
  if (!r.passed) return el('span', { class: 'res-mark mono fail', text: 'FAIL' });
  if (outcomes.length === 0) return el('span', { class: 'res-mark mono', text: 'no checks' });
  return el('span', { class: 'res-mark mono pass', text: 'PASS' });
}

function outcomeRow(o) {
  const a = o.assertion || {};
  const label = [a.type, a.path, a.op].filter(Boolean).join(' ');
  return el('div', { class: 'outcome' }, [
    el('span', { class: o.passed ? 'pass' : 'fail', text: o.passed ? 'PASS' : 'FAIL' }),
    el('span', { class: 'outcome-label mono', text: label }),
    el('span', { class: 'outcome-cmp', text: `expected ${o.expected || '-'}` }),
    el('span', { class: 'outcome-cmp', text: `actual ${o.actual || '-'}` }),
    o.error && el('span', { class: 'outcome-err fail', text: o.error }),
  ]);
}

// bodySection is honest about where a body comes from. The 16KB preview rides
// the live stream and is stored on the finished report, but a partial report
// fetched mid-run carries none by design — so a row that arrived over the
// polling fallback has no body until the run ends, and says so rather than
// rendering an empty <pre> that looks like an empty response.
function bodySection(r, finished) {
  if (!r.body_preview) {
    return el('p', {
      class: 'note',
      text: finished
        ? 'No response body was captured for this request.'
        : 'The response body arrives with the finished report. A report fetched while a run is still going deliberately carries no body previews.',
    });
  }
  return el('div', {}, [
    el('h4', { class: 'block-heading' }, [
      el('span', { text: 'Response body' }),
      r.body_truncated && el('span', { class: 'badge', text: 'truncated at 16KB' }),
    ]),
    jsonView(r.body_preview, { truncated: Boolean(r.body_truncated) }),
  ]);
}

// ---------------------------------------------------------------- perf live

function renderLive(state) {
  const p = state.progress;
  setText(byId('perf-elapsed'), p ? fmtMs(p.elapsed_ms) : '0.0s');
  setText(byId('perf-rps'), p ? (p.rps || 0).toFixed(1) : '0');
  setText(byId('perf-counters'), p
    ? [
      `${p.requests} requests`,
      `${p.errors} errors`,
      `${p.aborted} aborted`,
      `avg ${fmtMs(p.avg_latency_ms)}`,
    ].join('  ·  ')
    : 'Waiting for the first progress tick...');
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

// ---------------------------------------------------------------- dashboard

function renderDashboard(rep) {
  const perf = rep.performance;
  if (!perf) return;
  // The dashboard is a function of one immutable object: a finished report is
  // never mutated again, so it is rebuilt when the report changes and not on
  // every notify. Sorting the per-request table is the one exception and it
  // clears this itself.
  if (rep === lastReport) return;
  lastReport = rep;

  const overall = perf.overall || {};
  renderVerdict(rep, perf);
  renderLadder(overall.sla || {}, perf.slo);
  renderApdex(overall.apdex || {}, perf.slo);
  renderLatency(overall.latency || {});
  renderHistogram(overall.histogram || [], gateOf(perf.slo));
  renderPerRequest(perf.per_request || []);
  renderErrors(overall, perf.overrun_ms);
}

// Two different things send a verdict to N/A, and the badge must not confuse
// them. A truncated run (cancelled or expired) has partial data: it stopped
// early, so the marker line and the 'partial data' label belong to it alone. A
// completed run of an uncalibrated sequence has complete data that no gate
// describes, so its badge is a plain N/A and the server's reason says why.
function renderVerdict(rep, perf) {
  const truncated = rep.status === 'cancelled' || rep.status === 'expired';
  const withheld = truncated || perf.verdict === 'N/A';
  const verdict = truncated ? 'N/A - partial data' : perf.verdict || 'N/A';
  const tone = withheld ? 'is-na' : (perf.verdict === 'PASS' ? 'is-pass' : 'is-fail');

  const node = byId('verdict-badge');
  node.className = `verdict ${tone}`;
  replace(node, [
    el('div', { class: 'verdict-badge', text: verdict }),
    el('div', { class: 'verdict-body' }, [
      truncated && el('p', {
        class: 'verdict-marker',
        text: `${rep.status} after ${Math.round((rep.duration_ms || 0) / 1000)}s`,
      }),
      ...(perf.verdict_reasons || []).map((reason) => el('p', { class: 'verdict-reason', text: reason })),
      withheld && el('p', {
        class: 'note',
        text: 'The numbers below are descriptive and still real. Only the pass-or-fail judgement is withheld; the reason above says why.',
      }),
      !withheld && el('p', {
        class: 'note',
        text: verdictNote(perf.slo),
      }),
    ]),
  ]);
}

// The gate the run was judged by, read from the report rather than repeated
// here. The sequence is the word the old copy was missing: the thresholds are
// calibrated against one specific five-request collection, and the app applies
// them to whatever a visitor assembles.
function verdictNote(slo) {
  if (!slo || !slo.p95_ms) {
    return 'Verdict SLOs are fixed server-side constants, calibrated against this target on this hardware rather than borrowed from generic web-latency advice.';
  }
  return `Verdict SLOs are fixed server-side constants: p95 within ${slo.p95_ms}ms and an error rate under ${(100 * slo.max_error_rate).toFixed(0)}%, calibrated on ${slo.calibration_date} against this target, this hardware, and the ${slo.calibration_sequence} sequence.`;
}

// The defaults are what a report without its own SLO block was judged by
// (internal/report): the p95 gate, and the rungs its SLA shares are keyed by.
const DefaultGateMs = 150;
const RungGoalPct = 95;

const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

// gateOf is the verdict's p95 goal, read from the report.
function gateOf(slo) {
  return slo && typeof slo === 'object' && positive(slo.p95_ms) ? slo.p95_ms : DefaultGateMs;
}

// rungsOf is the ladder the report states, lowest rung first. A report that
// states none, or one that is not a list of thresholds (an older report),
// draws the rungs its shares are keyed by instead.
function rungsOf(sla, slo) {
  const stated = slo && typeof slo === 'object' ? slo.ladder_ms : null;
  if (Array.isArray(stated) && stated.length > 0 && stated.every(positive)) {
    return [...new Set(stated)].sort((x, y) => x - y);
  }
  const keyed = Object.keys(sla).map((k) => /^under_(\d+)$/.exec(k)).filter(Boolean).map((m) => Number(m[1]));
  return keyed.length > 0 ? [...new Set(keyed)].sort((x, y) => x - y) : [50, 150, DefaultGateMs * 2];
}

// The server judges a run by its p95 gate alone; marking each rung met at
// RungGoalPct is this page's convention, and the server's shares count the
// responses at or under a rung. A rung that met the mark is a pass. One that
// missed it is a failure at the verdict's gate and above it; below the gate it
// is tighter than anything the run is judged by, so it keeps the plain fill,
// and says in words that it missed. The note names the gate only when the
// report states one, so it never quotes a number the report did not send.
function renderLadder(sla, slo) {
  const gate = gateOf(slo);
  const stated = slo && typeof slo === 'object' && positive(slo.p95_ms);
  const rung = stated ? `the ${msText(gate)}ms rung` : 'the rung at the verdict\'s p95 gate';
  replace(byId('sla-ladder'), [
    ...rungsOf(sla, slo).map((ms) => ladderBar(ms, sla[`under_${msText(ms)}`], gate)),
    el('p', {
      class: 'note',
      text: `This page marks a rung's goal met when at least ${RungGoalPct}% of responses took that long or less.`
        + ` Only ${rung} corresponds to the verdict's p95 gate: a rung at or above it that misses its goal is drawn as a failure, and one below it only describes the run.`,
    }),
  ]);
}

// shareText prints a share rounded down to one decimal, so a share under the
// goal never reads as the goal, and one under 100 never reads as 100.
function shareText(pct) {
  return `${(Math.floor(pct * 10 + 1e-9) / 10).toFixed(1)}%`;
}

function ladderBar(ms, pct, gate) {
  const known = typeof pct === 'number' && Number.isFinite(pct);
  const met = known && pct >= RungGoalPct;
  const tone = !known ? '' : (met ? ' is-pass' : (ms >= gate ? ' is-fail' : ''));
  const goal = !known ? 'no share recorded' : (met ? 'goal met' : 'goal missed');
  const label = `under ${msText(ms)}ms`;
  const fill = el('div', { class: `bar-fill${tone}` });
  fill.style.width = `${known ? clampPct(pct) : 0}%`;
  return el('div', { class: 'bar-row', attrs: { 'aria-label': `${label}: ${known ? shareText(pct) : 'no share'}, ${goal}` } }, [
    el('span', { class: 'bar-label', text: label }),
    el('div', { class: 'bar-track' }, [fill]),
    el('span', { class: 'bar-value mono', text: known ? shareText(pct) : '-' }),
    el('span', { class: 'bar-goal', text: goal }),
  ]);
}

function clampPct(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100);
}

// apdexT is the threshold the report's Apdex was scored against, or null when
// the report does not say: the heading and the note then name no number
// rather than one the server may not have used.
function apdexT(slo) {
  const t = slo && typeof slo === 'object' ? slo.apdex_t_ms : null;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
}

// msText writes a threshold the way the report states it: 50, 37.5.
function msText(ms) {
  return String(Number(ms.toPrecision(4)));
}

function renderApdex(apdex, slo) {
  const t = apdexT(slo);
  setText(byId('apdex-heading'), t === null ? 'Apdex' : `Apdex - T = ${msText(t)}ms`);
  const bands = t === null ? '' : `Satisfied at or under ${msText(t)}ms, tolerating at or under ${msText(4 * t)}ms. `;
  const n = (apdex.satisfied || 0) + (apdex.tolerating || 0) + (apdex.frustrated || 0);
  replace(byId('apdex-block'), [
    el('div', { class: 'apdex-head' }, [
      el('span', { class: 'apdex-score mono', text: (apdex.score || 0).toFixed(3) }),
      el('span', { class: `apdex-rating${apdexTone(apdex.rating)}`, text: apdex.rating || '-' }),
    ]),
    el('p', {
      class: 'note mono',
      text: `${apdex.satisfied || 0} satisfied  ·  ${apdex.tolerating || 0} tolerating  ·  ${apdex.frustrated || 0} frustrated  ·  ${n} judged`,
    }),
    el('p', {
      class: 'note',
      text: `${bands}Every non-2xx and every transport failure counts as frustrated however fast it was; dispatches Courier aborted are not counted at all.`,
    }),
  ]);
}

// The five rating words come from report.ApdexRating, so the mapping lives
// here rather than being re-derived from the score.
function apdexTone(rating) {
  switch (rating) {
    case 'Excellent':
    case 'Good':
      return ' is-good';
    case 'Fair':
      return ' is-fair';
    case 'Poor':
    case 'Unacceptable':
      return ' is-poor';
    default:
      return '';
  }
}

const LatencyKeys = [
  ['min', 'min'],
  ['avg', 'avg'],
  ['p50', 'p50'],
  ['p90', 'p90'],
  ['p95', 'p95'],
  ['p99', 'p99'],
  ['max', 'max'],
];

function renderLatency(latency) {
  const head = el('tr', {}, LatencyKeys.map(([, label]) => el('th', { text: label })));
  const row = el('tr', {}, LatencyKeys.map(([key]) => el('td', { class: 'mono', text: fmtMs(latency[key] || 0) })));
  replace(byId('latency-table'), [
    el('table', { class: 'data-table' }, [el('thead', {}, [head]), el('tbody', {}, [row])]),
  ]);
}

function renderHistogram(buckets, gate) {
  const max = buckets.reduce((m, b) => Math.max(m, b.count || 0), 0);
  replace(byId('histogram'), buckets.map((b) => {
    // A bucket that straddles the gate is a warning and one entirely past it
    // is a failure. to === 0 is the unbounded top bucket.
    const tone = (b.to === 0 || b.from >= gate) ? ' is-fail' : (b.to > gate ? ' is-warn' : '');
    const fill = el('div', { class: `bar-fill${tone}` });
    fill.style.width = `${max > 0 ? (100 * (b.count || 0)) / max : 0}%`;
    return el('div', { class: 'bar-row' }, [
      el('span', { class: 'bar-label mono', text: b.label }),
      el('div', { class: 'bar-track' }, [fill]),
      el('span', { class: 'bar-value mono', text: String(b.count || 0) }),
    ]);
  }));
}

function renderPerRequest(rows) {
  const sorted = rows.slice().sort((a, b) => {
    if (sortKey === 'p95') {
      const d = ((b.latency && b.latency.p95) || 0) - ((a.latency && a.latency.p95) || 0);
      return sortDesc ? d : -d;
    }
    return (a.index || 0) - (b.index || 0);
  });

  const head = el('tr', {}, [
    sortHeader('#', 'index'),
    el('th', { text: 'request' }),
    el('th', { text: 'requests' }),
    el('th', { text: 'errors' }),
    el('th', { text: 'aborted' }),
    el('th', { text: 'p50' }),
    sortHeader('p95', 'p95'),
    el('th', { text: 'p99' }),
    el('th', { text: 'req/s' }),
  ]);

  const body = sorted.map((s) => {
    const lat = s.latency || {};
    return el('tr', {}, [
      el('td', { class: 'mono', text: String((s.index || 0) + 1) }),
      el('td', { class: 'cell-name', text: s.name || '-' }),
      el('td', { class: 'mono', text: String(s.requests || 0) }),
      el('td', { class: `mono${s.errors ? ' fail' : ''}`, text: String(s.errors || 0) }),
      el('td', { class: 'mono', text: String(s.aborted || 0) }),
      el('td', { class: 'mono', text: fmtMs(lat.p50 || 0) }),
      el('td', { class: 'mono', text: fmtMs(lat.p95 || 0) }),
      el('td', { class: 'mono', text: fmtMs(lat.p99 || 0) }),
      el('td', { class: 'mono', text: (s.requests_per_sec || 0).toFixed(1) }),
    ]);
  });

  replace(byId('per-request-table'), [
    el('table', { class: 'data-table' }, [el('thead', {}, [head]), el('tbody', {}, body)]),
    el('p', {
      class: 'note',
      text: 'Per-entry numbers are what let a report say which request is the p99 problem, rather than only that the run has one.',
    }),
  ]);
}

function sortHeader(label, key) {
  const active = sortKey === key;
  const arrow = active && key === 'p95' ? (sortDesc ? ' ↓' : ' ↑') : '';
  return el('th', { class: active ? 'is-sorted' : '' }, [
    el('button', {
      class: 'link-btn',
      type: 'button',
      text: `${label}${arrow}`,
      title: key === 'p95' ? 'Sort by p95' : 'Back to sequence order',
      on: {
        click: () => {
          if (sortKey === key && key === 'p95') sortDesc = !sortDesc;
          else {
            sortKey = key;
            sortDesc = true;
          }
          const rep = lastReport;
          lastReport = null; // let the dashboard rebuild with the new order
          if (rep) renderDashboard(rep);
        },
      },
    }),
  ]);
}

const ErrorKindLabels = {
  timeout: 'timeout',
  connection: 'connection',
  non_2xx: 'non-2xx response',
};

function renderErrors(overall, overrunMs) {
  const judged = (overall.requests || 0) - (overall.aborted || 0);
  const statuses = Object.entries(overall.status_counts || {})
    .map(([code, n]) => [Number(code), n])
    .sort((a, b) => a[0] - b[0]);
  const kinds = Object.entries(overall.error_kinds || {}).sort((a, b) => b[1] - a[1]);

  replace(byId('error-block'), [
    // success_ratio arrives as a percentage, not a fraction.
    el('p', { class: 'mono', text: `${(overall.success_ratio || 0).toFixed(2)}% success` }),
    el('p', {
      class: 'note mono',
      text: `${overall.ok || 0} 2xx  ·  ${overall.errors || 0} errors  ·  ${overall.aborted || 0} aborted  ·  ${judged} judged  ·  ${fmtBytes(overall.bytes || 0)} read`,
    }),

    el('h4', { class: 'block-heading', text: 'Status distribution' }),
    statuses.length === 0
      ? el('p', { class: 'note', text: 'No responses were recorded.' })
      : el('div', { class: 'chips' }, statuses.map(([code, n]) => el('span', {
        class: `chip mono${code === 0 || code >= 400 ? ' fail' : ''}`,
        text: code === 0 ? `0 (transport error) x${n}` : `${code} x${n}`,
      }))),

    el('h4', { class: 'block-heading', text: 'Error kinds' }),
    kinds.length === 0
      ? el('p', { class: 'note', text: 'No errors.' })
      : el('div', { class: 'chips' }, kinds.map(([kind, n]) => el('span', {
        class: 'chip mono fail',
        text: `${ErrorKindLabels[kind] || kind} x${n}`,
      }))),

    el('p', {
      class: 'note',
      text: 'Success is 2xx over dispatches minus aborts. A dispatch Courier itself killed - a cancel, a shutdown, a deadline - is neither a success nor an error: counting it as one would let pressing Cancel manufacture a failure the target never caused.',
    }),
    overrunMs > 0 && el('p', {
      class: 'note',
      text: `In-flight requests took ${fmtMs(overrunMs)} past the deadline to drain. Courier waits for them rather than abandoning the measurement.`,
    }),
  ]);
}
