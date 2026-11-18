// render-sidebar.js — curated collections, the visitor workspace (saved
// requests and saved collections), and history.

import { get, set, deepCopy } from './store.js';
import { el, replace, byId, fmtMs, fmtTime } from './dom.js';
import * as workspace from './workspace.js';
import { savedCollections, methodBadge } from './render-runner.js';

// onSelect / onAdd are wired by main.js so this module stays a pure function
// of state plus its two callbacks.
let hooks = { select: () => {}, add: () => {}, addAll: () => {}, openRun: () => {}, retryCatalog: () => {} };

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

// showResetConfirm renders an inline two-step confirm. Deliberately not
// window.confirm(): a modal dialog blocks the page, and in a browser-automation
// session it wedges the whole tab.
function showResetConfirm() {
  const box = byId('reset-confirm');
  box.hidden = false;
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
            box.hidden = true;
            const note = byId('workspace-note');
            if (ok) {
              note.hidden = true;
              return;
            }
            replace(note, [el('span', { text: workspace.RESET_REFUSED })]);
            note.hidden = false;
          },
        },
      }),
      el('button', {
        class: 'btn btn-mini',
        type: 'button',
        text: 'Cancel',
        on: { click: () => { box.hidden = true; } },
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
      on: { click: () => hooks.select(request) },
    }, [
      methodBadge(endpoints, request.endpoint),
      ' ',
      el('span', { text: name }),
    ]),
    queuedMark(counts, request.id),
    el('button', {
      class: 'btn btn-mini',
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

// The saved collections are rebuilt only when what they show changes: the
// list itself, which of their requests are queued, or the catalog their
// method badges are read from. The status poll
// notifies every few seconds, and a long list rebuilt on each one would cost
// the page for nothing. Which ones are open is read back from the tree, as for
// the curated collections.
let lastSaved = null;
let lastSavedMarks = null;
let lastSavedEndpoints = null;

function renderSaved(list, counts, endpoints) {
  const marks = [...counts].map(([id, n]) => `${id}\u0000${n}`).sort().join('\u0001');
  if (list === lastSaved && marks === lastSavedMarks && endpoints === lastSavedEndpoints) return;
  lastSaved = list;
  lastSavedMarks = marks;
  lastSavedEndpoints = endpoints;
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

function historyRow(entry) {
  const status = entry.status === 'completed' ? '' : ` (${entry.status})`;
  return el('div', { class: 'req-row' }, [
    el('button', {
      class: 'req-open',
      type: 'button',
      title: `${entry.id} - ${entry.summary}`,
      on: { click: () => hooks.openRun(entry.id) },
    }, [
      el('span', { class: 'method', text: entry.mode === 'performance' ? 'PERF' : 'FUNC' }),
      ' ',
      el('span', { text: `${fmtTime(entry.started_at)}${status}` }),
      el('div', { class: 'note', text: `${entry.summary} - ${fmtMs(entry.duration_ms)}` }),
    ]),
  ]);
}

let openCollections = new Set();

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

// ---------------------------------------------------------------- focus
//
// Every render rebuilds the trees, a status poll's every 3 seconds included,
// and a rebuilt control is a new node: whatever had focus in the old tree is
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
  if (node) node.focus();
}

export function render(state) {
  const focus = focusedKey();
  const counts = queuedCounts(state.sequence);
  const tree = byId('collections-tree');
  // Remember which collections the visitor had expanded, so a notify from an
  // unrelated part of the app does not collapse the tree under their cursor.
  const previouslyOpen = openCollections;
  const detailNodes = tree.querySelectorAll('details[data-id]');
  openCollections = new Set();
  for (const node of detailNodes) {
    if (node.open) openCollections.add(node.dataset.id);
  }
  // Fall back only when there was no tree to read (first render, loading
  // placeholder) — an all-closed tree is a state the visitor chose, and
  // restoring the previous set would pop the last-closed collection back open.
  if (detailNodes.length === 0) openCollections = previouslyOpen;

  replace(tree, state.collections.map((c) => {
    const node = collectionNode(c, state.selectedId, counts, state.endpoints);
    node.dataset.id = c.id;
    node.open = openCollections.has(c.id);
    return node;
  }));
  if (state.collections.length === 0) replace(tree, catalogPlaceholder(state));

  const ws = byId('workspace-tree');
  if (state.workspace.length === 0) {
    replace(ws, [el('div', {
      class: 'tree-empty',
      text: 'Empty. Editing a built-in request copies it here.',
    })]);
  } else {
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

  renderSaved(state.savedCollections, counts, state.endpoints);

  const hist = byId('history-list');
  // The five most recent runs, list and click-to-reopen only.
  const recent = state.history.slice(0, 5);
  const rows = recent.length === 0
    ? [el('div', { class: 'tree-empty', text: 'No runs yet.' })]
    : recent.map(historyRow);
  // An entry that could not be opened says so here, beside the list it was
  // clicked in; nothing else on the page would explain the click.
  replace(hist, [state.historyNote ? el('div', { class: 'note', text: state.historyNote }) : null, ...rows]);

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
