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
export const RESET_REFUSED = 'Could not reset - this browser refused the write (storage full or disabled). Your saved requests are unchanged.';

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
  // What this tab may conclude from storage, because two tabs share it and
  // either may be refused a read or a write at any moment:
  //
  //   1. Only a current read counts. A storage event's newValue, or anything
  //      else of unknown age, never replaces what this tab knows; when the
  //      read is refused, the tab keeps its view until a read succeeds.
  //   2. A request this tab deleted stays deleted by this tab until this tab
  //      stores it again (Undo), or a current read lists it while this tab
  //      has no delete of it waiting. Until then, its Undo is never refused
  //      as "deleted in another tab". An Undo that comes before storage
  //      accepted the delete withdraws the delete instead, and the request is
  //      again one this tab knows (rule 3).
  //   3. "Deleted in another tab" is concluded only from a current read that
  //      lacks a request this tab saw in an earlier current read or stored
  //      itself, and that this tab did not delete. A request this tab has
  //      only queued has never been stored, so its absence proves nothing.
  //   4. Changes the browser refused are this tab's intent: one per request,
  //      replayed over every current read, and dropped only when the request
  //      was deleted in another tab (the delete wins), which closes it with a
  //      notice if it is open.
  //
  // known holds the requests of rule 3, deletedHere those of rule 2; no id is
  // in both. stored is the list as of the last current read or accepted
  // write, and pending the refused changes of rule 4, oldest first.
  let known = new Set();
  let deletedHere = new Set();
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
    deletedHere = new Set();
    stored = requests;
    pending = [];
    set({ workspace: requests });
    if (target) unsubscribe = storage.subscribe(target, area, key, onExternal);
  }

  function stop() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  const removing = (id) => pending.some((op) => op.type === 'remove' && op.id === id);

  // observe takes in one current read (rules 2 and 3).
  function observe(requests) {
    for (const r of requests) {
      if (deletedHere.has(r.id)) {
        if (removing(r.id)) continue;
        deletedHere.delete(r.id);
      }
      known.add(r.id);
    }
    stored = requests;
  }

  function onExternal(raw) {
    observe(decode(raw).requests);
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

  const opId = (op) => (op.type === 'remove' ? op.id : op.request.id);

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
    // Only the latest change per request matters, and every keystroke is a
    // change: without this a store that stays unwritable would grow the
    // queue, and the cost of every later write, by one entry per keystroke.
    const id = opId(op);
    const replaced = pending.find((p) => opId(p) === id);
    if (op.type === 'save' && replaced && replaced.type === 'remove') withdraw(replaced);
    pending = pending.filter((p) => p !== replaced);
    pending.push(op);
    let result = null;
    const written = storage.update(area, key, (raw) => {
      const saved = decode(raw);
      observe(saved.requests);
      result = applyAll(saved.requests, pending);
      return result.changed ? encode(result.list, saved.counter) : undefined;
    });
    if (!written.read.ok) {
      // A store that cannot be read cannot be merged into, so nothing was
      // written; the page carries on from what this tab last saw.
      result = applyAll(stored, pending);
    } else if (!written.ok) {
      console.warn('workspace not persisted', written.error);
    } else {
      stored = result.list;
      for (const p of pending) {
        if (p.type !== 'save' || result.blocked.has(p.request.id)) continue;
        known.add(p.request.id);
        deletedHere.delete(p.request.id);
      }
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
    copy.name = copyName(request.name || 'Request');
    return save(copy);
  }

  // copyName numbers a fork so two copies of one request can be told apart in
  // the sidebar. Names stored by another tab count as taken too, even before
  // its storage event has arrived.
  function copyName(base) {
    const r = storage.read(area, key);
    const lists = [get().workspace, r.ok ? decode(r.value).requests : []];
    const taken = new Set(lists.flat().map((req) => req.name));
    if (!taken.has(`${base} (copy)`)) return `${base} (copy)`;
    let n = 2;
    while (taken.has(`${base} (copy ${n})`)) n += 1;
    return `${base} (copy ${n})`;
  }

  // remove deletes a request and closes it if it is open, returning what was
  // deleted so the caller can offer it back.
  function remove(id) {
    const request = find(id);
    const wasKnown = known.has(id);
    known.delete(id);
    deletedHere.add(id);
    closeIfOpen(id);
    return { ...commit({ type: 'remove', id, wasKnown }), request };
  }

  // withdraw takes back a delete storage never saw, for an Undo that came
  // before the browser accepted it: the tab is back where it was before the
  // delete, so a delete made in another tab meanwhile wins over the Undo, as
  // it would over any edit.
  function withdraw(op) {
    deletedHere.delete(op.id);
    if (op.wasKnown) known.add(op.id);
  }

  // reset clears the stored workspace and returns { ok }. A refused removal
  // leaves everything as it was: clearing only this page would show an empty
  // list that the next accepted write quietly merges the stored requests back
  // into.
  function reset() {
    const removed = storage.remove(area, key);
    if (!removed.ok) {
      console.warn('workspace not reset', removed.error);
      return { ok: false };
    }
    known = new Set();
    deletedHere = new Set();
    stored = [];
    pending = [];
    closeIfOpen();
    set({ workspace: [] });
    return { ok: true };
  }

  // queued is how many changes are waiting for the browser to accept a write.
  function queued() {
    return pending.length;
  }

  return { load, init, stop, find, save, fork, remove, reset, queued };
}

const page = createWorkspace({
  storage: () => globalThis.localStorage,
  get: storeGet,
  set: storeSet,
  target: globalThis,
});

export const { load, init, stop, find, save, fork, remove, reset } = page;
