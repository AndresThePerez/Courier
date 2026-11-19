// An assertion whose operator needs a value is refused while its value box is
// empty, whether the box was never typed into or was typed into and erased:
// by Save, Send, queueing and Start alike, with the same message beside the
// field. The server itself accepts an empty string; the page asks for a value
// because an empty box is almost never what the visitor meant to check.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resetBrowser, localStorage, fetchStub, flush, listenerErrors, typeInto } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as workspace from '../js/workspace.js';
import * as editor from '../js/render-editor.js';
import * as runner from '../js/render-runner.js';
import * as sidebar from '../js/render-sidebar.js';
import { requestPayload, requestProblem, assertionProblem, valueKind, isQueueable } from '../js/request-model.js';

const byId = (id) => document.getElementById(id);
const SETUP = 'courier.runner.v1';
const WORKSPACE = 'courier.workspace.v1';
const endpoints = [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }];

const withCheck = (id, check) => ({ id, name: 'Checked', endpoint: 'search', params: { q: 'x' }, assertions: [{ type: 'status', op: 'eq', value: 200 }, check] });

let unsubscribe = null;

function boot({ saved, setup } = {}) {
  if (saved) localStorage.setItem(WORKSPACE, JSON.stringify({ version: 1, requests: saved }));
  if (setup) localStorage.setItem(SETUP, JSON.stringify(setup));
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
  unsubscribe = subscribe((state) => { sidebar.render(state); editor.render(state); runner.render(state); });
  set({ endpoints });
}

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  resetBrowser();
  resetState();
});

afterEach(() => {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  workspace.stop();
});

const valueBox = (j) => byId('assertion-rows').querySelectorAll('.assert-row')[j].querySelector('input.assert-value');
const describedBy = (control) => document.getElementById(control.getAttribute('aria-describedby') || '');
const sends = () => fetchStub.calls.filter((c) => c.url === '/api/send');
const starts = () => fetchStub.calls.filter((c) => c.url === '/api/runs' && c.method === 'POST');

const EqNeeds = 'eq needs a number or a string value';

async function sendAndRead() {
  byId('send-request').click();
  await flush();
  return byId('send-status').textContent;
}

test('a json eq box typed into and erased is refused by Send, with the message beside the box, as a box never typed into is', async () => {
  boot({ saved: [withCheck('ws-a', { type: 'json', path: '$.name', op: 'exists' })] });
  sidebar.selectRequest(workspace.find('ws-a'));

  // Never typed into: exists has no box, so switching to eq leaves it empty.
  const op = byId('assertion-rows').querySelectorAll('.assert-row')[1].querySelector('.assert-op');
  op.value = 'eq';
  op.dispatchEvent(new Event('change', { bubbles: true }));
  const never = await sendAndRead();
  assert.equal(never, `Refused - Assertion 2: ${EqNeeds}`);
  assert.equal(describedBy(valueBox(1)).textContent, EqNeeds);

  // Typed into, then erased.
  typeInto(valueBox(1), 'Pikachu');
  typeInto(valueBox(1), '');
  const erased = await sendAndRead();
  assert.equal(erased, never, 'an erased box reads as a box never typed into');
  assert.equal(valueBox(1).getAttribute('aria-invalid'), 'true');
  assert.equal(describedBy(valueBox(1)).textContent, EqNeeds);
  assert.equal(sends().length, 0, 'nothing was sent');
  assert.deepEqual(listenerErrors, []);
});

test('Save refuses an erased value box, with the same message beside it', () => {
  boot({ saved: [withCheck('ws-a', { type: 'json', path: '$.name', op: 'contains', value: 'Pi' })] });
  sidebar.selectRequest(workspace.find('ws-a'));
  typeInto(valueBox(1), '');
  byId('save-request').click();
  assert.equal(byId('editor-note').textContent, 'Kept in this browser, but not ready to run - Assertion 2: contains needs a number or a string value');
  assert.equal(valueBox(1).getAttribute('aria-invalid'), 'true');
  assert.equal(describedBy(valueBox(1)).textContent, 'contains needs a number or a string value');
  assert.deepEqual(listenerErrors, []);
});

test('an erased body_contains box is refused too', async () => {
  boot({ saved: [withCheck('ws-a', { type: 'body_contains', op: 'contains', value: 'Pi' })] });
  sidebar.selectRequest(workspace.find('ws-a'));
  typeInto(valueBox(1), '');
  assert.equal(await sendAndRead(), 'Refused - Assertion 2: body_contains needs a string value');
  assert.equal(sends().length, 0);
});

test('a stored request already holding an empty value cannot be sent, queued or started', async () => {
  const stored = withCheck('ws-a', { type: 'json', path: '$.name', op: 'eq', value: '' });
  boot({
    saved: [stored],
    setup: { version: 1, mode: 'functional', options: {}, sequence: [{ enabled: true, request: stored }] },
  });
  assert.equal(get().sequence.length, 1, 'the stored setup holds the request');

  // Start: refused here, by field, with no request made.
  byId('start-run').click();
  await flush();
  assert.equal(starts().length, 0, 'nothing was started');
  assert.equal(byId('start-note').textContent, `Refused - Request 1, assertion 2: ${EqNeeds}`);

  // Queueing it again is refused.
  runner.add(workspace.find('ws-a'));
  assert.equal(get().sequence.length, 1);
  assert.equal(isQueueable(stored), false);

  // Send, from the editor.
  sidebar.selectRequest(workspace.find('ws-a'));
  assert.equal(await sendAndRead(), `Refused - Assertion 2: ${EqNeeds}`);
  assert.equal(sends().length, 0);
  assert.deepEqual(listenerErrors, []);
});

test('the payload builder treats an empty value as no value, while the rule that mirrors the server still accepts one', () => {
  for (const a of [
    { type: 'json', path: '$.a', op: 'eq', value: '' },
    { type: 'json', path: '$.a', op: 'neq', value: '' },
    { type: 'json', path: '$.a', op: 'contains', value: '' },
    { type: 'body_contains', op: 'contains', value: '' },
  ]) {
    assert.equal(assertionProblem(a), null, `the server accepts ${JSON.stringify(a)}`);
    const built = requestPayload({ id: 'x', endpoint: 'search', params: {}, assertions: [a] });
    assert.equal(Object.hasOwn(built.assertions[0], 'value'), false, JSON.stringify(a));
    const problem = requestProblem(built);
    assert.ok(problem && problem.part === 'value', JSON.stringify(a));
  }
  // A value of whitespace is a value.
  const spaced = requestPayload({ id: 'x', endpoint: 'search', assertions: [{ type: 'json', path: '$.a', op: 'eq', value: ' ' }] });
  assert.equal(requestProblem(spaced), null);
});

test('no curated request holds an empty value where its operator needs one', () => {
  const data = new URL('../../internal/collections/data/', import.meta.url);
  let checked = 0;
  for (const f of readdirSync(data).filter((n) => n.endsWith('.json'))) {
    const c = JSON.parse(readFileSync(new URL(f, data), 'utf8'));
    for (const r of c.requests) {
      for (const a of r.assertions || []) {
        checked += 1;
        if (valueKind(a) !== 'none') assert.notEqual(a.value, '', `${c.id}/${r.id}`);
      }
    }
  }
  assert.ok(checked > 0, 'the curated assertions were read');
});
