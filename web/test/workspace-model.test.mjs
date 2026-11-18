// Saved requests driven through orderings nobody wrote down: two or three tabs
// over one shared storage take random turns saving, editing, deleting,
// undoing, forking, resetting, receiving (or not yet receiving) each other's
// storage events, while the browser refuses writes or reads on and off. The
// test keeps its own record of what every tab asked for and checks the
// workspace against it after every turn and once everything has healed.
//
// Every ordering is one a browser can produce: the shared value changes
// first, its event is queued for each other tab, and that tab may act before
// the event is delivered. Sequences come from fixed seeds, so a failure prints
// the seed and the turns that led to it and replays exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage, StorageEvent } from './shim.mjs';
import * as workspace from '../js/workspace.js';

const KEY = 'courier.workspace.v1';
const DELETED_ELSEWHERE = 'This request was deleted in another tab.';
const curated = { id: 'search-pikachu', name: 'Search pikachu', endpoint: 'search', params: { q: 'pikachu' }, assertions: [] };

// mulberry32: a small seeded generator, so every sequence replays exactly.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const storedList = (shared) => {
  const raw = shared.peek(KEY);
  if (raw === null) return [];
  return JSON.parse(raw).requests;
};
const byId = (list) => new Map(list.map((r) => [r.id, r]));
const sortById = (list) => list.slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

// world holds the shared storage, the tabs and the ground truth the checks
// compare against.
function newWorld(rand, nTabs) {
  const shared = new FakeStorage();
  const world = {
    rand,
    shared,
    tabs: [],
    writesRefused: false,
    readsRefused: false,
    nextId: 1,
    nextVersion: 1,
    // removedBy: id -> tabs whose turn removed it from storage.
    removedBy: new Map(),
    // deleteIssued: id -> tabs that asked to delete it (or reset it away).
    deleteIssued: new Map(),
    // lastLanded: id -> 'save' | 'remove', the last change storage took for
    // it. Storage order, not the order tabs asked: a delete that finds the
    // request already gone leaves no trace any tab could see.
    lastLanded: new Map(),
    // everStored: every id storage has held.
    everStored: new Set(),
    // truth: id -> the request as its last accepted or replayed save left it,
    // for requests no tab ever deleted.
    truth: new Map(),
    // deletes: [id, tab] for every delete asked for, in order.
    deletes: [],
    resets: [],
    log: [],
  };
  for (let i = 0; i < nTabs; i += 1) world.tabs.push(newTab(world, 'ABC'[i]));
  return world;
}

function newTab(world, name) {
  const listeners = new Set();
  const target = {
    addEventListener: (type, fn) => { if (type === 'storage') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'storage') listeners.delete(fn); },
  };
  const t = {
    name,
    state: { workspace: [], draft: null, selectedId: null, editorNotice: '' },
    inbox: [],
    // mirror is this tab's changes the test expects still to be waiting for
    // an accepted write: id -> { type, request }, one per request.
    mirror: new Map(),
    lastDeleted: null,
    notices: [],
  };
  t.ws = workspace.createWorkspace({
    storage: world.shared,
    get: () => t.state,
    set: (patch) => {
      if (patch.editorNotice === DELETED_ELSEWHERE) t.notices.push(t.state.draft && t.state.draft.id);
      t.state = { ...t.state, ...patch };
    },
    target,
  });
  // Listeners are called directly, so anything they throw reaches the test.
  t.deliver = () => {
    const newValue = t.inbox.shift();
    const event = new StorageEvent('storage', { key: KEY, newValue, storageArea: world.shared });
    for (const fn of [...listeners]) fn(event);
  };
  t.ws.init();
  return t;
}

const addTo = (map, id, v) => {
  if (!map.has(id)) map.set(id, new Set());
  map.get(id).add(v);
};

function content(world, base) {
  const v = world.nextVersion;
  world.nextVersion += 1;
  return { ...base, params: { v } };
}

function pick(rand, list) {
  return list.length ? list[Math.floor(rand() * list.length)] : null;
}

// expectNotice checks a "deleted in another tab" conclusion against the
// truth: some other tab really took that id out of storage.
function expectRemovedElsewhere(world, t, id, how) {
  const by = world.removedBy.get(id) || new Set();
  assert.ok([...by].some((n) => n !== t.name), `${t.name} ${how} ${id} as deleted in another tab, but no other tab removed it`);
}

// track records a save or a delete this tab asked for.
function trackSave(world, t, request) {
  t.mirror.delete(request.id);
  t.mirror.set(request.id, { type: 'save', request });
}

function trackRemove(world, t, id) {
  t.mirror.delete(id);
  t.mirror.set(id, { type: 'remove' });
  addTo(world.deleteIssued, id, t.name);
  world.deletes.push([id, t.name]);
}

// settle runs after every turn of tab t: it queues the storage event for the
// other tabs, records what left storage, and folds the tab's changes into the
// truth once the tab's queue is empty (its write was accepted).
function settle(world, t, before, result) {
  const after = world.shared.peek(KEY);
  if (after !== before.raw) {
    for (const o of world.tabs) if (o !== t) o.inbox.push(after);
  }
  const now = byId(storedList(world.shared));
  for (const id of before.ids) if (!now.has(id)) addTo(world.removedBy, id, t.name);
  // A delete wins over an edit: a request that was stored and then removed
  // comes back only through a tab that deleted it itself (its Undo).
  for (const id of now.keys()) {
    if (before.ids.includes(id) || !world.everStored.has(id)) continue;
    assert.ok(world.deleteIssued.get(id)?.has(t.name), `${t.name} brought back ${id}, which it never deleted itself`);
  }
  for (const id of now.keys()) world.everStored.add(id);

  if (result && result.deleted) expectRemovedElsewhere(world, t, result.request.id, 'refused a save of');

  const queued = t.ws.queued();
  assert.ok(queued <= t.mirror.size, `${t.name} holds ${queued} queued changes for ${t.mirror.size} requests`);
  if (queued === 0) {
    for (const [id, op] of t.mirror) {
      if (op.type === 'remove') world.lastLanded.set(id, 'remove');
      else if (now.has(id)) world.lastLanded.set(id, 'save');
      if (op.type === 'save' && !world.deleteIssued.has(id)) world.truth.set(id, op.request);
    }
    t.mirror.clear();
  }
}

function snapshot(world) {
  const raw = world.shared.peek(KEY);
  return { raw, ids: storedList(world.shared).map((r) => r.id) };
}

const ACTIONS = [
  ['saveNew', 3],
  ['edit', 3],
  ['delete', 2],
  ['undo', 2],
  ['fork', 1],
  ['open', 2],
  ['deliver', 6],
  ['writes', 1],
  ['reads', 1],
  ['reset', 0.25],
];
const TOTAL = ACTIONS.reduce((s, [, w]) => s + w, 0);

function chooseAction(rand) {
  let x = rand() * TOTAL;
  for (const [name, w] of ACTIONS) {
    x -= w;
    if (x < 0) return name;
  }
  return 'deliver';
}

function turn(world) {
  const { rand } = world;
  const action = chooseAction(rand);
  const t = pick(rand, world.tabs);
  const before = snapshot(world);

  switch (action) {
    case 'saveNew': {
      const request = content(world, { id: `ws-m${world.nextId++}`, name: `new ${world.nextId}`, endpoint: 'search', assertions: [] });
      world.log.push(`${t.name} save new ${request.id}`);
      trackSave(world, t, request);
      const r = t.ws.save(request);
      settle(world, t, before, r);
      return;
    }
    case 'edit': {
      const { draft, workspace: list } = t.state;
      const target = draft && list.some((r) => r.id === draft.id) && rand() < 0.5 ? draft : pick(rand, list);
      if (!target) break;
      const request = content(world, target);
      world.log.push(`${t.name} edit ${request.id}`);
      trackSave(world, t, request);
      const r = t.ws.save(request);
      if (t.state.draft && t.state.draft.id === request.id && !r.deleted) t.state = { ...t.state, draft: structuredClone(request) };
      settle(world, t, before, r);
      return;
    }
    case 'delete': {
      const target = pick(rand, t.state.workspace);
      if (!target) break;
      world.log.push(`${t.name} delete ${target.id}`);
      trackRemove(world, t, target.id);
      const r = t.ws.remove(target.id);
      t.lastDeleted = { request: r.request, others: othersDeleted(world, t, target.id) };
      settle(world, t, before, null);
      return;
    }
    case 'undo': {
      if (!t.lastDeleted || !t.lastDeleted.request) break;
      const { request, others } = t.lastDeleted;
      t.lastDeleted = null;
      world.log.push(`${t.name} undo ${request.id}`);
      // (d) An undo with storage healthy and no delete elsewhere since this
      // tab's own one is never refused. Adjusted to the stated rule that a
      // delete wins over an edit: an undo of a delete storage never saw only
      // withdraws it, the tab cannot tell whether a delete made elsewhere came
      // before or after its own, so then any delete elsewhere may win.
      const withdrawn = t.mirror.get(request.id)?.type === 'remove';
      trackSave(world, t, request);
      const r = t.ws.save(request);
      const healthy = !world.writesRefused && !world.readsRefused;
      const now = othersDeleted(world, t, request.id);
      if (healthy && now === others && (!withdrawn || now === 0)) {
        assert.deepEqual({ ok: r.ok, deleted: r.deleted }, { ok: true, deleted: false }, `${t.name} could not undo its own delete of ${request.id}`);
        assert.ok(byId(storedList(world.shared)).has(request.id), `${t.name} undo did not restore ${request.id}`);
      }
      settle(world, t, before, r);
      return;
    }
    case 'fork': {
      world.log.push(`${t.name} fork`);
      const r = t.ws.fork(curated);
      trackSave(world, t, r.request);
      t.state = { ...t.state, draft: structuredClone(r.request), selectedId: r.request.id };
      world.log[world.log.length - 1] += ` -> ${r.request.id}`;
      settle(world, t, before, r);
      return;
    }
    case 'open': {
      const target = pick(rand, t.state.workspace);
      if (!target) break;
      world.log.push(`${t.name} open ${target.id}`);
      t.state = { ...t.state, draft: structuredClone(target), selectedId: target.id };
      return;
    }
    case 'deliver': {
      const waiting = world.tabs.filter((o) => o.inbox.length);
      const o = pick(rand, waiting);
      if (!o) break;
      world.log.push(`${o.name} receive`);
      o.deliver();
      return;
    }
    case 'writes': {
      world.writesRefused = !world.writesRefused;
      world.log.push(`writes ${world.writesRefused ? 'refused' : 'accepted'}`);
      setFailures(world);
      return;
    }
    case 'reads': {
      world.readsRefused = !world.readsRefused;
      world.log.push(`reads ${world.readsRefused ? 'refused' : 'accepted'}`);
      setFailures(world);
      return;
    }
    case 'reset': {
      world.log.push(`${t.name} reset`);
      const queuedIds = [...t.mirror.keys()];
      const r = t.ws.reset();
      if (r.ok) {
        world.resets.push(t.name);
        for (const id of [...before.ids, ...queuedIds]) {
          world.lastLanded.set(id, 'remove');
          addTo(world.deleteIssued, id, t.name);
        }
        t.mirror.clear();
        t.lastDeleted = null;
      }
      settle(world, t, before, null);
      return;
    }
    default:
      break;
  }
  world.log.push(`(${t.name} ${action}: nothing to do)`);
}

// othersDeleted counts deletes and resets by tabs other than t that could
// have removed id, so an undo can tell whether one happened in between.
function othersDeleted(world, t, id) {
  const deletes = world.deletes.filter(([d, n]) => d === id && n !== t.name).length;
  return deletes + world.resets.filter((n) => n !== t.name).length;
}

function setFailures(world) {
  world.shared.heal();
  if (world.writesRefused) {
    world.shared.failOn('setItem');
    world.shared.failOn('removeItem');
  }
  if (world.readsRefused) world.shared.failOn('getItem');
}

function checkNotices(world) {
  for (const t of world.tabs) {
    for (const id of t.notices) expectRemovedElsewhere(world, t, id, 'closed');
    t.notices = [];
  }
}

// finish heals storage, delivers every event, lets every tab make one more
// accepted write (which carries anything it still has queued), delivers the
// events of those writes, and checks the end state.
function finish(world) {
  world.writesRefused = false;
  world.readsRefused = false;
  setFailures(world);
  world.log.push('heal');
  for (const t of world.tabs) while (t.inbox.length) t.deliver();
  checkNotices(world);
  for (const t of world.tabs) {
    const before = snapshot(world);
    const request = content(world, { id: `ws-end-${t.name}`, name: `end ${t.name}`, endpoint: 'search', assertions: [] });
    trackSave(world, t, request);
    const r = t.ws.save(request);
    assert.equal(r.ok, true, `${t.name} final write refused`);
    settle(world, t, before, r);
    assert.equal(t.ws.queued(), 0, `${t.name} still has queued changes after an accepted write`);
  }
  for (const t of world.tabs) while (t.inbox.length) t.deliver();
  checkNotices(world);

  const stored = byId(storedList(world.shared));
  // (b) Saved and never deleted: stored, with its last accepted or replayed
  // save. Two tabs saving one request is last-writer-wins, and the truth is
  // folded in the order the writes were accepted, so it follows that rule.
  for (const [id, request] of world.truth) {
    if (world.deleteIssued.has(id)) continue;
    assert.ok(stored.has(id), `${id} was saved, never deleted, and is missing`);
    assert.deepEqual(stored.get(id), request, `${id} does not hold its last accepted save`);
  }
  // (c) Deleted, not undone, and saved by nobody afterwards: gone. Measured
  // in the order storage took the changes; that a delete also wins over an
  // edit storage takes later is checked on every turn (settle).
  for (const [id, last] of world.lastLanded) {
    if (last === 'remove') assert.ok(!stored.has(id), `${id} was deleted last but is stored`);
  }
  // (f) Every tab lists exactly what is stored.
  const want = sortById([...stored.values()]);
  for (const t of world.tabs) {
    assert.deepEqual(sortById(t.state.workspace), want, `${t.name} does not list what is stored`);
  }
}

function runSequence(seed) {
  const rand = prng(seed);
  const world = newWorld(rand, 2 + Math.floor(rand() * 2));
  const steps = 1 + Math.floor(rand() * 30);
  try {
    for (let i = 0; i < steps; i += 1) {
      turn(world);
      checkNotices(world);
    }
    finish(world);
  } catch (err) {
    err.message = `seed ${seed}, ${world.tabs.length} tabs, turns:\n  ${world.log.join('\n  ')}\n${err.message}`;
    throw err;
  }
}

test('300 random sequences of tab, storage and event turns keep every saved request and every delete', (t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  for (let seed = 1; seed <= 300; seed += 1) runSequence(seed);
});


// ---------------------------------------------------------------- sequences the model found

// smallTab is one tab over shared storage, receiving events by hand.
function smallTab(shared) {
  const world = { shared };
  const t = newTab(world, 'T');
  return t;
}

const plain = (id, name = id) => ({ id, name, endpoint: 'search', params: {}, assertions: [] });

test('an undo of a delete that never reached storage loses to a reset made in another tab afterwards', (t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  const shared = new FakeStorage();
  shared.setItem(KEY, JSON.stringify({ version: 1, requests: [plain('ws-1', 'one')] }));
  const a = smallTab(shared);
  const b = smallTab(shared);

  // B deletes and undoes while the browser refuses its reads (so also its
  // writes): storage never saw the delete, so the undo only withdraws it.
  shared.failOn('getItem');
  const gone = b.ws.remove('ws-1');
  b.ws.save(gone.request);
  shared.heal();

  // Then A clears the workspace, and B's next write goes through.
  assert.equal(a.ws.reset().ok, true);
  b.ws.save(plain('ws-2', 'two'));

  assert.deepEqual(storedList(shared).map((r) => r.id), ['ws-2'], 'the reset made after the undo wins');
  assert.deepEqual(b.state.workspace.map((r) => r.id), ['ws-2']);
});
