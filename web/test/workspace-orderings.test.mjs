// Saved requests under hand-built orderings of tabs, storage and events that a
// random walk rarely reaches. Each tab here acts through act(), which queues
// the storage event for every other tab when the shared value changed; the
// test then delivers those events when it chooses, so a tab can make any
// number of its own changes between another tab's write and the event that
// announces it, exactly as a browser allows.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, FakeStorage, StorageEvent, listenerErrors } from './shim.mjs';
import * as workspace from '../js/workspace.js';

const KEY = 'courier.workspace.v1';
const DELETED_ELSEWHERE = 'This request was deleted in another tab.';

const req = (id, name = id, v = 0) => ({ id, name, endpoint: 'search', params: { v }, assertions: [] });

let shared;
let tabs;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  shared = new FakeStorage();
  tabs = [];
});

function tab(name) {
  let state = { workspace: [], draft: null, selectedId: null, editorNotice: '' };
  const target = new EventTarget();
  const notices = [];
  const ws = workspace.createWorkspace({
    storage: shared,
    get: () => state,
    set: (patch) => {
      if (patch.editorNotice === DELETED_ELSEWHERE) notices.push(state.draft && state.draft.id);
      state = { ...state, ...patch };
    },
    target,
  });
  ws.init();
  const t = {
    name,
    ws,
    notices,
    inbox: [],
    get state() { return state; },
    open(id) {
      const r = ws.find(id);
      assert.ok(r, `${name} cannot open ${id}: not listed`);
      state = { ...state, draft: structuredClone(r), selectedId: id, editorNotice: '' };
    },
    // act runs one change of this tab and queues its event for the others.
    act(fn) {
      const before = shared.peek(KEY);
      const result = fn(ws);
      const after = shared.peek(KEY);
      if (after !== before) for (const o of tabs) if (o !== t) o.inbox.push({ key: KEY, newValue: after });
      return result;
    },
    // deliver hands this tab the oldest storage event waiting for it.
    deliver() {
      const e = t.inbox.shift();
      assert.ok(e, `${name} has no event waiting`);
      target.dispatchEvent(new StorageEvent('storage', { key: e.key, newValue: e.newValue, storageArea: shared }));
    },
    deliverAll() { while (t.inbox.length) t.deliver(); },
    // clearFromHere is localStorage.clear() run in this tab: every other tab
    // gets one event with key null.
    clearFromHere() {
      shared.clear();
      for (const o of tabs) if (o !== t) o.inbox.push({ key: null, newValue: null });
    },
  };
  tabs.push(t);
  return t;
}

const seed = (requests) => shared.setItem(KEY, JSON.stringify({ version: 1, requests }));
const storedList = () => (JSON.parse(shared.peek(KEY))?.requests || []);
const stored = () => Object.fromEntries(storedList().map((r) => [r.id, r]));
const ids = (list) => list.map((r) => r.id).sort();
const storedIds = () => ids(storedList());

function refuseWrites() {
  shared.failOn('setItem');
  shared.failOn('removeItem');
}

// ---------------------------------------------------------------- withdrawn deletes

test('an undo of a delete storage never saw does not bring back a request another tab deleted before this tab\'s write lands', () => {
  seed([req('ws-x', 'X'), req('ws-y', 'Y')]);
  const a = tab('A');
  const b = tab('B');

  refuseWrites();
  const gone = b.act((ws) => ws.remove('ws-x'));
  const undo = b.act((ws) => ws.save(gone.request));
  assert.equal(undo.ok, false, 'the undo was refused like the delete');
  shared.heal();

  a.act((ws) => ws.remove('ws-x'));
  // B writes something else before hearing of A's delete: its queued undo is
  // an edit of a request another tab deleted, and the delete wins.
  b.act((ws) => ws.save(req('ws-y', 'Y edited')));

  assert.deepEqual(storedIds(), ['ws-y']);
  assert.equal(stored()['ws-y'].name, 'Y edited');
  assert.deepEqual(ids(b.state.workspace), ['ws-y']);
  b.deliverAll();
  assert.deepEqual(ids(b.state.workspace), ['ws-y']);
});

test('an undo of a refused delete, after another tab deleted the same request, is told it could not restore and nothing comes back', () => {
  seed([req('ws-x', 'X')]);
  const a = tab('A');
  const b = tab('B');

  refuseWrites();
  const gone = b.act((ws) => ws.remove('ws-x'));
  shared.heal();
  a.act((ws) => ws.remove('ws-x'));
  refuseWrites();
  const undo = b.act((ws) => ws.save(gone.request));
  shared.heal();

  // Storage never took B's delete, so the undo only withdraws it, and A's
  // delete wins over it as over any edit (documented choice).
  assert.deepEqual({ ok: undo.ok, deleted: undo.deleted }, { ok: false, deleted: true });
  assert.equal(b.ws.queued(), 0, 'the lost undo is not kept to resurrect the request later');
  b.act((ws) => ws.save(req('ws-z', 'Z')));
  assert.deepEqual(storedIds(), ['ws-z']);
});

test('an undo of a delete storage took is never refused, even when another tab deleted the same request first', () => {
  seed([req('ws-x', 'X')]);
  const a = tab('A');
  const b = tab('B');

  a.act((ws) => ws.remove('ws-x'));
  // B has not heard of A's delete and still lists ws-x.
  const gone = b.act((ws) => ws.remove('ws-x'));
  assert.equal(gone.ok, true);
  const undo = b.act((ws) => ws.save(gone.request));

  assert.deepEqual({ ok: undo.ok, deleted: undo.deleted }, { ok: true, deleted: false });
  assert.deepEqual(storedIds(), ['ws-x']);
  a.deliverAll();
  b.deliverAll();
  assert.deepEqual(ids(a.state.workspace), ['ws-x']);
  assert.deepEqual(a.notices, []);
});

test('a delete asked for before another tab\'s undo but stored after it wins, and the tab with it open is told the truth', () => {
  seed([req('ws-x', 'X')]);
  const a = tab('A');
  const b = tab('B');

  refuseWrites();
  b.act((ws) => ws.remove('ws-x'));
  shared.heal();
  // A deletes and undoes its own delete, then opens the request.
  const gone = a.act((ws) => ws.remove('ws-x'));
  a.act((ws) => ws.save(gone.request));
  a.open('ws-x');
  b.deliverAll();
  assert.deepEqual(b.state.workspace, [], 'B still has its own delete waiting');

  // B's delete reaches storage after A's undo: the delete wins.
  b.act((ws) => ws.save(req('ws-n', 'N')));
  a.deliverAll();

  assert.deepEqual(storedIds(), ['ws-n']);
  assert.equal(a.state.draft, null, 'A closed the request B deleted');
  assert.deepEqual(a.notices, ['ws-x'], 'and said another tab deleted it, which is true');
  assert.deepEqual(ids(a.state.workspace), ['ws-n']);
  assert.deepEqual(ids(b.state.workspace), ['ws-n']);
});

// ---------------------------------------------------------------- three tabs, repeated deletes

test('three tabs: two delete the same request, the first undoes, and every tab ends listing it with no untrue notice', () => {
  seed([req('ws-x', 'X'), req('ws-y', 'Y')]);
  const a = tab('A');
  const b = tab('B');
  const c = tab('C');
  c.open('ws-x');

  const gone = a.act((ws) => ws.remove('ws-x'));
  b.act((ws) => ws.remove('ws-x'));
  const undo = a.act((ws) => ws.save(gone.request));
  assert.equal(undo.ok, true);
  for (const t of tabs) t.deliverAll();

  assert.deepEqual(storedIds(), ['ws-x', 'ws-y']);
  for (const t of tabs) assert.deepEqual(ids(t.state.workspace), ['ws-x', 'ws-y'], `${t.name} lists what is stored`);
  // C heard of the delete only after the undo had restored it: it was never
  // gone from any read C made, so C keeps it open.
  assert.equal(c.state.draft?.id, 'ws-x');
  assert.deepEqual(c.notices, []);
  // B's own undo still works and is not called deleted elsewhere.
  const bUndo = b.act((ws) => ws.save({ ...gone.request, name: 'X from B' }));
  assert.deepEqual({ ok: bUndo.ok, deleted: bUndo.deleted }, { ok: true, deleted: false });
  assert.deepEqual(listenerErrors, []);
});

test('delete, undo, delete, undo with every event delivered in between: watchers close once, truthfully, and end listing the request', () => {
  seed([req('ws-x', 'X', 1)]);
  const a = tab('A');
  const b = tab('B');
  const c = tab('C');
  b.open('ws-x');
  c.open('ws-x');

  for (let round = 0; round < 2; round += 1) {
    const gone = a.act((ws) => ws.remove('ws-x'));
    b.deliverAll();
    c.deliverAll();
    assert.deepEqual(b.state.workspace, []);
    const undo = a.act((ws) => ws.save(gone.request));
    assert.equal(undo.ok, true, `undo ${round + 1}`);
    b.deliverAll();
    c.deliverAll();
    assert.deepEqual(ids(b.state.workspace), ['ws-x']);
    if (round === 0) c.open('ws-x');
  }

  assert.deepEqual(storedList(), [req('ws-x', 'X', 1)]);
  assert.deepEqual(b.notices, ['ws-x'], 'B was told once, the first time');
  assert.deepEqual(c.notices, ['ws-x', 'ws-x'], 'C reopened it and was told again');
  assert.equal(b.state.draft, null);
  assert.equal(c.state.draft, null);
  // A's second undo is a request A stores again, so an edit of it from B
  // after reopening lands.
  b.open('ws-x');
  const edit = b.act((ws) => ws.save(req('ws-x', 'X', 2)));
  assert.equal(edit.ok, true);
  assert.equal(stored()['ws-x'].params.v, 2);
});

test('delete, undo, delete, undo in one tab with events reaching the other tab only at the end leaves it open and unwarned', () => {
  seed([req('ws-x', 'X', 1)]);
  const a = tab('A');
  const b = tab('B');
  b.open('ws-x');
  for (let i = 0; i < 2; i += 1) {
    const gone = a.act((ws) => ws.remove('ws-x'));
    a.act((ws) => ws.save(gone.request));
  }
  // Four events queued for B; every one reads the key as stored now.
  assert.equal(b.inbox.length, 4);
  b.deliverAll();
  assert.equal(b.state.draft?.id, 'ws-x');
  assert.deepEqual(b.notices, []);
  assert.deepEqual(ids(b.state.workspace), ['ws-x']);
});

// ---------------------------------------------------------------- deleted and re-created elsewhere

test('an edit queued behind a refused write, the request deleted and undone elsewhere before it lands: the edit is the last write and wins', () => {
  seed([req('ws-x', 'X', 1)]);
  const a = tab('A');
  const b = tab('B');
  a.open('ws-x');

  refuseWrites();
  const edit = a.act((ws) => ws.save(req('ws-x', 'X', 2)));
  assert.equal(edit.ok, false);
  shared.heal();
  const gone = b.act((ws) => ws.remove('ws-x'));
  b.act((ws) => ws.save(gone.request));
  // A has not heard of either; its next write carries the queued edit.
  const next = a.act((ws) => ws.save(req('ws-x', 'X', 3)));

  assert.deepEqual({ ok: next.ok, deleted: next.deleted }, { ok: true, deleted: false });
  assert.equal(stored()['ws-x'].params.v, 3);
  assert.equal(a.state.draft?.id, 'ws-x');
  assert.deepEqual(a.notices, []);
  a.deliverAll();
  b.deliverAll();
  assert.deepEqual(a.notices, [], 'events that arrive after the undo never report the request deleted');
  assert.equal(b.state.workspace.find((r) => r.id === 'ws-x').params.v, 3);
});

test('an edit queued behind a refused write, and the delete elsewhere heard before the undo: the edit is dropped, the notice is true, and the undone request comes back', () => {
  seed([req('ws-x', 'X', 1)]);
  const a = tab('A');
  const b = tab('B');
  a.open('ws-x');

  refuseWrites();
  a.act((ws) => ws.save(req('ws-x', 'X', 2)));
  shared.heal();
  const gone = b.act((ws) => ws.remove('ws-x'));
  a.deliver();
  assert.equal(a.state.draft, null);
  assert.deepEqual(a.notices, ['ws-x']);
  assert.equal(a.ws.queued(), 0, 'the edit lost to the delete');

  b.act((ws) => ws.save(gone.request));
  a.deliverAll();
  a.act((ws) => ws.save(req('ws-z', 'Z')));

  assert.equal(stored()['ws-x'].params.v, 1, 'B\'s undo restored its request, not A\'s dropped edit');
  assert.deepEqual(ids(a.state.workspace), ['ws-x', 'ws-z']);
});

// ---------------------------------------------------------------- reads refused for a long stretch

test('reads refused while another tab changes everything: the view holds, then one current read brings it to what is stored', () => {
  seed([req('ws-x', 'X'), req('ws-y', 'Y'), req('ws-w', 'W')]);
  const a = tab('A');
  const b = tab('B');
  a.open('ws-y');

  b.act((ws) => ws.remove('ws-x'));
  b.act((ws) => ws.save(req('ws-y', 'Y edited')));
  b.act((ws) => ws.save(req('ws-z', 'Z')));
  const goneW = b.act((ws) => ws.remove('ws-w'));
  b.act((ws) => ws.save(goneW.request));

  shared.failOn('getItem');
  a.deliverAll();
  assert.deepEqual(ids(a.state.workspace), ['ws-w', 'ws-x', 'ws-y'], 'nothing of unknown age replaced the view');
  assert.equal(a.state.draft?.id, 'ws-y');
  assert.deepEqual(a.notices, []);
  shared.heal();

  // No event is left; the next thing that reads is A's own write.
  a.act((ws) => ws.save(req('ws-a', 'A')));
  assert.deepEqual(ids(a.state.workspace), ['ws-a', 'ws-w', 'ws-y', 'ws-z']);
  assert.deepEqual(ids(a.state.workspace), storedIds());
  assert.equal(a.state.workspace.find((r) => r.id === 'ws-y').name, 'Y edited');
  assert.equal(a.state.draft?.id, 'ws-y', 'the open request still exists and stays open');
  assert.deepEqual(a.notices, []);
});

test('reads refused while another tab deletes the open request: the tab closes it with a true notice once a read succeeds, not before', () => {
  seed([req('ws-x', 'X'), req('ws-y', 'Y')]);
  const a = tab('A');
  const b = tab('B');
  a.open('ws-x');

  shared.failOn('getItem');
  b.act((ws) => ws.remove('ws-x'));
  a.deliverAll();
  // A keeps editing while its reads are refused; nothing is written.
  const blind = a.act((ws) => ws.save(req('ws-x', 'X edited blind')));
  assert.equal(blind.ok, false);
  assert.equal(a.state.draft?.id, 'ws-x');
  assert.deepEqual(a.notices, []);
  shared.heal();

  b.act((ws) => ws.save(req('ws-y', 'Y edited')));
  a.deliverAll();
  assert.equal(a.state.draft, null);
  assert.deepEqual(a.notices, ['ws-x']);
  assert.equal(a.ws.queued(), 0);
  a.act((ws) => ws.save(req('ws-n', 'N')));
  assert.deepEqual(storedIds(), ['ws-n', 'ws-y'], 'the blind edit did not resurrect the deleted request');
});

test('reads refused while this tab deletes and undoes, another tab deletes in between: healed, the request is gone and no tab is misinformed', () => {
  seed([req('ws-x', 'X'), req('ws-y', 'Y')]);
  const a = tab('A');
  const b = tab('B');
  b.open('ws-x');

  shared.failOn('getItem');
  const gone = a.act((ws) => ws.remove('ws-x'));
  shared.heal();
  b.act((ws) => ws.remove('ws-x'));
  shared.failOn('getItem');
  const undo = a.act((ws) => ws.save(gone.request));
  assert.equal(undo.ok, false);
  shared.heal();
  a.deliverAll();
  a.act((ws) => ws.save(req('ws-y', 'Y edited')));
  b.deliverAll();

  assert.deepEqual(storedIds(), ['ws-y']);
  for (const t of tabs) assert.deepEqual(ids(t.state.workspace), ['ws-y'], `${t.name} lists what is stored`);
  assert.deepEqual(b.notices, [], 'B deleted it itself');
});

// ---------------------------------------------------------------- clear() elsewhere

test('a clear() in another tab arrives with key null: the open request closes truthfully, a queued new request survives', () => {
  seed([req('ws-x', 'X'), req('ws-y', 'Y')]);
  const a = tab('A');
  const b = tab('B');
  a.open('ws-x');

  refuseWrites();
  const fresh = a.act((ws) => ws.save(req('ws-new', 'new')));
  assert.equal(fresh.ok, false);
  shared.heal();

  b.clearFromHere();
  a.deliver();
  assert.equal(a.state.draft, null);
  assert.deepEqual(a.notices, ['ws-x']);
  assert.deepEqual(ids(a.state.workspace), ['ws-new'], 'only the request A never stored is left');

  a.act((ws) => ws.save(req('ws-new', 'new 2')));
  assert.deepEqual(storedIds(), ['ws-new']);
  assert.equal(stored()['ws-new'].name, 'new 2');
  assert.deepEqual(listenerErrors, []);
});

test('a clear() event delivered while reads are refused changes nothing until a current read, which then closes the open request truthfully', () => {
  seed([req('ws-x', 'X')]);
  const a = tab('A');
  const b = tab('B');
  a.open('ws-x');
  b.clearFromHere();
  // B had not heard of the clear either: its edit of a request it saw is an
  // edit of a deleted request and writes nothing.
  const late = b.act((ws) => ws.save(req('ws-x', 'X again')));
  assert.equal(late.deleted, true);
  b.act((ws) => ws.save(req('ws-z', 'Z')));

  shared.failOn('getItem');
  a.deliver();
  assert.equal(a.state.draft?.id, 'ws-x');
  assert.deepEqual(a.notices, []);
  assert.deepEqual(ids(a.state.workspace), ['ws-x']);
  shared.heal();
  a.deliver();

  assert.deepEqual(storedIds(), ['ws-z']);
  assert.deepEqual(ids(a.state.workspace), ['ws-z']);
  assert.equal(a.state.draft, null);
  assert.deepEqual(a.notices, ['ws-x']);
});

// ---------------------------------------------------------------- refused reset

test('a refused reset returns the reset wording\'s condition, clears nothing, and keeps this tab\'s queued changes', () => {
  assert.equal(workspace.RESET_REFUSED, 'Could not reset - this browser refused the write (storage full or disabled). Your saved requests are unchanged.');
  seed([req('ws-x', 'X'), req('ws-y', 'Y')]);
  const a = tab('A');
  a.open('ws-x');

  refuseWrites();
  a.act((ws) => ws.save(req('ws-x', 'X edited')));
  const r = a.act((ws) => ws.reset());
  assert.deepEqual(r, { ok: false });
  assert.deepEqual(storedIds(), ['ws-x', 'ws-y']);
  assert.deepEqual(ids(a.state.workspace), ['ws-x', 'ws-y']);
  assert.equal(a.state.draft?.id, 'ws-x');
  assert.equal(a.ws.queued(), 1);
  shared.heal();

  a.act((ws) => ws.save(req('ws-y', 'Y edited')));
  assert.equal(stored()['ws-x'].name, 'X edited', 'the edit queued before the refused reset still lands');
  assert.equal(a.ws.queued(), 0);
});
