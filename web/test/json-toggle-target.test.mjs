// Below 900px nothing a finger presses is under 24px tall, the JSON view's
// fold toggles included; above it they keep the height of their line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetBrowser } from './shim.mjs';
import { jsonView } from '../js/json-view.js';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// narrowBlocks is the body of every @media (max-width: 900px) block, and wide
// the stylesheet with those blocks taken out.
function split() {
  const narrow = [];
  let wide = '';
  let at = 0;
  for (;;) {
    const start = css.indexOf('@media (max-width: 900px)', at);
    if (start < 0) break;
    wide += css.slice(at, start);
    let i = css.indexOf('{', start) + 1;
    let depth = 1;
    const from = i;
    while (depth > 0) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') depth -= 1;
      i += 1;
    }
    narrow.push(css.slice(from, i - 1));
    at = i;
  }
  return { narrow: narrow.join('\n'), wide: wide + css.slice(at) };
}

const minHeightFor = (text, sel) => [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .filter((m) => m[1].split(',').map((s) => s.trim()).includes(sel))
  .map((m) => /min-height:\s*([^;]+);?/.exec(m[2]))
  .filter(Boolean)
  .map((m) => m[1].trim());

test('a folded JSON node is drawn as a .jv-summary toggle', () => {
  resetBrowser();
  const view = jsonView('{"a":{"b":1}}');
  assert.ok(view.querySelector('summary.jv-summary'), 'the toggle is not a .jv-summary; the rule below would miss it');
});

test('below 900px the JSON view\'s toggles are at least 24px tall, and above it their height is left alone', () => {
  const { narrow, wide } = split();
  assert.ok(narrow.length > 0, 'no below-900px block');
  assert.deepEqual(minHeightFor(narrow, '.jv-summary'), ['24px']);
  assert.deepEqual(minHeightFor(wide, '.jv-summary'), [], 'the toggles changed height above 900px');
});
