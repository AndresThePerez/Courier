// storage.js — reading, writing and following one localStorage key, for any
// module that keeps visitor data in this browser.
//
// Every call here answers instead of throwing. A browser can refuse storage at
// any of these points (disabled storage throws on the localStorage getter
// itself, a full one throws on setItem, a privacy mode on getItem), and a page
// whose saved data cannot be read or written must still work.
//
// The storage is passed in, either as the object or as a function returning
// it, so tests can run two "tabs" over one fake storage and the page can defer
// touching window.localStorage until it is actually needed.

function resolve(storage) {
  return typeof storage === 'function' ? storage() : storage;
}

// read returns { ok: true, value } with the raw string (null when the key is
// absent) or { ok: false, error } when the browser refused the read.
export function read(storage, key) {
  try {
    return { ok: true, value: resolve(storage).getItem(key) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function write(storage, key, value) {
  try {
    resolve(storage).setItem(key, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function remove(storage, key) {
  try {
    resolve(storage).removeItem(key);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

// parseJSON never throws: anything that is not JSON reads as null, the same as
// an absent key.
export function parseJSON(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// update is the only safe way for two tabs to share a key: it re-reads the
// value as it is now and writes fn(current) in the same synchronous turn, so a
// tab never writes back a copy it loaded minutes ago over another tab's
// changes. localStorage has no compare-and-set; nothing else on this page can
// run between the read and the write, which is as strong as synchronous
// storage allows.
//
// When the read is refused nothing is written: merging into a value we could
// not see would overwrite whatever another tab stored. fn returning undefined
// writes nothing. The result says which step failed:
// { ok, read: { ok, value }, value?, error? }.
export function update(storage, key, fn) {
  const current = read(storage, key);
  if (!current.ok) return { ok: false, read: current, error: current.error };
  const next = fn(current.value);
  if (next === undefined) return { ok: true, read: current, value: current.value };
  const written = write(storage, key, next);
  return { ok: written.ok, read: current, value: next, error: written.error };
}

// subscribe calls fn(value) whenever another tab changes key. A browser fires
// `storage` only in the other tabs, never in the one that wrote. A clear()
// elsewhere arrives with key null and counts as the key removed; events for
// another storage area (sessionStorage) are ignored.
//
// The event is queued after the shared value has changed, and this page may
// have written in between, so its newValue can be older than what is stored.
// The value handed on is therefore always the key as stored now. When the
// browser refuses that read, fn is not called: a value of unknown age must
// never stand in for what is stored, and the next read that succeeds catches
// up anyway.
export function subscribe(target, storage, key, fn) {
  const onStorage = (event) => {
    if (event.key !== key && event.key !== null) return;
    if (event.storageArea) {
      let area = null;
      try {
        area = resolve(storage);
      } catch {
        return;
      }
      if (event.storageArea !== area) return;
    }
    const now = read(storage, key);
    if (now.ok) fn(now.value);
  };
  target.addEventListener('storage', onStorage);
  return () => target.removeEventListener('storage', onStorage);
}

// randomId gives two tabs creating an entry at the same moment different ids
// without any coordination between them. randomUUID needs a secure context,
// so the fallbacks keep a page served over plain http working.
export function randomId(prefix) {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `${prefix}${c.randomUUID()}`;
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return `${prefix}${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------- stored requests

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// assertionOps is internal/assert's matrix, the same one the editor offers:
// the only types and operators an assertion the page built can carry.
const assertionOps = {
  status: ['eq', 'neq'],
  latency: ['lt'],
  json: ['eq', 'neq', 'gt', 'lt', 'exists', 'contains', 'count'],
  body_contains: ['contains'],
};

// What a restored request is cut to, and what it is not. A name is cut to 120
// characters and a parameter value to 500, exactly as the server cuts them, so
// the cut changes nothing a run would have sent; a request keeps its first 20
// assertions, the editor's cap. An assertion's path and value are never cut:
// the editor accepts them at any length, and a shortened one would check
// something the visitor did not write, so an over-long one goes out whole and
// is refused by field. Ids and parameter names are the page's or the catalog's
// and are short; one past these bounds was not made by the page.
export const MaxStoredAssertions = 20;
const MaxParamValue = 500;
const MaxName = 120;
const MaxId = 200;
const MaxParams = 32;
const MaxParamKey = 64;

const isId = (v, max) => typeof v === 'string' && v !== '' && v.length <= max;

// requestOf rebuilds a request read back from this browser, or answers null
// when it cannot be one. Every stored request goes through it before the page
// shows, queues or sends it: saved requests, the run setup, saved collections.
//
// A stored value is whatever the browser hands back, and another script on
// the origin, an older build or a damaged profile may have written it. So the
// result holds only the fields the page itself writes, each one a primitive of
// the kind the editor produces, or a container rebuilt from such primitives;
// nothing from the stored value is kept by reference. That is what stops a stored url, host or method reaching a run's
// payload, and a value nested deeper than the page can print or encode
// wedging it. A request the editor built comes back unchanged.
export function requestOf(value) {
  if (!isPlain(value)) return null;
  const { id, endpoint } = value;
  const name = value.name ?? '';
  const stored = value.assertions ?? [];
  if (!isId(id, MaxId) || !isId(endpoint, MaxId) || typeof name !== 'string') return null;
  const params = paramsOf(value.params ?? {});
  if (!params || !Array.isArray(stored) || !stored.every(isPlain)) return null;
  const assertions = [];
  for (const a of stored) {
    if (assertions.length >= MaxStoredAssertions) break;
    const rebuilt = assertionOf(a);
    if (rebuilt) assertions.push(rebuilt);
  }
  return { id, name: name.slice(0, MaxName), endpoint, params, assertions };
}

// paramsOf answers null for anything but string values under short names,
// which is all the editor's parameter table can produce. fromEntries keeps a
// "__proto__" name as data.
function paramsOf(value) {
  if (!isPlain(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MaxParams) return null;
  if (!entries.every(([k, v]) => isId(k, MaxParamKey) && typeof v === 'string')) return null;
  return Object.fromEntries(entries.map(([k, v]) => [k, v.slice(0, MaxParamValue)]));
}

// assertionOf drops an assertion whose type or operator the page does not
// know. Its path is kept only on a json assertion; its value only as a string
// (or, outside body_contains, a finite number). Both are kept whole: text
// cannot nest, so its length is no risk to the page. Keys keep their stored
// order, so a saved request reads back exactly as it was written.
function assertionOf(a) {
  const { type, op } = a;
  if (typeof type !== 'string' || !Object.hasOwn(assertionOps, type)) return null;
  if (typeof op !== 'string' || !assertionOps[type].includes(op)) return null;
  const out = {};
  for (const key of Object.keys(a)) {
    if (key === 'type') out.type = type;
    else if (key === 'op') out.op = op;
    else if (key === 'path' && type === 'json' && typeof a.path === 'string') out.path = a.path;
    else if (key === 'value' && typeof a.value === 'string') out.value = a.value;
    else if (key === 'value' && type !== 'body_contains' && Number.isFinite(a.value)) out.value = a.value;
  }
  return out;
}

// removeKey is remove under a name createSyncedList does not shadow.
const removeKey = remove;

// createSyncedList keeps one list of entries with string ids in one key that
// every tab of the page shares, and publishes it into state[field]. Each list
// the visitor owns in this browser (saved requests, saved collections) is an
// instance of it, so they all keep the same rules below.
//
// decode(raw) turns a stored string into { items, extra } and never throws;
// whatever it cannot use is dropped, and an unusable value reads as an empty
// list. extra is whatever else the value carries, handed back to
// encode(items, extra) so a write keeps it. hooks lets the owner react to the
// list: published(isKnown) after every change shown, removing(id) when this tab
// deletes an entry, cleared() after an accepted reset.
export function createSyncedList({ storage: area, key, field, decode, encode, get, set, target = null, hooks = {} }) {
  // What this tab may conclude from storage, because two tabs share it and
  // either may be refused a read or a write at any moment:
  //
  //   1. Only a current read counts. A storage event's newValue, or anything
  //      else of unknown age, never replaces what this tab knows; when the
  //      read is refused, the tab keeps its view until a read succeeds.
  //   2. An entry this tab deleted stays deleted by this tab until this tab
  //      stores it again (Undo), or a current read lists it while this tab
  //      has no delete of it waiting. Until then, its Undo is never refused
  //      as "deleted in another tab". An Undo that comes before storage
  //      accepted the delete withdraws the delete instead, and the entry is
  //      again one this tab knows (rule 3).
  //   3. "Deleted in another tab" is concluded only from a current read that
  //      lacks an entry this tab saw in an earlier current read or stored
  //      itself, and that this tab did not delete. An entry this tab has
  //      only queued has never been stored, so its absence proves nothing.
  //   4. Changes the browser refused are this tab's intent: one per entry,
  //      replayed over every current read, and dropped only when the entry
  //      was deleted in another tab (the delete wins), which the published
  //      hook can tell the visitor about.
  //
  // known holds the entries of rule 3, deletedHere those of rule 2; no id is
  // in both. stored is the list as of the last current read or accepted
  // write, and pending the refused changes of rule 4, oldest first.
  let known = new Set();
  let deletedHere = new Set();
  let stored = [];
  let pending = [];
  let unsubscribe = null;

  function load() {
    const r = read(area, key);
    return r.ok ? decode(r.value).items : [];
  }

  function init() {
    stop();
    const items = load();
    known = new Set(items.map((r) => r.id));
    deletedHere = new Set();
    stored = items;
    pending = [];
    set({ [field]: items });
    if (target) unsubscribe = subscribe(target, area, key, onExternal);
  }

  function stop() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  const removing = (id) => pending.some((op) => op.type === 'remove' && op.id === id);

  // observe takes in one current read (rules 2 and 3).
  function observe(items) {
    for (const r of items) {
      if (deletedHere.has(r.id)) {
        if (removing(r.id)) continue;
        deletedHere.delete(r.id);
      }
      known.add(r.id);
    }
    stored = items;
  }

  function onExternal(raw) {
    observe(decode(raw).items);
    publish(applyAll(stored, pending));
  }

  // apply folds one change into a list.
  //
  // Merge rules, because two tabs can change the same stored value:
  //   - Changes merge by id into the value as stored now; a tab never writes
  //     its whole loaded list back, so another tab's entries survive.
  //   - Two tabs editing the same entry: the last write wins for that entry,
  //     whole. Entries are small and edited by one person, so a field-level
  //     merge would buy nothing a visitor could tell apart.
  //   - Delete against edit of the same entry: the delete wins whichever came
  //     first, so an entry deleted in one tab is never resurrected by a
  //     keystroke in another that had not yet heard about it.
  function apply(list, op) {
    const out = list.slice();
    if (op.type === 'remove') return { list: out.filter((r) => r.id !== op.id), blocked: false };
    const i = out.findIndex((r) => r.id === op.item.id);
    if (i >= 0) out[i] = op.item;
    else if (known.has(op.item.id)) return { list: out, blocked: true };
    else out.push(op.item);
    return { list: out, blocked: false };
  }

  const opId = (op) => (op.type === 'remove' ? op.id : op.item.id);

  function applyAll(list, ops) {
    let out = list;
    const blocked = new Set();
    let changed = false;
    for (const op of ops) {
      const r = apply(out, op);
      out = r.list;
      if (r.blocked) blocked.add(op.item.id);
      else changed = true;
    }
    return { list: out, blocked, changed };
  }

  // publish shows the merged list and forgets changes that lost to a delete.
  function publish(result) {
    pending = pending.filter((op) => op.type !== 'save' || !result.blocked.has(op.item.id));
    set({ [field]: result.list });
    if (hooks.published) hooks.published((id) => known.has(id));
  }

  // commit stores one change and returns { ok, deleted }: ok only when the
  // browser accepted the write, deleted when the change lost to a delete made
  // in another tab.
  function commit(op) {
    // An entry that cannot be encoded can never be written. Queued, it would
    // make every later write of this list throw, and be retried each time; so
    // it is refused here, before it joins anything.
    if (op.type === 'save' && !encodable(op.item)) return { ok: false, deleted: false };
    // Only the latest change per entry matters, and every keystroke is a
    // change: without this a store that stays unwritable would grow the
    // queue, and the cost of every later write, by one entry per keystroke.
    const id = opId(op);
    const replaced = pending.find((p) => opId(p) === id);
    if (op.type === 'save' && replaced && replaced.type === 'remove') withdraw(replaced);
    pending = pending.filter((p) => p !== replaced);
    pending.push(op);
    let result = null;
    const written = update(area, key, (raw) => {
      const saved = decode(raw);
      observe(saved.items);
      result = applyAll(saved.items, pending);
      return result.changed ? encode(result.list, saved.extra) : undefined;
    });
    if (!written.read.ok) {
      // A store that cannot be read cannot be merged into, so nothing was
      // written; the page carries on from what this tab last saw.
      result = applyAll(stored, pending);
    } else if (!written.ok) {
      console.warn(`${key} not persisted`, written.error);
    } else {
      stored = result.list;
      for (const p of pending) {
        if (p.type !== 'save' || result.blocked.has(p.item.id)) continue;
        known.add(p.item.id);
        deletedHere.delete(p.item.id);
      }
      pending = [];
    }
    const deleted = op.type === 'save' && result.blocked.has(op.item.id);
    publish(result);
    return { ok: written.ok && !deleted, deleted };
  }

  function encodable(item) {
    try {
      encode([item]);
      return true;
    } catch (error) {
      console.warn(`${key} entry not persisted`, error);
      return false;
    }
  }

  function find(id) {
    return get()[field].find((r) => r.id === id) || null;
  }

  // save stores an entry, inserting or replacing by id. The caller hands over
  // an entry nothing else holds.
  function save(item) {
    return commit({ type: 'save', item });
  }

  // remove deletes an entry, returning what was deleted so the caller can
  // offer it back.
  function remove(id) {
    const item = find(id);
    const wasKnown = known.has(id);
    known.delete(id);
    deletedHere.add(id);
    if (hooks.removing) hooks.removing(id);
    return { ...commit({ type: 'remove', id, wasKnown }), item };
  }

  // withdraw takes back a delete storage never saw, for an Undo that came
  // before the browser accepted it: the tab is back where it was before the
  // delete, so a delete made in another tab meanwhile wins over the Undo, as
  // it would over any edit.
  function withdraw(op) {
    deletedHere.delete(op.id);
    if (op.wasKnown) known.add(op.id);
  }

  // reset clears the stored list and returns { ok }. A refused removal leaves
  // everything as it was: clearing only this page would show an empty list
  // that the next accepted write quietly merges the stored entries back into.
  function reset() {
    const removed = removeKey(area, key);
    if (!removed.ok) {
      console.warn(`${key} not reset`, removed.error);
      return { ok: false };
    }
    known = new Set();
    deletedHere = new Set();
    stored = [];
    pending = [];
    if (hooks.cleared) hooks.cleared();
    set({ [field]: [] });
    return { ok: true };
  }

  // queued is how many changes are waiting for the browser to accept a write.
  function queued() {
    return pending.length;
  }

  return { load, init, stop, find, save, remove, reset, queued };
}
