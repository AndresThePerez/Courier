// The "Saved in this browser only" badge is not part of the My Workspace
// heading: a screen reader reading the heading's content reads only its name,
// and the badge keeps its place on its own line under the heading row, in the
// badge's own look.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetBrowser } from './shim.mjs';

const byId = (id) => document.getElementById(id);

beforeEach(() => {
  resetBrowser();
});

test('the My Workspace heading holds only its name, with the badge on its own beneath the heading row', () => {
  const h = byId('workspace-tree').parentNode.querySelector('h2');
  assert.equal(h.textContent.trim(), 'My Workspace');
  assert.equal(h.getAttribute('aria-labelledby'), null, 'a heading named by its own text needs no aria-labelledby');
  assert.equal(h.children.length, 0);
  const row = byId('reset-workspace').parentNode;
  const siblings = [...row.parentNode.children];
  const next = siblings[siblings.indexOf(row) + 1];
  assert.ok(next.classList.contains('badge'), 'the badge is not directly under the heading row');
  assert.equal(next.textContent, 'Saved in this browser only');
  assert.equal(document.querySelectorAll('h2 .badge').length, 0, 'no heading holds a badge');
});

test('the badge under the heading row wraps rather than widening the rail, and keeps the weight it had in the heading', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const rule = /\.badge\.rail-heading-badge\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the badge under the heading row has no rule that outranks .badge');
  assert.match(rule[1], /white-space:\s*normal/);
  assert.match(rule[1], /overflow-wrap:\s*anywhere/);
  assert.match(rule[1], /max-width:\s*100%/);
  assert.match(rule[1], /font-weight:\s*bold/);
  assert.doesNotMatch(css, /\.rail-heading \.badge/, 'a rule for a badge inside the heading was left behind');
});
