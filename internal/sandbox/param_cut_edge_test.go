package sandbox

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/assert"
)

// cutHolds checks every promise the cut makes about in and its result: a
// prefix of the value, within both limits, whole characters only, the value
// itself exactly when it was within both limits, a fixed point, and reported
// exactly when it changed the value.
func cutHolds(t *testing.T, label, in string) string {
	t.Helper()
	got := CutParamValue(in)
	within := utf8.RuneCountInString(in) <= MaxParamValueLen && words(in) <= MaxParamWords
	switch {
	case !strings.HasPrefix(in, got):
		t.Errorf("%s: the cut %q is not a prefix of the value", label, clipForLog(got))
	case utf8.ValidString(in) && !utf8.ValidString(got):
		t.Errorf("%s: the cut of a valid value is not valid UTF-8", label)
	case utf8.RuneCountInString(got) > MaxParamValueLen:
		t.Errorf("%s: the cut is %d characters, past %d", label, utf8.RuneCountInString(got), MaxParamValueLen)
	case words(got) > MaxParamWords:
		t.Errorf("%s: the cut is %d words, past %d", label, words(got), MaxParamWords)
	case within != (got == in):
		t.Errorf("%s: within the limits %v, but the value came back unchanged %v", label, within, got == in)
	case CutParamValue(got) != got:
		t.Errorf("%s: cutting the cut changes it again", label)
	}
	r := Request{Endpoint: "search", Params: map[string]string{"q": in}}
	if reported := RequestTruncations(r) != nil; reported != (got != in) {
		t.Errorf("%s: reported as cut %v, but the value changed %v", label, reported, got != in)
	}
	return got
}

// Every edge the rule names, each held to every promise of the cut and to the
// exact value it must produce.
func TestTheCutHoldsAtEveryEdgeOfBothLimits(t *testing.T) {
	combining := "e\u0301" // two characters that print as one
	allSpace := []string{" ", "\t", "\n", "\v", "\f", "\r", "\u0085", "\u00a0", "\u1680",
		"\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007",
		"\u2008", "\u2009", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000"}
	mixed := func(n int, w string) string {
		var b strings.Builder
		for i := range n {
			if i > 0 {
				b.WriteString(allSpace[i%len(allSpace)])
				b.WriteString(allSpace[(i*7)%len(allSpace)])
			}
			b.WriteString(w)
		}
		return b.String()
	}
	for _, tc := range []struct {
		name, in, want string
	}{
		{"empty", "", ""},
		{"a NUL inside", "pika\x00chu", "pika\x00chu"},
		{"one word of 300 characters", strings.Repeat("a", 300), strings.Repeat("a", 256)},
		{"33 one-character words", wordsOf(33, "a", " "), wordsOf(32, "a", " ")},
		{"32 words of more than 256 characters", wordsOf(32, "abcdefghi", " "), wordsOf(32, "abcdefghi", " ")[:256]},
		{"257 characters of white space", strings.Repeat(" ", 257), strings.Repeat(" ", 256)},
		{"257 ideographic spaces", strings.Repeat("\u3000", 257), strings.Repeat("\u3000", 256)},
		{"256 three-byte characters", strings.Repeat("語", 256), strings.Repeat("語", 256)},
		{"257 three-byte characters", strings.Repeat("語", 257), strings.Repeat("語", 256)},
		{"255 two-byte then a four-byte", strings.Repeat("é", 255) + "\U0001F525", strings.Repeat("é", 255) + "\U0001F525"},
		{"combining pairs, 257 characters", strings.Repeat(combining, 128) + "x", strings.Repeat(combining, 128)},
		// The cut counts characters, not what prints: it may part a letter
		// from the accent that follows it, never a character in two.
		{"combining pair across the limit", strings.Repeat("x", 255) + combining, strings.Repeat("x", 255) + "e"},
		{"33 words, every white space, mixed and repeated", mixed(33, "w"), strings.TrimRightFunc(mixed(32, "w"), unicode.IsSpace)},
		{"32 words, every white space, mixed and repeated", mixed(32, "w"), mixed(32, "w")},
		{"33 words with white space at both ends", "\u3000\t " + wordsOf(33, "w", "\u00a0") + " \n", "\u3000\t " + wordsOf(32, "w", "\u00a0")},
		{"32 words with white space at both ends", "\u3000\t " + wordsOf(32, "w", "\u00a0") + " \n", "\u3000\t " + wordsOf(32, "w", "\u00a0") + " \n"},
		// Both limits cross on the same character: the 33rd word starts at
		// the 257th character.
		{"both limits at the same character", wordsOf(32, "abcdefg", " ") + " z", wordsOf(32, "abcdefg", " ")},
		// The word cut leaves 256 characters exactly: nothing more to cut.
		{"word cut to exactly 256", wordsOf(32, "abcdefg", " ") + " more words", wordsOf(32, "abcdefg", " ")},
		{"a zero-width space joins words", wordsOf(40, "w", "\u200b"), wordsOf(40, "w", "\u200b")},
	} {
		got := cutHolds(t, tc.name, tc.in)
		if got != tc.want {
			t.Errorf("%s: cut to %d characters and %d words (%q...), want %d characters and %d words",
				tc.name, utf8.RuneCountInString(got), words(got), clipForLog(got), utf8.RuneCountInString(tc.want), words(tc.want))
		}
	}
	if utf8.RuneCountInString(wordsOf(32, "abcdefg", " ")) != 255 {
		t.Fatal("the fixture for both limits at once is not 255 characters")
	}
}

// Random values over every kind of character and separator keep every
// promise of the cut.
func TestTheCutKeepsItsPromisesOverRandomValues(t *testing.T) {
	pieces := []string{"a", "Z", "9", "é", "語", "\U0001F525", "e\u0301", "\x00", "{{randomWord}}",
		" ", "  ", "\t", "\r\n", "\u00a0", "\u3000", "\u2003", "\u200b", "\u0085"}
	rng := rand.New(rand.NewPCG(19, 11))
	for i := range 20000 {
		var b strings.Builder
		for range rng.IntN(400) {
			b.WriteString(pieces[rng.IntN(len(pieces))])
		}
		cutHolds(t, fmt.Sprintf("random value %d", i), b.String())
		if t.Failed() {
			t.Fatalf("value %d: %q", i, b.String())
		}
	}
}

// A value that is not valid UTF-8 still leaves the cut as whole characters
// within both limits when it is cut, and is reported.
func TestAnInvalidUTF8ValueIsCutToValidCharacters(t *testing.T) {
	in := strings.Repeat("\xff", 300)
	got := CutParamValue(in)
	if !utf8.ValidString(got) || utf8.RuneCountInString(got) > MaxParamValueLen {
		t.Errorf("cut of 300 invalid bytes: valid %v, %d characters", utf8.ValidString(got), utf8.RuneCountInString(got))
	}
	if RequestTruncations(Request{Endpoint: "search", Params: map[string]string{"q": in}}) == nil {
		t.Error("the cut of 300 invalid bytes was not reported")
	}
}

// Several parameters of one request, and several requests of a run, each
// report their own cut and nothing else, in the validator's notation.
func TestTruncatedNamesExactlyTheParametersCut(t *testing.T) {
	long := strings.Repeat("x", 257)
	wordy := wordsOf(33, "w", "\t")
	atLimit := wordsOf(32, "w", "\u3000")
	rr := RunRequest{Mode: ModeFunctional, Sequence: []Request{
		{ID: "a", Name: "a", Endpoint: "search", Params: map[string]string{"q": wordy, "set": long, "rarity": atLimit, "types": "fire"}},
		{ID: "b", Name: "b", Endpoint: "search", Params: map[string]string{"q": atLimit, "series": strings.Repeat("y", 256)}},
		{ID: "c", Name: "c", Endpoint: "suggest", Params: map[string]string{"q": long + " " + wordy}},
	}}
	want := []string{"sequence[0].params.q", "sequence[0].params.set", "sequence[2].params.q"}
	if got := Truncations(rr); !slices.Equal(got, want) {
		t.Errorf("Truncations = %v, want %v", got, want)
	}
	out, err := Validate(rr)
	if err != nil {
		t.Fatalf("a run with long values was refused: %v", err)
	}
	for i, r := range out.Sequence {
		for k, v := range r.Params {
			if v != CutParamValue(rr.Sequence[i].Params[k]) {
				t.Errorf("sequence[%d].params.%s went out as %q, not its cut", i, k, clipForLog(v))
			}
		}
	}
}

// The assertion strings keep their own limit of 500: 257 to 500 characters
// are accepted, in any width of character, and 501 is refused.
func TestAssertionTextFrom257To500IsStillAccepted(t *testing.T) {
	for _, n := range []int{257, 300, 499, 500} {
		for _, ch := range []string{"x", "語", "\U0001F525"} {
			v := strings.Repeat(ch, n)
			r := Request{Endpoint: "search", Params: map[string]string{"q": "a"}, Assertions: []assert.Assertion{
				{Type: assert.TypeBodyContains, Op: "contains", Value: v},
				{Type: assert.TypeJSON, Path: "$." + strings.Repeat(ch, n-2), Op: "exists"},
			}}
			if _, err := ValidateRequest(r); err != nil {
				t.Errorf("%d characters of %q in an assertion were refused: %v", n, ch, err)
			}
		}
	}
	r := Request{Endpoint: "search", Assertions: []assert.Assertion{
		{Type: assert.TypeBodyContains, Op: "contains", Value: strings.Repeat("語", 501)}}}
	if _, err := ValidateRequest(r); err == nil {
		t.Error("an assertion value of 501 characters was accepted")
	}
}
