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

// The filter is the plan's All/Passed/Failed/Skipped as four plain buttons.
// Addendum A3 defers filter-tab chrome, so this is a button row and nothing
// more.
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
let lastReport = null;

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
    pdf.hidden = true;
    return;
  }

  const id = (rep && rep.id) || (run && run.id) || '';
  const status = rep ? rep.status : 'running';
  const startedAt = (rep && rep.started_at) || (run && run.started_at) || '';
  const config = (rep && rep.config) || (run && run.config) || {};

  const bits = [];
  if (id) bits.push(id);
  if (startedAt) bits.push(fmtTime(startedAt));
  bits.push(durationText(state, rep));
  bits.push(configText(mode, config));

  if (mode === 'functional') {
    const c = counts(state.results);
    // The report's own counters are json:"-" (NOTE.md N6) — they are derivable
    // from the results array, and one source of truth beats two.
    bits.push(`${c.passed} passed / ${c.failed} failed / ${c.skipped} skipped of ${c.total}`);
  } else {
    const overall = (rep && rep.performance && rep.performance.overall) || null;
    if (overall) bits.push(`${overall.requests} requests`, `${(overall.requests_per_sec || 0).toFixed(1)} req/s`);
    else if (state.progress) bits.push(`${state.progress.requests} requests`);
  }

  replace(node, [
    el('div', { class: 'results-title' }, [
      el('span', { text: `${mode} run` }),
      el('span', { class: `pill ${statusClass(status)}`, text: status }),
      state.spectator && el('span', { class: 'badge', text: 'spectating' }),
    ]),
    el('div', { class: 'results-meta mono', text: bits.filter(Boolean).join('  ·  ') }),
  ]);

  // The route lands with the PDF renderer in Task 19; the button is the one the
  // plan asks this task for, pointed at the route shape Task 19 specifies.
  pdf.hidden = !rep;
  if (rep) {
    pdf.href = `/api/runs/${encodeURIComponent(rep.id)}/report.pdf`;
    pdf.title = `Download the ${rep.mode} report for ${rep.id} as a PDF`;
  }
}

function durationText(state, rep) {
  if (rep) return fmtMs(rep.duration_ms);
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

function statusClass(status) {
  if (status === 'completed') return 'is-pass';
  if (status === 'running') return 'is-live';
  return 'is-warn';
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
  const signature = `${filter}|${state.results.length}|${rep ? `${rep.id}:${rep.status}` : 'live'}`;
  if (signature === lastRowSignature) return;
  lastRowSignature = signature;

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
  replace(box, rows.map((r) => resultRow(r, Boolean(rep))));
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

function resultRow(r, finished) {
  const outcomes = r.assertions || [];
  const passed = outcomes.filter((o) => o.passed).length;

  const head = el('summary', { class: 'res-head' }, [
    el('span', { class: 'res-index mono', text: String((r.index || 0) + 1) }),
    el('span', { class: `pill ${pillClass(r)}`, text: pillText(r) }),
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

function pillClass(r) {
  if (r.skipped) return 'is-muted';
  return r.passed ? 'is-pass' : 'is-fail';
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
  renderLadder(overall.sla || {});
  renderApdex(overall.apdex || {});
  renderLatency(overall.latency || {});
  renderHistogram(overall.histogram || []);
  renderPerRequest(perf.per_request || []);
  renderErrors(overall, perf.overrun_ms);
}

function renderVerdict(rep, perf) {
  const partial = rep.status === 'cancelled' || rep.status === 'expired' || perf.verdict === 'N/A';
  const verdict = partial ? 'N/A - partial data' : perf.verdict || 'N/A';
  const tone = partial ? 'is-na' : (perf.verdict === 'PASS' ? 'is-pass' : 'is-fail');

  const node = byId('verdict-badge');
  node.className = `verdict ${tone}`;
  replace(node, [
    el('div', { class: 'verdict-badge', text: verdict }),
    el('div', { class: 'verdict-body' }, [
      partial && el('p', {
        class: 'verdict-marker',
        text: `${rep.status} after ${Math.round((rep.duration_ms || 0) / 1000)}s`,
      }),
      ...(perf.verdict_reasons || []).map((reason) => el('p', { class: 'verdict-reason', text: reason })),
      partial && el('p', {
        class: 'note',
        text: 'The numbers below are still real - they are descriptive. Only the pass/fail judgement is withheld, because the SLOs describe a run that finished.',
      }),
      !partial && el('p', {
        class: 'note',
        text: 'Verdict SLOs are fixed server-side constants: p95 within 150ms and an error rate under 1%, calibrated against this target on this hardware rather than borrowed from generic web-latency advice.',
      }),
    ]),
  ]);
}

function renderLadder(sla) {
  replace(byId('sla-ladder'), [
    ladderBar('under 50ms', sla.under_50 || 0),
    ladderBar('under 150ms', sla.under_150 || 0),
    ladderBar('under 300ms', sla.under_300 || 0),
  ]);
}

function ladderBar(label, pct) {
  const fill = el('div', { class: 'bar-fill' });
  fill.style.width = `${clampPct(pct)}%`;
  return el('div', { class: 'bar-row' }, [
    el('span', { class: 'bar-label', text: label }),
    el('div', { class: 'bar-track' }, [fill]),
    el('span', { class: 'bar-value mono', text: `${pct.toFixed(1)}%` }),
  ]);
}

function clampPct(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100);
}

function renderApdex(apdex) {
  const n = (apdex.satisfied || 0) + (apdex.tolerating || 0) + (apdex.frustrated || 0);
  replace(byId('apdex-block'), [
    el('div', { class: 'apdex-head' }, [
      el('span', { class: 'apdex-score mono', text: (apdex.score || 0).toFixed(3) }),
      el('span', { class: 'apdex-rating', text: apdex.rating || '-' }),
    ]),
    el('p', {
      class: 'note mono',
      text: `${apdex.satisfied || 0} satisfied  ·  ${apdex.tolerating || 0} tolerating  ·  ${apdex.frustrated || 0} frustrated  ·  ${n} judged`,
    }),
    el('p', {
      class: 'note',
      text: 'Satisfied at or under 50ms, tolerating at or under 200ms. Every non-2xx and every transport failure counts as frustrated however fast it was; dispatches Courier aborted are not counted at all.',
    }),
  ]);
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

function renderHistogram(buckets) {
  const max = buckets.reduce((m, b) => Math.max(m, b.count || 0), 0);
  replace(byId('histogram'), buckets.map((b) => {
    const fill = el('div', { class: 'bar-fill' });
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
