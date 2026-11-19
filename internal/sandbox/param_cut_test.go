package sandbox

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"slices"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/assert"
)

// words counts the white-space-separated words of s, the rule the cut uses.
func words(s string) int { return len(strings.FieldsFunc(s, unicode.IsSpace)) }

// wordsOf is n copies of w joined by sep.
func wordsOf(n int, w, sep string) string { return strings.Join(slices.Repeat([]string{w}, n), sep) }

// cutQ runs a search request with q through the validator and reports what
// it sent and whether the cut was reported.
func cutQ(t *testing.T, q string) (string, bool) {
	t.Helper()
	r := Request{Endpoint: "search", Params: map[string]string{"q": q}}
	out, err := ValidateRequest(r)
	if err != nil {
		t.Fatalf("a parameter value was refused rather than cut: %v", err)
	}
	reported := slices.Equal(RequestTruncations(r), []string{"params.q"})
	if !reported && RequestTruncations(r) != nil {
		t.Fatalf("RequestTruncations = %v, want nil or [params.q]", RequestTruncations(r))
	}
	if got := CutParamValue(q); got != out.Params["q"] {
		t.Fatalf("CutParamValue = %q, but the validator sent %q", got, out.Params["q"])
	}
	return out.Params["q"], reported
}

func TestTheParameterLimitsAreTheTargetsSearchLimits(t *testing.T) {
	if MaxParamValueLen != 256 || MaxParamWords != 32 {
		t.Errorf("a parameter value is cut to %d characters and %d words, want 256 and 32", MaxParamValueLen, MaxParamWords)
	}
	if MaxAssertionTextLen != 500 || MaxNameLen != 120 {
		t.Errorf("the assertion text cap is %d and the name cap %d, want 500 and 120 as before", MaxAssertionTextLen, MaxNameLen)
	}
}

// A value is cut to 256 characters, counted as runes; one at the limit is
// sent whole and not reported.
func TestAParameterValueIsCutTo256Characters(t *testing.T) {
	for _, tc := range []struct {
		in, want string
		cut      bool
	}{
		{strings.Repeat("x", 255), strings.Repeat("x", 255), false},
		{strings.Repeat("x", 256), strings.Repeat("x", 256), false},
		{strings.Repeat("x", 257), strings.Repeat("x", 256), true},
		{strings.Repeat("x", 5000), strings.Repeat("x", 256), true},
		// Characters, not bytes: 256 two-byte and four-byte characters fit.
		{strings.Repeat("é", 256), strings.Repeat("é", 256), false},
		{strings.Repeat("x", 255) + "\U0001F525", strings.Repeat("x", 255) + "\U0001F525", false},
		{strings.Repeat("x", 255) + "\U0001F525\U0001F525", strings.Repeat("x", 255) + "\U0001F525", true},
		{strings.Repeat("\U0001F525", 257), strings.Repeat("\U0001F525", 256), true},
	} {
		got, reported := cutQ(t, tc.in)
		if got != tc.want || reported != tc.cut {
			t.Errorf("%d characters: sent %d characters (%q...), reported %v; want %d characters, reported %v",
				utf8.RuneCountInString(tc.in), utf8.RuneCountInString(got), clipForLog(got), reported, utf8.RuneCountInString(tc.want), tc.cut)
		}
		if !utf8.ValidString(got) {
			t.Errorf("%d characters: the cut split a character", utf8.RuneCountInString(tc.in))
		}
	}
}

func clipForLog(s string) string {
	if r := []rune(s); len(r) > 12 {
		return string(r[:12])
	}
	return s
}

// A value is cut to its first 32 words; the white space after the last word
// kept goes with the words cut.
func TestAParameterValueIsCutTo32Words(t *testing.T) {
	for _, tc := range []struct {
		in, want string
		cut      bool
	}{
		{wordsOf(31, "w", " "), wordsOf(31, "w", " "), false},
		{wordsOf(32, "w", " "), wordsOf(32, "w", " "), false},
		{wordsOf(33, "w", " "), wordsOf(32, "w", " "), true},
		{wordsOf(100, "w", " "), wordsOf(32, "w", " "), true},
		// White space inside and around the words kept is kept as written.
		{"  " + wordsOf(32, "w", " \t ") + "  ", "  " + wordsOf(32, "w", " \t ") + "  ", false},
		{"  " + wordsOf(33, "w", " \t ") + "  ", "  " + wordsOf(32, "w", " \t "), true},
	} {
		got, reported := cutQ(t, tc.in)
		if got != tc.want || reported != tc.cut {
			t.Errorf("%d words: sent %q, reported %v; want %q, reported %v", words(tc.in), got, reported, tc.want, tc.cut)
		}
	}
}

// Every Unicode white space separates words: tabs, newlines, non-breaking and
// ideographic spaces as well as the plain space.
func TestEveryUnicodeWhiteSpaceSeparatesWords(t *testing.T) {
	for name, sep := range map[string]string{
		"space": " ", "tab": "\t", "newline": "\n", "carriage return and newline": "\r\n",
		"non-breaking space": "\u00a0", "ideographic space": "\u3000", "em space": "\u2003",
	} {
		got, reported := cutQ(t, wordsOf(33, "wörd", sep))
		if want := wordsOf(32, "wörd", sep); got != want || !reported {
			t.Errorf("33 words separated by a %s: sent %q, reported %v; want the first 32", name, got, reported)
		}
		if got, reported := cutQ(t, wordsOf(32, "wörd", sep)); got != wordsOf(32, "wörd", sep) || reported {
			t.Errorf("32 words separated by a %s were cut to %q", name, got)
		}
	}
	// A character that is not white space joins words: a zero-width space
	// is not a separator.
	if got, reported := cutQ(t, wordsOf(40, "w", "\u200b")); reported || got != wordsOf(40, "w", "\u200b") {
		t.Errorf("words joined by zero-width spaces were cut to %q", got)
	}
}

// The word cut comes first, then the character cut; a value over both limits
// meets whichever comes first along the value.
func TestBothLimitsAtOnce(t *testing.T) {
	// The character limit comes first: 40 words of ten letters.
	long := wordsOf(40, "abcdefghij", " ")
	if got, reported := cutQ(t, long); got != long[:256] || !reported {
		t.Errorf("40 ten-letter words: sent %d characters and %d words, want the first 256 characters", len(got), words(got))
	}
	// The word limit comes first: 100 one-letter words.
	short := wordsOf(100, "a", " ")
	if got, reported := cutQ(t, short); got != wordsOf(32, "a", " ") || !reported {
		t.Errorf("100 one-letter words: sent %q, want the first 32 words", got)
	}
	// Both bind: the first 32 words are longer than 256 characters.
	both := wordsOf(33, strings.Repeat("é", 9), " ")
	if got, reported := cutQ(t, both); got != string([]rune(both)[:256]) || !reported {
		t.Errorf("33 nine-character words: sent %d characters, want the first 256", utf8.RuneCountInString(got))
	}
	// The order shows when the 256th character falls in the white space after
	// the 32nd word: the words go first, and that white space with them.
	word := strings.Repeat("y", 7) // 32 words and their separators: 32*8 = 256
	edge := wordsOf(33, word, " ")
	if got := CutParamValue(edge); got != wordsOf(32, word, " ") {
		t.Errorf("33 seven-letter words: sent %q (%d characters), want the first 32 words without the space after them", got, len(got))
	}
}

// Leading and trailing white space count as characters, and a value that is
// only white space has no words: it is cut by characters alone.
func TestWhiteSpaceAtTheEdgesAndAValueOfOnlyWhiteSpace(t *testing.T) {
	if got, reported := cutQ(t, strings.Repeat(" ", 300)); got != strings.Repeat(" ", 256) || !reported {
		t.Errorf("300 spaces: sent %d characters, reported %v; want 256, reported", len(got), reported)
	}
	if got, reported := cutQ(t, strings.Repeat("\u3000", 256)); got != strings.Repeat("\u3000", 256) || reported {
		t.Errorf("256 ideographic spaces were cut to %d characters", utf8.RuneCountInString(got))
	}
	if got, reported := cutQ(t, "  charizard  "); got != "  charizard  " || reported {
		t.Errorf("a padded word was changed to %q", got)
	}
	if got, reported := cutQ(t, strings.Repeat(" ", 250)+"pikachu"); got != strings.Repeat(" ", 250)+"pikach" || !reported {
		t.Errorf("a word after 250 spaces: sent %q", got)
	}
	if got, reported := cutQ(t, ""); got != "" || reported {
		t.Errorf("an empty value was changed to %q", got)
	}
}

// Whatever the value, what is sent is a prefix of it, within both limits,
// whole characters only, and unchanged exactly when it is not reported.
func TestTheCutNeverExceedsEitherLimit(t *testing.T) {
	alphabet := []rune{'a', 'é', '\U0001F525', ' ', '\t', '\n', '\u00a0', '\u3000', '\u200b', 'x'}
	rng := rand.New(rand.NewPCG(7, 13))
	for range 3000 {
		n := rng.IntN(700)
		var b strings.Builder
		for range n {
			b.WriteRune(alphabet[rng.IntN(len(alphabet))])
		}
		in := b.String()
		got, reported := cutQ(t, in)
		switch {
		case !strings.HasPrefix(in, got):
			t.Fatalf("%q was cut to %q, which is not its prefix", in, got)
		case utf8.RuneCountInString(got) > MaxParamValueLen, words(got) > MaxParamWords:
			t.Fatalf("%q was cut to %d characters and %d words", in, utf8.RuneCountInString(got), words(got))
		case !utf8.ValidString(got):
			t.Fatalf("%q was cut inside a character", in)
		case reported != (got != in):
			t.Fatalf("%q: sent %q, reported %v", in, got, reported)
		case CutParamValue(got) != got:
			t.Fatalf("cutting %q again changed it", got)
		}
		within := utf8.RuneCountInString(in) <= MaxParamValueLen && words(in) <= MaxParamWords
		if within != !reported {
			t.Fatalf("%q (%d characters, %d words) reported %v", in, utf8.RuneCountInString(in), words(in), reported)
		}
	}
}

// A run reports each cut at its own request, by the same rule.
func TestARunReportsWordCutsAtTheirRequest(t *testing.T) {
	rr := RunRequest{Mode: ModeFunctional, Sequence: []Request{
		req(map[string]string{"q": wordsOf(32, "w", " ")}),
		req(map[string]string{"q": wordsOf(33, "w", " ")}),
		req(map[string]string{"q": strings.Repeat("x", 257)}),
	}}
	want := []string{"sequence[1].params.q", "sequence[2].params.q"}
	if got := Truncations(rr); !slices.Equal(got, want) {
		t.Errorf("Truncations = %v, want %v", got, want)
	}
	out, err := Validate(rr)
	if err != nil {
		t.Fatal(err)
	}
	if q := out.Sequence[1].Params["q"]; q != wordsOf(32, "w", " ") {
		t.Errorf("sequence[1] sent %q, want its first 32 words", q)
	}
}

// The assertion limits stay at 500 characters and still refuse: between the
// parameter limit and 500 an assertion's value and path are accepted whole.
func TestAssertionTextBetweenTheParameterLimitAndItsOwnIsAccepted(t *testing.T) {
	for _, n := range []int{MaxParamValueLen + 1, 300, 499, MaxAssertionTextLen} {
		for _, a := range []assert.Assertion{
			{Type: "body_contains", Op: "contains", Value: strings.Repeat("é", n)},
			{Type: "json", Path: "$.name", Op: "eq", Value: strings.Repeat("w ", n/2) + strings.Repeat("z", n%2)},
			{Type: "json", Path: "$." + strings.Repeat("a", n-2), Op: "exists"},
		} {
			out, err := ValidateRequest(Request{Endpoint: "healthz", Assertions: []assert.Assertion{a}})
			if err != nil {
				t.Errorf("an assertion of %d characters was refused: %v", n, err)
				continue
			}
			if out.Assertions[0] != a {
				t.Errorf("an assertion of %d characters was changed", n)
			}
		}
	}
	_, err := ValidateRequest(Request{Endpoint: "healthz", Assertions: []assert.Assertion{
		{Type: "body_contains", Op: "contains", Value: strings.Repeat("x", MaxAssertionTextLen+1)}}})
	var ve ValidationError
	if !errors.As(err, &ve) || ve.Field != "assertions[0]" {
		t.Errorf("an assertion value of %d characters: err = %v, want it refused", MaxAssertionTextLen+1, err)
	}
}

// The README's Caps row and the design notes state the parameter limits; this
// fails when they and the code stop agreeing.
func TestTheParameterLimitsMatchTheDocuments(t *testing.T) {
	for path, want := range map[string]string{
		"../../README.md": fmt.Sprintf("| Param value length | ≤ %d chars and the first %d words (truncated, not rejected) |",
			MaxParamValueLen, MaxParamWords),
		"../../docs/design.md": fmt.Sprintf("its first %d words and then its first %d characters", MaxParamWords, MaxParamValueLen),
		"../../docs/deviations.md": fmt.Sprintf("cut to its first %d words and then to its first %d characters",
			MaxParamWords, MaxParamValueLen),
	} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), want) {
			t.Errorf("%s does not say %q", path, want)
		}
	}
}
