// The page cuts a stored parameter value exactly as the server cuts one
// (sandbox.CutParamValue): its first 32 words, then its first 256
// characters. A character is a code point; a word is a run of characters
// that are not white space as Go's unicode.IsSpace has it; past a 32nd word
// the value ends at that word, the white space after it dropped. The table is
// JSON: web/limits_test.go reads it out of this file and runs every case
// through the server's own CutParamValue, so the two cannot drift apart.
// Each value is built from [text, count] parts, the text repeated count times.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutParamValue, requestOf } from '../js/storage.js';

// cases:begin
const CASES = [
  {"rule": "an empty value is unchanged", "input": [], "want": [], "cut": false},
  {"rule": "a short value is unchanged", "input": [["pikachu", 1]], "want": [["pikachu", 1]], "cut": false},
  {"rule": "256 characters are unchanged", "input": [["a", 256]], "want": [["a", 256]], "cut": false},
  {"rule": "257 characters are cut to 256", "input": [["a", 257]], "want": [["a", 256]], "cut": true},
  {"rule": "256 characters outside the BMP are unchanged", "input": [["\ud83d\ude00", 256]], "want": [["\ud83d\ude00", 256]], "cut": false},
  {"rule": "257 characters outside the BMP are cut to 256 characters, not 256 UTF-16 units", "input": [["\ud83d\ude00", 257]], "want": [["\ud83d\ude00", 256]], "cut": true},
  {"rule": "257 two-byte characters are cut to 256", "input": [["\u00e9", 257]], "want": [["\u00e9", 256]], "cut": true},
  {"rule": "32 words are unchanged", "input": [["w", 1], [" w", 31]], "want": [["w", 1], [" w", 31]], "cut": false},
  {"rule": "33 words are cut to 32", "input": [["w", 1], [" w", 32]], "want": [["w", 1], [" w", 31]], "cut": true},
  {"rule": "32 words with white space at both ends keep it", "input": [["  ", 1], ["w", 1], [" \t w", 31], ["  ", 1]], "want": [["  ", 1], ["w", 1], [" \t w", 31], ["  ", 1]], "cut": false},
  {"rule": "33 words keep the leading white space and drop the white space after the 32nd", "input": [["  ", 1], ["w", 1], [" \t w", 32], ["  ", 1]], "want": [["  ", 1], ["w", 1], [" \t w", 31]], "cut": true},
  {"rule": "inner runs of white space are kept", "input": [["a   b\t\tc", 1]], "want": [["a   b\t\tc", 1]], "cut": false},
  {"rule": "100 one-letter words are cut to 32", "input": [["x", 1], [" x", 99]], "want": [["x", 1], [" x", 31]], "cut": true},
  {"rule": "40 ten-letter words are cut to 32 words, then to 256 characters", "input": [["abcdefghij", 1], [" abcdefghij", 39]], "want": [["abcdefghij ", 23], ["abc", 1]], "cut": true},
  {"rule": "33 nine-character words are cut to 32 words, then to 256 characters", "input": [["abcdefghi", 1], [" abcdefghi", 32]], "want": [["abcdefghi ", 25], ["abcdef", 1]], "cut": true},
  {"rule": "33 seven-letter words lose the 33rd and the space before it", "input": [["abcdefg", 1], [" abcdefg", 32]], "want": [["abcdefg", 1], [" abcdefg", 31]], "cut": true},
  {"rule": "300 spaces have no words and are cut to 256 characters", "input": [[" ", 300]], "want": [[" ", 256]], "cut": true},
  {"rule": "a value of only white space within the limit is unchanged", "input": [[" \t\n", 10]], "want": [[" \t\n", 10]], "cut": false},
  {"rule": "a tab separates words", "input": [["w\u00f6rd", 1], ["\tw\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\tw\u00f6rd", 31]], "cut": true},
  {"rule": "a line feed separates words", "input": [["w\u00f6rd", 1], ["\nw\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\nw\u00f6rd", 31]], "cut": true},
  {"rule": "a vertical tab separates words", "input": [["w\u00f6rd", 1], ["\u000bw\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u000bw\u00f6rd", 31]], "cut": true},
  {"rule": "a form feed separates words", "input": [["w\u00f6rd", 1], ["\fw\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\fw\u00f6rd", 31]], "cut": true},
  {"rule": "a carriage return separates words", "input": [["w\u00f6rd", 1], ["\rw\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\rw\u00f6rd", 31]], "cut": true},
  {"rule": "a next line U+0085 separates words", "input": [["w\u00f6rd", 1], ["\u0085w\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u0085w\u00f6rd", 31]], "cut": true},
  {"rule": "a no-break space U+00A0 separates words", "input": [["w\u00f6rd", 1], ["\u00a0w\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u00a0w\u00f6rd", 31]], "cut": true},
  {"rule": "a ogham space U+1680 separates words", "input": [["w\u00f6rd", 1], ["\u1680w\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u1680w\u00f6rd", 31]], "cut": true},
  {"rule": "an en quad U+2000 separates words", "input": [["w\u00f6rd", 1], ["\u2000w\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u2000w\u00f6rd", 31]], "cut": true},
  {"rule": "a hair space U+200A separates words", "input": [["w\u00f6rd", 1], ["\u200aw\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u200aw\u00f6rd", 31]], "cut": true},
  {"rule": "a line separator U+2028 separates words", "input": [["w\u00f6rd", 1], ["\u2028w\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u2028w\u00f6rd", 31]], "cut": true},
  {"rule": "a paragraph separator U+2029 separates words", "input": [["w\u00f6rd", 1], ["\u2029w\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u2029w\u00f6rd", 31]], "cut": true},
  {"rule": "a narrow no-break space U+202F separates words", "input": [["w\u00f6rd", 1], ["\u202fw\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u202fw\u00f6rd", 31]], "cut": true},
  {"rule": "a medium mathematical space U+205F separates words", "input": [["w\u00f6rd", 1], ["\u205fw\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u205fw\u00f6rd", 31]], "cut": true},
  {"rule": "a ideographic space U+3000 separates words", "input": [["w\u00f6rd", 1], ["\u3000w\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u3000w\u00f6rd", 31]], "cut": true},
  {"rule": "a figure space U+2007 separates words", "input": [["w\u00f6rd", 1], ["\u2007w\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u2007w\u00f6rd", 31]], "cut": true},
  {"rule": "a six-per-em space U+2006 separates words", "input": [["w\u00f6rd", 1], ["\u2006w\u00f6rd", 32]], "want": [["w\u00f6rd", 1], ["\u2006w\u00f6rd", 31]], "cut": true},
  {"rule": "a zero-width space U+200B does not separate words", "input": [["w", 1], ["\u200bw", 39]], "want": [["w", 1], ["\u200bw", 39]], "cut": false},
  {"rule": "a byte order mark U+FEFF does not separate words", "input": [["w", 1], ["\ufeffw", 39]], "want": [["w", 1], ["\ufeffw", 39]], "cut": false},
  {"rule": "a mongolian vowel separator U+180E does not separate words", "input": [["w", 1], ["\u180ew", 39]], "want": [["w", 1], ["\u180ew", 39]], "cut": false},
  {"rule": "a word joiner U+2060 does not separate words", "input": [["w", 1], ["\u2060w", 39]], "want": [["w", 1], ["\u2060w", 39]], "cut": false},
  {"rule": "an information separator U+001F does not separate words", "input": [["w", 1], ["\u001fw", 39]], "want": [["w", 1], ["\u001fw", 39]], "cut": false}
];
// cases:end

const built = (parts) => parts.map(([text, count]) => text.repeat(count)).join('');

test('the page cuts every value in the table as the server does', () => {
  assert.ok(CASES.length > 30);
  for (const c of CASES) {
    const input = built(c.input);
    const got = cutParamValue(input);
    assert.ok(got === built(c.want), `${c.rule}: got ${JSON.stringify(got.slice(0, 40))}... (${[...got].length} characters)`);
    assert.equal(got !== input, c.cut, `${c.rule}: cut`);
  }
});

test('a stored request has its parameter values cut by the same rule', () => {
  for (const c of CASES) {
    const r = requestOf({ id: 'ws-c', endpoint: 'search', params: { q: built(c.input) } });
    assert.ok(r.params.q === built(c.want), c.rule);
  }
});
