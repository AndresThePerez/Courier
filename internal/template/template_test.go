package template

import (
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// stubPick makes expansion deterministic for a test: it returns pool indices
// from script in order, wrapping.
func stubPick(t *testing.T, script ...int) {
	t.Helper()
	orig := intN
	i := 0
	intN = func(n int) int {
		v := script[i%len(script)] % n
		i++
		return v
	}
	t.Cleanup(func() { intN = orig })
}

func TestHasPlaceholder(t *testing.T) {
	cases := []struct {
		name   string
		params map[string]string
		want   bool
	}{
		{"nil", nil, false},
		{"plain", map[string]string{"q": "charizard"}, false},
		{"word", map[string]string{"q": "{{randomWord}}"}, true},
		{"pokemon", map[string]string{"q": "{{randomPokemon}}"}, true},
		{"embedded", map[string]string{"q": "mega {{randomPokemon}} ex"}, true},
	}
	for _, c := range cases {
		if got := HasPlaceholder(c.params); got != c.want {
			t.Errorf("%s: HasPlaceholder = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestExpandDrawsFromPool(t *testing.T) {
	r := sandbox.Request{Params: map[string]string{"q": "{{randomPokemon}}"}}
	out := Expand(r)
	got := out.Params["q"]
	if strings.Contains(got, "{{") {
		t.Fatalf("placeholder survived expansion: %q", got)
	}
	found := false
	for _, p := range pokemon {
		if got == p {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expanded value %q is not in the pokemon pool", got)
	}
}

func TestExpandEachOccurrenceIndependent(t *testing.T) {
	stubPick(t, 0, 1)
	r := sandbox.Request{Params: map[string]string{"q": "{{randomWord}} {{randomWord}}"}}
	out := Expand(r)
	want := words[0] + " " + words[1]
	if out.Params["q"] != want {
		t.Errorf("got %q, want %q", out.Params["q"], want)
	}
}

func TestExpandLeavesInputUntouched(t *testing.T) {
	r := sandbox.Request{Params: map[string]string{"q": "{{randomWord}}"}}
	_ = Expand(r)
	if r.Params["q"] != "{{randomWord}}" {
		t.Errorf("Expand mutated its input: %q", r.Params["q"])
	}
}

func TestExpandPassthroughWithoutPlaceholders(t *testing.T) {
	r := sandbox.Request{Params: map[string]string{"q": "charizard"}}
	out := Expand(r)
	if out.Params["q"] != "charizard" {
		t.Fatal("passthrough broke the request")
	}
	// Same map, not a copy: the fast path must not allocate per dispatch.
	out.Params["probe"] = "x"
	if _, shared := r.Params["probe"]; !shared {
		t.Error("expected the no-placeholder fast path to return the same map")
	}
}

func TestPoolsAreUsable(t *testing.T) {
	pools := []struct {
		name  string
		token string
		pool  []string
	}{
		{"words", WordToken, words},
		{"pokemon", PokemonToken, pokemon},
	}
	for _, p := range pools {
		if len(p.pool) < 40 {
			t.Fatalf("%s pool too small: %d", p.name, len(p.pool))
		}
		for _, w := range p.pool {
			if w == "" || strings.ContainsAny(w, "{}&=?") {
				t.Errorf("bad %s entry %q", p.name, w)
			}
			// A token is one word and must expand to one word: white space in
			// an entry would add words past sandbox.MaxParamWords.
			if strings.IndexFunc(w, unicode.IsSpace) >= 0 {
				t.Errorf("%s entry %q holds white space: expansion could add words past sandbox.MaxParamWords", p.name, w)
			}
			// Expansion runs after sandbox validation, and the cap is not
			// re-checked on the way out: only a strictly shrinking substitution
			// keeps an expanded value inside sandbox.MaxParamValueLen.
			if len(w) >= len(p.token) {
				t.Errorf("%s entry %q is %d bytes, not shorter than %s (%d bytes): expansion could grow a value past sandbox.MaxParamValueLen",
					p.name, w, len(w), p.token, len(p.token))
			}
		}
	}
}

// A value the validator let through at either limit, holding placeholders,
// is still within both limits once every placeholder is drawn, whatever is
// drawn: the value dispatched is never longer or wordier than the one checked.
func TestAnExpandedValueAtTheLimitsStaysWithinThem(t *testing.T) {
	join := func(n int, w string) string { return strings.TrimSuffix(strings.Repeat(w+" ", n), " ") }
	values := map[string]string{
		"256 characters of pokemon placeholders": sandbox.CutParamValue(join(40, PokemonToken)),
		"256 characters of word placeholders":    sandbox.CutParamValue(join(40, WordToken)),
		"32 words, the last one a placeholder":   join(31, "a") + " " + PokemonToken,
		"32 words, each holding a placeholder":   sandbox.CutParamValue(join(32, "x"+WordToken)),
		"placeholders with no space between":     sandbox.CutParamValue(strings.Repeat(WordToken+PokemonToken, 20)),
	}
	longest := max(len(words), len(pokemon))
	for name, v := range values {
		if sandbox.CutParamValue(v) != v {
			t.Fatalf("%s: the value is not within the limits before expansion", name)
		}
		for i := range longest {
			stubPick(t, i)
			r := Expand(sandbox.Request{Endpoint: "search", Params: map[string]string{"q": v}})
			got := r.Params["q"]
			if sandbox.CutParamValue(got) != got {
				t.Fatalf("%s, draw %d: the expanded value is %d characters and %d words, past the limits",
					name, i, utf8.RuneCountInString(got), len(strings.FieldsFunc(got, unicode.IsSpace)))
			}
		}
	}
}
