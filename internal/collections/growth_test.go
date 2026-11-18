package collections

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// The curated assertions run against an index that keeps growing, so a number
// copied from one day's index is a defect on the next. These tests hold the
// collections to a policy: a corpus-dependent count is a bound, and only a
// shape (a page size, a suggester cap, an error code) or a single named card is
// asserted exactly.

// corpusCeiling is the document count the index held when the fixtures were
// measured. A filter-scoped total sits far below it, so "lt corpusCeiling"
// fails when the filter is dropped, and stays true as the index grows.
const corpusCeiling = 20324

// exactIDLookups are the only requests allowed an eq on $.total. An exact-id
// lookup returns one card whatever the size of the index.
var exactIDLookups = map[string]bool{
	"search-basics/exact-id": true,
}

// exactCounts are the only count assertions allowed, each with the reason it
// does not depend on how many documents the index holds.
var exactCounts = map[string]struct {
	value  float64
	reason string
}{
	"search-basics/browse-all $.results":              {24, "the page size"},
	"search-basics/browse-all $.facets.types":         {11, "the number of Pokemon TCG energy types, a property of the game"},
	"search-filters/sort-hp-desc $.results":           {24, "the page size"},
	"suggest-health/prefix-suggestions $.suggestions": {8, "the suggester's size cap"},
	"suggest-health/single-letter-cap $.suggestions":  {8, "the suggester's size cap"},
	"suggest-health/no-matches $.suggestions":         {0, "a query nothing can match"},
	"error-handling/page-overflow-clamps $.results":   {0, "a page past the last one holds nothing"},
}

// exactByRank are the only eq assertions on a rank-dependent path. Each is
// exact for a reason that holds as the index grows.
var exactByRank = map[string]string{
	"search-basics/exact-id $.results[0].name":         "an exact id returns that one card",
	"search-basics/exact-id $.results[0].set_id":       "an exact id returns that one card",
	"search-filters/filter-rarity $.results[0].rarity": "the filter guarantees every hit carries the rarity",
}

// filterScoped are the requests whose total was measured below half the corpus
// and is scoped by a filter, so a dropped filter must fail an upper bound.
var filterScoped = []string{
	"search-filters/filter-rarity",
	"search-filters/filter-two-types",
	"search-filters/filter-hp-range",
	"error-handling/lenient-list-member",
}

func key(c Collection, r sandbox.Request) string { return c.ID + "/" + r.ID }

func TestNoCuratedTotalOrDocsIsAnExactCount(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range All() {
		for _, r := range c.Requests {
			for _, a := range r.Assertions {
				if a.Type != assert.TypeJSON || (a.Path != "$.total" && a.Path != "$.docs") {
					continue
				}
				if a.Op != "eq" && a.Op != "neq" {
					continue
				}
				if exactIDLookups[key(c, r)] && a.Path == "$.total" && hasParam(r, "id") {
					seen[key(c, r)] = true
					continue
				}
				t.Errorf("%s: %s %s %v is an exact count; the index grows, so assert a bound", key(c, r), a.Path, a.Op, a.Value)
			}
		}
	}
	for k := range exactIDLookups {
		if !seen[k] {
			t.Errorf("exactIDLookups lists %s but it no longer asserts $.total eq on an id lookup; remove the stale entry", k)
		}
	}
}

func TestFilterScopedTotalsAreBoundedBothWays(t *testing.T) {
	byKey := map[string]sandbox.Request{}
	for _, c := range All() {
		for _, r := range c.Requests {
			byKey[key(c, r)] = r
		}
	}
	for _, k := range filterScoped {
		r, ok := byKey[k]
		if !ok {
			t.Errorf("%s: no such curated request", k)
			continue
		}
		var lower, upper bool
		for _, a := range r.Assertions {
			if a.Type != assert.TypeJSON || a.Path != "$.total" {
				continue
			}
			switch v, _ := a.Value.(float64); {
			case a.Op == "gt" && v > 0:
				lower = true
			case a.Op == "lt" && v == corpusCeiling:
				upper = true
			}
		}
		if !lower {
			t.Errorf("%s: no lower bound on $.total", k)
		}
		if !upper {
			t.Errorf("%s: no $.total lt %d, so a dropped filter would still pass", k, corpusCeiling)
		}
	}
}

func TestOnlyShapesAreCountedExactly(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range All() {
		for _, r := range c.Requests {
			for _, a := range r.Assertions {
				if a.Type != assert.TypeJSON || a.Op != "count" {
					continue
				}
				k := key(c, r) + " " + a.Path
				want, ok := exactCounts[k]
				if !ok {
					t.Errorf("%s: count %v is not a listed shape; a size that follows the index becomes a lower bound (e.g. an [n] exists)", k, a.Value)
					continue
				}
				seen[k] = true
				if got, _ := a.Value.(float64); got != want.value {
					t.Errorf("%s: count %v, the listed shape is %v (%s)", k, a.Value, want.value, want.reason)
				}
			}
		}
	}
	for k := range exactCounts {
		if !seen[k] {
			t.Errorf("exactCounts lists %q but no such count assertion exists; remove the stale entry", k)
		}
	}
}

func TestRankDependentValuesAreNotAssertedExactly(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range All() {
		for _, r := range c.Requests {
			for _, a := range r.Assertions {
				if a.Type != assert.TypeJSON || a.Op != "eq" {
					continue
				}
				if !strings.HasPrefix(a.Path, "$.results[") && !strings.HasPrefix(a.Path, "$.suggestions[") {
					continue
				}
				k := key(c, r) + " " + a.Path
				if _, ok := exactByRank[k]; !ok {
					t.Errorf("%s eq %v depends on ranking or on one card; use a bound or a contains check", k, a.Value)
					continue
				}
				seen[k] = true
			}
		}
	}
	for k := range exactByRank {
		if !seen[k] {
			t.Errorf("exactByRank lists %q but no such assertion exists; remove the stale entry", k)
		}
	}
}

// index is one state of the target's corpus.
type index struct {
	name     string
	charizar int // total for q=charizard
	corpus   int // browse total and /healthz docs
	scale    func(int) int
}

// The 2026-08-22 values are the ones the fixtures were measured against. The
// 2026-11-17 values are what the live index returned after it grew: charizard
// 108 and 20,635 documents were read off it, and every other corpus count is
// the old one scaled by 20,635/20,324 and rounded up, which is what a uniform
// growth of the index would do to it.
var (
	measured = index{"2026-08-22", 107, 20324, func(n int) int { return n }}
	grown    = index{"2026-11-17", 108, 20635, func(n int) int { return (n*20635 + 20323) / 20324 }}
)

type response struct {
	status int
	doc    map[string]any
}

func list(n int, each func(i int) any) []any {
	out := make([]any, n)
	for i := range out {
		out[i] = each(i)
	}
	return out
}

func cards(n int, first map[string]any) []any {
	return list(n, func(i int) any {
		if i == 0 {
			return first
		}
		return map[string]any{"name": "Filler"}
	})
}

func names(n int, first string) []any {
	return list(n, func(i int) any {
		if i == 0 {
			return first
		}
		return fmt.Sprintf("Suggestion %d", i)
	})
}

func errorBody(field string) map[string]any {
	return map[string]any{
		"error":      map[string]any{"code": "invalid_param", "field": field},
		"request_id": "req-0",
	}
}

// responses is what a healthy target answers to each curated request when its
// index is in state ix.
func responses(ix index) map[string]response {
	sets := func() []any { return list(ix.scale(173), func(i int) any { return map[string]any{"id": i} }) }
	return map[string]response{
		"search-basics/basic-text": {200, map[string]any{
			"total": ix.charizar, "results": cards(24, map[string]any{"name": "Charizard"})}},
		"search-basics/exact-id": {200, map[string]any{
			"total": 1, "results": cards(1, map[string]any{"name": "Alakazam", "set_id": "base1"})}},
		"search-basics/browse-all": {200, map[string]any{
			"total": ix.corpus, "results": cards(24, map[string]any{"name": "Anything"}),
			"facets": map[string]any{"types": list(11, func(i int) any { return i })}}},
		"search-basics/fuzzy-typo": {200, map[string]any{
			"total": ix.scale(128), "results": cards(24, map[string]any{"name": "Charizard ex"})}},
		"search-basics/scoped-facets": {200, map[string]any{
			"total": ix.scale(221),
			"facets": map[string]any{
				"types": list(ix.scale(9), func(i int) any { return i }),
				"sets":  sets(),
			}}},
		"search-filters/filter-rarity": {200, map[string]any{
			"total": ix.scale(1617), "results": cards(24, map[string]any{"rarity": "Rare Holo"})}},
		"search-filters/filter-two-types": {200, map[string]any{
			"total": ix.scale(3992), "facets": map[string]any{"sets": sets()}}},
		"search-filters/filter-hp-range": {200, map[string]any{
			"total": ix.scale(491), "results": cards(24, map[string]any{"hp": 300})}},
		"search-filters/sort-hp-desc": {200, map[string]any{
			"results": cards(24, map[string]any{"hp": 380, "name": "Mega Venusaur ex"})}},
		"suggest-health/prefix-suggestions": {200, map[string]any{"suggestions": names(8, "Alakazam")}},
		"suggest-health/single-letter-cap":  {200, map[string]any{"suggestions": names(8, "Pidgey")}},
		"suggest-health/no-matches":         {200, map[string]any{"suggestions": []any{}}},
		"suggest-health/health-check":       {200, map[string]any{"status": "ok", "docs": ix.corpus}},
		"error-handling/strict-sort":        {400, errorBody("sort")},
		"error-handling/strict-supertype":   {400, errorBody("supertype")},
		"error-handling/strict-page-size":   {400, errorBody("page_size")},
		"error-handling/page-overflow-clamps": {200, map[string]any{
			"page": 400, "results": []any{}}},
		"error-handling/lenient-list-member": {200, map[string]any{
			"total": ix.scale(1513), "results": cards(24, map[string]any{"types": []any{"Lightning"}})}},
		"random-traffic/random-word":    {200, map[string]any{"total": 0}},
		"random-traffic/random-pokemon": {200, map[string]any{"total": ix.scale(50)}},
	}
}

func target(t *testing.T, r response) assert.Target {
	t.Helper()
	body, err := json.Marshal(r.doc)
	if err != nil {
		t.Fatal(err)
	}
	return assert.NewTarget(r.status, 5, body)
}

// A curated assertion that passes only on the day it was measured fails the
// demo the next time the index is reseeded.
func TestEveryCuratedAssertionPassesWhateverTheIndexHolds(t *testing.T) {
	for _, ix := range []index{measured, grown} {
		bodies := responses(ix)
		for _, c := range All() {
			for _, r := range c.Requests {
				resp, ok := bodies[key(c, r)]
				if !ok {
					t.Errorf("[%s] %s: no synthetic response; add one so the new request is checked against index growth", ix.name, key(c, r))
					continue
				}
				outcomes, _ := assert.EvaluateAll(r.Assertions, target(t, resp))
				for _, o := range outcomes {
					if !o.Passed {
						t.Errorf("[%s] %s: %s %s %v: expected %s, got %s %s",
							ix.name, key(c, r), o.Assertion.Type, o.Assertion.Path, o.Assertion.Op, o.Expected, o.Actual, o.Error)
					}
				}
			}
		}
	}
}

// The upper bound is only worth having if it fails when the filter is lost:
// the target then answers with the whole corpus.
func TestADroppedFilterFailsTheCuratedAssertions(t *testing.T) {
	for _, ix := range []index{measured, grown} {
		bodies := responses(ix)
		for _, c := range All() {
			for _, r := range c.Requests {
				k := key(c, r)
				scoped := false
				for _, f := range filterScoped {
					scoped = scoped || f == k
				}
				if !scoped {
					continue
				}
				resp := bodies[k]
				resp.doc["total"] = ix.corpus
				if _, passed := assert.EvaluateAll(r.Assertions, target(t, resp)); passed {
					t.Errorf("[%s] %s: still passes when $.total is the whole corpus (%d)", ix.name, k, ix.corpus)
				}
			}
		}
	}
}
