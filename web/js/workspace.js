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

// fitted shortens text to at most max UTF-16 units (the unit the stored name
// is cut in), dropping whole characters so no half of a pair is left.
function fitted(text, max) {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

export function createWorkspace({ storage: area, get, set, target = null, key = KEY }) {
  // The rules for what this tab may conclude from storage shared with other
  // tabs, and how changes merge into it, are createSyncedList's
  // (storage.js); this is what saved requests add on top.
  const list = storage.createSyncedList({
    storage: area,
    key,
    field: 'workspace',
    decode: (raw) => {
      const saved = decode(raw);
      return { items: saved.requests, extra: saved.counter };
    },
    encode,
    get,
    set,
    target,
    hooks: { published: closeIfDeletedElsewhere, removing: closeIfOpen, cleared: () => closeIfOpen() },
  });

  // closeIfDeletedElsewhere closes the open request once another tab has
  // deleted it. Left open, the editor would write it straight back on the
  // next keystroke, or keep showing a request the sidebar no longer lists.
  function closeIfDeletedElsewhere(isKnown) {
    const { draft, workspace } = get();
    if (!draft || !isKnown(draft.id) || workspace.some((r) => r.id === draft.id)) return;
    set({ draft: null, selectedId: null, editorNotice: DELETED_ELSEWHERE });
  }

  function closeIfOpen(id) {
    const { draft } = get();
    if (draft && (id === undefined ? isWorkspaceId(draft.id) : draft.id === id)) {
      set({ draft: null, selectedId: null });
    }
  }

  function load() {
    return { requests: list.load() };
  }

  // save stores a workspace request, inserting or replacing by id.
  function save(request) {
    const copy = deepCopy(request);
    return { ...list.save(copy), request: copy };
  }

  // fork deep-copies a curated request into the workspace under a fresh id.
  // This is the write half of fork-on-write; the editor calls it on the first
  // edit of anything that is not already a workspace request.
  function fork(request) {
    const copy = deepCopy(request);
    copy.id = storage.randomId('ws-');
    copy.name = copyName(request.name || 'Request');
    return save(copy);
  }

  // copyName numbers a fork so two copies of one request can be told apart in
  // the sidebar. Names stored by another tab count as taken too, even before
  // its storage event has arrived. A stored name is cut to the name cap on
  // every read, so the suffix is kept whole and the base is shortened
  // instead: cut, two numbered copies of one long name would read the same.
  function copyName(base) {
    const lists = [get().workspace, list.load()];
    const taken = new Set(lists.flat().map((req) => req.name));
    const named = (suffix) => `${fitted(base, storage.MaxName - suffix.length)}${suffix}`;
    if (!taken.has(named(' (copy)'))) return named(' (copy)');
    let n = 2;
    while (taken.has(named(` (copy ${n})`))) n += 1;
    return named(` (copy ${n})`);
  }

  // remove deletes a request and closes it if it is open, returning what was
  // deleted so the caller can offer it back.
  function remove(id) {
    const { item, ...result } = list.remove(id);
    return { ...result, request: item };
  }

  const { init, stop, find, reset, queued } = list;
  return { load, init, stop, find, save, fork, remove, reset, queued };
}

const page = createWorkspace({
  storage: () => globalThis.localStorage,
  get: storeGet,
  set: storeSet,
  target: globalThis,
});

export const { load, init, stop, find, save, fork, remove, reset } = page;
