// The selected sidebar row is text a visitor reads, so its colour against its
// background clears WCAG 1.4.3's 4.5:1, worked out from the stylesheet the
// page ships, through the palette's own tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(selector) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].split(',').map((s) => s.trim()).includes(selector));
  assert.ok(rules.length > 0, `no rule for ${selector}`);
  const out = {};
  for (const [, , body] of rules) {
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
  }
  return out;
}

const tokens = declarations(':root');

function resolve(value) {
  const m = /^var\((--[\w-]+)\)$/.exec(value);
  if (!m) return value;
  assert.ok(m[1] in tokens, `${m[1]} is not a token of the palette`);
  return resolve(tokens[m[1]]);
}

function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `${hex} is not a six-digit colour`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the selected sidebar row\'s text clears 4.5:1 against its background, using palette tokens only', () => {
  const rule = declarations('.req-open.is-selected');
  const fg = rule.color;
  const bg = rule.background || rule['background-color'];
  assert.match(fg, /^var\(--[\w-]+\)$/, 'the text colour is not a token');
  assert.match(bg, /^var\(--[\w-]+\)$/, 'the background is not a token');
  const ratio = contrast(resolve(fg), resolve(bg));
  assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
});

test('the contrast arithmetic agrees with WCAG\'s own end points', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrast('#777777', '#777777').toFixed(2), '1.00');
  assert.equal(contrast('#767676', '#ffffff').toFixed(2), '4.54');
});
