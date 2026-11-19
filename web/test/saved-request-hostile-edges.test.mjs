// More shapes a saved request can be given by hand in the browser's storage:
// fields of the wrong type at every level, names of the object prototype as
// ids, names, parameter names and assertion types, and very long text. After
// each, every pane keeps drawing, Object.prototype is untouched, what Send and
// Start put on the wire holds only the request fields, and Reset recovers.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe, renderAll } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';

const byId = (id) => document.getElementById(id);
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];
const good = { id: 'ws-good', name: 'Good one', endpoint: 'search', params: { q: 'x' }, assertions: [{ type: 'status', op: 'eq', value: 200 }] };

let unsubscribe = null;
let renderErrors = [];

function boot(raw) {
  localStorage.setItem(WORKSPACE, raw);
  workspace.init();
  runner.savedCollections.init();
  runner.restore();
  editor.init();
  runner.init({ refresh: async () => {} });
  sidebar.init({
    select: (request) => { editor.onSelect(); sidebar.selectRequest(request); },
    add: (request) => runner.add(request),
    addAll: (collection) => runner.addAll(collection),
  });
  unsubscribe = subscribe((state) => renderAll([sidebar.render, editor.render, runner.render], state));
  set({ endpoints });
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  renderErrors = [];
  t.mock.method(console, 'error', (...args) => { renderErrors.push(args); });
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
});

const prototypeKeys = () => Object.getOwnPropertyNames(Object.prototype).sort().join(',');
const cleanPrototype = prototypeKeys();
const tree = () => byId('workspace-tree');
const openButtons = () => [...tree().querySelectorAll('.req-open')];
const sends = () => fetchStub.calls.filter((c) => c.url === '/api/send');
const starts = () => fetchStub.calls.filter((c) => c.url === '/api/runs' && c.method === 'POST');
const Request = ['assertions', 'endpoint', 'id', 'name', 'params'];
const Assertion = new Set(['type', 'op', 'path', 'value']);

// Each shape is one saved request beside a good one.
const shapes = {
  'id __proto__': { id: '__proto__', name: 'Proto id', endpoint: 'search', params: { q: 'x' } },
  'id constructor': { id: 'constructor', name: 'Ctor id', endpoint: 'search', params: { q: 'x' } },
  'name __proto__': { id: 'ws-pn', name: '__proto__', endpoint: 'search', params: { q: 'x' } },
  'params a list': { id: 'ws-pl', name: 'Params list', endpoint: 'search', params: ['x', 'y'] },
  'params a string': { id: 'ws-ps', name: 'Params text', endpoint: 'search', params: 'q=x' },
  'param value an object': { id: 'ws-pv', name: 'Param object', endpoint: 'search', params: { q: { toString: 'x' } } },
  'param value null': { id: 'ws-pnull', name: 'Param null', endpoint: 'search', params: { q: null } },
  'param key __proto__': { id: 'ws-pk', name: 'Param proto', endpoint: 'search', params: JSON.parse('{"__proto__":{"polluted":"yes"},"q":"x"}') },
  'param key constructor': { id: 'ws-pc', name: 'Param ctor', endpoint: 'search', params: { constructor: 'x', toString: 'y' } },
  'assertions an object': { id: 'ws-ao', name: 'Assert object', endpoint: 'search', assertions: { type: 'status', op: 'eq', value: 200 } },
  'assertions a string': { id: 'ws-as', name: 'Assert text', endpoint: 'search', assertions: 'status eq 200' },
  'assertion null': { id: 'ws-an', name: 'Assert null', endpoint: 'search', assertions: [null] },
  'assertion a list': { id: 'ws-al', name: 'Assert list', endpoint: 'search', assertions: [['status', 'eq', 200]] },
  'assertion op an object': { id: 'ws-aop', name: 'Assert op', endpoint: 'search', assertions: [{ type: 'status', op: { eq: 1 }, value: 200 }] },
  'assertion path an object': { id: 'ws-ap', name: 'Assert path', endpoint: 'search', assertions: [{ type: 'json', op: 'eq', path: { a: 1 }, value: 1 }] },
  'assertion value an object': { id: 'ws-av', name: 'Assert value', endpoint: 'search', assertions: [{ type: 'json', op: 'eq', path: '$.a', value: { a: [1] } }] },
  'assertion type prototype': { id: 'ws-at', name: 'Assert proto', endpoint: 'search', assertions: [{ type: 'prototype', op: 'eq', value: 1 }] },
  'assertion with extra fields': { id: 'ws-ax', name: 'Assert extra', endpoint: 'search', assertions: [{ type: 'status', op: 'eq', value: 200, url: 'http://192.0.2.1/', host: '192.0.2.1' }] },
  'request with extra fields': { id: 'ws-rx', name: 'Extra', endpoint: 'search', params: { q: 'x' }, url: 'http://192.0.2.1/', method: 'DELETE', headers: { a: 'b' } },
  'a very long name': { id: 'ws-long', name: 'L'.repeat(200000), endpoint: 'search', params: { q: 'x' } },
};

// The shapes whose assertions the page itself cannot send, with what the
// editor says when Send is pressed: the page refuses them before anything
// goes out, and will not queue them for a run. Every other shape is sent once
// and started once, and what goes out is checked.
const refusedByPage = {
  'assertions an object': 'Refused - Assertions: the assertions are not a list',
  'assertions a string': 'Refused - Assertions: the assertions are not a list',
  'assertion null': 'Refused - Assertion 1: this assertion cannot be read',
  'assertion a list': 'Refused - Assertion 1: this assertion cannot be read',
  'assertion op an object': 'Refused - Assertion 1: operator "[object Object]" is not valid for a status assertion',
  'assertion path an object': 'Refused - Assertion 1: JSON path is required',
  'assertion value an object': 'Refused - Assertion 1: eq needs a number or a string value',
  'assertion type prototype': 'Refused - Assertion 1: unknown assertion type "prototype"',
};

// onWire holds what was sent to the request fields, at both levels.
function onWire(body) {
  for (const k of Object.keys(body)) assert.ok(Request.includes(k), `request field ${k}`);
  if (Array.isArray(body.assertions)) {
    for (const a of body.assertions) {
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        for (const k of Object.keys(a)) assert.ok(Assertion.has(k), `assertion field ${k}`);
      }
    }
  }
}

for (const [label, shape] of Object.entries(shapes)) {
  test(`a saved request with ${label}: every pane draws, the prototype is untouched, the wire holds request fields only, and Reset recovers`, async () => {
    boot(JSON.stringify({ version: 1, requests: [good, shape] }));
    assert.doesNotMatch(tree().textContent, /\[object /);
    const ids = get().workspace.map((r) => r.id);
    assert.ok(ids.includes('ws-good'), 'the good request is listed');

    // Each shape has a text id and endpoint and can be encoded, so it is kept.
    assert.ok(ids.includes(shape.id), 'the hostile request is kept and listed');
    {
      const open = openButtons()[ids.indexOf(shape.id)];
      assert.ok(open, 'the hostile request has a row');
      open.click();
      assert.equal(get().draft.id, shape.id, 'it opens');
      assert.equal(byId('editor-form').hidden, false, 'the editor draws');

      const refused = refusedByPage[label];
      fetchStub.respond('/api/send', { status: 400, body: { error: 'no', field: 'endpoint' } }, { method: 'POST' });
      byId('send-request').click();
      await flush();
      if (refused) {
        assert.equal(sends().length, 0, 'the page sent what it cannot send');
        assert.equal(byId('send-status').textContent, refused);
      } else {
        assert.equal(sends().length, 1, 'Send sent nothing');
        onWire(sends()[0].json());
        assert.equal(sends()[0].json().id, shape.id);
      }

      runner.add(workspace.find(shape.id));
      fetchStub.respond('/api/runs', { status: 400, body: { error: 'no', field: 'sequence[0].endpoint' } }, { method: 'POST' });
      byId('start-run').click();
      await flush();
      if (refused) {
        assert.equal(get().sequence.length, 0, 'the page queued what it cannot send');
        assert.equal(starts().length, 0, 'the page started a run of nothing');
        assert.match(byId('sequence-note').textContent, /has an invalid assertion - fix it in the editor before queuing it\./);
      } else {
        assert.equal(starts().length, 1, 'Start sent nothing');
        const sequence = starts()[0].json().sequence;
        assert.equal(sequence.length, 1);
        onWire(sequence[0]);
        assert.equal(sequence[0].id, shape.id);
        assert.equal(byId('start-run').disabled, false, 'Start comes back');
      }
    }

    assert.equal(prototypeKeys(), cleanPrototype, 'Object.prototype gained nothing');
    assert.equal({}.polluted, undefined);

    // The good request still opens and edits.
    openButtons()[0].click();
    assert.equal(get().draft.id, 'ws-good');
    typeInto(byId('editor-name'), 'Good two');
    assert.ok(openButtons().some((b) => b.textContent.includes('Good two')), 'the sidebar follows an edit');

    workspace.reset();
    assert.equal(get().workspace.length, 0, 'Reset empties the workspace');
    assert.doesNotMatch(tree().textContent, /Proto|Ctor|Assert|Param/);

    assert.deepEqual(renderErrors, [], 'no pane threw');
    assert.deepEqual(listenerErrors, []);
  });
}
