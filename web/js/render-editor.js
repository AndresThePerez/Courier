// render-editor.js — the request editor: name, endpoint, the allowlisted param
// table, the assertion builder, and Send.
//
// Two rules shape this file. The first is that the param key is a <select> fed
// from the server's own allowlist (`/api/collections` -> endpoints[].params)
// and never from a list typed in here: the sandbox is the security boundary,
// and a second copy of it in the frontend is a second copy to keep in sync.
// The second is that the curated tree is read-only — the first edit of a
// built-in request forks it into My Workspace and reselects the copy.

import { get, set, deepCopy } from './store.js';
import { el, replace, byId, fmtMs, fmtBytes } from './dom.js';
import * as api from './api.js';
import * as workspace from './workspace.js';

// MaxAssertions mirrors sandbox.MaxAssertions. The server enforces it either
// way; matching it here means a visitor meets the cap as a disabled button and
// a sentence, rather than as a 400 after they have already written row 21.
const MaxAssertions = 20;

// opsByType is internal/assert's matrix, transcribed. It is the whole
// assertion language — there is no expression syntax — so the op select can
// simply never offer an operator ValidateAssertion would refuse.
const opsByType = {
  status: ['eq', 'neq'],
  latency: ['lt'],
  json: ['eq', 'neq', 'gt', 'lt', 'exists', 'contains', 'count'],
  body_contains: ['contains'],
};

const assertionTypes = Object.keys(opsByType);

// Module-local render memory. None of this is application state: it is what
// the editor has last painted, so a notify from an unrelated part of the app
// (the 3s status poll, say) does not rebuild a table under the visitor's
// cursor or repaint a 16KB response body for nothing.
let lastDraft = null;
let lastSignature = '';
let lastSend = null;
let endpointsPainted = 0;
let paramNote = '';
let forkNote = '';
let saveNote = '';

export function init() {
  byId('editor-name').addEventListener('input', (e) => {
    const name = e.target.value;
    edit((draft) => { draft.name = name; });
  });

  byId('endpoint-select').addEventListener('change', (e) => changeEndpoint(e.target.value));
  byId('add-param').addEventListener('click', addParam);
  byId('add-assertion').addEventListener('click', addAssertion);
  byId('send-request').addEventListener('click', sendDraft);
  byId('save-request').addEventListener('click', saveDraft);
}

// onSelect is main.js's sidebar hook. Picking a request drops the previous
// one's notes and its last response: nothing on screen should belong to a
// request that is no longer open.
export function onSelect() {
  paramNote = '';
  forkNote = '';
  saveNote = '';
  set({ send: null });
}

// ---------------------------------------------------------------- fork-on-write

// own returns the draft the editor is allowed to write to. The first write to
// anything that is not already a workspace request deep-copies it into My
// Workspace under a fresh id, so the collections every visitor shares stay
// exactly as the server shipped them.
//
// It deliberately does not notify: the caller mutates the object it gets back
// and then publishes it in one set(), so no render ever paints a draft that is
// half-way through an edit.
function own() {
  const draft = get().draft;
  if (!draft) return null;
  if (workspace.isWorkspaceId(draft.id)) return draft;

  const forked = deepCopy(workspace.fork(draft));
  forkNote = `Copied to My Workspace as "${forked.name}" - the built-in request is untouched.`;
  saveNote = '';
  return forked;
}

// edit is the only way this module changes the draft: fork if needed, mutate,
// then hand the whole thing back through set() so every render module sees it.
function edit(mutate) {
  const draft = own();
  if (!draft) return;
  mutate(draft);
  set({ draft, selectedId: draft.id });
}

function saveDraft() {
  const draft = own();
  if (!draft) return;
  workspace.save(draft);
  saveNote = `Saved "${draft.name || draft.id}" to My Workspace.`;
  set({ draft, selectedId: draft.id });
}

// ---------------------------------------------------------------- endpoints

function endpointById(id) {
  return get().endpoints.find((e) => e.id === id) || null;
}

// allowedParams is the server's allowlist for one endpoint. `healthz` accepts
// nothing at all and serializes its params as null, which is why this never
// assumes an array came back.
function allowedParams(id) {
  const ep = endpointById(id);
  return (ep && ep.params) || [];
}

function changeEndpoint(id) {
  const draft = get().draft;
  if (!draft) return;
  const allowed = allowedParams(id);
  const dropped = Object.keys(draft.params || {}).filter((key) => !allowed.includes(key));
  const ep = endpointById(id);

  paramNote = dropped.length
    ? `Dropped ${dropped.join(', ')} - ${ep ? ep.label : id} does not accept ${dropped.length === 1 ? 'it' : 'them'}.`
    : '';

  edit((d) => {
    const kept = {};
    for (const [key, value] of Object.entries(d.params || {})) {
      if (allowed.includes(key)) kept[key] = value;
    }
    d.endpoint = id;
    d.params = kept;
  });
}

function addParam() {
  const draft = get().draft;
  if (!draft) return;
  const used = Object.keys(draft.params || {});
  const next = allowedParams(draft.endpoint).find((p) => !used.includes(p));
  if (!next) return;
  paramNote = '';
  edit((d) => { d.params = { ...(d.params || {}), [next]: '' }; });
}

// renameParam rewrites one key in place. Params are a JSON object, so their
// order is their insertion order — rebuilding the whole object is what keeps a
// renamed key from jumping to the bottom of the table under the cursor.
function renameParam(params, from, to) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === from) out[to] = value;
    else out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------- assertions

function addAssertion() {
  const draft = get().draft;
  if (!draft || (draft.assertions || []).length >= MaxAssertions) return;
  edit((d) => {
    d.assertions = [...(d.assertions || []), { type: 'status', op: 'eq', value: 200 }];
  });
}

// valueKind is ValidateAssertion's value rule read back out: which kind of
// value each (type, op) pair accepts. "none" is `json exists`, whose value the
// evaluator ignores entirely.
function valueKind(a) {
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
// in a numeric slot is passed through untouched, so the 400 that comes back
// names the row instead of the editor quietly inventing a zero.
function coerceValue(a, text) {
  if (valueKind(a) === 'none') return undefined;
  if (valueKind(a) === 'string') return text;
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) ? n : text;
}

function valueText(a) {
  if (a.value === undefined || a.value === null) return '';
  return String(a.value);
}

// ---------------------------------------------------------------- send

async function sendDraft() {
  const state = get();
  if (!state.draft || (state.send && state.send.pending)) return;

  set({ send: { pending: true } });
  const outcome = await api.send(payloadOf(state.draft));
  if (outcome.ok) set({ send: { pending: false, result: outcome.result } });
  else set({ send: { pending: false, kind: outcome.kind, error: outcome.error, field: outcome.field || '' } });
}

// payloadOf strips the editor's bookkeeping down to the sandbox.Request the
// server validates. Note what is absent: there is no URL here and there never
// will be — the client names an endpoint and the catalog owns the path.
function payloadOf(draft) {
  return {
    id: draft.id,
    name: draft.name || '',
    endpoint: draft.endpoint,
    params: { ...(draft.params || {}) },
    assertions: (draft.assertions || []).map((a) => {
      const row = { type: a.type, op: a.op };
      if (a.type === 'json') row.path = a.path || '$';
      if (valueKind(a) !== 'none') row.value = a.value === undefined ? '' : a.value;
      return row;
    }),
  };
}

// ---------------------------------------------------------------- render

export function render(state) {
  const draft = state.draft;
  byId('editor-empty').hidden = Boolean(draft);
  byId('editor-form').hidden = !draft;
  if (!draft) {
    lastDraft = null;
    lastSignature = '';
    return;
  }

  renderEndpoints(state, draft);
  renderName(draft);
  renderOrigin(draft);

  const sig = signature(draft);
  if (draft !== lastDraft || sig !== lastSignature) {
    renderParams(draft);
    renderAssertions(draft);
    lastDraft = draft;
    lastSignature = sig;
  }

  renderNotes(draft);
  renderSend(state);
}

// signature covers everything that changes the *shape* of the two tables — the
// rows themselves, not what is typed into them. Value inputs are left alone
// between structural changes, because rebuilding one under a visitor mid-word
// throws away their caret.
function signature(draft) {
  const params = Object.keys(draft.params || {}).join(',');
  const asserts = (draft.assertions || []).map((a) => `${a.type}:${a.op}`).join('|');
  return `${draft.id}::${draft.endpoint}::${params}::${asserts}`;
}

function renderEndpoints(state, draft) {
  const select = byId('endpoint-select');
  if (state.endpoints.length !== endpointsPainted) {
    replace(select, state.endpoints.map((e) => el('option', {
      text: `${e.label} - ${e.method} ${e.path}`,
      attrs: { value: e.id },
    })));
    endpointsPainted = state.endpoints.length;
  }
  if (select.value !== draft.endpoint) select.value = draft.endpoint;
}

function renderName(draft) {
  const input = byId('editor-name');
  const name = draft.name || '';
  // Never write over the field the visitor is typing into: assigning a value
  // moves the caret to the end, and their own keystroke is what put that value
  // into state a moment ago anyway.
  if (input.value !== name && document.activeElement !== input) input.value = name;
}

function renderOrigin(draft) {
  const badge = byId('editor-origin');
  const text = workspace.isWorkspaceId(draft.id) ? 'my workspace' : 'built-in - editing copies it';
  if (badge.textContent !== text) badge.textContent = text;
}

function renderNotes(draft) {
  const note = byId('editor-note');
  const text = saveNote || forkNote;
  note.hidden = !text;
  if (note.textContent !== text) note.textContent = text;

  const pn = byId('param-note');
  pn.hidden = !paramNote;
  if (pn.textContent !== paramNote) pn.textContent = paramNote;

  const an = byId('assertion-note');
  const capped = (draft.assertions || []).length >= MaxAssertions
    ? `${MaxAssertions} assertions is the cap - the server refuses a request carrying more.`
    : '';
  an.hidden = !capped;
  if (an.textContent !== capped) an.textContent = capped;
}

// ---------------------------------------------------------------- param table

function renderParams(draft) {
  const rows = byId('param-rows');
  const focus = captureFocus();
  const allowed = allowedParams(draft.endpoint);
  const entries = Object.entries(draft.params || {});
  const ep = endpointById(draft.endpoint);

  byId('add-param').disabled = allowed.length === 0 || entries.length >= allowed.length;

  if (allowed.length === 0) {
    // The sandbox made visible: healthz takes nothing, so the table is empty
    // and Add is dead rather than offering a key the server would refuse.
    replace(rows, [el('div', {
      class: 'rows-empty',
      text: `${ep ? ep.label : draft.endpoint} takes no query parameters.`,
    })]);
  } else if (entries.length === 0) {
    replace(rows, [el('div', {
      class: 'rows-empty',
      text: `No parameters. This endpoint allows ${allowed.length}: ${allowed.join(', ')}.`,
    })]);
  } else {
    const used = entries.map(([key]) => key);
    replace(rows, entries.map(([key, value], i) => paramRow(key, value, i, allowed, used)));
  }
  restoreFocus(focus);
}

function paramRow(key, value, index, allowed, used) {
  // Every allowlisted key is offered; the ones already in the table are
  // disabled rather than hidden, because params are an object and two rows
  // sharing a key would silently collapse into one.
  const keySelect = el('select', {
    class: 'param-key mono',
    attrs: { 'data-focus-key': `param-key:${index}`, 'aria-label': 'Parameter name' },
    on: {
      change: (e) => {
        const next = e.target.value;
        edit((d) => { d.params = renameParam(d.params || {}, key, next); });
      },
    },
  }, allowed.map((name) => el('option', {
    text: name,
    attrs: { value: name, selected: name === key, disabled: name !== key && used.includes(name) },
  })));
  keySelect.value = key;

  return el('div', { class: 'row param-row' }, [
    keySelect,
    el('input', {
      class: 'param-value mono',
      type: 'text',
      attrs: {
        value,
        maxlength: 500,
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'value',
        'aria-label': `Value for ${key}`,
        'data-focus-key': `param-value:${index}`,
      },
      on: {
        input: (e) => {
          const text = e.target.value;
          edit((d) => { d.params = { ...(d.params || {}), [key]: text }; });
        },
      },
    }),
    el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: 'x',
      title: `Remove ${key}`,
      on: {
        click: () => {
          paramNote = '';
          edit((d) => {
            const next = { ...(d.params || {}) };
            delete next[key];
            d.params = next;
          });
        },
      },
    }),
  ]);
}

// ------------------------------------------------------------ assertion table

function renderAssertions(draft) {
  const rows = byId('assertion-rows');
  const focus = captureFocus();
  const list = draft.assertions || [];

  byId('add-assertion').disabled = list.length >= MaxAssertions;

  if (list.length === 0) {
    replace(rows, [el('div', {
      class: 'rows-empty',
      text: 'No assertions. A request with none is a plain probe - it passes as long as the response arrives.',
    })]);
  } else {
    replace(rows, list.map((a, i) => assertionRow(a, i)));
  }
  restoreFocus(focus);
}

function assertionRow(a, index) {
  const kind = valueKind(a);

  const typeSelect = el('select', {
    class: 'assert-type',
    attrs: { 'data-focus-key': `assert-type:${index}`, 'aria-label': 'Assertion type' },
    on: { change: (e) => changeAssertionType(index, e.target.value) },
  }, assertionTypes.map((t) => el('option', { text: t, attrs: { value: t, selected: t === a.type } })));
  typeSelect.value = a.type;

  const opSelect = el('select', {
    class: 'assert-op',
    attrs: { 'data-focus-key': `assert-op:${index}`, 'aria-label': 'Operator' },
    on: { change: (e) => { const op = e.target.value; edit((d) => { d.assertions[index].op = op; }); } },
  }, (opsByType[a.type] || []).map((op) => el('option', { text: op, attrs: { value: op, selected: op === a.op } })));
  opSelect.value = a.op;

  const children = [typeSelect];

  // The path field belongs to json assertions and to nothing else: the
  // validator rejects a path on any other type outright.
  if (a.type === 'json') {
    children.push(el('input', {
      class: 'assert-path mono',
      type: 'text',
      attrs: {
        value: a.path || '',
        placeholder: '$.total',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': 'JSON path',
        'data-focus-key': `assert-path:${index}`,
      },
      on: { input: (e) => { const p = e.target.value; edit((d) => { d.assertions[index].path = p; }); } },
    }));
  }

  children.push(opSelect);

  if (kind === 'none') {
    children.push(el('span', { class: 'assert-value muted', text: 'no value needed' }));
  } else {
    children.push(el('input', {
      class: 'assert-value mono',
      type: 'text',
      attrs: {
        value: valueText(a),
        placeholder: kind === 'number' ? 'number' : 'value',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': 'Expected value',
        'data-focus-key': `assert-value:${index}`,
      },
      on: {
        input: (e) => {
          const text = e.target.value;
          edit((d) => { d.assertions[index].value = coerceValue(d.assertions[index], text); });
        },
      },
    }));
  }

  children.push(el('button', {
    class: 'btn btn-mini',
    type: 'button',
    text: 'x',
    title: 'Remove this assertion',
    on: { click: () => edit((d) => { d.assertions = d.assertions.filter((_, i) => i !== index); }) },
  }));

  return el('div', { class: 'row assert-row' }, children);
}

// changeAssertionType keeps the row valid across the switch: an op the new type
// does not accept snaps to that type's first op, the path is added or dropped
// to match, and the value is re-coerced into the new slot's kind.
function changeAssertionType(index, type) {
  edit((d) => {
    const a = d.assertions[index];
    a.type = type;
    if (!(opsByType[type] || []).includes(a.op)) a.op = opsByType[type][0];
    if (type === 'json') {
      if (!a.path) a.path = '$';
    } else {
      delete a.path;
    }
    a.value = coerceValue(a, valueText(a));
  });
}

// ---------------------------------------------------------------- focus

// Rebuilding a table throws away whatever the visitor had focused, which is
// jarring at best and drops a keystroke at worst — the first edit of a curated
// request rebuilds both tables, because forking it changes its id. These two
// carry the focused element and its caret across a rebuild by a stable key.
function captureFocus() {
  const node = document.activeElement;
  if (!node || !node.dataset || !node.dataset.focusKey) return null;
  const out = { key: node.dataset.focusKey, start: null, end: null };
  try {
    out.start = node.selectionStart;
    out.end = node.selectionEnd;
  } catch {
    // selectionStart throws on controls that have no text selection.
  }
  return out;
}

function restoreFocus(focus) {
  if (!focus) return;
  const node = document.querySelector(`[data-focus-key="${focus.key}"]`);
  if (!node || node === document.activeElement) return;
  node.focus();
  if (focus.start === null || focus.start === undefined) return;
  try {
    node.setSelectionRange(focus.start, focus.end);
  } catch {
    /* nothing to restore */
  }
}

// ---------------------------------------------------------------- response

function renderSend(state) {
  const send = state.send;
  if (send === lastSend) return;
  lastSend = send;

  const status = byId('send-status');
  const box = byId('send-response');
  byId('send-request').disabled = Boolean(send && send.pending);

  if (!send) {
    status.textContent = '';
    status.className = 'send-status';
    replace(box, []);
    return;
  }
  if (send.pending) {
    status.textContent = 'Sending...';
    status.className = 'send-status muted';
    return;
  }
  if (!send.result) {
    // 429 is a rate limit; 400 is the sandbox refusing the request before it
    // could reach the target. Both are answers, not failures of the page, and
    // the 400 is where a visitor learns the allowlist is real.
    status.textContent = send.kind === 'busy' ? `Busy - ${send.error}` : `Refused - ${send.error}`;
    status.className = 'send-status fail';
    replace(box, [el('p', {
      class: 'note',
      text: send.kind === 'invalid' && send.field
        ? `Courier validated this request before dispatching it and rejected "${send.field}". Nothing reached the target.`
        : 'Nothing reached the target.',
    })]);
    return;
  }

  const r = send.result;
  const outcomes = r.assertions || [];
  const passed = outcomes.filter((o) => o.passed).length;
  const bits = [
    r.status ? String(r.status) : 'no response',
    fmtMs(r.latency_ms),
    fmtBytes(r.size_bytes),
  ];
  if (outcomes.length > 0) bits.push(`${passed}/${outcomes.length} assertions passed`);
  if (r.body_truncated) bits.push('truncated at 16KB');
  status.textContent = bits.join(' - ');
  status.className = `send-status ${r.passed ? 'pass' : 'fail'}`;

  // The server hands back the endpoint id and an already-`?`-prefixed query
  // string; the catalog is what turns the id back into the path it resolved to.
  const ep = endpointById(r.endpoint);
  replace(box, [
    el('p', { class: 'note mono', text: `GET ${ep ? ep.path : r.endpoint}${r.query || ''}` }),
    r.error && el('p', {
      class: 'note fail',
      text: `${r.error_kind ? `${r.error_kind}: ` : ''}${r.error}`,
    }),
    outcomes.length > 0 && el('div', { class: 'outcomes' }, outcomes.map(outcomeRow)),
    el('h4', { class: 'block-heading', text: 'Response body' }),
    el('pre', { class: 'body-pre mono', text: prettyBody(r.body) }),
  ]);
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

// prettyBody re-indents a JSON body and leaves anything else exactly as it
// arrived. The body is target output, so it goes in through textContent on a
// <pre> and nowhere near inner-HTML.
function prettyBody(body) {
  if (!body) return '(empty body)';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // A truncated body is perfectly good text and invalid JSON; showing it raw
    // is more useful than a parse error about a cut Courier made itself.
    return body;
  }
}
