// render-sidebar.js — curated collections, the visitor workspace (saved
// requests and saved collections), and history.

import { set, deepCopy } from './store.js';
import { el, replace, byId, fmtMs, fmtTime } from './dom.js';
import * as workspace from './workspace.js';
import { savedCollections } from './render-runner.js';

// onSelect / onAdd are wired by main.js so this module stays a pure function
// of state plus its two callbacks.
let hooks = { select: () => {}, add: () => {}, addAll: () => {}, openRun: () => {} };

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
function deleteWithUndo(remove, restore) {
  const { entry, ok } = remove();
  const note = byId('workspace-note');
  if (!entry) {
    note.hidden = true;
    return;
  }
  const label = entry.name || entry.id;
  replace(note, [
    el('span', { text: `Deleted "${label}". ` }),
    el('button', {
      class: 'link-btn',
      type: 'button',
      text: 'Undo',
      on: {
        click: () => {
          // An undo that did not land must say so: hiding the note would
          // leave the visitor believing the entry is back.
          const restored = restore(entry);
          if (restored.ok) {
            note.hidden = true;
            return;
          }
          const why = restored.deleted
            ? `Could not restore "${label}".`
            : workspace.WRITE_REFUSED;
          replace(note, [el('span', { text: why })]);
          note.hidden = false;
        },
      },
    }),
    ok ? null : el('span', { text: ` ${workspace.WRITE_REFUSED}` }),
  ]);
  note.hidden = false;
}

function deleteRequest(id) {
  deleteWithUndo(() => {
    const { request, ok } = workspace.remove(id);
    return { entry: request, ok };
  }, (request) => workspace.save(request));
}

function deleteCollection(id) {
  deleteWithUndo(() => {
    const { collection, ok } = savedCollections.remove(id);
    return { entry: collection, ok };
  }, (collection) => savedCollections.save(collection));
}

function requestRow(request, selectedId) {
  return el('div', { class: 'req-row' }, [
    el('button', {
      class: `req-open${request.id === selectedId ? ' is-selected' : ''}`,
      type: 'button',
      title: request.name || request.id,
      on: { click: () => hooks.select(request) },
    }, [
      // Plain-text method, deliberately: no coloured method badges.
      el('span', { class: 'method', text: 'GET' }),
      ' ',
      el('span', { text: request.name || request.id }),
    ]),
    el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: '+',
      title: 'Add to the run sequence',
      on: { click: () => hooks.add(request) },
    }),
  ]);
}

function collectionNode(collection, selectedId) {
  const summary = el('summary', {}, [
    el('span', { class: 'collection-name', text: collection.name }),
    el('span', { class: 'badge', text: 'built-in' }),
  ]);
  const body = el('div', { class: 'collection-body' },
    collection.requests.map((r) => requestRow(r, selectedId)));
  const actions = el('div', { class: 'collection-actions' }, [
    el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: `Add all ${collection.requests.length} to run`,
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
function savedNode(collection) {
  const name = collection.name || 'Untitled';
  const summary = el('summary', {}, [
    el('span', { class: 'collection-name', text: name }),
    el('span', { class: 'badge', text: 'saved' }),
  ]);
  const body = el('div', { class: 'collection-body' }, collection.requests.map((r) => el('div', { class: 'req-row' }, [
    el('span', { class: 'method', text: 'GET' }),
    ' ',
    el('span', { text: r.name || r.id }),
  ])));
  const actions = el('div', { class: 'collection-actions' }, [
    el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: `Add all ${collection.requests.length} to run`,
      on: { click: () => hooks.addAll(collection) },
    }),
    ' ',
    el('button', {
      class: 'btn btn-mini',
      type: 'button',
      text: 'x',
      title: 'Delete this saved collection',
      attrs: { 'aria-label': `Delete saved collection "${name}"` },
      on: { click: () => deleteCollection(collection.id) },
    }),
  ]);
  const node = el('details', { class: 'collection' }, [summary, body, actions]);
  node.dataset.id = collection.id;
  return node;
}

// The saved collections are rebuilt only when the list itself changes: the
// status poll notifies every few seconds, and a long list rebuilt on each one
// would cost the page for nothing. Which ones are open is read back from the
// tree, as for the curated collections.
let lastSaved = null;

function renderSaved(list) {
  if (list === lastSaved) return;
  lastSaved = list;
  const tree = byId('saved-collections');
  const open = new Set();
  for (const node of tree.querySelectorAll('details[data-id]')) {
    if (node.open) open.add(node.dataset.id);
  }
  replace(tree, list.map((c) => {
    const node = savedNode(c);
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

export function render(state) {
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
    const node = collectionNode(c, state.selectedId);
    node.dataset.id = c.id;
    node.open = openCollections.has(c.id);
    return node;
  }));
  if (state.collections.length === 0) {
    replace(tree, [el('div', { class: 'tree-empty', text: 'Loading collections...' })]);
  }

  const ws = byId('workspace-tree');
  if (state.workspace.length === 0) {
    replace(ws, [el('div', {
      class: 'tree-empty',
      text: 'Empty. Editing a built-in request copies it here.',
    })]);
  } else {
    replace(ws, state.workspace.map((r) => {
      const row = requestRow(r, state.selectedId);
      row.appendChild(el('button', {
        class: 'btn btn-mini',
        type: 'button',
        text: 'x',
        title: 'Delete this saved request',
        on: { click: () => deleteRequest(r.id) },
      }));
      return row;
    }));
  }

  renderSaved(state.savedCollections);

  const hist = byId('history-list');
  // The five most recent runs, list and click-to-reopen only.
  const recent = state.history.slice(0, 5);
  if (recent.length === 0) {
    replace(hist, [el('div', { class: 'tree-empty', text: 'No runs yet.' })]);
  } else {
    replace(hist, recent.map(historyRow));
  }

  const name = byId('target-note-name');
  if (state.target && name.textContent !== state.target) name.textContent = state.target;
  const label = byId('target-label');
  const wanted = state.target ? `target: ${state.target}` : '';
  if (label.textContent !== wanted) label.textContent = wanted;
}

// selectRequest is the sidebar's half of selection: the editor owns the draft,
// but the tree owns which id is highlighted.
export function selectRequest(request) {
  set({ selectedId: request.id, draft: deepCopy(request), editorNotice: '' });
}
