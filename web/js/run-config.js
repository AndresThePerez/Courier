// run-config.js — the run setup (sequence, mode and options) kept in this
// browser, so a reload does not throw away a run the visitor configured, and
// run sequences the visitor saved as collections.
//
// The server stores none of it and is not asked to: this is the visitor's
// data, in this browser's localStorage, and every request restored from it is
// validated by the server like any other when a run starts.

import * as storage from './storage.js';

const SETUP_KEY = 'courier.runner.v1';
const SAVED_LIST = 'courier.collections.v1';
const VERSION = 1;

export const SETUP_REFUSED = 'Could not save the run setup in this browser.';

const MODES = ['functional', 'performance'];

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// requestOf rebuilds a stored request from the fields a run sends and nothing
// else, or answers null when any of them is malformed. A stored value is
// whatever the browser hands back, so a url, host or method smuggled into it
// must not survive into the page: a run's payload is built from these fields
// alone, and an unknown endpoint id is refused by the server's catalog.
export function requestOf(value) {
  if (!isPlain(value)) return null;
  const { id, endpoint } = value;
  const name = value.name ?? '';
  const params = value.params ?? {};
  const assertions = value.assertions ?? [];
  if (typeof id !== 'string' || id === '' || typeof endpoint !== 'string' || endpoint === '') return null;
  if (typeof name !== 'string') return null;
  if (!isPlain(params) || !Object.values(params).every((p) => typeof p === 'string')) return null;
  if (!Array.isArray(assertions) || !assertions.every(isPlain)) return null;
  return { id, name, endpoint, params: { ...params }, assertions: assertions.map((a) => ({ ...a })) };
}

// clampOption is the run-config inputs' rule, and a stored option's: under
// the floor (or not a number) falls back to the default, over the cap is
// pulled down to the cap.
export function clampOption(limits, key, raw) {
  const { lo, hi, fallback } = limits[key];
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < lo) return fallback;
  return n > hi ? hi : n;
}

function optionsOf(limits, value) {
  const stored = isPlain(value) ? value : {};
  const options = { stop_on_failure: stored.stop_on_failure === true };
  for (const key of Object.keys(limits)) options[key] = clampOption(limits, key, stored[key]);
  return options;
}

// createRunConfig reads and writes the run setup over one storage. limits and
// maxSequence are the runner's own caps, so a stored setup can never hold
// more than the page lets a visitor build.
//
// Across tabs the setup is one whole value, last writer wins, and it is read
// once when the page loads and never adopted from another tab's storage
// event: a second tab must not have its queued sequence replaced under the
// visitor's hands. A refused read loads the defaults; a refused write leaves
// the page as it is and is reported by save().
export function createRunConfig({ storage: area, limits, maxSequence }) {
  let counter = 0;

  function decode(raw) {
    const saved = storage.parseJSON(raw);
    const ok = isPlain(saved) && saved.version === VERSION;
    const entries = ok && Array.isArray(saved.sequence) ? saved.sequence : [];
    const sequence = [];
    for (const e of entries) {
      if (sequence.length >= maxSequence) break;
      if (!isPlain(e) || typeof e.enabled !== 'boolean') continue;
      const request = requestOf(e.request);
      if (!request) continue;
      counter += 1;
      sequence.push({ key: `seq-r${counter}`, enabled: e.enabled, request });
    }
    return {
      sequence,
      mode: ok && MODES.includes(saved.mode) ? saved.mode : MODES[0],
      options: optionsOf(limits, ok ? saved.options : null),
    };
  }

  function load() {
    const r = storage.read(area, SETUP_KEY);
    return decode(r.ok ? r.value : null);
  }

  // save stores the setup whole and returns { ok }.
  function save({ sequence, mode, options }) {
    const value = {
      version: VERSION,
      sequence: sequence.map((e) => ({ enabled: e.enabled, request: e.request })),
      mode,
      options,
    };
    const written = storage.write(area, SETUP_KEY, JSON.stringify(value));
    if (!written.ok) console.warn('run setup not persisted', written.error);
    return { ok: written.ok };
  }

  return { load, save };
}


// MaxCollectionName matches the editor's name field.
export const MaxCollectionName = 120;

// createSavedCollections keeps the visitor's saved sequences, a list shared by
// every tab and merged by id under the same rules as saved requests
// (createSyncedList in storage.js), published as state.savedCollections.
//
// A saved collection holds copies of the requests as they were queued, never
// references: deleting a saved request, or the collection itself, leaves
// whatever is queued alone, and adding one to the run copies it again.
// maxRequests is the runner's cap; a stored collection holding more is cut to
// it, since no more than that could ever be added to a run.
export function createSavedCollections({ storage: area, get, set, target = null, maxRequests }) {
  function collectionOf(value) {
    if (!isPlain(value)) return null;
    const { id, name, requests } = value;
    if (typeof id !== 'string' || id === '' || typeof name !== 'string' || !Array.isArray(requests)) return null;
    const kept = [];
    for (const r of requests) {
      if (kept.length >= maxRequests) break;
      const request = requestOf(r);
      if (request) kept.push(request);
    }
    return { id, name: name.slice(0, MaxCollectionName), requests: kept };
  }

  function decode(raw) {
    const saved = storage.parseJSON(raw);
    if (!isPlain(saved) || saved.version !== VERSION || !Array.isArray(saved.collections)) return { items: [] };
    return { items: saved.collections.map(collectionOf).filter(Boolean) };
  }

  const encode = (collections) => JSON.stringify({ version: VERSION, collections });

  const list = storage.createSyncedList({ storage: area, key: SAVED_LIST, field: 'savedCollections', decode, encode, get, set, target });

  const named = ({ item, ...result }) => ({ ...result, collection: item });

  // create saves requests as a new collection under a fresh id.
  function create(name, requests) {
    const collection = collectionOf({ id: storage.randomId('wc-'), name: String(name).trim(), requests });
    return { ...list.save(collection), collection };
  }

  // save stores a collection again by id; the Undo of a delete.
  function save(collection) {
    const copy = collectionOf(collection);
    if (!copy) return { ok: false, deleted: false, collection: null };
    return { ...list.save(copy), collection: copy };
  }

  const remove = (id) => named(list.remove(id));

  const { init, stop, load, find, reset, queued } = list;
  return { init, stop, load, find, create, save, remove, reset, queued };
}
