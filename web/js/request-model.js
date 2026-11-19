// request-model.js — what a request is on the wire, built in one place for
// Send and for a run, and the server's own refusals of it, checked before it
// leaves.
//
// Send and Start must put the same request on the wire: a request one of them
// sends and the other has refused is a request the visitor cannot reason
// about. So there is one builder, and it rewrites nothing.
//
// The checks here refuse exactly what internal/sandbox and internal/assert
// refuse, and nothing they accept: the server stays the authority, and a rule
// the page invented would be a request the visitor cannot send for no reason
// the server would give.

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// valueKind is ValidateAssertion's value rule read back out: which kind of
// value each (type, op) pair accepts. "none" is `json exists`, whose value the
// evaluator ignores entirely.
export function valueKind(a) {
  if (a.type === 'status' || a.type === 'latency') return 'number';
  if (a.type === 'body_contains') return 'string';
  if (a.op === 'exists') return 'none';
  if (a.op === 'gt' || a.op === 'lt' || a.op === 'count') return 'number';
  return 'either';
}

// coerceValue turns what was typed into what the wire format needs. Where the
// server accepts either a number or a string, anything that parses as a number
// is sent as one — that is how the curated collections are written
// (`"value": 107`, `"value": "Charizard"`), and it is what makes
// `$.total eq 107` work without a type picker on every row. The cost is that
// the *string* "107" cannot be expressed; the outcome then says so in plain
// words ("cannot compare it to a number") rather than failing silently. Text
// in a numeric slot is kept as typed, so the check below names the row
// instead of the editor quietly inventing a zero.
export function coerceValue(a, text) {
  if (valueKind(a) === 'none') return undefined;
  if (valueKind(a) === 'string') return text;
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) ? n : text;
}

// textOf is how a stored value is shown in a field: text and numbers as
// themselves, anything else (a value an older build or another script stored)
// as nothing, never as a rendering of its structure.
export function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

// ---------------------------------------------------------------- the payload

// requestPayload is the sandbox.Request the server validates, built from any
// request the page holds: the five request fields and the four assertion
// fields, nothing else at any level. There is no URL here and there never will
// be — the client names an endpoint and the catalog owns the path. Nothing is
// rewritten: a path the visitor left empty is sent empty, and refused, rather
// than turned into one they did not write.
export function requestPayload(r) {
  return {
    id: r.id,
    name: r.name || '',
    endpoint: r.endpoint,
    params: isPlain(r.params) ? { ...r.params } : {},
    assertions: Array.isArray(r.assertions) ? r.assertions.map(assertionPayload) : r.assertions,
  };
}

function assertionPayload(a) {
  if (!isPlain(a)) return a;
  const row = { type: a.type, op: a.op };
  if (a.type === 'json') row.path = a.path;
  if (valueKind(a) !== 'none' && a.value !== undefined) row.value = a.value;
  return row;
}

// runPayload is POST /api/runs: the checked requests in order, and options
// that are the run settings' own whole numbers.
export function runPayload(mode, requests, options) {
  return {
    mode,
    sequence: requests.map(requestPayload),
    options: {
      stop_on_failure: options.stop_on_failure === true,
      delay_ms: options.delay_ms,
      concurrency: options.concurrency,
      duration_secs: options.duration_secs,
    },
  };
}

// ---------------------------------------------------------------- the checks

// assertionProblem answers what the server would refuse about one built
// assertion, as { part, message } (part names the control: path or value),
// or null.
export function assertionProblem(a) {
  if (!isPlain(a)) return null;
  // internal/assert/assertion.go ValidateAssertion: a json assertion
  // requires a path.
  if (a.type === 'json' && (typeof a.path !== 'string' || a.path === '')) {
    return { part: 'path', message: 'JSON path is required' };
  }
  return null;
}

// requestProblem answers the first thing the server would refuse in a built
// request, as { field, assertion, part, message } with field in the server's
// own notation ("assertions[2]"), or null.
export function requestProblem(payload) {
  const list = payload.assertions;
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) return { field: 'assertions', assertion: null, part: '', message: 'the assertions are not a list' };
  for (let j = 0; j < list.length; j += 1) {
    const problem = assertionProblem(list[j]);
    if (problem) return { field: `assertions[${j}]`, assertion: j, ...problem };
  }
  return null;
}

// runProblem is requestProblem over a run payload's sequence, with the field
// under its sequence index, the way the server scopes it.
export function runProblem(payload) {
  for (let i = 0; i < payload.sequence.length; i += 1) {
    const problem = requestProblem(payload.sequence[i]);
    if (problem) return { ...problem, field: `sequence[${i}].${problem.field}` };
  }
  return null;
}

// isQueueable answers whether a request may join the run: whether its built
// form passes every check above.
export function isQueueable(request) {
  return isPlain(request) && requestProblem(requestPayload(request)) === null;
}

// ---------------------------------------------------------------- refusals

// whereIn reads the part of a refused field below one request ("endpoint",
// "params.q", "assertions[0].value", ...) as what a visitor calls it, with
// the assertion it points at. Numbering is from 1. A part this does not know
// answers null: its raw name is shown as it came, never relabelled.
export function whereIn(rest) {
  if (rest === '') return { label: '', assertion: null, part: '' };
  if (rest === 'endpoint') return { label: 'endpoint', assertion: null, part: '' };
  if (rest === 'params') return { label: 'parameters', assertion: null, part: '' };
  if (rest === 'assertions') return { label: 'assertions', assertion: null, part: '' };
  if (rest === 'name') return { label: 'name', assertion: null, part: '' };
  if (rest === 'id') return { label: 'id', assertion: null, part: '' };
  const param = /^params\.(.+)$/s.exec(rest);
  if (param) return { label: `parameter ${JSON.stringify(param[1])}`, assertion: null, part: '' };
  const assertion = /^assertions\[(\d+)\](?:\.(path|value|type|op)(?:[.[].*)?)?$/s.exec(rest);
  if (assertion) {
    const j = Number(assertion[1]);
    return { label: `assertion ${j + 1}`, assertion: j, part: assertion[2] || '' };
  }
  return null;
}

// RunFields are the run-level fields a refusal can name, as a visitor reads
// them.
const RunFields = {
  mode: 'run mode',
  sequence: 'run sequence',
  options: 'run options',
  'options.stop_on_failure': 'stop on first failure',
  'options.delay_ms': 'delay',
  'options.concurrency': 'concurrency',
  'options.duration_secs': 'duration',
};

// runField reads a refused run field: { index, where } for a field inside one
// request of the sequence (index is the payload's), { label } for a run-level
// one, or null for one this does not know.
export function runField(field) {
  if (typeof field !== 'string') return null;
  if (field === '' || field === 'body') return { label: '' };
  if (Object.hasOwn(RunFields, field)) return { label: RunFields[field] };
  const m = /^sequence\[(\d+)\](?:\.(.*))?$/s.exec(field);
  if (!m) return null;
  const where = whereIn(m[2] === undefined ? '' : m[2]);
  return where ? { index: Number(m[1]), where } : null;
}

export const capitalized = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

// refusedText is the one sentence a refusal reads as: "Refused - " and where,
// once, then the server's message.
export function refusedText(where, message) {
  return where ? `Refused - ${where}: ${message}` : `Refused - ${message}`;
}

// ---------------------------------------------------------------- run settings

// shownNumber is a parsed number as a sentence can print it, or '' for one too
// large or small to read back as typed digits.
const shownNumber = (n) => (Number.isFinite(n) && Math.abs(n) < 1e15 ? String(n) : '');

const clip = (text) => (text.length > 40 ? `${text.slice(0, 40)}...` : text);

// clampSetting reads what was typed into a run setting the way the run will
// use it, and says so whenever that is not what was typed: { value, note }.
// It parses with Number(), so 1e2 is 100 and "10 workers" is not a number,
// takes the whole part of a fraction, and then applies the server's own
// clamp (sandbox.clampOptions): under the floor falls back to the default,
// over the cap is pulled down to the cap. value is always a whole number
// within limits; note is '' when the value is the one typed. badInput is a
// number field's own report that what is in it is not a number.
export function clampSetting({ lo, hi, fallback }, typed, badInput = false) {
  const text = String(typed).trim();
  const fallbackNote = `the run will use the default, ${fallback}.`;
  if (badInput) return { value: fallback, note: `That is not a number - ${fallbackNote}` };
  if (text === '') return { value: fallback, note: `Empty - ${fallbackNote}` };
  const n = Number(text);
  if (Number.isNaN(n)) return { value: fallback, note: `${JSON.stringify(clip(text))} is not a number - ${fallbackNote}` };
  const whole = Math.trunc(n) + 0;
  const reads = shownNumber(n) && shownNumber(n) !== text ? `${clip(text)} is ${shownNumber(n)}` : clip(text);
  if (whole < lo) return { value: fallback, note: `${clip(text)} is under the floor of ${lo} - ${fallbackNote}` };
  if (whole > hi) {
    const over = reads === clip(text) ? `${reads} is over` : `${reads}, over`;
    return { value: hi, note: `${over} the cap of ${hi} - the run will use ${hi}.` };
  }
  if (whole !== n) return { value: whole, note: `${clip(text)} is not a whole number - the run will use ${whole}.` };
  if (String(whole) !== text) return { value: whole, note: `${reads} - the run will use ${whole}.` };
  return { value: whole, note: '' };
}
