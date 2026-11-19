// The page's checks on an assertion refuse exactly what the server refuses,
// and nothing it accepts. The table below is JSON: web/limits_test.go reads it
// out of this file and runs every case through the server's own validation, so
// the two cannot drift apart unnoticed. "mirrors" is the Go line each case is
// about; "fill" builds a long string (prefix, then unit repeated count times)
// under the named key.
//
// Rules and the Go they mirror:
//   status: a whole number from 100 to 599    internal/assert/assertion.go:118-122
//   latency lt: a number above 0              internal/assert/assertion.go:118-120, 125
//   json count: a whole number of 0 or more   internal/assert/assertion.go:137-141
//   json gt / lt: a number                    internal/assert/assertion.go:137-139
//   json eq / neq / contains: number or text  internal/assert/assertion.go:145-149
//   body_contains: text                       internal/assert/assertion.go:129-130
//   json path: required, and well formed      internal/assert/assertion.go:103-106, jsonpath.go:28-60
//   path and string value: at most 500 runes  internal/sandbox/validate.go:187, 191

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetBrowser, fetchStub, flush, listenerErrors } from './shim.mjs';
import { resetState, get, set, subscribe } from '../js/store.js';
import * as editor from '../js/render-editor.js';
import { requestProblem, requestPayload } from '../js/request-model.js';

// cases:begin
const CASES = [
  {"rule": "status 100 is accepted", "mirrors": "internal/assert/assertion.go:122", "assertion": {"type": "status", "op": "eq", "value": 100}, "refused": false},
  {"rule": "status 599 is accepted", "mirrors": "internal/assert/assertion.go:122", "assertion": {"type": "status", "op": "neq", "value": 599}, "refused": false},
  {"rule": "status 99 is refused", "mirrors": "internal/assert/assertion.go:122", "assertion": {"type": "status", "op": "eq", "value": 99}, "refused": true, "part": "value"},
  {"rule": "status 600 is refused", "mirrors": "internal/assert/assertion.go:122", "assertion": {"type": "status", "op": "eq", "value": 600}, "refused": true, "part": "value"},
  {"rule": "status 200.5 is refused", "mirrors": "internal/assert/assertion.go:122", "assertion": {"type": "status", "op": "eq", "value": 200.5}, "refused": true, "part": "value"},
  {"rule": "status as text is refused", "mirrors": "internal/assert/assertion.go:118-120", "assertion": {"type": "status", "op": "eq", "value": "200"}, "refused": true, "part": "value"},
  {"rule": "status with no value is refused", "mirrors": "internal/assert/assertion.go:118-120", "assertion": {"type": "status", "op": "eq"}, "refused": true, "part": "value"},
  {"rule": "latency lt 0.001 is accepted", "mirrors": "internal/assert/assertion.go:125", "assertion": {"type": "latency", "op": "lt", "value": 0.001}, "refused": false},
  {"rule": "latency lt 0 is refused", "mirrors": "internal/assert/assertion.go:125", "assertion": {"type": "latency", "op": "lt", "value": 0}, "refused": true, "part": "value"},
  {"rule": "latency lt -5 is refused", "mirrors": "internal/assert/assertion.go:125", "assertion": {"type": "latency", "op": "lt", "value": -5}, "refused": true, "part": "value"},
  {"rule": "latency as text is refused", "mirrors": "internal/assert/assertion.go:118-120", "assertion": {"type": "latency", "op": "lt", "value": "5"}, "refused": true, "part": "value"},
  {"rule": "count 0 is accepted", "mirrors": "internal/assert/assertion.go:141", "assertion": {"type": "json", "path": "$.items", "op": "count", "value": 0}, "refused": false},
  {"rule": "count 3 is accepted", "mirrors": "internal/assert/assertion.go:141", "assertion": {"type": "json", "path": "$.items", "op": "count", "value": 3}, "refused": false},
  {"rule": "count -1 is refused", "mirrors": "internal/assert/assertion.go:141", "assertion": {"type": "json", "path": "$.items", "op": "count", "value": -1}, "refused": true, "part": "value"},
  {"rule": "count 1.5 is refused", "mirrors": "internal/assert/assertion.go:141", "assertion": {"type": "json", "path": "$.items", "op": "count", "value": 1.5}, "refused": true, "part": "value"},
  {"rule": "count as text is refused", "mirrors": "internal/assert/assertion.go:137-139", "assertion": {"type": "json", "path": "$.items", "op": "count", "value": "3"}, "refused": true, "part": "value"},
  {"rule": "gt -1 is accepted", "mirrors": "internal/assert/assertion.go:137-139", "assertion": {"type": "json", "path": "$.total", "op": "gt", "value": -1}, "refused": false},
  {"rule": "lt as text is refused", "mirrors": "internal/assert/assertion.go:137-139", "assertion": {"type": "json", "path": "$.total", "op": "lt", "value": "x"}, "refused": true, "part": "value"},
  {"rule": "eq an empty string is accepted", "mirrors": "internal/assert/assertion.go:145-149", "assertion": {"type": "json", "path": "$.name", "op": "eq", "value": ""}, "refused": false},
  {"rule": "neq a number is accepted", "mirrors": "internal/assert/assertion.go:145-149", "assertion": {"type": "json", "path": "$.name", "op": "neq", "value": 100.0}, "refused": false},
  {"rule": "contains with no value is refused", "mirrors": "internal/assert/assertion.go:145-149", "assertion": {"type": "json", "path": "$.name", "op": "contains"}, "refused": true, "part": "value"},
  {"rule": "eq a boolean is refused", "mirrors": "internal/assert/assertion.go:145-149", "assertion": {"type": "json", "path": "$.name", "op": "eq", "value": true}, "refused": true, "part": "value"},
  {"rule": "exists needs no value", "mirrors": "internal/assert/assertion.go:134-135", "assertion": {"type": "json", "path": "$.name", "op": "exists"}, "refused": false},
  {"rule": "body_contains an empty string is accepted", "mirrors": "internal/assert/assertion.go:129-130", "assertion": {"type": "body_contains", "op": "contains", "value": ""}, "refused": false},
  {"rule": "body_contains a number is refused", "mirrors": "internal/assert/assertion.go:129-130", "assertion": {"type": "body_contains", "op": "contains", "value": 5}, "refused": true, "part": "value"},
  {"rule": "an empty JSON path is refused", "mirrors": "internal/assert/assertion.go:103-104", "assertion": {"type": "json", "path": "", "op": "exists"}, "refused": true, "part": "path"},
  {"rule": "a missing JSON path is refused", "mirrors": "internal/assert/assertion.go:103-104", "assertion": {"type": "json", "op": "exists"}, "refused": true, "part": "path"},
  {"rule": "the path $ is accepted", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "$", "op": "exists"}, "refused": false},
  {"rule": "a path with indexes is accepted", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "$.results[0].name", "op": "exists"}, "refused": false},
  {"rule": "a negative or signed index is accepted", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "$[-1][+2]", "op": "exists"}, "refused": false},
  {"rule": "a field with spaces and ] is accepted", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "$.a b]c", "op": "exists"}, "refused": false},
  {"rule": "a path not starting with $ is refused", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "total", "op": "exists"}, "refused": true, "part": "path"},
  {"rule": "$a is refused", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "$a", "op": "exists"}, "refused": true, "part": "path"},
  {"rule": "an empty field name is refused", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "$.a..b", "op": "exists"}, "refused": true, "part": "path"},
  {"rule": "an unclosed [ is refused", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "$.a[1", "op": "exists"}, "refused": true, "part": "path"},
  {"rule": "a bad index is refused", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "$[x]", "op": "exists"}, "refused": true, "part": "path"},
  {"rule": "an index past 64 bits is refused", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "$[9223372036854775808]", "op": "exists"}, "refused": true, "part": "path"},
  {"rule": "an index at the 64-bit edge is accepted", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "$[9223372036854775807]", "op": "exists"}, "refused": false},
  {"rule": "text after ] is refused", "mirrors": "internal/assert/assertion.go:106, internal/assert/jsonpath.go:28-60", "assertion": {"type": "json", "path": "$[1]x", "op": "exists"}, "refused": true, "part": "path"},
  {"rule": "a 500-character path is accepted", "mirrors": "internal/sandbox/validate.go:187", "assertion": {"type": "json", "op": "exists"}, "refused": false, "fill": {"key": "path", "prefix": "$.", "unit": "p", "count": 498}},
  {"rule": "a 501-character path is refused", "mirrors": "internal/sandbox/validate.go:187", "assertion": {"type": "json", "op": "exists"}, "refused": true, "part": "path", "fill": {"key": "path", "prefix": "$.", "unit": "p", "count": 499}},
  {"rule": "a 500-character path of astral characters is accepted", "mirrors": "internal/sandbox/validate.go:187", "assertion": {"type": "json", "op": "exists"}, "refused": false, "fill": {"key": "path", "prefix": "$.", "unit": "\ud83d\ude00", "count": 498}},
  {"rule": "a 501-character path of astral characters is refused", "mirrors": "internal/sandbox/validate.go:187", "assertion": {"type": "json", "op": "exists"}, "refused": true, "part": "path", "fill": {"key": "path", "prefix": "$.", "unit": "\ud83d\ude00", "count": 499}},
  {"rule": "a 500-character value is accepted", "mirrors": "internal/sandbox/validate.go:191", "assertion": {"type": "json", "path": "$.a", "op": "eq"}, "refused": false, "fill": {"key": "value", "prefix": "", "unit": "v", "count": 500}},
  {"rule": "a 501-character value is refused", "mirrors": "internal/sandbox/validate.go:191", "assertion": {"type": "json", "path": "$.a", "op": "eq"}, "refused": true, "part": "value", "fill": {"key": "value", "prefix": "", "unit": "v", "count": 501}},
  {"rule": "500 astral characters are accepted", "mirrors": "internal/sandbox/validate.go:191", "assertion": {"type": "body_contains", "op": "contains"}, "refused": false, "fill": {"key": "value", "prefix": "", "unit": "\ud83d\ude00", "count": 500}},
  {"rule": "501 astral characters are refused", "mirrors": "internal/sandbox/validate.go:191", "assertion": {"type": "body_contains", "op": "contains"}, "refused": true, "part": "value", "fill": {"key": "value", "prefix": "", "unit": "\ud83d\ude00", "count": 501}},
  {"rule": "a 501-character status value is refused by its length", "mirrors": "internal/sandbox/validate.go:191", "assertion": {"type": "status", "op": "eq"}, "refused": true, "part": "value", "fill": {"key": "value", "prefix": "", "unit": "9", "count": 501}}
];
// cases:end

const byId = (id) => document.getElementById(id);

function assertionOf(c) {
  const a = { ...c.assertion };
  if (c.fill) a[c.fill.key] = c.fill.prefix + c.fill.unit.repeat(c.fill.count);
  return a;
}

test('the table is the server\'s: every case the page refuses, and only those, carries refused', () => {
  assert.ok(CASES.length > 40);
  for (const c of CASES) {
    const problem = requestProblem({ id: 'r', endpoint: 'search', assertions: [assertionOf(c)] });
    assert.equal(problem !== null, c.refused, c.rule);
    if (problem) {
      assert.equal(problem.field, 'assertions[0]', c.rule);
      assert.equal(problem.part, c.part, c.rule);
      assert.ok(problem.message.length > 0, c.rule);
    }
  }
});

let unsubscribe = null;

beforeEach((t) => {
  t.mock.method(console, 'warn', () => {});
  if (unsubscribe) unsubscribe();
  resetBrowser();
  resetState();
  set({ endpoints: [{ id: 'search', label: 'Search', method: 'GET', path: '/search', params: ['q'] }] });
  editor.init();
  unsubscribe = subscribe((state) => editor.render(state));
});

const sendOk = { status: 200, body: { status: 200, passed: true, endpoint: 'search', query: '', latency_ms: 1, size_bytes: 0, body: '', assertions: [] } };

// One test per case: Send refuses it beside the control, or sends it.
for (const c of CASES) {
  test(`Send: ${c.rule}`, async () => {
    const a = assertionOf(c);
    set({ draft: { id: 'ws-1', name: 'Case', endpoint: 'search', params: {}, assertions: [a] }, selectedId: 'ws-1', send: null });
    fetchStub.respond('/api/send', sendOk, { method: 'POST' });
    byId('send-request').click();
    await flush();
    const sent = fetchStub.calls.filter((c2) => c2.url === '/api/send');
    // An empty value box is the page's own refusal, not the server's: the
    // builder sends it as no value.
    const emptyBox = a.value === '' && a.op !== 'exists';
    if (!c.refused && !emptyBox) {
      assert.equal(sent.length, 1, 'the request was sent');
      assert.deepEqual(sent[0].json().assertions[0], JSON.parse(JSON.stringify(requestPayload({ assertions: [a] }).assertions[0])));
      assert.equal(byId('assertion-rows').querySelectorAll('[aria-invalid="true"]').length, 0);
      return;
    }
    assert.equal(sent.length, 0, 'nothing was sent');
    const { message } = requestProblem(emptyBox ? requestPayload({ assertions: [a] }) : { assertions: [a] });
    assert.equal(byId('send-status').textContent, `Refused - Assertion 1: ${message}`);
    const row = byId('assertion-rows').querySelector('.assert-row');
    const control = row.querySelector(c.part === 'path' ? '.assert-path' : 'input.assert-value');
    assert.ok(control, `the ${c.part} control is there`);
    assert.equal(control.getAttribute('aria-invalid'), 'true');
    const error = byId(control.getAttribute('aria-describedby'));
    assert.ok(error && row.contains(error), 'the error is beside the control');
    assert.equal(error.textContent, message);
    assert.deepEqual(listenerErrors, []);
  });
}

test('the messages a visitor reads for the rules the brief names', () => {
  const said = (a) => requestProblem({ assertions: [a] }).message;
  assert.equal(said({ type: 'json', path: '', op: 'exists' }), 'JSON path is required');
  assert.equal(said({ type: 'status', op: 'eq', value: 600 }), 'a status assertion needs a whole number from 100 to 599');
  assert.equal(said({ type: 'latency', op: 'lt', value: 0 }), 'a latency bound must be above 0 ms');
  assert.equal(said({ type: 'json', path: '$.a', op: 'count', value: 1.5 }), 'count needs a whole number of 0 or more');
  assert.equal(said({ type: 'json', path: '$.a', op: 'eq', value: 'v'.repeat(501) }), 'the value is 501 characters; the cap is 500');
  assert.equal(said({ type: 'json', path: `$.${'p'.repeat(499)}`, op: 'exists' }), 'the path is 501 characters; the cap is 500');
  assert.equal(get().draft, null);
});
