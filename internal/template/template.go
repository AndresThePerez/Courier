// Package template expands random-variable placeholders in request param
// values. Expansion happens at dispatch time, after sandbox validation — the
// sandbox has exactly one door and this is not a second one: a placeholder is
// an ordinary param value on the way in, and what it expands to is bounded by
// the pools below, never by client input.
package template

import (
	"math/rand/v2"
	"strings"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// The two placeholder tokens. Matched literally, case-sensitively — a
// mistyped token is an ordinary search string, which the target answers with
// zero results rather than an error, so there is nothing to validate.
const (
	WordToken    = "{{randomWord}}"
	PokemonToken = "{{randomPokemon}}"
)

// intN is rand/v2's global IntN, swappable so tests can script the draw.
// The v2 global generator is safe for concurrent use, which matters: perf
// mode expands from up to 50 worker goroutines at once.
var intN = rand.IntN

// Every entry in both pools must be shorter than the token it replaces, which
// TestPoolsAreUsable enforces. Expansion happens after sandbox validation and
// MaxParamValueLen is not re-checked on the way out, so a strictly shrinking
// substitution is what keeps an expanded value inside the cap.

// words is deliberately generic English: against the card corpus many of
// these miss or fuzzy-match, which is what real messy traffic looks like.
var words = []string{
	"ancient", "apple", "armor", "autumn", "banana", "battle", "blaze",
	"breeze", "bridge", "candle", "canyon", "castle", "charge", "cloud",
	"copper", "coral", "crystal", "dagger", "dawn", "desert", "diamond",
	"dragon", "dream", "ember", "empty", "falcon", "feather", "fire",
	"flame", "forest", "frost", "garden", "giant", "glacier", "golden",
	"granite", "harbor", "hollow", "hunter", "island", "ivory", "jungle",
	"knight", "lantern", "legend", "lunar", "marble", "meadow", "midnight",
	"mirror", "mountain", "ocean", "orange", "phantom", "planet", "prism",
	"raven", "river", "shadow", "silver", "spark", "spirit", "storm",
	"summit", "thunder", "tiger", "torch", "tower", "valley", "velvet",
	"water", "willow", "winter", "wizard", "wolf", "zephyr",
}

// pokemon guarantees rich results: every entry is a real species name the
// seeded index answers with non-zero totals.
var pokemon = []string{
	"pikachu", "charizard", "bulbasaur", "squirtle", "eevee", "snorlax",
	"gengar", "mewtwo", "dragonite", "gyarados", "alakazam", "machamp",
	"arcanine", "lapras", "vaporeon", "jolteon", "flareon", "articuno",
	"zapdos", "moltres", "mew", "chikorita", "cyndaquil", "totodile",
	"typhlosion", "feraligatr", "meganium", "lugia", "celebi", "treecko",
	"torchic", "mudkip", "blaziken", "swampert", "sceptile", "rayquaza",
	"groudon", "kyogre", "garchomp", "lucario", "greninja", "sylveon",
	"umbreon", "espeon", "leafeon", "glaceon", "ditto", "magikarp",
	"onix", "steelix", "scizor", "heracross", "tyranitar", "salamence",
	"metagross", "absol", "riolu", "togepi", "marill", "wobbuffet",
}

// HasPlaceholder reports whether any param value carries a token. It is cheap
// enough to call per dispatch, but perf mode still precomputes it per entry —
// the engine's measured overhead budget is microseconds, not a place to spend
// a map walk 18,000 times when the answer never changes mid-run.
func HasPlaceholder(params map[string]string) bool {
	for _, v := range params {
		if strings.Contains(v, WordToken) || strings.Contains(v, PokemonToken) {
			return true
		}
	}
	return false
}

// Expand returns r with every token occurrence replaced by an independent
// random draw from its pool. Without placeholders it returns r unchanged —
// same map, zero allocations — so callers can expand unconditionally.
// The input is never mutated.
func Expand(r sandbox.Request) sandbox.Request {
	if !HasPlaceholder(r.Params) {
		return r
	}
	out := r
	out.Params = make(map[string]string, len(r.Params))
	for k, v := range r.Params {
		v = replaceEach(v, WordToken, words)
		v = replaceEach(v, PokemonToken, pokemon)
		out.Params[k] = v
	}
	return out
}

// replaceEach substitutes occurrences one at a time so two tokens in one
// value draw two different words.
func replaceEach(s, token string, pool []string) string {
	for strings.Contains(s, token) {
		s = strings.Replace(s, token, pool[intN(len(pool))], 1)
	}
	return s
}
