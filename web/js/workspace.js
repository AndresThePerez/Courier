// workspace.js — the visitor's own copies of requests, persisted to
// localStorage, plus fork-on-write.
//
// Scope note: Addendum A3 defers fork-on-write beyond "the minimum needed to
// edit a request". That minimum is exactly this file: a curated request the
// visitor edits is deep-copied into the workspace with a fresh id and
// reselected, so the curated tree the next visitor sees is pristine. What is
// deferred is the product chrome around it — folders, renaming in the tree,
// duplicate detection, per-origin provenance badges, re-forking a fork.

import { get, set, deepCopy } from './store.js';

const KEY = 'courier.workspace.v1';
const VERSION = 1;

// load reads the saved workspace. Anything unparseable, wrong-version, or
// structurally wrong is discarded and the workspace starts empty: a visitor
// with a stale value from an older build gets a working page, not a white one.
export function load() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved || saved.version !== VERSION || !Array.isArray(saved.requests)) {
    return { counter: 0, requests: [] };
  }
  const requests = saved.requests.filter((r) => r && typeof r.id === 'string' && typeof r.endpoint === 'string');
  const counter = Number.isInteger(saved.counter) ? saved.counter : requests.length;
  return { counter, requests };
}

let counter = 0;

export function init() {
  const { counter: c, requests } = load();
  counter = c;
  set({ workspace: requests });
}

function persist(requests) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: VERSION, counter, requests }));
  } catch (err) {
    // A full or disabled localStorage must not break the page; the workspace
    // simply stops surviving a reload.
    console.warn('workspace not persisted', err);
  }
}

export function reset() {
  counter = 0;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
  set({ workspace: [] });
}

export function isWorkspaceId(id) {
  return typeof id === 'string' && id.startsWith('ws-');
}

export function find(id) {
  return get().workspace.find((r) => r.id === id) || null;
}

function nextId() {
  counter += 1;
  return `ws-${counter}`;
}

// save stores a workspace request, inserting or replacing by id, and returns
// the stored object.
export function save(request) {
  const copy = deepCopy(request);
  const list = get().workspace.slice();
  const i = list.findIndex((r) => r.id === copy.id);
  if (i >= 0) list[i] = copy;
  else list.push(copy);
  persist(list);
  set({ workspace: list });
  return copy;
}

// fork deep-copies a curated request into the workspace under a fresh id.
// This is the write half of fork-on-write; the editor calls it on the first
// edit of anything that is not already a workspace request.
export function fork(request) {
  const copy = deepCopy(request);
  copy.id = nextId();
  copy.name = `${request.name || 'Request'} (copy)`;
  return save(copy);
}

export function remove(id) {
  const list = get().workspace.filter((r) => r.id !== id);
  persist(list);
  set({ workspace: list });
}
