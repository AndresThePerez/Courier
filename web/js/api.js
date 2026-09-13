// api.js — every fetch call and the live-update transport.
// Nothing else in the frontend calls fetch.

async function readJSON(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await readJSON(res);
  if (!res.ok) {
    const err = new Error((body && body.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export function getCollections() {
  return getJSON('/api/collections');
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

// startRun answers with a tagged result rather than throwing, because every
// one of its outcomes is a UI state and not an error: 409 with a run_id means
// "offer spectator mode", 409 with a cooldown_until means "start the
// countdown", and 400 means "highlight this field in the editor". The server
// is the authority on run state; the UI never assumes its own optimism was
// right.
export async function startRun(payload) {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await readJSON(res)) || {};
  if (res.status === 202) {
    startedHook(body.run_id);
    return { ok: true, runId: body.run_id };
  }
  if (res.status === 409) {
    // Exactly one of the two fields is set; branching on which is present is
    // the documented contract.
    if (body.cooldown_until) return { ok: false, kind: 'cooling', cooldownUntil: body.cooldown_until };
    return { ok: false, kind: 'busy', runId: body.run_id || '' };
  }
  if (res.status === 400) return { ok: false, kind: 'invalid', error: body.error || 'invalid payload', field: body.field || '' };
  return { ok: false, kind: 'error', error: body.error || `${res.status} ${res.statusText}` };
}

export async function cancelRun(id) {
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res.status === 204) return { ok: true };
  const body = (await readJSON(res)) || {};
  // 404 is "there is nothing there to stop" — an unknown id and a finished id
  // are the same fact from here.
  return { ok: false, gone: res.status === 404, error: body.error || `${res.status} ${res.statusText}` };
}

export async function send(request) {
  const res = await fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = (await readJSON(res)) || {};
  if (res.ok) return { ok: true, result: body };
  if (res.status === 429) return { ok: false, kind: 'busy', error: body.error || 'another send is in flight' };
  if (res.status === 400) return { ok: false, kind: 'invalid', error: body.error || 'invalid request', field: body.field || '' };
  return { ok: false, kind: 'error', error: body.error || `${res.status} ${res.statusText}` };
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

// startedHook lets the page tell "a run is live" from "this tab started it".
// Every tab attaches to a live run; only the one that pressed Start follows it
// to the Results tab. The alternative — the runner module calling openLive
// itself — would put a second transport owner in the page.
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
// handlers: { event({type, run_id, data}), transport('sse'|'polling'|'idle') }.
// Returns a stop() function.
export function openLive(runId, handlers) {
  const h = { event: () => {}, transport: () => {}, ...handlers };

  let stopped = false;
  let source = null;
  let poller = null;
  let watchdog = null;
  let polling = false;
  let kind = '';

  // Cross-transport memory. A fallback that lands mid-run re-reads the whole
  // report, so without these the polling path would replay run_started and
  // every row the stream had already delivered.
  let started = false;
  let delivered = 0;

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
    // transport (NOTE.md N27), so a transport that detaches quietly leaves the
    // page with neither a stream nor a poll.
    kind = 'idle';
    h.transport('idle');
  }

  function finish(event) {
    emit(event);
    // The server holds the stream open after run_finished on purpose — closing
    // it would make EventSource reconnect and replay the terminal event
    // forever (N22). Closing it is the client's job, and this is it.
    stop();
  }

  // ---------------------------------------------------------------- stream

  function openStream() {
    announce('sse');
    source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
    for (const type of LiveEvents) source.addEventListener(type, onFrame);
    // EventSource reports a refused connection, a dropped one, a mid-flight
    // reconnect, and the 503 {"poll":true} over the subscriber cap as the same
    // bare error with no status code. They all mean the same thing here: this
    // run is still live and the stream is not carrying it, so fall back rather
    // than let EventSource retry into a ceiling it cannot see.
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
    if (envelope.type === 'run_started') started = true;
    if (envelope.type === 'request_result') delivered += 1;
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
    try {
      absorb(await getRun(runId));
    } catch (err) {
      // 404 is the run having aged out of the history ring, or a server that
      // restarted under us. There is nothing left to follow; the idle status
      // poll takes over the moment this transport says it is gone.
      if (err.status === 404) {
        console.warn('polled run is gone', runId);
        stop();
      } else {
        console.warn('run poll failed', err);
      }
    } finally {
      polling = false;
    }
  }

  // absorb turns a polled report into the events the stream would have sent.
  // This is the seam that makes "both paths feed the same reducer" true rather
  // than aspirational: everything downstream sees run_started, request_result,
  // progress, run_finished, whatever carried them.
  function absorb(rep) {
    if (!rep) return;
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
    for (let i = delivered; i < rows.length; i += 1) {
      emit({ type: 'request_result', run_id: rep.id, data: rows[i] });
    }
    delivered = Math.max(delivered, rows.length);

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
          verdict: (rep.performance && rep.performance.verdict) || '',
          // The polled report does not carry one; the status poll this
          // transport hands back to reads the authoritative value.
          cooldown_until: '',
        },
      });
    }
  }

  openStream();
  return stop;
}

function elapsedSince(iso) {
  const started = new Date(iso).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(Date.now() - started, 0);
}
