// A failed comparison of two shim nodes must say which nodes in one short
// line. Left to itself node's assert inspects both values to build its
// message, and a node reaches its parent, its document and every listener
// in the page: one such message grew a test process past 60 GB.
//
// The comparison runs in a child process with a small heap, a timeout and a
// capped output, so a shim that regresses fails this test instead of taking
// the suite down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const SHIM = new URL('./shim.mjs', import.meta.url).href;

const CHILD = `
import assert from 'node:assert/strict';
import { resetBrowser, localStorage, eventSources } from ${JSON.stringify(SHIM)};
resetBrowser();
const list = document.createElement('div');
document.body.appendChild(list);
for (let i = 0; i < 3000; i += 1) {
  const row = document.createElement('button');
  row.setAttribute('data-focus-key', 'row:' + i);
  row.addEventListener('click', () => {});
  row.appendChild(document.createTextNode('Row ' + i + ' '.repeat(10)));
  list.appendChild(row);
}
const [a, b] = [list.children[10], list.children[2000]];
const out = {};
const started = Date.now();
for (const [name, fn] of [
  ['equal', () => assert.equal(a, b)],
  ['deepStrictEqual', () => assert.deepStrictEqual(a, b)],
  ['deepStrictEqual of lists', () => assert.deepStrictEqual([a, a.firstChild], [b, b.firstChild])],
  ['equal of text nodes', () => assert.equal(a.firstChild, b.firstChild)],
  ['equal of the document', () => assert.equal(document, a)],
]) {
  try {
    fn();
    out[name] = -1;
  } catch (error) {
    out[name] = String(error.message).length;
  }
}
out.ms = Date.now() - started;
const { inspect } = await import('node:util');
const button = document.createElement('button');
button.id = 'start';
button.setAttribute('data-focus-key', 'add:workspace:ws-1');
button.appendChild(document.createTextNode('Added ' + 'x'.repeat(200)));
list.appendChild(button);
out.shown = [inspect(button), inspect(button.firstChild), inspect(document), inspect([button, { node: button }])];
process.stdout.write(JSON.stringify(out));
`;

test('a failed comparison of two nodes in a page of thousands says so in a few short lines, and quickly, and a node prints as a one-line tag', () => {
  // The child's heap is capped well below the suite's memory, so a message
  // that walks the page ends that child alone, at once, rather than the run.
  const run = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', CHILD], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 1 << 20,
    killSignal: 'SIGKILL',
  });
  assert.equal(run.signal, null, `the comparison was killed (${run.signal}): it ran away`);
  assert.equal(run.status, 0, `the comparison ended with ${run.status}: ${run.stderr.slice(0, 300)}`);
  const out = JSON.parse(run.stdout);
  const { ms, shown } = out;
  delete out.ms;
  delete out.shown;
  for (const [name, length] of Object.entries(out)) {
    assert.ok(length > 0, `${name} failed as it should`);
    assert.ok(length < 4096, `${name}: a ${length}-character message`);
  }
  assert.ok(ms < 10000, `the comparisons took ${ms}ms`);

  const [element, text, doc, nested] = shown;
  assert.ok(!element.includes('\n') && element.length < 200, element);
  assert.match(element, /^<button#start/);
  assert.match(element, /data-focus-key="add:workspace:ws-1"/);
  assert.match(text, /^#text "Added x+/);
  assert.ok(text.length < 100, text);
  assert.ok(doc.length < 100, doc);
  assert.ok(nested.length < 400, nested);
});
