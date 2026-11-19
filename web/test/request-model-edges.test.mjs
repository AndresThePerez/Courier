// The client's checks refuse exactly what internal/sandbox and internal/assert
// refuse: every curated request passes them, and at each rule's edge the
// client agrees with the server's own answer, read from the Go source
// (validateAssertion, ValidateAssertion, parsePath with strconv.Atoi, and
// utf8.RuneCountInString for the 500-character cap).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  requestPayload, runPayload, requestProblem, runProblem, assertionProblem, isQueueable, clampSetting, runField, whereIn,
} from '../js/request-model.js';

const DATA = new URL('../../internal/collections/data/', import.meta.url);
const curated = readdirSync(DATA).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8')));

test('every curated request in the embedded collections passes the client checks and is queueable', () => {
  assert.ok(curated.length >= 5, 'the embedded collections were read');
  let n = 0;
  for (const c of curated) {
    for (const r of c.requests) {
      n += 1;
      assert.equal(requestProblem(requestPayload(r)), null, `${c.id}/${r.id}`);
      assert.equal(isQueueable(r), true, `${c.id}/${r.id}`);
    }
    assert.equal(runProblem(runPayload('functional', c.requests, {})), null, c.id);
  }
  assert.ok(n > 0);
});

// [assertion, server accepts?] with the Go line that decides it.
const astral = (n) => '\u{1F600}'.repeat(n);
const combining = (n) => 'é'.repeat(n); // two runes each
const Cases = [
  // status: whole number 100..599 (isWhole && 100 <= n <= 599)
  [{ type: 'status', op: 'eq', value: 100 }, true],
  [{ type: 'status', op: 'eq', value: 599 }, true],
  [{ type: 'status', op: 'eq', value: 99 }, false],
  [{ type: 'status', op: 'eq', value: 600 }, false],
  [{ type: 'status', op: 'eq', value: 200.5 }, false],
  [{ type: 'status', op: 'eq', value: 1e2 }, true],
  [{ type: 'status', op: 'eq', value: '200' }, false], // a string is not toFloat-able
  [{ type: 'status', op: 'neq', value: 200.0 }, true],
  [{ type: 'status', op: 'gt', value: 200 }, false], // op not in the matrix
  // latency: n > 0
  [{ type: 'latency', op: 'lt', value: 0.001 }, true],
  [{ type: 'latency', op: 'lt', value: 1e-300 }, true],
  [{ type: 'latency', op: 'lt', value: -0 }, false],
  [{ type: 'latency', op: 'lt', value: 0 }, false],
  [{ type: 'latency', op: 'lt', value: -5 }, false],
  [{ type: 'latency', op: 'lt', value: '5' }, false],
  // count: whole number >= 0
  [{ type: 'json', path: '$.a', op: 'count', value: 0 }, true],
  [{ type: 'json', path: '$.a', op: 'count', value: -0 }, true],
  [{ type: 'json', path: '$.a', op: 'count', value: 1.0 }, true],
  [{ type: 'json', path: '$.a', op: 'count', value: 1e3 }, true],
  [{ type: 'json', path: '$.a', op: 'count', value: 2 ** 53 }, true],
  [{ type: 'json', path: '$.a', op: 'count', value: 1.5 }, false],
  [{ type: 'json', path: '$.a', op: 'count', value: -1 }, false],
  // eq / neq / contains: a number or a string
  [{ type: 'json', path: '$.a', op: 'eq', value: 7 }, true],
  [{ type: 'json', path: '$.a', op: 'neq', value: 'x' }, true],
  [{ type: 'json', path: '$.a', op: 'contains', value: '' }, true],
  [{ type: 'json', path: '$.a', op: 'eq', value: true }, false],
  [{ type: 'json', path: '$.a', op: 'eq', value: null }, false],
  [{ type: 'json', path: '$.a', op: 'eq' }, false],
  [{ type: 'json', path: '$.a', op: 'exists' }, true],
  [{ type: 'json', path: '$.a', op: 'exists', value: { any: 'thing' } }, true], // value ignored and not sent
  [{ type: 'body_contains', op: 'contains', value: '' }, true],
  [{ type: 'body_contains', op: 'contains', value: 5 }, false],
  // paths: parsePath
  [{ type: 'json', path: '$', op: 'exists' }, true],
  [{ type: 'json', path: '$.a', op: 'exists' }, true],
  [{ type: 'json', path: '$[0]', op: 'exists' }, true],
  [{ type: 'json', path: '$[-1]', op: 'exists' }, true],
  [{ type: 'json', path: '$[+1]', op: 'exists' }, true], // Atoi takes a sign
  [{ type: 'json', path: '$[9223372036854775807]', op: 'exists' }, true],
  [{ type: 'json', path: '$[9223372036854775808]', op: 'exists' }, false], // out of range
  [{ type: 'json', path: '$[ 1]', op: 'exists' }, false],
  [{ type: 'json', path: '$[1_0]', op: 'exists' }, false],
  [{ type: 'json', path: '$[٣]', op: 'exists' }, false],
  [{ type: 'json', path: '$["a"]', op: 'exists' }, false],
  [{ type: 'json', path: '$.a.b[2].c', op: 'exists' }, true],
  [{ type: 'json', path: '$..a', op: 'exists' }, false],
  [{ type: 'json', path: '$.', op: 'exists' }, false],
  [{ type: 'json', path: '$.a[', op: 'exists' }, false],
  [{ type: 'json', path: '$. a', op: 'exists' }, true],
  [{ type: 'json', path: '$.a]', op: 'exists' }, true], // "]" is a field character
  [{ type: 'json', path: '$a', op: 'exists' }, false],
  [{ type: 'json', path: ' $.a', op: 'exists' }, false],
  [{ type: 'json', path: '', op: 'exists' }, false],
  // 500 characters, counted in runes
  [{ type: 'json', path: `$.${astral(498)}`, op: 'exists' }, true],
  [{ type: 'json', path: `$.${astral(499)}`, op: 'exists' }, false],
  [{ type: 'json', path: '$.a', op: 'eq', value: 'a'.repeat(500) }, true],
  [{ type: 'json', path: '$.a', op: 'eq', value: 'a'.repeat(501) }, false],
  [{ type: 'json', path: '$.a', op: 'eq', value: combining(250) }, true],
  [{ type: 'json', path: '$.a', op: 'eq', value: `${combining(250)}x` }, false],
  [{ type: 'body_contains', op: 'contains', value: astral(500) }, true],
  [{ type: 'body_contains', op: 'contains', value: astral(501) }, false],
  // unknown type or operator
  [{ type: 'header', op: 'eq', value: 'x' }, false],
  [{ type: 'json', path: '$.a', op: 'matches', value: 'x' }, false],
  [{ type: '__proto__', op: 'eq', value: 1 }, false],
  [{ type: 'status', op: 'constructor', value: 200 }, false],
];

test('at every rule edge the client accepts exactly what the server accepts', () => {
  for (const [a, accepts] of Cases) {
    const built = requestPayload({ id: 'x', endpoint: 'search', params: {}, assertions: [a] });
    const problem = requestProblem(built);
    assert.equal(problem === null, accepts, `${JSON.stringify(a).slice(0, 80)} -> ${problem && problem.message}`);
  }
});

test('extra keys on an assertion or a request never reach the wire, so they never cause a refusal', () => {
  const r = {
    id: 'x', name: 'n', endpoint: 'search', url: 'http://192.0.2.1/', params: { q: 'a' },
    assertions: [{ type: 'status', op: 'eq', value: 200, path: '$.leak', note: 'x' }, { type: 'json', op: 'exists', path: '$', value: 3 }],
  };
  const built = requestPayload(r);
  assert.deepEqual(Object.keys(built).sort(), ['assertions', 'endpoint', 'id', 'name', 'params']);
  assert.deepEqual(built.assertions, [{ type: 'status', op: 'eq', value: 200 }, { type: 'json', op: 'exists', path: '$' }]);
  assert.equal(requestProblem(built), null);
});

test('a hostile assertion list is refused by field and never throws', () => {
  const deep = JSON.parse(`${'['.repeat(3000)}1${']'.repeat(3000)}`);
  for (const assertions of ['x', 5, { 0: {} }, [null], ['status'], [[]], [{ type: 'json', path: '$.a', op: 'eq', value: deep }]]) {
    let problem;
    assert.doesNotThrow(() => { problem = requestProblem(requestPayload({ id: 'x', endpoint: 'search', assertions })); });
    assert.ok(problem && /^assertions(\[0\])?$/.test(problem.field), JSON.stringify(problem));
  }
});

test('assertionProblem never throws on a type or operator that is not text', () => {
  for (const a of [{ type: Symbol.iterator }, { type: 'status', op: Symbol('x') }, { type: {}, op: [] }, Object.create(null)]) {
    assert.doesNotThrow(() => assertionProblem(a));
    assert.notEqual(assertionProblem(a), null);
  }
});

// ------------------------------------------------------------------ run settings

const Limits = {
  concurrency: { lo: 1, hi: 50, fallback: 10 },
  delay_ms: { lo: 0, hi: 1000, fallback: 0 },
  duration_secs: { lo: 1, hi: 30, fallback: 10 },
};
const Inputs = ['0', '1e2', '51', 'abc', '2.5', '', '-1', ' 7 ', '0x10', '1e999', '-1e999', '-0', '.5', '5.', '٣',
  '10 workers', '1e-7', '9007199254740993', '-0.5', 'Infinity', 'NaN', '1'.repeat(400)];

test('a run setting is always a whole number inside the frozen bounds, and the note names exactly that value', () => {
  for (const [key, limits] of Object.entries(Limits)) {
    for (const typed of Inputs) {
      const { value, note } = clampSetting(limits, typed);
      assert.ok(Number.isInteger(value) && !Object.is(value, -0), `${key} ${JSON.stringify(typed)} -> ${value}`);
      assert.ok(value >= limits.lo && value <= limits.hi, `${key} ${JSON.stringify(typed)} -> ${value}`);
      if (note) {
        assert.ok(note.endsWith(` ${value}.`), `${key} ${JSON.stringify(typed)}: ${note}`);
        assert.ok(note.length < 200, 'a long typed text is clipped in the note');
      } else {
        assert.equal(String(value), typed.trim(), `${key} ${JSON.stringify(typed)} changed without a note`);
      }
    }
  }
});

// ------------------------------------------------------------------ refused fields

test('a refused field the page cannot place is never read as a row', () => {
  for (const field of ['sequence[-1]', 'sequence[1e9]', 'sequence[', 'sequence[0', 'sequence[0].bogus',
    '__proto__', 'constructor', 'toString', 'options.__proto__', `sequence[0].${'x'.repeat(10000)}`, 'sequence[0]\n', 'Sequence[0]']) {
    assert.equal(runField(field), null, JSON.stringify(field.slice(0, 40)));
  }
  assert.equal(whereIn('hasOwnProperty'), null);
  assert.deepEqual(runField('sequence[2].assertions[0].value'), { index: 2, where: { label: 'assertion 1', assertion: 0, part: 'value' } });
});
