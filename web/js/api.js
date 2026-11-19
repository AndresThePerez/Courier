// api.js — every fetch call and the live-update transport.
// Nothing else in the frontend calls fetch.
//
// No call here throws. A request that could not be made, or whose answer never
// arrived whole, is an outcome like any other: the caller asked a question and
// is owed an answer it can show, and a rejected promise nobody caught is how a
// button stays on "Sending..." until the page is reloaded.

// unreachable is that outcome: the request was refused, dropped, or cut off
// while its body was being read. All three are the same fact to a visitor.
function unreachable() {
  return { ok: false, kind: 'network', error: 'Could not reach Courier' };
}

function parse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// isRecord is the least any 2xx body of Courier's is: a JSON object. Every
// read route, Send and Start answer one. A 2xx whose body is anything else (a
// proxy's holding page, a body cut short that the browser reports as complete,
// a JSON null) was not written by Courier, and is the network outcome rather
// than an answer a reader would have to second-guess.
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------- answer shapes
//
// An answer is read item by item before any of it is trusted. The render
// modules read these fields straight off the state, so one entry of the wrong
// shape would throw inside a render and take the rest of the page with it.
// Such an answer was not written by Courier, and is unusable as a whole: the
// reader treats it as the failed read a body that is not JSON is, rather than
// showing the part that looked right. Go writes an empty list as null, and a
// field tagged omitempty is absent, so both are allowed where the server can
// send them.

const isText = (v) => typeof v === 'string';
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const absentOr = (check) => (v) => v === undefined || check(v);
const listOf = (check) => (v) => Array.isArray(v) && v.every(check);
const nullableListOf = (check) => (v) => v === undefined || v === null || listOf(check)(v);

// RunStatuses are the states a report can be in; EndedStatuses the ones a
// finished report can be in (internal/report).
const RunStatuses = ['running', 'completed', 'cancelled', 'expired'];
export const EndedStatuses = ['completed', 'cancelled', 'expired'];

export function isStatus(s) {
  return isRecord(s)
    && typeof s.running === 'boolean'
    && absentOr(isText)(s.run_id)
    && absentOr(isText)(s.mode)
    && absentOr(isText)(s.started_at)
    && absentOr(isText)(s.cooldown_until)
    && absentOr(isNumber)(s.budget_balance);
}

function isHistoryEntry(e) {
  return isRecord(e)
    && isText(e.id) && e.id !== ''
    && isText(e.mode)
    && isText(e.status)
    && isText(e.started_at)
    && isNumber(e.duration_ms)
    && isText(e.summary)
    && absentOr(isText)(e.verdict);
}

export function isHistory(body) {
  return isRecord(body) && listOf(isHistoryEntry)(body.runs);
}

function isCatalogRequest(r) {
  return isRecord(r)
    && isText(r.id)
    && isText(r.endpoint)
    && absentOr(isText)(r.name)
    && (r.params === undefined || r.params === null || isRecord(r.params))
    && nullableListOf(isRecord)(r.assertions);
}

// A collection with no requests is a nil slice on the server, written as null.
function isCollection(c) {
  return isRecord(c)
    && isText(c.id)
    && isText(c.name)
    && absentOr(isText)(c.description)
    && (c.requests === null || listOf(isCatalogRequest)(c.requests));
}

// An endpoint's method is not checked here: the badge reads only a method
// it recognises and shows any other value as unknown (methodBadge).
function isEndpoint(e) {
  return isRecord(e)
    && isText(e.id)
    && absentOr(isText)(e.label)
    && absentOr(isText)(e.path)
    && nullableListOf(isText)(e.params);
}

export function isCatalog(body) {
  return isRecord(body)
    && listOf(isCollection)(body.collections)
    && nullableListOf(isEndpoint)(body.endpoints)
    && absentOr(isText)(body.target);
}

// isRow is one functional result: a request_result's data, or one row of a
// report's functional.results.
export function isRow(r) {
  return isRecord(r)
    && absentOr(Number.isInteger)(r.index)
    && absentOr(isText)(r.name)
    && absentOr(isText)(r.endpoint)
    && absentOr(isText)(r.query)
    && absentOr(isNumber)(r.status)
    && absentOr((v) => typeof v === 'boolean')(r.passed)
    && absentOr((v) => typeof v === 'boolean')(r.skipped)
    && nullableListOf(isRecord)(r.assertions);
}

const isNullableRecord = (v) => v === undefined || v === null || isRecord(v);

// isStats is one scope of a performance report (internal/report Stats): the
// dashboard reads its blocks as records and its histogram item by item.
function isStats(s) {
  return isRecord(s)
    && isNullableRecord(s.latency)
    && isNullableRecord(s.sla)
    && isNullableRecord(s.apdex)
    && nullableListOf(isRecord)(s.histogram)
    && isNullableRecord(s.status_counts)
    && isNullableRecord(s.error_kinds);
}

// isPerformance is a report's performance block. Every list in it is a Go
// slice, so null where nothing was recorded.
function isPerformance(p) {
  return isRecord(p)
    && absentOr(isText)(p.verdict)
    && nullableListOf(isText)(p.verdict_reasons)
    && isNullableRecord(p.slo)
    && (p.overall === undefined || p.overall === null || isStats(p.overall))
    && nullableListOf(isStats)(p.per_request);
}

// isReport is a run's report, finished or not, as GET /api/runs/{id} serves
// it.
export function isReport(rep) {
  return isRecord(rep)
    && isText(rep.id) && rep.id !== ''
    && RunStatuses.includes(rep.status)
    && absentOr(isText)(rep.mode)
    && absentOr(isText)(rep.started_at)
    && absentOr(isNumber)(rep.duration_ms)
    && isNullableRecord(rep.config)
    && nullableListOf(isRecord)(rep.entries)
    && isNullableRecord(rep.functional)
    && (!rep.functional || (nullableListOf(isRow)(rep.functional.results) && absentOr(isText)(rep.functional.verdict)))
    && (rep.performance === undefined || rep.performance === null || isPerformance(rep.performance));
}

// isSendResult is Send's 200. A result always carries the target's status,
// 0 when it did not answer.
function isSendResult(r) {
  return isRecord(r)
    && isNumber(r.status)
    && absentOr((v) => typeof v === 'boolean')(r.passed)
    && nullableListOf(isRecord)(r.assertions);
}

// How long a request may take before the page stops waiting for it. A read,
// or a cancel, is answered from memory and is slow only when something is
// wrong. Send and Start can sit behind the server's own 10s timeout towards
// the target, so they get twice that before the page decides for itself.
const ReadTimeoutMs = 10000;
const WriteTimeoutMs = 20000;

// call makes one request and reads its whole body, within timeoutMs. It
// answers null when Courier could not be reached, and otherwise the status
// and the parsed body (null for an empty or non-JSON one).
//
// The timeout is an AbortController aborted from a timer, armed until the
// body has been read: an answer whose headers arrive and whose body then
// stalls is as lost as one that never came. AbortSignal.timeout would do the
// same with less code, but it runs on a clock the tests cannot advance.
async function call(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = parse(await res.text());
    return { status: res.status, statusText: res.statusText, ok: res.ok, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const said = (res) => (res.body && res.body.error) || `${res.status} ${res.statusText}`;

// getJSON answers { ok: true, body }, or { ok: false, kind: 'error', status,
// error, body } when the server refused, or the network outcome.
async function getJSON(url) {
  const res = await call(url, { headers: { Accept: 'application/json' } }, ReadTimeoutMs);
  if (!res) return unreachable();
  if (!res.ok) return { ok: false, kind: 'error', status: res.status, error: said(res), body: res.body };
  if (!isRecord(res.body)) return unreachable();
  return { ok: true, body: res.body };
}

// getCollections answers the catalog with a collection's null requests read
// as the empty list they stand for, so nothing that lists a collection has to
// know how Go writes an empty slice.
export async function getCollections() {
  const res = await getJSON('/api/collections');
  if (res.ok && isCatalog(res.body)) {
    res.body.collections = res.body.collections.map((c) => (c.requests === null ? { ...c, requests: [] } : c));
  }
  return res;
}

export function getStatus() {
  return getJSON('/api/status');
}

export function getHistory() {
  return getJSON('/api/runs');
}

export function getRun(id) {
  return getJSON(`/api/runs/${encodeURIComponent(id)}`);
}

// encode answers null for a payload JSON cannot carry, which is the page's
// own fault and must not read as the network's.
function encode(payload) {
  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

const unencodable = () => ({ ok: false, kind: 'error', error: 'the request could not be encoded' });

// A 503 from Send or Start is the server's body gate: too many request bodies
// arrived at once. It is a moment, not a refusal of this request, so it is
// told apart from both, and never retried from here: the visitor presses
// again.
const busyFallback = 'the server is busy; try again in a moment';
const busySaid = (body) => (typeof body.error === 'string' && body.error) || busyFallback;

// startRun answers with a tagged result rather than throwing, because every
// one of its outcomes is a UI state and not an error: 409 with a run_id means
// "offer spectator mode", 409 with a cooldown_until means "start the
// countdown", and 400 means "highlight this field in the editor". The server
// is the authority on run state; the UI never assumes its own optimism was
// right.
export async function startRun(payload) {
  const text = encode(payload);
  if (text === null) return unencodable();
  const res = await call('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  }, WriteTimeoutMs);
  if (!res) return unreachable();
  const body = res.body || {};
  if (res.status === 202) {
    // A 202 that names no run cannot be followed or cancelled: the page
    // learns of the run, if there is one, from status, as it does when the
    // answer is lost altogether.
    if (!isRecord(res.body) || typeof body.run_id !== 'string' || !body.run_id) return unreachable();
    startedHook(body.run_id, payload && payload.mode);
    return { ok: true, runId: body.run_id };
  }
  if (res.status === 409) {
    // Exactly one of the two fields is set; branching on which is present is
    // the documented contract.
    if (body.cooldown_until) return { ok: false, kind: 'cooling', cooldownUntil: body.cooldown_until };
    return { ok: false, kind: 'busy', runId: body.run_id || '' };
  }
  if (res.status === 400) return { ok: false, kind: 'invalid', error: body.error || 'invalid payload', field: body.field || '' };
  // kind 'busy' is taken here by the 409 of a run already live.
  if (res.status === 503) return { ok: false, kind: 'overloaded', error: busySaid(body) };
  return { ok: false, kind: 'error', error: said(res) };
}

export async function cancelRun(id) {
  const res = await call(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }, ReadTimeoutMs);
  if (!res) return unreachable();
  if (res.status === 204) return { ok: true };
  // 404 is "there is nothing there to stop" — an unknown id and a finished id
  // are the same fact from here.
  return { ok: false, gone: res.status === 404, error: said(res) };
}

export async function send(request) {
  const text = encode(request);
  if (text === null) return unencodable();
  const res = await call('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  }, WriteTimeoutMs);
  if (!res) return unreachable();
  const body = res.body || {};
  if (res.ok) return isSendResult(res.body) ? { ok: true, result: body } : unreachable();
  if (res.status === 429) return { ok: false, kind: 'busy', error: body.error || 'another send is in flight' };
  if (res.status === 400) return { ok: false, kind: 'invalid', error: body.error || 'invalid request', field: body.field || '' };
  if (res.status === 503) return { ok: false, kind: 'busy', error: busySaid(body) };
  return { ok: false, kind: 'error', error: said(res) };
}

// ---------------------------------------------------------- live transport

// PollMs is the fallback cadence, and it is the polling contract: GET
// /api/runs/{id} every 500ms while status is "running", stop when it is not.
const PollMs = 500;

// FirstEventMs is how long a stream gets to deliver something before the page
// stops believing in it.
//
// The spec's trigger is "no bytes for 5s", and the server's 2s heartbeat exists
// to satisfy it. EventSource, though, never hands a `: ping` comment to script
// — comments are consumed by the parser — so "no bytes" is not observable from
// here. What is observable is "no events since the stream opened", and that is
// the case this timer is really for: a proxy that buffers the response (the
// Cloudflare tunnel) accepts the connection and then delivers
// nothing, while the server has already replayed run_started into the void. A
// live run always replays at least run_started on connect, so silence at open
// means the bytes are not arriving. Once a single event has landed the timer is
// disarmed for good, because a quiet functional run against a slow target can
// legitimately go far longer than 5s between events and must not be mistaken
// for a dead stream.
const FirstEventMs = 5000;

const LiveEvents = ['run_started', 'request_result', 'progress', 'run_finished'];

// startedHook lets the page tell "a run is live" from "this tab started it":
// it is called with the run's id and mode on this tab's own 202 and on
// nothing else. The alternative — the runner module calling openLive itself —
// would put a second transport owner in the page.
let startedHook = () => {};

export function onRunStarted(fn) {
  startedHook = fn;
}

// openLive attaches to one run and pushes its events at the caller.
//
// EventSource is primary and 500ms polling is the fallback, and the whole point
// of the shape is that the caller cannot tell which one is talking: both paths
// emit the same four event envelopes, so the reducer upstream has one code path
// and every render module has none. The fallback exists because SSE meets the
// Cloudflare tunnel, and a buffering proxy would otherwise kill live results
// outright rather than degrade them.
//
// handlers: { event({type, run_id, data}), transport('sse'|'polling'|'idle'),
// gone() }. gone is the run answering 404: it aged out of the server's history
// or the server restarted, and there is nothing left to follow.
//
// Returns a stop() function. stop.probe() reads the run's report once, now,
// without leaving the stream: it is how a caller that has reason to think the
// run is over finds out, and it ends the attachment if it is.
//
// It opens exactly one EventSource and never lets it reconnect, so the number
// of stream requests a run can cost is the number of times a caller opened it.
export function openLive(runId, handlers) {
  const h = { event: () => {}, transport: () => {}, gone: () => {}, ...handlers };

  let stopped = false;
  let source = null;
  let poller = null;
  let watchdog = null;
  let polling = false;
  let kind = '';

  // Cross-transport memory. A fallback that lands mid-run re-reads the whole
  // report, so without these the polling path would replay run_started and
  // every row the stream had already delivered. Rows are remembered by index,
  // not counted: a stream may deliver one twice, and a count would then skip
  // a row the page never had.
  let started = false;
  const delivered = new Set();

  function announce(next) {
    if (kind === next) return;
    kind = next;
    h.transport(next);
  }

  function emit(event) {
    if (!stopped) h.event(event);
  }

  function disarm() {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    disarm();
    if (source) {
      source.close();
      source = null;
    }
    if (poller !== null) {
      clearInterval(poller);
      poller = null;
    }
    // Saying so is not optional: the idle status poll is gated on the
    // transport (docs/deviations.md N27), so a transport that detaches quietly leaves the
    // page with neither a stream nor a poll.
    kind = 'idle';
    h.transport('idle');
  }

  function finish(event) {
    emit(event);
    // After a run's run_finished the server writes `retry: 60000` and ends the
    // stream, on every path, a stream opened on an already finished run
    // included (docs/deviations.md N38). Closing here, on the terminal event
    // itself, is what makes that end of stream silent: an EventSource left
    // open would report it as an error and, a minute later, reconnect to be
    // told the same thing again.
    stop();
  }

  // ---------------------------------------------------------------- stream

  function openStream() {
    announce('sse');
    source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
    for (const type of LiveEvents) source.addEventListener(type, onFrame);
    // EventSource reports a refused connection, a dropped one, a stream the
    // server ended, and the 503 {"poll":true} over the subscriber cap as the
    // same bare error with no status code. Reaching this handler at all means
    // run_finished has not been seen (the source is closed the moment it is),
    // so the run may still be live and the stream is not carrying it: fall
    // back at once rather than let EventSource retry into a ceiling it cannot
    // see, or wait out the minute the server's `retry:` asks of a reconnect.
    source.onerror = () => fallback('the stream errored or closed');
    watchdog = setTimeout(() => fallback(`no events within ${FirstEventMs}ms`), FirstEventMs);
  }

  function onFrame(e) {
    disarm();
    let envelope;
    try {
      envelope = JSON.parse(e.data);
    } catch {
      // A frame we cannot parse is not a reason to tear the stream down.
      console.warn('unparseable live frame', e.data);
      return;
    }
    // A frame of another run is not this run's news, whatever it says: its
    // run_finished in particular must not end this stream.
    if (!envelope || envelope.run_id !== runId) return;
    // A row of the wrong shape is a frame like the unparseable one above:
    // dropped, and the finished report brings the run's real rows.
    if (envelope.type === 'request_result' && !isRow(envelope.data)) {
      console.warn('live frame is not a result row', runId);
      return;
    }
    if (envelope.type === 'run_started') started = true;
    if (envelope.type === 'request_result') delivered.add(rowKey(envelope.data, delivered.size));
    if (envelope.type === 'run_finished') {
      finish(envelope);
      return;
    }
    emit(envelope);
  }

  // ---------------------------------------------------------------- polling

  function fallback(reason) {
    if (stopped || kind === 'polling') return;
    if (source) {
      source.close();
      source = null;
    }
    disarm();
    console.warn(`live updates degraded (${reason}) - polling ${runId} instead`);
    announce('polling');
    tick(); // no 500ms hole between the stream giving up and the first poll
    poller = setInterval(tick, PollMs);
  }

  async function tick() {
    if (stopped || polling) return;
    polling = true;
    const res = await getRun(runId);
    polling = false;
    if (stopped) return;
    if (res.ok) {
      absorb(res.body);
    } else if (res.status === 404) {
      // 404 is the run having aged out of the history ring, or a server that
      // restarted under us. There is nothing left to follow, and saying so is
      // what keeps the caller from attaching to the same id again.
      console.warn('polled run is gone', runId);
      h.gone();
      stop();
    } else {
      console.warn('run poll failed', res.error);
    }
  }

  // absorb turns a polled report into the events the stream would have sent.
  // This is the seam that makes "both paths feed the same reducer" true rather
  // than aspirational: everything downstream sees run_started, request_result,
  // progress, run_finished, whatever carried them.
  function absorb(rep) {
    // Only this run's report says anything about this run: another run's
    // status: completed must not end it.
    // A report of the wrong shape is a poll that failed: the next tick reads
    // it again.
    if (!isReport(rep) || rep.id !== runId) {
      console.warn('polled answer is not this run\'s report', runId);
      return;
    }
    if (!started) {
      started = true;
      emit({
        type: 'run_started',
        run_id: rep.id,
        data: {
          mode: rep.mode,
          total: (rep.entries || []).length,
          started_at: rep.started_at,
          config: rep.config || {},
          entries: rep.entries || [],
        },
      });
    }

    const rows = (rep.functional && rep.functional.results) || [];
    rows.forEach((row, i) => {
      const key = rowKey(row, i);
      if (delivered.has(key)) return;
      delivered.add(key);
      emit({ type: 'request_result', run_id: rep.id, data: row });
    });

    const overall = rep.performance && rep.performance.overall;
    if (overall) {
      emit({
        type: 'progress',
        run_id: rep.id,
        data: {
          elapsed_ms: rep.duration_ms || elapsedSince(rep.started_at),
          requests: overall.requests || 0,
          errors: overall.errors || 0,
          aborted: overall.aborted || 0,
          rps: overall.requests_per_sec || 0,
          avg_latency_ms: (overall.latency && overall.latency.avg) || 0,
        },
      });
    }

    if (rep.status && rep.status !== 'running') {
      finish({
        type: 'run_finished',
        run_id: rep.id,
        data: {
          status: rep.status,
          duration_ms: rep.duration_ms,
          // A functional run carries a verdict too, on its own block.
          verdict: (rep.performance && rep.performance.verdict) || (rep.functional && rep.functional.verdict) || '',
          // No cooldown_until: the report does not carry one, and the stream's
          // own terminal event may omit it as well. Status is what says when
          // the next run may start, and the caller reads it on every end.
        },
      });
    }
  }

  // probe is one read of the report on top of whatever transport is open.
  // tick already refuses to overlap itself, so a probe during a poll is the
  // poll.
  stop.probe = () => {
    void tick();
  };

  openStream();
  return stop;
}

// rowKey is what makes two deliveries of a row the same row: its index, or
// its position when a row carries none.
function rowKey(row, position) {
  return row && Number.isInteger(row.index) ? row.index : `#${position}`;
}

function elapsedSince(iso) {
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(Date.now() - started, 0);
}
