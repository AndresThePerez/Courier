// api.js — every fetch call and (from Task 18) the live-update transport.
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
  if (res.status === 202) return { ok: true, runId: body.run_id };
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

// openLive is the live-update transport seam: it attaches to one run and
// pushes its events at the caller. Task 18 fills it in with the streaming
// transport plus the polling fallback; declaring it here means every render
// module is written against a stable shape from the start.
//
// Returns a stop() function.
export function openLive(runId, handlers) {
  console.warn('live transport not installed yet', runId, handlers);
  return () => {};
}
