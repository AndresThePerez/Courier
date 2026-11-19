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
import { jsonView } from './json-view.js';
import * as api from './api.js';
import * as workspace from './workspace.js';
import * as runner from './render-runner.js';
import {
  opsByType, valueKind, coerceValue, textOf, requestPayload, requestProblem, assertionProblem, whereIn, refusedText,
  capitalized, sameRequest, cutText,
} from './request-model.js';

// MaxAssertions mirrors sandbox.MaxAssertions. The server enforces it either
// way; matching it here means a visitor meets the cap as a disabled button and
// a sentence, rather than as a 400 after they have already written row 21.
const MaxAssertions = 20;

const assertionTypes = Object.keys(opsByType);

// Module-local render memory. None of this is application state: it is what
// the editor has last painted, so a notify from an unrelated part of the app
// (the 3s status poll, say) does not rebuild a table under the visitor's
// cursor or repaint a 256KB response body for nothing.
let lastDraft = null;
let lastSignature = '';
let lastSend = null;
let lastSendEndpoints = null;
let lastTableEndpoints = null;
let endpointsPainted = null;
let pickerPainted = null;
let paramNote = '';
let forkNote = '';
let saveNote = '';
// writeRefused is whether this browser refused the last write of the open
// request, so no sentence claims the draft was kept when it was not.
let writeRefused = false;
// saveRefusal is the problem a refused Save named, for the request it was
// refused for: { id, assertion, part, message }. An edit takes it away.
let saveRefusal = null;

// linked is the queued entry the open request was opened from by its row's
// Edit, { key, id }: Save puts the request back into that entry. It holds only
// while that request is the one open.
let linked = null;

// outbound is the Send that is out: which request it was made for, and the
// pending marker it put in state. An answer is shown only under the request
// it was asked for, so it is checked against this when it lands.
let outbound = null; // { id, marker }

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
  writeRefused = false;
  saveRefusal = null;
  linked = null;
  outbound = null;
  set({ send: null });
}

// openQueued is a queued row's Edit: it opens the request that entry holds, as
// it was queued, and links the two so Save can put the fix back into that
// entry. Keystrokes are stored as they are typed, so the first keystroke
// writes whatever opens over the saved original. While that original is the
// same request, it is the original itself that opens: the queued copy may
// have been cut by the stored run setup (a long name or parameter value), and
// writing it back would cut the saved request without a word. A queued
// request with no saved original to write to (a built-in one, one deleted
// since, or one changed since) is first copied into My Workspace, and the
// entry is pointed at the copy, so the run and the editor hold the same
// request from then on.
//
// The entry already open through Edit is left as it is: its saved request now
// holds the visitor's unsaved keystrokes, so opening it again would copy it
// and drop what they typed.
export function openQueued(key) {
  const entry = runner.queuedEntry(key);
  if (!entry || !isPlainRequest(entry.request)) return;
  if (linkedKey(get().draft) === key) return;
  onSelect();
  let request;
  try {
    request = deepCopy(entry.request);
  } catch (error) {
    console.warn('queued request not opened', error);
    return;
  }
  const saved = get().workspace.find((r) => r.id === request.id);
  if (!workspace.isWorkspaceId(request.id) || !saved || !sameRequest(saved, request)) {
    const forked = workspace.fork(request);
    request = deepCopy(forked.request);
    runner.repoint(key, request, { fixed: false });
    forkNote = copiedForRun(request.name);
    writeRefused = !forked.ok;
    if (!forked.ok) saveNote = workspace.WRITE_REFUSED;
  } else {
    try {
      request = deepCopy(saved);
    } catch (error) {
      console.warn('queued request not opened', error);
      return;
    }
  }
  linked = { key, id: request.id };
  set({ selectedId: request.id, draft: request, editorNotice: '' });
}

// copiedForRun is the note for a queued request copied into My Workspace. The
// entry already points at the copy, but holds it as it was queued: what is
// typed from here reaches the run only on Save.
const copiedForRun = (name) => `Copied to My Workspace as "${name}". Save puts your changes into the run.`;

// editQueued is a queued row's Edit as the page wires it: the entry opens,
// the editor is shown, and focus moves to the request's name. Left on the
// Edit button, focus would sit inside the Runner panel the switch just hid.
// The editor is shown before it is focused because a hidden field cannot take
// focus, and showTab's hash change reaches the page only as a later event.
export function editQueued(key, showTab) {
  openQueued(key);
  showTab('editor');
  if (!get().draft) return;
  if (get().activeTab !== 'editor') set({ activeTab: 'editor' });
  byId('editor-name').focus();
}

const isPlainRequest = (r) => r !== null && typeof r === 'object' && !Array.isArray(r);

// linkedKey is the queued entry the open draft is linked to, or null.
function linkedKey(draft) {
  return linked && draft && draft.id === linked.id && runner.queuedEntry(linked.key) ? linked.key : null;
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
  if (workspace.isWorkspaceId(draft.id)) return keepNewer(draft);

  const forked = deepCopy(workspace.fork(draft).request);
  forkNote = `Copied to My Workspace as "${forked.name}" - the built-in request is untouched.`;
  saveNote = '';
  // The copy is the same request under a new id: a Send that is out for it
  // still belongs to what the visitor is looking at.
  if (outbound && outbound.id === draft.id) outbound.id = forked.id;
  return forked;
}

// keepNewer returns the draft a request opened from a queued row may write
// to. Its saved original can change while it is open (in another tab), and
// the next write would put this tab's copy over that change. So once the
// saved request is no longer the one this tab last stored, the open request
// is copied into My Workspace instead, the queued entry is pointed at the
// copy (as it was queued: unsaved keystrokes reach the run only through
// Save), and the change made elsewhere is left as it is.
function keepNewer(draft) {
  const key = linkedKey(draft);
  const saved = key ? workspace.find(draft.id) : null;
  if (!saved || sameRequest(saved, draft)) return draft;
  const forked = workspace.fork(draft);
  const copy = deepCopy(forked.request);
  const entry = runner.queuedEntry(key);
  runner.repoint(key, { ...entry.request, id: copy.id, name: copy.name }, { fixed: false });
  linked = { key, id: copy.id };
  forkNote = copiedForRun(copy.name);
  writeRefused = !forked.ok;
  saveNote = forked.ok ? '' : workspace.WRITE_REFUSED;
  if (outbound && outbound.id === draft.id) outbound.id = copy.id;
  return copy;
}

// edit is the only way this module changes the draft: fork if needed, mutate,
// persist, then hand the whole thing back through set() so every render module
// sees it. Persisting on every edit (not only on Save) is what makes the
// sidebar note truthful — a fork that kept the pre-edit snapshot until Save
// would silently revert the visitor's changes on reload.
function edit(mutate) {
  const draft = own();
  if (!draft) return;
  mutate(draft);
  const saved = workspace.save(draft);
  // A request another tab deleted has just been closed; publishing the draft
  // again would reopen it.
  if (saved.deleted) return;
  writeRefused = !saved.ok;
  if (!saved.ok) saveNote = workspace.WRITE_REFUSED;
  else if (saveNote === workspace.WRITE_REFUSED) saveNote = '';
  const patch = { draft, selectedId: draft.id };
  // A refusal is about the request as it was sent; once it is edited, the
  // refusal and its mark describe something that is no longer on screen.
  if (saveRefusal) {
    saveRefusal = null;
    saveNote = writeRefused ? workspace.WRITE_REFUSED : '';
  }
  const send = get().send;
  if (send && !send.pending && send.kind === 'invalid') patch.send = null;
  set(patch);
}

// saveDraft is Save. Keystrokes are kept in this browser as they are typed,
// so a reload loses nothing, and the sentence says so; Save is the step that
// calls a request ready to run. A request the server would refuse is not: the
// refusal is said beside the field, and the queued entry it was opened from,
// which Save would update, is not touched.
function saveDraft() {
  const current = get().draft;
  if (!current) return;
  let problem = null;
  try {
    problem = requestProblem(requestPayload(current));
  } catch {
    problem = null;
  }
  if (problem) {
    const where = whereIn(problem.field);
    saveRefusal = { id: current.id, assertion: problem.assertion, part: problem.part, message: problem.message };
    const detail = `${where && where.label ? `${capitalized(where.label)}: ` : ''}${problem.message}`;
    // Kept only if the browser took the last write; otherwise that refusal
    // stays said, and why the draft cannot run is added to it.
    saveNote = writeRefused
      ? `${workspace.WRITE_REFUSED} Not ready to run either - ${detail}`
      : `Kept in this browser, but not ready to run - ${detail}`;
    set({});
    return;
  }
  const key = linkedKey(current);
  const draft = own();
  if (!draft) return;
  const saved = workspace.save(draft);
  if (saved.deleted) return;
  writeRefused = !saved.ok;
  // The queued entry is the run's own copy and is stored with the run setup,
  // so it is updated whether or not the browser took the workspace write.
  const position = key && runner.repoint(key, draft) ? runner.queuedPosition(key) : 0;
  // Only a write the browser accepted may claim the request is saved: a full
  // or disabled localStorage throws, and the visitor would lose it on reload.
  const name = textOf(draft.name) || draft.id;
  saveNote = !saved.ok ? workspace.WRITE_REFUSED
    : position ? `Saved "${name}" to My Workspace and to request ${position} in the run.`
      : `Saved "${name}" to My Workspace.`;
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
  const dropped = Object.keys(paramsOf(draft)).filter((key) => !allowed.includes(key));
  const ep = endpointById(id);

  paramNote = dropped.length
    ? `Dropped ${dropped.join(', ')} - ${ep ? ep.label : id} does not accept ${dropped.length === 1 ? 'it' : 'them'}.`
    : '';

  edit((d) => {
    const kept = {};
    for (const [key, value] of Object.entries(paramsOf(d))) {
      if (allowed.includes(key)) kept[key] = value;
    }
    d.endpoint = id;
    d.params = kept;
  });
}

function addParam() {
  const draft = get().draft;
  if (!draft) return;
  const used = Object.keys(paramsOf(draft));
  const next = allowedParams(draft.endpoint).find((p) => !used.includes(p));
  if (!next) return;
  paramNote = '';
  edit((d) => { d.params = { ...paramsOf(d), [next]: '' }; });
}

// paramsOf and assertionsOf read a request's two tables as the editor draws
// them. A request saved by an older build may hold something else there; it
// is drawn as empty rather than read as something it is not.
function paramsOf(draft) {
  const p = draft.params;
  return p !== null && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

function assertionsOf(draft) {
  return Array.isArray(draft.assertions) ? draft.assertions : [];
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
  if (!draft || assertionsOf(draft).length >= MaxAssertions) return;
  edit((d) => {
    d.assertions = [...assertionsOf(d), { type: 'status', op: 'eq', value: 200 }];
  });
}

function valueText(a) {
  return textOf(a.value);
}

// ---------------------------------------------------------------- send

async function sendDraft() {
  const state = get();
  if (!state.draft || (state.send && state.send.pending)) return;

  // What the server would refuse is refused here, the same way and by the
  // same field, and nothing is sent. A request that cannot even be built is
  // left to the catch below, as one that could not be sent.
  let problem = null;
  try {
    problem = requestProblem(requestPayload(state.draft));
  } catch {
    problem = null;
  }
  if (problem) {
    outbound = null;
    set({ send: { pending: false, kind: 'invalid', error: problem.message, field: problem.field, part: problem.part } });
    return;
  }

  const marker = { pending: true };
  const mine = { id: state.draft.id, marker };
  outbound = mine;
  set({ send: marker });
  // Whatever building or sending the request throws, Send must come back: a
  // button left on "Sending..." can only be cleared by a reload.
  let outcome;
  try {
    outcome = await api.send(requestPayload(state.draft));
  } catch (error) {
    console.warn('request not sent', error);
    outcome = { ok: false, kind: 'error', error: 'this request could not be sent from this page.' };
  }

  // The visitor opened another request while this one was out. Its answer
  // belongs to nothing on screen and is dropped; if the pending marker is
  // still what state holds, nothing else will ever clear it.
  const open = get().draft;
  if (outbound !== mine || !open || open.id !== mine.id) {
    if (outbound === mine) outbound = null;
    if (get().send === marker) set({ send: null });
    return;
  }
  outbound = null;
  if (outcome.ok) set({ send: { pending: false, result: outcome.result } });
  else set({ send: { pending: false, kind: outcome.kind, error: outcome.error, field: outcome.field || '' } });
}

// ---------------------------------------------------------------- render

export function render(state) {
  const draft = state.draft;
  const notice = byId('editor-notice');
  const noticeText = draft ? '' : state.editorNotice || '';
  notice.hidden = !noticeText;
  if (notice.textContent !== noticeText) notice.textContent = noticeText;
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

  // The parameter table is drawn from the catalog as well as the draft: a
  // request opened before the catalog arrived would otherwise keep saying its
  // endpoint takes no parameters.
  const sig = signature(draft);
  if (draft !== lastDraft || sig !== lastSignature || state.endpoints !== lastTableEndpoints) {
    renderParams(draft);
    renderAssertions(draft);
    lastDraft = draft;
    lastSignature = sig;
    lastTableEndpoints = state.endpoints;
  }

  renderNotes(draft);
  renderSend(state);
  renderMark(state, draft);
  renderParamMark(state, draft);
}

// signature covers everything that changes the *shape* of the two tables — the
// rows themselves, not what is typed into them. Value inputs are left alone
// between structural changes, because rebuilding one under a visitor mid-word
// throws away their caret.
function signature(draft) {
  const params = Object.keys(paramsOf(draft)).join(',');
  const asserts = assertionsOf(draft).map((a) => (isPlainRequest(a) ? `${textOf(a.type)}:${textOf(a.op)}` : '?')).join('|');
  return `${draft.id}::${draft.endpoint}::${params}::${asserts}`;
}

function renderEndpoints(state, draft) {
  const select = byId('endpoint-select');
  if (state.endpoints !== endpointsPainted || select !== pickerPainted) {
    replace(select, state.endpoints.map((e) => el('option', {
      text: `${e.label} - ${e.method} ${e.path}`,
      attrs: { value: e.id },
    })));
    endpointsPainted = state.endpoints;
    pickerPainted = select;
  }
  if (select.value !== draft.endpoint) select.value = draft.endpoint;
}

function renderName(draft) {
  const input = byId('editor-name');
  const name = textOf(draft.name);
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
  const capped = assertionsOf(draft).length >= MaxAssertions
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
  const entries = Object.entries(paramsOf(draft));
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
    attrs: { name: `param-key-${index}`, 'data-focus-key': `param-key:${index}`, 'aria-label': 'Parameter name' },
    on: {
      change: (e) => {
        const next = e.target.value;
        edit((d) => { d.params = renameParam(paramsOf(d), key, next); });
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
        value: textOf(value),
        maxlength: 256,
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'value',
        name: `param-value-${index}`,
        'aria-label': `Value for ${key}`,
        'data-focus-key': `param-value:${index}`,
      },
      on: {
        input: (e) => {
          const text = e.target.value;
          edit((d) => { d.params = { ...paramsOf(d), [key]: text }; });
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
            const next = { ...paramsOf(d) };
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
  const list = assertionsOf(draft);

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
  if (!isPlainRequest(a)) {
    // Something an older build stored where an assertion goes: it is said,
    // and can be removed, but never read as an assertion.
    return el('div', { class: 'row assert-row' }, [
      el('span', { class: 'assert-value muted', text: 'This assertion cannot be shown.' }),
      el('button', {
        class: 'btn btn-mini',
        type: 'button',
        text: 'x',
        title: 'Remove this assertion',
        on: { click: () => edit((d) => { d.assertions = assertionsOf(d).filter((_, i) => i !== index); }) },
      }),
    ]);
  }
  const kind = valueKind(a);

  const typeSelect = el('select', {
    class: 'assert-type',
    attrs: { name: `assert-type-${index}`, 'data-focus-key': `assert-type:${index}`, 'aria-label': 'Assertion type' },
    on: { change: (e) => changeAssertionType(index, e.target.value) },
  }, assertionTypes.map((t) => el('option', { text: t, attrs: { value: t, selected: t === a.type } })));
  typeSelect.value = textOf(a.type);

  const opSelect = el('select', {
    class: 'assert-op',
    attrs: { name: `assert-op-${index}`, 'data-focus-key': `assert-op:${index}`, 'aria-label': 'Operator' },
    on: { change: (e) => { const op = e.target.value; edit((d) => { d.assertions[index].op = op; }); } },
  }, opsOf(a.type).map((op) => el('option', { text: op, attrs: { value: op, selected: op === a.op } })));
  opSelect.value = textOf(a.op);

  const children = [typeSelect];

  // The path field belongs to json assertions and to nothing else: the
  // validator rejects a path on any other type outright.
  if (a.type === 'json') {
    children.push(el('input', {
      class: 'assert-path mono',
      type: 'text',
      attrs: {
        value: textOf(a.path),
        placeholder: '$.total',
        autocomplete: 'off',
        spellcheck: 'false',
        name: `assert-path-${index}`,
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
        name: `assert-value-${index}`,
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

// opsOf is the operators offered for a type. A type read back from storage
// may be any text, "constructor" included, so the matrix is read by its own
// keys only; a type it does not hold offers none, and is refused by field.
function opsOf(type) {
  return typeof type === 'string' && Object.hasOwn(opsByType, type) ? opsByType[type] : [];
}

// changeAssertionType keeps the row valid across the switch: an op the new type
// does not accept snaps to that type's first op, the path is added or dropped
// to match, and the value is re-coerced into the new slot's kind.
function changeAssertionType(index, type) {
  edit((d) => {
    const a = d.assertions[index];
    a.type = type;
    if (!opsOf(type).includes(a.op)) a.op = opsOf(type)[0];
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
// Only the editor's own keys are read: focus elsewhere on the page is not this
// render's to move, and a key is compared as a string, never put into a
// selector, because keys elsewhere on the page carry ids holding any character.
function captureFocus() {
  const node = document.activeElement;
  if (!node || !node.dataset || !node.dataset.focusKey) return null;
  if (!byId('editor-form').contains(node)) return null;
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
  const node = [...byId('editor-form').querySelectorAll('[data-focus-key]')].find((n) => n.dataset.focusKey === focus.key);
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
  // The line above a response names its method and path from the catalog, so
  // a catalog arriving after the answer is a change to what is shown.
  const send = state.send;
  if (send === lastSend && state.endpoints === lastSendEndpoints) return;
  lastSend = send;
  lastSendEndpoints = state.endpoints;

  const status = byId('send-status');
  const box = byId('send-response');
  byId('send-request').disabled = Boolean(send && send.pending);
  // What the server cut from the request it sent is said with its answer,
  // and goes with the next Send.
  const cut = byId('send-cut');
  const cutSaid = send && send.result ? cutText(send.result.truncated) : '';
  cut.hidden = !cutSaid;
  if (cut.textContent !== cutSaid) cut.textContent = cutSaid;

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
  if (!send.result && send.kind === 'network') {
    // Nothing is known about the target here: the request may never have
    // left, or its answer may have been lost on the way back.
    status.textContent = 'Could not reach Courier - check the connection and try again.';
    status.className = 'send-status fail';
    replace(box, []);
    return;
  }
  if (!send.result) {
    // 429 (one send at a time) and 503 (too many request bodies at once) are
    // the server busy for a moment; 400 is the sandbox refusing the request
    // before it could reach the target. All are answers, not failures of the
    // page, and the 400 is where a visitor learns the allowlist is real.
    status.textContent = send.kind === 'busy' ? `Busy - ${send.error}` : sendRefusal(send);
    status.className = 'send-status fail';
    replace(box, [el('p', { class: 'note', text: 'Nothing reached the target.' })]);
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
  if (r.body_truncated) bits.push('truncated at 256KB');
  status.textContent = bits.join(' - ');
  status.className = `send-status ${r.passed ? 'pass' : 'fail'}`;

  // The server hands back the endpoint id and an already-`?`-prefixed query
  // string; the catalog is what turns the id back into the method and path it
  // resolved to. The method is the badge's own reading of the catalog, so an
  // endpoint the page does not know shows the same placeholder here.
  const ep = endpointById(r.endpoint);
  const method = runner.methodBadge(state.endpoints, r.endpoint).textContent;
  replace(box, [
    el('p', { class: 'note mono sent-line', text: `${method} ${ep && typeof ep.path === 'string' ? ep.path : r.endpoint}${r.query || ''}` }),
    r.error && el('p', {
      class: 'note fail',
      text: `${r.error_kind ? `${r.error_kind}: ` : ''}${r.error}`,
    }),
    outcomes.length > 0 && el('div', { class: 'outcomes' }, outcomes.map(outcomeRow)),
    el('h4', { class: 'block-heading', text: 'Response body' }),
    jsonView(r.body, { truncated: Boolean(r.body_truncated) }),
  ]);
}

// sendRefusal is Send's refusal as one sentence, the field named once as a
// visitor would name it. A field the page does not know is shown as it came.
function sendRefusal(send) {
  const field = typeof send.field === 'string' && send.field !== 'body' ? send.field : '';
  const where = whereIn(field);
  return refusedText(where ? capitalized(where.label) : field, send.error);
}

// ---------------------------------------------------------------- field marks

// markOf is the refusal the open request carries, if any: Send's own, a
// refused Save's, or the run's when the refused queued request is the one open.
function markOf(state, draft) {
  const send = state.send;
  if (send && !send.pending && send.kind === 'invalid') {
    const where = whereIn(typeof send.field === 'string' ? send.field : '');
    if (where && where.assertion !== null) return { assertion: where.assertion, part: where.part || send.part || '', message: send.error };
  }
  if (saveRefusal && saveRefusal.id === draft.id && saveRefusal.assertion !== null) return saveRefusal;
  return runner.refusedAssertion(draft);
}

// markTarget is the control a refusal points at. A refusal that names only
// the assertion is placed by the same checks the page runs before sending;
// failing those, on the value, then the path.
function markTarget(row, assertion, part) {
  const path = row.querySelector('.assert-path');
  const value = row.querySelector('input.assert-value');
  if (part === 'path' && path) return path;
  if (part === 'value' && value) return value;
  if (part === 'type') return row.querySelector('.assert-type');
  if (part === 'op') return row.querySelector('.assert-op');
  let found = '';
  try {
    const problem = assertionProblem(requestPayload({ assertions: [assertion] }).assertions[0]);
    found = problem ? problem.part : '';
  } catch {
    found = '';
  }
  if (found === 'path' && path) return path;
  return value || path || row.querySelector('.assert-type');
}

// paramMarkOf is the refused parameter the open request carries, if any:
// Send's own, or the run's when the refused queued request is the one open.
// param is the parameter's name, or '' for the parameters as a whole.
function paramMarkOf(state, draft) {
  const send = state.send;
  if (send && !send.pending && send.kind === 'invalid') {
    const where = whereIn(typeof send.field === 'string' ? send.field : '');
    if (where && where.param !== undefined) return { param: where.param, message: send.error };
  }
  return runner.refusedParam(draft);
}

// renderParamMark is renderMark for a refused parameter. A named parameter
// that has a row is marked on its value field; otherwise (no name, a name the
// table does not hold, or an endpoint that takes none) the message sits at
// the end of the table, and the table's controls are described by it, none
// of them invalid, since none of them was named.
function renderParamMark(state, draft) {
  const mark = paramMarkOf(state, draft);
  const box = byId('param-rows');
  const add = byId('add-param');
  const values = [...box.querySelectorAll('.param-value')];
  let holder = null;
  let target = null;
  if (mark) {
    const i = mark.param === '' ? -1 : Object.keys(paramsOf(draft)).indexOf(mark.param);
    const row = i >= 0 ? box.querySelectorAll('.param-row')[i] : null;
    target = row ? row.querySelector('.param-value') : null;
    holder = target ? row : box;
  }
  const described = !mark ? [] : target ? [target] : [add, ...values];
  for (const control of [add, ...values]) {
    if (control !== target && control.hasAttribute('aria-invalid')) control.removeAttribute('aria-invalid');
    if (!described.includes(control) && control.getAttribute('aria-describedby') === 'param-error') {
      control.removeAttribute('aria-describedby');
    }
  }
  for (const old of box.querySelectorAll('.field-error')) {
    if (!holder || old.parentNode !== holder || old.textContent !== mark.message) old.remove();
  }
  if (!mark) return;
  if (target && target.getAttribute('aria-invalid') !== 'true') target.setAttribute('aria-invalid', 'true');
  for (const control of described) {
    if (control.getAttribute('aria-describedby') !== 'param-error') control.setAttribute('aria-describedby', 'param-error');
  }
  if (![...holder.children].some((c) => c.classList.contains('field-error'))) {
    holder.appendChild(el('p', { class: 'field-error fail', text: mark.message, attrs: { id: 'param-error' } }));
  }
}

// renderMark puts the open request's refusal on its control: aria-invalid, and
// an error beside it that the control is described by. It runs on every render
// and touches only what changed, so a poll neither moves nor re-announces it.
function renderMark(state, draft) {
  const mark = markOf(state, draft);
  const list = Array.isArray(draft.assertions) ? draft.assertions : [];
  const rows = [...byId('assertion-rows').querySelectorAll('.assert-row')];
  const target = mark && rows[mark.assertion] && list[mark.assertion]
    ? markTarget(rows[mark.assertion], list[mark.assertion], mark.part)
    : null;
  rows.forEach((row) => {
    for (const control of row.querySelectorAll('[aria-invalid]')) {
      if (control !== target) {
        control.removeAttribute('aria-invalid');
        control.removeAttribute('aria-describedby');
      }
    }
    for (const old of row.querySelectorAll('.field-error')) {
      if (!target || !row.contains(target) || old.textContent !== mark.message) old.remove();
    }
  });
  if (!target) return;
  if (target.getAttribute('aria-invalid') !== 'true') target.setAttribute('aria-invalid', 'true');
  if (target.getAttribute('aria-describedby') !== 'assertion-error') target.setAttribute('aria-describedby', 'assertion-error');
  const row = rows[mark.assertion];
  if (!row.querySelector('.field-error')) {
    row.appendChild(el('p', { class: 'field-error fail', text: mark.message, attrs: { id: 'assertion-error' } }));
  }
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
