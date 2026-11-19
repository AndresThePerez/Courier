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

import { requestOf } from './storage.js';

// MaxAssertionText mirrors sandbox.MaxParamValueLen as the validator applies
// it to an assertion's JSON path and string value: counted in characters
// (runes), and refused over it rather than cut.
const MaxAssertionText = 500;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// opsByType is internal/assert's matrix, transcribed. It is the whole
// assertion language — there is no expression syntax — so the editor's
// operator select can simply never offer an operator ValidateAssertion would
// refuse, and a request stored with one is refused here by field.
export const opsByType = {
  status: ['eq', 'neq'],
  latency: ['lt'],
  json: ['eq', 'neq', 'gt', 'lt', 'exists', 'contains', 'count'],
  body_contains: ['contains'],
};

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

// runes counts characters the way the server does (utf8.RuneCountInString):
// a character outside the BMP is one, not the two UTF-16 units of .length.
function runes(s) {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

const isWhole = (n) => Number.isFinite(n) && Math.trunc(n) === n;

// isGoInt mirrors strconv.Atoi: an optional sign and decimal digits, within
// a 64-bit int.
function isGoInt(text) {
  if (!/^[+-]?[0-9]+$/.test(text)) return false;
  const n = BigInt(text);
  return n >= -(2n ** 63n) && n < 2n ** 63n;
}

// pathProblem mirrors parsePath (internal/assert/jsonpath.go):
//   path = "$" *( "." field | "[" int "]" ), field = 1*( any char but "." and "[" )
function pathProblem(path) {
  if (path !== '$' && !path.startsWith('$.') && !path.startsWith('$[')) return 'the path must start with $';
  let rest = path.slice(1);
  while (rest !== '') {
    if (rest[0] === '.') {
      rest = rest.slice(1);
      const dot = rest.indexOf('.');
      const bracket = rest.indexOf('[');
      const ends = [dot, bracket].filter((i) => i >= 0);
      const end = ends.length > 0 ? Math.min(...ends) : rest.length;
      if (end === 0) return 'the path has an empty field name';
      rest = rest.slice(end);
    } else if (rest[0] === '[') {
      const closing = rest.indexOf(']');
      if (closing < 0) return 'the path has an unclosed [';
      if (!isGoInt(rest.slice(1, closing))) return 'the path has a bad array index';
      rest = rest.slice(closing + 1);
    } else {
      return `the path has an unexpected ${JSON.stringify(rest[0])}`;
    }
  }
  return '';
}

// assertionProblem answers what the server would refuse about one built
// assertion, as { part, message } (part names the control: path or value),
// or null. The order is the server's, so the first problem named is the one
// its 400 would name.
export function assertionProblem(a) {
  if (!isPlain(a)) return { part: '', message: 'this assertion cannot be read' };
  const { type, op, path, value } = a;
  const json = type === 'json';

  // internal/sandbox/validate.go validateAssertion: both strings bounded first.
  if (typeof path === 'string' && runes(path) > MaxAssertionText) {
    return { part: 'path', message: `the path is ${runes(path)} characters; the cap is ${MaxAssertionText}` };
  }
  if (typeof value === 'string' && runes(value) > MaxAssertionText) {
    return { part: 'value', message: `the value is ${runes(value)} characters; the cap is ${MaxAssertionText}` };
  }

  // internal/assert/assertion.go ValidateAssertion: a known type and one of
  // its operators, then a json path that is there and parses.
  if (typeof type !== 'string' || !Object.hasOwn(opsByType, type)) {
    return { part: 'type', message: `unknown assertion type ${JSON.stringify(String(type).slice(0, 64))}` };
  }
  if (!opsByType[type].includes(op)) {
    return { part: 'op', message: `operator ${JSON.stringify(String(op).slice(0, 64))} is not valid for a ${type} assertion` };
  }
  if (json) {
    if (typeof path !== 'string' || path === '') return { part: 'path', message: 'JSON path is required' };
    const bad = pathProblem(path);
    if (bad) return { part: 'path', message: bad };
  }

  const number = typeof value === 'number';
  if (type === 'status') {
    if (!number || !Number.isFinite(value)) return { part: 'value', message: 'a status assertion needs a numeric value' };
    if (!(isWhole(value) && value >= 100 && value <= 599)) {
      return { part: 'value', message: 'a status assertion needs a whole number from 100 to 599' };
    }
  } else if (type === 'latency') {
    if (!number || !Number.isFinite(value)) return { part: 'value', message: 'a latency assertion needs a numeric value' };
    if (!(value > 0)) return { part: 'value', message: 'a latency bound must be above 0 ms' };
  } else if (type === 'body_contains') {
    if (typeof value !== 'string') return { part: 'value', message: 'body_contains needs a string value' };
  } else if (json && op !== 'exists') {
    if (op === 'gt' || op === 'lt' || op === 'count') {
      if (!number || !Number.isFinite(value)) return { part: 'value', message: `${op} needs a numeric value` };
      if (op === 'count' && !(isWhole(value) && value >= 0)) {
        return { part: 'value', message: 'count needs a whole number of 0 or more' };
      }
    } else if (!(number && Number.isFinite(value)) && typeof value !== 'string') {
      return { part: 'value', message: `${op} needs a number or a string value` };
    }
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

// sameRequest answers whether two requests are one request as a visitor can
// tell them apart: the same built form, which is the id, the name and every
// field that is sent. Keys nothing reads or shows do not make them differ. Two
// requests that cannot be built or encoded are never the same: answering
// "different" costs at most a copy, answering "same" can cost a version.
//
// Both sides are compared as this browser stores them: a queued copy read
// back after a reload has been through storage.requestOf, which cuts a name
// and a parameter value as the server does, while a saved request may still
// hold the uncut text. Cut on one side only, one request would read as two.
// A value requestOf cannot rebuild is compared as it is.
export function sameRequest(a, b) {
  if (!isPlain(a) || !isPlain(b)) return false;
  try {
    const stored = (r) => requestOf(r) ?? r;
    return JSON.stringify(requestPayload(stored(a))) === JSON.stringify(requestPayload(stored(b)));
  } catch {
    return false;
  }
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
