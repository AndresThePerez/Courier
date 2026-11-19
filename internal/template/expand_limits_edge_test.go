package template

import (
	"math/rand/v2"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// spaces is the white space of s, in order: what the visitor typed between
// the words.
func spaces(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return r
		}
		return -1
	}, s)
}

// expandedWithin expands v, checked by the validator first, under the real
// random draw, and holds the dispatched value to both limits and to the white
// space the value was written with.
func expandedWithin(t *testing.T, label, v string, draws int) {
	t.Helper()
	checked := sandbox.CutParamValue(v)
	for range draws {
		got := Expand(sandbox.Request{Endpoint: "search", Params: map[string]string{"q": checked}}).Params["q"]
		n, w := utf8.RuneCountInString(got), len(strings.FieldsFunc(got, unicode.IsSpace))
		if n > sandbox.MaxParamValueLen || w > sandbox.MaxParamWords {
			t.Fatalf("%s: dispatched %d characters and %d words", label, n, w)
		}
		if spaces(got) != spaces(checked) {
			t.Fatalf("%s: the dispatched value's white space %q is not the %q written", label, spaces(got), spaces(checked))
		}
		if n > utf8.RuneCountInString(checked) {
			t.Fatalf("%s: expansion grew the value from %d to %d characters", label, utf8.RuneCountInString(checked), n)
		}
	}
}

// Values at the limits made of placeholders, however they end and whatever
// separates them, never go out past either limit or with white space the
// visitor did not type.
func TestExpandedValuesAtTheLimitsNeverPassThem(t *testing.T) {
	fill := func(tok, sep string) string { // as many tokens as 256 characters hold, then a part of one
		var b strings.Builder
		for utf8.RuneCountInString(b.String()) < 300 {
			if b.Len() > 0 {
				b.WriteString(sep)
			}
			b.WriteString(tok)
		}
		return b.String()
	}
	cases := map[string]string{
		"256 characters ending in a whole token":        strings.Repeat("x", 256-len(PokemonToken)) + PokemonToken,
		"256 characters ending in half a token":         strings.Repeat("x", 256-len(PokemonToken)) + PokemonToken + PokemonToken[:8],
		"only word tokens":                              strings.Repeat(WordToken, 30),
		"only pokemon tokens":                           strings.Repeat(PokemonToken, 30),
		"tokens and a token cut in two at the limit":    fill(WordToken, ""),
		"nested braces":                                 strings.Repeat("{{{{randomWord}}}}{{random{{randomPokemon}}Word}}", 10),
		"31 words, then two tokens, the second cut":     strings.Repeat("a ", 31) + WordToken + " " + WordToken,
		"a token in every one of 32 words and a 33rd":   strings.Repeat("a"+PokemonToken+"b ", 33),
		"a token glued to the next by a zero-width gap": strings.Repeat(WordToken+"\u200b", 20),
	}
	for name, sep := range map[string]string{
		"space": " ", "tab": "\t", "newline": "\n", "CRLF": "\r\n", "NBSP": "\u00a0",
		"ideographic space": "\u3000", "em space": "\u2003", "mixed": " \t\u3000",
	} {
		cases["tokens separated by "+name] = fill(PokemonToken, sep)
		cases["word tokens separated by "+name] = fill(WordToken, sep)
	}
	for label, v := range cases {
		expandedWithin(t, label, v, 200)
	}

	// How many whole tokens a value at the limit holds, and they all expand.
	only := sandbox.CutParamValue(strings.Repeat(WordToken, 30))
	if got := strings.Count(only, WordToken); got != 256/len(WordToken) {
		t.Errorf("a value of word tokens kept %d whole tokens, want %d", got, 256/len(WordToken))
	}
	if HasPlaceholder(map[string]string{"q": Expand(sandbox.Request{Params: map[string]string{"q": only}}).Params["q"]}) {
		t.Error("a whole token was left unexpanded")
	}
}

// Over many random values of tokens, words and white space, nothing the
// expansion dispatches is past either limit or carries white space the value
// did not hold.
func TestRandomPlaceholderValuesNeverExpandPastTheLimits(t *testing.T) {
	pieces := []string{WordToken, PokemonToken, "{{random", "Word}}", "a", "語", " ", "\t", "\u3000", "\u00a0", "\r\n", "{{", "}}"}
	rng := rand.New(rand.NewPCG(5, 23))
	for i := range 3000 {
		var b strings.Builder
		for range rng.IntN(120) {
			b.WriteString(pieces[rng.IntN(len(pieces))])
		}
		expandedWithin(t, "random value", b.String(), 3)
		if t.Failed() {
			t.Fatalf("value %d: %q", i, b.String())
		}
	}
}
