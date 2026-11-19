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

// importedNames lists the names a source takes from a module file: the names
// inside its import braces (the name before any "as"), and, for a namespace
// import, every name it reads off the namespace. A name that only appears as a
// word elsewhere in the file (a local of the same name, a string, a comment)
// is not an import of it.
function importedNames(text, file) {
  const from = `'(?:\\./|\\.\\./js/)${file.replace('.', '\\.')}'`;
  const names = new Set();
  for (const m of text.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*${from}`, 'g'))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) names.add(name);
    }
  }
  for (const m of text.matchAll(new RegExp(`import\\s*\\*\\s*as\\s+(\\w+)\\s*from\\s*${from}`, 'g'))) {
    for (const use of text.matchAll(new RegExp(`\\b${m[1]}\\.(\\w+)`, 'g'))) names.add(use[1]);
  }
  return names;
}

test('every export of a page module is imported by another module or a test', () => {
  const unused = [];
  for (const file of modules) {
    const imported = new Set();
    for (const s of sources) {
      if (s.name !== `js/${file}`) for (const name of importedNames(s.text, file)) imported.add(name);
    }
    for (const name of exportsOf(read(JS, file))) {
      if (!imported.has(name)) unused.push(`${file} ${name}`);
    }
  }
  assert.deepEqual(unused, []);
});

test('the scan finds an export nothing imports', () => {
  assert.deepEqual(exportsOf('export function a() {}\nexport const b = 1;\nexport const { c, d } = x;\nexport async function e() {}\n'), ['a', 'b', 'e', 'c', 'd']);
});

test('the scan reads named and namespace imports, and nothing else, as imports', () => {
  const text = [
    "import { a, b as bee } from './m.js';",
    "import {\n  c,\n  d,\n} from '../js/m.js';",
    "import * as ns from './m.js';",
    "import { z } from './other.js';",
    'ns.e(); ns.f.g; const h = 1; // i',
    "const s = 'j';",
  ].join('\n');
  assert.deepEqual([...importedNames(text, 'm.js')].sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
});
