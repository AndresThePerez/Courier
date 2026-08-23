package template

import (
	"strings"
	"testing"

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
