// workspace.js — the visitor's own copies of requests, persisted to
// localStorage, plus fork-on-write.
//
// Scope note: fork-on-write is deliberately limited to "the minimum needed to
// edit a request". That minimum is exactly this file: a curated request the
// visitor edits is deep-copied into the workspace with a fresh id and
// reselected, so the curated tree the next visitor sees is pristine. What is
// deferred is the product chrome around it — folders, renaming in the tree,
// duplicate detection, per-origin provenance badges, re-forking a fork.
//
// Several tabs of the page share one stored value, so the workspace is a
// factory: each page (or each simulated tab in the tests) is an instance over
// a storage, a state get/set pair and the window its storage events arrive on.
// The module-level functions are the page's own instance.

import { get as storeGet, set as storeSet, deepCopy } from './store.js';
import * as storage from './storage.js';

const KEY = 'courier.workspace.v1';
const VERSION = 1;

export const DELETED_ELSEWHERE = 'This request was deleted in another tab.';
export const WRITE_REFUSED = 'Could not save - this browser refused the write (storage full or disabled). The change stays on this page until you reload.';

export function isWorkspaceId(id) {
  return typeof id === 'string' && id.startsWith('ws-');
}

// decode reads a stored value. Anything unparseable, wrong-version, or
// structurally wrong is discarded and the workspace starts empty: a visitor
// with a stale value from an older build gets a working page, not a white one.
function decode(raw) {
  const saved = storage.parseJSON(raw);
  if (!saved || saved.version !== VERSION || !Array.isArray(saved.requests)) {
    return { counter: 0, requests: [] };
  }
  const requests = saved.requests.filter((r) => r && typeof r.id === 'string' && typeof r.endpoint === 'string');
  return { counter: legacyCounter(saved.counter, requests), requests };
}

// legacyCounter keeps the counter older builds numbered their ws-N ids from.
// Ids are random now, but a page loaded before that change may still be open
// in another tab, and it would hand out ws-N again from a counter that went
// backwards — reusing the id of a request that still exists.
function legacyCounter(counter, requests) {
  let n = Number.isInteger(counter) && counter > 0 ? counter : 0;
  for (const r of requests) {
    const m = /^ws-(\d+)$/.exec(r.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n;
}

function encode(requests, counter) {
  const value = { version: VERSION, requests };
  if (counter > 0) value.counter = counter;
  return JSON.stringify(value);
}

// randomId gives two tabs forking at the same moment different ids without
// any coordination between them. randomUUID needs a secure context, so the
// fallbacks keep a page served over plain http working.
function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `ws-${c.randomUUID()}`;
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return `ws-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export function createWorkspace({ storage: area, get, set, target = null, key = KEY }) {
  // known is every id this tab has seen in storage and not deleted itself. A
  // write that finds one of them gone from storage is editing a request
  // another tab deleted, and must not bring it back.
  let known = new Set();
  // stored is the list as this tab last read or wrote it. pending is this
  // tab's changes the browser refused to store, oldest first: they stay on the
  // page and ride along with the next write the browser accepts, so storage
  // that frees up (or a storage event from another tab) loses none of them.
  let stored = [];
  let pending = [];
  let unsubscribe = null;

  function load() {
    const r = storage.read(area, key);
    return { requests: r.ok ? decode(r.value).requests : [] };
  }

  function init() {
    stop();
    const { requests } = load();
    known = new Set(requests.map((r) => r.id));
    stored = requests;
    pending = [];
    set({ workspace: requests });
    if (target) unsubscribe = storage.subscribe(target, area, key, onExternal);
  }

  function stop() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  function onExternal(raw) {
    const { requests } = decode(raw);
    for (const r of requests) known.add(r.id);
    stored = requests;
    publish(applyAll(stored, pending));
  }

  // closeIfDeletedElsewhere closes the open request once another tab has
  // deleted it. Left open, the editor would write it straight back on the
  // next keystroke, or keep showing a request the sidebar no longer lists.
  function closeIfDeletedElsewhere() {
    const { draft, workspace } = get();
    if (!draft || !known.has(draft.id) || workspace.some((r) => r.id === draft.id)) return;
    set({ draft: null, selectedId: null, editorNotice: DELETED_ELSEWHERE });
  }

  function closeIfOpen(id) {
    const { draft } = get();
    if (draft && (id === undefined ? isWorkspaceId(draft.id) : draft.id === id)) {
      set({ draft: null, selectedId: null });
    }
  }

  // apply folds one change into a list.
  //
  // Merge rules, because two tabs can change the same stored value:
  //   - Changes merge by id into the value as stored now; a tab never writes
  //     its whole loaded list back, so another tab's requests survive.
  //   - Two tabs editing the same request: the last write wins for that
  //     request, whole. Requests are small and edited by one person, so a
  //     field-level merge would buy nothing a visitor could tell apart.
  //   - Delete against edit of the same request: the delete wins whichever
  //     came first, so a request deleted in one tab is never resurrected by a
  //     keystroke in another that had not yet heard about it.
  function apply(list, op) {
    const out = list.slice();
    if (op.type === 'remove') return { list: out.filter((r) => r.id !== op.id), blocked: false };
    const i = out.findIndex((r) => r.id === op.request.id);
    if (i >= 0) out[i] = op.request;
    else if (known.has(op.request.id)) return { list: out, blocked: true };
    else out.push(op.request);
    return { list: out, blocked: false };
  }

  function applyAll(list, ops) {
    let out = list;
    const blocked = new Set();
    let changed = false;
    for (const op of ops) {
      const r = apply(out, op);
      out = r.list;
      if (r.blocked) blocked.add(op.request.id);
      else changed = true;
    }
    return { list: out, blocked, changed };
  }

  // publish shows the merged list and forgets changes that lost to a delete.
  function publish(result) {
    pending = pending.filter((op) => op.type !== 'save' || !result.blocked.has(op.request.id));
    set({ workspace: result.list });
    closeIfDeletedElsewhere();
  }

  // commit stores one change and returns { ok, deleted }: ok only when the
  // browser accepted the write, deleted when the change lost to a delete made
  // in another tab.
  function commit(op) {
    pending.push(op);
    let result = null;
    const written = storage.update(area, key, (raw) => {
      const saved = decode(raw);
      result = applyAll(saved.requests, pending);
      return result.changed ? encode(result.list, saved.counter) : undefined;
    });
    if (!written.read.ok) {
      // A store that cannot be read cannot be merged into, so nothing was
      // written; the page carries on from what this tab last saw.
      result = applyAll(stored, pending);
    } else if (!written.ok) {
      stored = decode(written.read.value).requests;
      console.warn('workspace not persisted', written.error);
    } else {
      stored = result.list;
      for (const p of pending) if (p.type === 'save' && !result.blocked.has(p.request.id)) known.add(p.request.id);
      pending = [];
    }
    const deleted = op.type === 'save' && result.blocked.has(op.request.id);
    publish(result);
    return { ok: written.ok && !deleted, deleted };
  }

  function find(id) {
    return get().workspace.find((r) => r.id === id) || null;
  }

  // save stores a workspace request, inserting or replacing by id.
  function save(request) {
    const copy = deepCopy(request);
    return { ...commit({ type: 'save', request: copy }), request: copy };
  }

  // fork deep-copies a curated request into the workspace under a fresh id.
  // This is the write half of fork-on-write; the editor calls it on the first
  // edit of anything that is not already a workspace request.
  function fork(request) {
    const copy = deepCopy(request);
    copy.id = randomId();
    copy.name = `${request.name || 'Request'} (copy)`;
    return save(copy);
  }

  // remove deletes a request and closes it if it is open, returning what was
  // deleted so the caller can offer it back.
  function remove(id) {
    const request = find(id);
    known.delete(id);
    closeIfOpen(id);
    return { ...commit({ type: 'remove', id }), request };
  }

  function reset() {
    known = new Set();
    stored = [];
    pending = [];
    storage.remove(area, key);
    closeIfOpen();
    set({ workspace: [] });
  }

  return { load, init, stop, find, save, fork, remove, reset };
}

const page = createWorkspace({
  storage: () => globalThis.localStorage,
  get: storeGet,
  set: storeSet,
  target: globalThis,
});

export const { load, init, stop, find, save, fork, remove, reset } = page;
