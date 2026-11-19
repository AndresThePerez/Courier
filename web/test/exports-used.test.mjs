// Every name a page module exports is imported somewhere: by another module
// or by a test. An export nothing imports reads as part of a module's surface
// when it is only an internal, and it hides from the next reader that
// changing it touches one file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const JS = new URL('../js/', import.meta.url);
const TEST = new URL('./', import.meta.url);

const read = (dir, f) => readFileSync(new URL(f, dir), 'utf8');
const modules = readdirSync(JS).filter((f) => f.endsWith('.js')).sort();
const sources = [
  ...modules.map((f) => ({ name: `js/${f}`, text: read(JS, f) })),
  ...readdirSync(TEST).filter((f) => f.endsWith('.mjs')).sort().map((f) => ({ name: `test/${f}`, text: read(TEST, f) })),
];

// exportsOf lists the names a module exports, in each form the page uses.
function exportsOf(text) {
  const names = [];
  for (const m of text.matchAll(/^export (?:async )?(?:function\*?|const|let|class) (\w+)/gm)) names.push(m[1]);
  for (const m of text.matchAll(/^export (?:const|let) \{([^}]*)\}/gm)) {
    names.push(...m[1].split(',').map((n) => n.trim()).filter(Boolean));
  }
  for (const m of text.matchAll(/^export \{([^}]*)\}/gm)) {
    names.push(...m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  }
  return names;
}

// importers are the other files that import a module, by its file name.
const importers = (file) => sources.filter((s) => s.name !== `js/${file}`
  && new RegExp(`from '(?:\\./|\\.\\./js/)${file.replace('.', '\\.')}'`).test(s.text));

test('every export of a page module is imported by another module or a test', () => {
  const unused = [];
  for (const file of modules) {
    const users = importers(file);
    for (const name of exportsOf(read(JS, file))) {
      const word = new RegExp(`\\b${name}\\b`);
      if (!users.some((s) => word.test(s.text))) unused.push(`${file} ${name}`);
    }
  }
  assert.deepEqual(unused, []);
});

test('the scan finds an export nothing imports', () => {
  assert.deepEqual(exportsOf('export function a() {}\nexport const b = 1;\nexport const { c, d } = x;\nexport async function e() {}\n'), ['a', 'b', 'e', 'c', 'd']);
});
