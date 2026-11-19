// render-sidebar.js — curated collections, the visitor workspace (saved
// requests and saved collections), and history.

import { get, set, deepCopy } from './store.js';
import { el, replace, byId, fmtMs, fmtDateTime } from './dom.js';
import * as workspace from './workspace.js';
import { savedCollections, methodBadge } from './render-runner.js';

// onSelect / onAdd are wired by main.js so this module stays a pure function
// of state plus its two callbacks.
let hooks = { select: () => {}, add: () => {}, addAll: () => {}, openRun: () => {}, retryCatalog: () => {}, retryHistory: () => {} };

export function init(h) {
  hooks = { ...hooks, ...h };

  byId('reset-workspace').addEventListener('click', showResetConfirm);
  byId('sidebar-toggle').addEventListener('click', () => {
    const open = byId('app').classList.toggle('sidebar-open');
    setDrawer(open);
  });
  // The drawer starts closed. Above 900px it is a pane rather than a drawer,
  // so the media query is read rather than assumed, and it is re-read on a
  // change so a rotation or a resize cannot leave the panel inert while it is
  // visible.
  window.matchMedia('(max-width: 900px)').addEventListener('change', () => {
    setDrawer(byId('app').classList.contains('sidebar-open'));
  });
  setDrawer(false);
}

// setDrawer keeps the off-screen drawer out of the tab order and the toggle's
// aria-expanded truthful. Below 900px a closed drawer is translated fully off
// the left edge but still in the document, so without inert a keyboard or
// switch user walks eleven invisible controls before reaching the tabs.
function setDrawer(open) {
  const drawer = byId('panel-sidebar');
  const hidden = window.matchMedia('(max-width: 900px)').matches && !open;
  // Moving focus before inert, because inert on an element that holds
  // document.activeElement drops focus to body and costs a keyboard visitor
  // their place. The toggle is the drawer's own control and is only visible
  // below 900px, which is the only width at which hidden is ever true.
  if (hidden && drawer.contains(document.activeElement)) byId('sidebar-toggle').focus();
  drawer.inert = hidden;
  if (hidden) drawer.setAttribute('aria-hidden', 'true');
  else drawer.removeAttribute('aria-hidden');
  byId('sidebar-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
}

// closeDrawer puts the drawer away once a request or a run is picked in it:
// below 900px it covers the page, and what was just opened is what the
// visitor came for. Above 900px the sidebar is a pane and stays.
function closeDrawer() {
  if (!window.matchMedia('(max-width: 900px)').matches) return;
  byId('app').classList.remove('sidebar-open');
  setDrawer(false);
}

// showResetConfirm renders an inline two-step confirm. Deliberately not
// window.confirm(): a modal dialog blocks the page, and in a browser-automation
// session it wedges the whole tab.
//
// Either answer hides the confirm, and the button pressed goes with it, so
// focus goes back to Reset: left where it was it would drop to the page. A
// refused reset is said in the workspace note, a status region, which is
// announced without taking focus.
function showResetConfirm() {
  const box = byId('reset-confirm');
  box.hidden = false;
  const close = () => {
    box.hidden = true;
    byId('reset-workspace').focus();
  };
  replace(box, [
    el('div', { text: 'Clear every saved request in My Workspace? This cannot be undone.' }),
    el('div', { class: 'confirm-actions' }, [
      el('button', {
        class: 'btn btn-mini btn-danger',
        type: 'button',
        text: 'Reset workspace',
        on: {
          click: () => {
            const { ok } = workspace.reset();
            const note = byId('workspace-note');
            if (ok) {
              note.hidden = true;
            } else {
              replace(note, [el('span', { text: workspace.RESET_REFUSED })]);
              note.hidden = false;
            }
            close();
          },
        },
      }),
      el('button', {
        class: 'btn btn-mini',
        type: 'button',
        text: 'Cancel',
        on: { click: close },
      }),
    ]),
  ]);
}

// deleteWithUndo deletes at once and offers the entry back, rather than
// asking first: an inline undo costs a visitor nothing when they meant it, and
// window.confirm would block the page (see showResetConfirm). remove answers
// { ok, entry } and restore(entry) { ok, deleted }, so saved requests and
// saved collections share it.
//
// The control that was pressed goes with the entry, so focus moves to Undo,
// and from a landed Undo to the entry it brought back (backTo is its focus
// key): left where it was, focus would drop to the page.
function deleteWithUndo(remove, restore, backTo) {
  const { entry, ok } = remove();
  const note = byId('workspace-note');
  if (!entry) {
    note.hidden = true;
    return;
  }
  const label = entry.name || entry.id;
  const undo = el('button', {
    class: 'link-btn',
    type: 'button',
    text: 'Undo',
    on: {
      click: () => {
        // An undo that did not land must say so: hiding the note would
        // leave the visitor believing the entry is back.
        const restored = restore(entry);
        if (restored.ok) {
          const back = keyedNode(backTo(entry));
          if (back) back.focus();
          note.hidden = true;
          return;
        }
        const why = restored.deleted
          ? `Could not restore "${label}".`
          : workspace.WRITE_REFUSED;
        replace(note, [el('span', { text: why })]);
        note.hidden = false;
        // The Undo pressed went with the sentence it was in; the sentence
        // that replaced it is where focus goes.
        note.setAttribute('tabindex', '-1');
        note.focus();
      },
    },
  });
  replace(note, [
    el('span', { text: `Deleted "${label}". ` }),
    undo,
    ok ? null : el('span', { text: ` ${workspace.WRITE_REFUSED}` }),
  ]);
  note.hidden = false;
  undo.focus();
}

function deleteRequest(id) {
  deleteWithUndo(() => {
    const { request, ok } = workspace.remove(id);
    return { entry: request, ok };
  }, (request) => workspace.save(request), (request) => `open:workspace:${request.id}`);
}

function deleteCollection(id) {
  deleteWithUndo(() => {
    const { collection, ok } = savedCollections.remove(id);
    return { entry: collection, ok };
  }, (collection) => savedCollections.save(collection), (collection) => `saved:${collection.id}`);
}

// queuedCounts counts the queued entries by request id, checked or not. A
// queued entry is a copy taken when it was added, so the id is what still
// ties it to the request in the tree: a request edited since is still marked,
// and one deleted since takes its mark with it while its copy stays queued.
function queuedCounts(sequence) {
  const counts = new Map();
  for (const entry of sequence || []) {
    const id = entry && entry.request && entry.request.id;
    if (typeof id === 'string') counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

// queuedMark is the tree's "already in the run" marker, or null. Its text is
// for the eye; its role and label are what a screen reader says.
function queuedMark(counts, id) {
  const n = counts.get(id) || 0;
  if (n === 0) return null;
  return el('span', {
    class: 'in-run',
    text: n === 1 ? 'in run' : `in run x${n}`,
    attrs: { role: 'img', 'aria-label': n === 1 ? 'Queued in the run once' : `Queued in the run ${n} times` },
  });
}

function requestRow(request, selectedId, listId, counts, endpoints) {
  const name = request.name || request.id;
  return el('div', { class: 'req-row' }, [
    el('button', {
      class: `req-open${request.id === selectedId ? ' is-selected' : ''}`,
      type: 'button',
      title: name,
      attrs: { 'data-focus-key': `open:${listId}:${request.id}` },
      on: {
        click: () => {
          hooks.select(request);
          closeDrawer();
        },
      },
    }, [
      methodBadge(endpoints, request.endpoint),
      ' ',
      el('span', { text: name }),
    ]),
    queuedMark(counts, request.id),
    el('button', {
      class: 'btn btn-mini req-add',
      type: 'button',
      text: '+',
      title: 'Add to the run sequence',
      attrs: { 'aria-label': `Add ${name} to the run`, 'data-focus-key': `add:${listId}:${request.id}` },
      on: { click: () => hooks.add(request) },
    }),
  ]);
}

function collectionNode(collection, selectedId, counts, endpoints) {
  const summary = el('summary', { attrs: { 'data-focus-key': `collection:${collection.id}` } }, [
    el('span', { class: 'collection-name', text: collection.name }),
    el('span', { class: 'badge', text: 'built-in' }),
  ]);
  const body = el('div', { class: 'collection-body' },
    collection.requests.map((r) => requestRow(r, selectedId, collection.id, counts, endpoints)));
  const actions = el('div', { class: 'collection-actions' }, [
    el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: `Add all ${collection.requests.length} to run`,
      attrs: { 'data-focus-key': `add-all:${collection.id}` },
      on: { click: () => hooks.addAll(collection) },
    }),
  ]);
  const node = el('details', { class: 'collection' }, [summary, body, actions]);
  if (collection.description) summary.title = collection.description;
  return node;
}

// savedNode lists a saved collection's requests as text: they are copies
// taken when the sequence was saved, so opening one in the editor would edit
// nothing the visitor could find again. Adding it to the run copies them anew.
function savedNode(collection, counts, endpoints) {
  const name = collection.name || 'Untitled';
  const summary = el('summary', { attrs: { 'data-focus-key': `saved:${collection.id}` } }, [
    el('span', { class: 'collection-name', text: name }),
    el('span', { class: 'badge', text: 'saved' }),
  ]);
  const body = el('div', { class: 'collection-body' }, collection.requests.map((r) => el('div', { class: 'req-row' }, [
    methodBadge(endpoints, r.endpoint),
    ' ',
    el('span', { class: 'req-name', text: r.name || r.id }),
    queuedMark(counts, r.id),
  ])));
  const actions = el('div', { class: 'collection-actions' }, [
    el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: `Add all ${collection.requests.length} to run`,
      attrs: { 'data-focus-key': `add-all:saved:${collection.id}` },
      on: { click: () => hooks.addAll({ ...collection, name }) },
    }),
    ' ',
    el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: 'x',
      title: 'Delete this saved collection',
      attrs: { 'aria-label': `Delete saved collection "${name}"`, 'data-focus-key': `delete-saved:${collection.id}` },
      on: { click: () => deleteCollection(collection.id) },
    }),
  ]);
  const node = el('details', { class: 'collection' }, [summary, body, actions]);
  node.dataset.id = collection.id;
  return node;
}

// Which saved collections are open is read back from the tree, as for the
// curated collections.
function renderSaved(list, counts, endpoints) {
  const tree = byId('saved-collections');
  const open = new Set();
  for (const node of tree.querySelectorAll('details[data-id]')) {
    if (node.open) open.add(node.dataset.id);
  }
  replace(tree, list.map((c) => {
    const node = savedNode(c, counts, endpoints);
    node.open = open.has(c.id);
    return node;
  }));
}

// A verdict is coloured by what it says; one this page does not know is muted.
// Only the table's own keys count: a verdict named like an inherited property
// would otherwise put that property's text into the class.
const verdictTone = { PASS: 'pass', FAIL: 'fail', 'N/A': 'muted' };
const toneOf = (verdict) => (Object.hasOwn(verdictTone, verdict) ? verdictTone[verdict] : 'muted');

function historyRow(entry) {
  const status = entry.status === 'completed' ? '' : ` (${entry.status})`;
  const verdict = entry.verdict
    ? el('span', { class: `history-verdict mono ${toneOf(entry.verdict)}`, text: entry.verdict })
    : null;
  return el('div', { class: 'req-row' }, [
    el('button', {
      class: 'req-open',
      type: 'button',
      title: `${entry.id} - ${entry.summary}`,
      attrs: { 'data-focus-key': `history:${entry.id}` },
      // Below 900px the drawer covers the report this opens, so it is put
      // away as it is when a request is picked.
      on: {
        click: () => {
          hooks.openRun(entry.id);
          closeDrawer();
        },
      },
    }, [
      el('span', { class: 'method', text: entry.mode === 'performance' ? 'PERF' : 'FUNC' }),
      ' ',
      el('span', { text: `${fmtDateTime(entry.started_at)}${status}` }),
      verdict && ' ',
      verdict,
      el('div', { class: 'note', text: `${entry.summary} - ${fmtMs(entry.duration_ms)}` }),
    ]),
  ]);
}

let openCollections = new Set();
let seededTree = null; // the tree node the first catalog was drawn into

// catalogPlaceholder is what stands in for the curated collections while there
// are none to list. Once a load has failed it says so and offers Retry, and it
// keeps saying so while the retry is out: "Loading" after a failure would read
// as progress the page cannot promise.
//
// Retry is never disabled while its load is out, only marked so: a disabled
// button cannot hold focus, and a keyboard visitor who pressed it would be
// sent back to the top of the page.
function catalogPlaceholder(state) {
  if (!state.notice) return [el('div', { class: 'tree-empty', text: 'Loading collections...' })];
  const loading = Boolean(state.catalogLoading);
  const retry = el('button', {
    class: 'btn btn-mini',
    type: 'button',
    text: 'Retry',
    attrs: { 'data-focus-key': 'catalog-retry', 'aria-disabled': loading ? 'true' : 'false' },
    on: { click: () => { if (!get().catalogLoading) hooks.retryCatalog(); } },
  });
  return [el('div', { class: 'tree-empty' }, [el('span', { text: state.notice }), ' ', retry])];
}

// ---------------------------------------------------------------- what each part shows
//
// Every notify reaches this render, the status poll's included (every 3s while
// idle, four times a second during a performance run), and a rebuilt part is
// new nodes: a control focused in it loses focus, and a click that lands
// mid-rebuild is lost. So each part is rebuilt only when its key moves, and the
// key holds every input that part paints:
//
//   curated tree       collections; the selected id, when it is one of their
//                      requests; the in-run counts of their requests; the
//                      endpoint methods; and, while there are no collections,
//                      the catalog notice and whether a load is out
//   My Workspace       workspace; the selected id, when it is one of them;
//                      their in-run counts; the endpoint methods
//   saved collections  savedCollections; the in-run counts of their requests;
//                      the endpoint methods
//   history notice     historyNotice; whether a Retry is out
//   history            history; historyNote; and, while it is empty, whether
//                      a list has ever arrived and whether the last read failed
//   target line        target, compared as the text it paints
//
// Lists are keyed by their content, not their identity. The history arrives
// as a new but equal array on every refresh (a start, a cancel, a run ending),
// and an identity key would rebuild it each time; content also catches a list
// changed in place. The status poll replaces state.status alone, which no part
// reads. The part's own node is in the key as well, so a node that was swapped
// out is drawn again. Click handlers hold the objects they were drawn from,
// which is why whole requests are keyed rather than only the fields painted.

const drawn = new Map(); // part id -> { node, key } as last drawn

let unencodable = 0;

function keyOf(inputs) {
  try {
    return JSON.stringify(inputs);
  } catch {
    // An input JSON cannot encode (a BigInt) is told apart from every other
    // render, so its part is always drawn from what it now holds.
    unencodable += 1;
    return `#${unencodable}`;
  }
}

// draw rebuilds a part when its key moved and records the key only once the
// part was built, so a build that threw is tried again on the next render. A
// build that throws costs that part alone, the way renderAll isolates the
// page's panes: the parts after it and the focus restore still run.
function draw(id, inputs, build) {
  const node = byId(id);
  const key = keyOf(inputs);
  const last = drawn.get(id);
  if (last && last.node === node && last.key === key) return;
  try {
    build(node);
  } catch (err) {
    console.error(`sidebar part ${id} could not be drawn`, err);
    return;
  }
  drawn.set(id, { node, key });
}

const requestIds = (requests) => (Array.isArray(requests) ? requests.map((r) => r && r.id) : []);
const marksOf = (counts, ids) => [...new Set(ids)].filter((id) => counts.has(id)).map((id) => [id, counts.get(id)]);
const selectedOf = (selectedId, ids) => (ids.includes(selectedId) ? selectedId : null);
const methodsOf = (endpoints) => (Array.isArray(endpoints) ? endpoints.map((e) => (e ? [e.id, e.method] : null)) : []);

// ---------------------------------------------------------------- focus
//
// A part that is rebuilt is new nodes: whatever had focus in the old one is
// gone, and focus drops to the page. Each control a visitor presses here
// carries a data-focus-key, and the render puts focus back on the control
// with the same key. Keys are compared as strings rather than through a
// selector, because a request id may hold any character.

function keyedNode(key) {
  if (!key) return null;
  for (const node of byId('panel-sidebar').querySelectorAll('[data-focus-key]')) {
    if (node.dataset.focusKey === key) return node;
  }
  return null;
}

function focusedKey() {
  const node = document.activeElement;
  if (!node || !node.dataset || !node.dataset.focusKey) return '';
  return byId('panel-sidebar').contains(node) ? node.dataset.focusKey : '';
}

function restoreFocus(key) {
  if (!key) return;
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  let node = keyedNode(key);
  // Retry leaves with the notice once the catalog is in: the collections it
  // brought are where the visitor was headed.
  if (!node && key === 'catalog-retry') node = byId('collections-tree').querySelector('summary');
  // With nothing in the list, the History heading takes it rather than the
  // page: the visitor is left in the section they were in.
  if (!node && key === 'history-retry') node = byId('history-list').querySelector('button') || byId('history-heading');
  if (node) node.focus();
}

function renderCollections(tree, state, counts) {
  // Remember which collections the visitor had expanded, so a rebuild for
  // another reason does not collapse the tree under their cursor.
  const previouslyOpen = openCollections;
  const detailNodes = tree.querySelectorAll('details[data-id]');
  openCollections = new Set();
  for (const node of detailNodes) {
    if (node.open) openCollections.add(node.dataset.id);
  }
  // Fall back only when there was no tree to read (first render, loading
  // placeholder) — an all-closed tree is a state the visitor chose, and
  // restoring the previous set would pop the last-closed collection back open.
  // The first catalog drawn into this tree opens its first collection, so the
  // first screen has a request to pick without hunting for one; the visitor
  // cannot have toggled a tree that was not there yet.
  if (detailNodes.length === 0) {
    const first = seededTree !== tree && state.collections.length > 0 ? state.collections[0] : null;
    openCollections = first ? new Set([first.id]) : previouslyOpen;
  }
  if (state.collections.length > 0) seededTree = tree;

  replace(tree, state.collections.map((c) => {
    const node = collectionNode(c, state.selectedId, counts, state.endpoints);
    node.dataset.id = c.id;
    node.open = openCollections.has(c.id);
    return node;
  }));
  if (state.collections.length === 0) replace(tree, catalogPlaceholder(state));
}

function renderWorkspace(ws, state, counts) {
  if (state.workspace.length === 0) {
    replace(ws, [el('div', {
      class: 'tree-empty',
      text: 'Empty. Editing a built-in request copies it here.',
    })]);
    return;
  }
  replace(ws, state.workspace.map((r) => {
    const row = requestRow(r, state.selectedId, 'workspace', counts, state.endpoints);
    row.appendChild(el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: 'x',
      title: 'Delete this saved request',
      attrs: { 'aria-label': `Delete saved request "${r.name || r.id}"`, 'data-focus-key': `delete:${r.id}` },
      on: { click: () => deleteRequest(r.id) },
    }));
    return row;
  }));
}

// historyEmpty is what the list says while it has no runs to show. "No runs
// yet." is a server's answer, so it is said only after one; before any answer
// the list is loading, and after a failed one the notice above it speaks.
function historyEmpty(state) {
  if (state.historyLoaded) return [el('div', { class: 'tree-empty', text: 'No runs yet.' })];
  if (state.historyNotice) return [];
  return [el('div', { class: 'tree-empty', text: 'Loading history...' })];
}

// renderHistoryNotice says a history read failed, with Retry, in the words and
// the shape of the catalog's own (catalogPlaceholder). It sits outside the
// list so the list the page already had stays as it was.
function renderHistoryNotice(box, state) {
  box.hidden = !state.historyNotice;
  if (!state.historyNotice) {
    replace(box, []);
    return;
  }
  const loading = Boolean(state.historyLoading);
  const retry = el('button', {
    class: 'btn btn-mini',
    type: 'button',
    text: 'Retry',
    attrs: { 'data-focus-key': 'history-retry', 'aria-disabled': loading ? 'true' : 'false' },
    on: { click: () => { if (!get().historyLoading) hooks.retryHistory(); } },
  });
  replace(box, [el('div', { class: 'tree-empty' }, [el('span', { text: state.historyNotice }), ' ', retry])]);
}

function renderHistory(hist, state) {
  // Every run the server keeps (at most 20), newest first as it sends them,
  // list and click-to-reopen only; the sidebar is what scrolls.
  const rows = state.history.length === 0 ? historyEmpty(state) : state.history.map(historyRow);
  // An entry that could not be opened says so here, beside the list it was
  // clicked in; nothing else on the page would explain the click.
  replace(hist, [state.historyNote ? el('div', { class: 'note', text: state.historyNote }) : null, ...rows]);
}

export function render(state) {
  const focus = focusedKey();
  const counts = queuedCounts(state.sequence);
  const methods = methodsOf(state.endpoints);

  const curatedIds = state.collections.flatMap((c) => requestIds(c && c.requests));
  const empty = state.collections.length === 0;
  draw('collections-tree', [
    state.collections,
    selectedOf(state.selectedId, curatedIds),
    marksOf(counts, curatedIds),
    methods,
    empty ? state.notice : null,
    empty ? Boolean(state.catalogLoading) : null,
  ], (tree) => renderCollections(tree, state, counts));

  const workspaceIds = requestIds(state.workspace);
  draw('workspace-tree', [
    state.workspace,
    selectedOf(state.selectedId, workspaceIds),
    marksOf(counts, workspaceIds),
    methods,
  ], (ws) => renderWorkspace(ws, state, counts));

  const savedIds = state.savedCollections.flatMap((c) => requestIds(c && c.requests));
  draw('saved-collections', [
    state.savedCollections,
    marksOf(counts, savedIds),
    methods,
  ], () => renderSaved(state.savedCollections, counts, state.endpoints));

  draw('history-notice', [state.historyNotice || '', Boolean(state.historyLoading)], (box) => renderHistoryNotice(box, state));
  draw('history-list', [
    state.history,
    state.historyNote,
    state.history.length === 0 ? [Boolean(state.historyLoaded), Boolean(state.historyNotice)] : null,
  ], (hist) => renderHistory(hist, state));

  const name = byId('target-note-name');
  if (state.target && name.textContent !== state.target) name.textContent = state.target;
  const label = byId('target-label');
  const wanted = state.target ? `target: ${state.target}` : '';
  if (label.textContent !== wanted) label.textContent = wanted;

  restoreFocus(focus);
}

// selectRequest is the sidebar's half of selection: the editor owns the draft,
// but the tree owns which id is highlighted.
export function selectRequest(request) {
  set({ selectedId: request.id, draft: deepCopy(request), editorNotice: '' });
}
