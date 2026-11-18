package collections

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
)

// measuredAt are the values the 2026-08-22 index answered for every bounded
// path. A lower bound must sit exactly one below its measured value: any
// looser and a shrinking index slips through, any tighter and the measured
// day itself fails.
var measuredAt = map[string]float64{
	"search-basics/basic-text $.total":            107,
	"search-basics/browse-all $.total":            20324,
	"search-basics/fuzzy-typo $.total":            128,
	"search-basics/scoped-facets $.total":         221,
	"search-filters/filter-rarity $.total":        1617,
	"search-filters/filter-two-types $.total":     3992,
	"search-filters/filter-hp-range $.total":      491,
	"search-filters/sort-hp-desc $.results[0].hp": 380,
	"suggest-health/health-check $.docs":          20324,
	"error-handling/lenient-list-member $.total":  1513,
}

// at builds a body holding v at a top-level path such as $.total, or at the
// hp of the first result.
func at(path string, v any) []byte {
	var doc map[string]any
	switch path {
	case "$.results[0].hp":
		doc = map[string]any{"results": []any{map[string]any{"hp": v}}}
	default:
		doc = map[string]any{path[2:]: v}
	}
	body, _ := json.Marshal(doc)
	return body
}

func passes(a assert.Assertion, body []byte) bool {
	return assert.Evaluate(a, assert.NewTarget(200, 5, body)).Passed
}

func TestEveryLowerBoundAdmitsTheMeasuredValueAndRejectsOneLess(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range All() {
		for _, r := range c.Requests {
			for _, a := range r.Assertions {
				if a.Type != assert.TypeJSON || a.Op != "gt" {
					continue
				}
				k := key(c, r) + " " + a.Path
				m, ok := measuredAt[k]
				if !ok {
					continue // the random-traffic floor of 0 has no measured value
				}
				seen[k] = true
				if !passes(a, at(a.Path, m)) {
					t.Errorf("%s gt %v rejects the measured %v", k, a.Value, m)
				}
				if passes(a, at(a.Path, m-1)) {
					t.Errorf("%s gt %v admits %v, one below the measured value: an index that lost a card still passes", k, a.Value, m-1)
				}
			}
		}
	}
	for k := range measuredAt {
		if !seen[k] {
			t.Errorf("%s: measured value listed but no gt bound asserts it", k)
		}
	}
}

func TestEveryUpperBoundRejectsTheWholeCorpusOldAndGrown(t *testing.T) {
	n := 0
	for _, c := range All() {
		for _, r := range c.Requests {
			for _, a := range r.Assertions {
				if a.Type != assert.TypeJSON || a.Op != "lt" {
					continue
				}
				n++
				k := key(c, r) + " " + a.Path
				if m := measuredAt[k]; !passes(a, at(a.Path, m)) || !passes(a, at(a.Path, m*20635/20324+1)) {
					t.Errorf("%s lt %v rejects the scoped total on the measured or the grown index", k, a.Value)
				}
				for _, corpus := range []float64{20324, 20635, 1e6} {
					if passes(a, at(a.Path, corpus)) {
						t.Errorf("%s lt %v admits a total equal to the whole corpus (%v)", k, a.Value, corpus)
					}
				}
			}
		}
	}
	if n != len(filterScoped) {
		t.Errorf("found %d upper bounds, want one per filter-scoped total (%d)", n, len(filterScoped))
	}
}

// A length bound written as an index must fail on an array one short of it.
func TestEveryArrayLengthBoundFailsOneShort(t *testing.T) {
	cases := map[string]struct {
		facet string
		want  int
	}{"$.facets.types[8]": {"types", 9}, "$.facets.sets[172]": {"sets", 173}}
	for _, c := range All() {
		for _, r := range c.Requests {
			for _, a := range r.Assertions {
				if a.Type != assert.TypeJSON || a.Op != "exists" {
					continue
				}
				cs, ok := cases[a.Path]
				if !ok {
					continue
				}
				want := cs.want
				arr := func(n int) []byte {
					body, _ := json.Marshal(map[string]any{"facets": map[string]any{cs.facet: list(n, func(i int) any { return i })}})
					return body
				}
				if !passes(a, arr(want)) {
					t.Errorf("%s/%s %s exists rejects the measured %d entries", c.ID, r.ID, a.Path, want)
				}
				if passes(a, arr(want-1)) {
					t.Errorf("%s/%s %s exists admits %d entries, one short", c.ID, r.ID, a.Path, want-1)
				}
				if passes(a, []byte(`{"facets":{}}`)) {
					t.Errorf("%s/%s %s exists admits a missing facet", c.ID, r.ID, a.Path)
				}
			}
		}
	}
}

// An assertion set that cannot fail is decoration: a target that is down,
// empty, or answering numbers as strings must fail every curated request.
func TestEveryCuratedRequestFailsOnABrokenTarget(t *testing.T) {
	healthy := responses(measured)
	down := assert.NewTarget(503, 5, []byte(`{"error":{"code":"es_unavailable"},"request_id":"req-0"}`))
	html := assert.NewTarget(200, 5, []byte(`<html>bad gateway</html>`))
	empty := assert.NewTarget(200, 5, []byte(
		`{"total":0,"docs":0,"page":1,"status":"ok","results":[],"suggestions":[],"facets":{"types":[],"sets":[]}}`))

	for _, c := range All() {
		for _, r := range c.Requests {
			k := key(c, r)
			if _, ok := assert.EvaluateAll(r.Assertions, down); ok {
				t.Errorf("%s passes against a 503 error body", k)
			}
			if c.ID == "random-traffic" {
				continue // loose on purpose: the query changes on every dispatch
			}
			if _, ok := assert.EvaluateAll(r.Assertions, html); ok {
				t.Errorf("%s passes against a non-JSON 200", k)
			}
			if k != "suggest-health/no-matches" { // empty is its correct answer
				if _, ok := assert.EvaluateAll(r.Assertions, empty); ok {
					t.Errorf("%s passes against an empty result page", k)
				}
			}

			// The same healthy body with its counts serialised as strings.
			doc := map[string]any{}
			raw, _ := json.Marshal(healthy[k].doc)
			_ = json.Unmarshal(raw, &doc)
			stringified := false
			for _, f := range []string{"total", "docs"} {
				if v, ok := doc[f].(float64); ok && v != 1 {
					doc[f] = fmt.Sprint(v)
					stringified = true
				}
			}
			if !stringified {
				continue
			}
			body, _ := json.Marshal(doc)
			if _, ok := assert.EvaluateAll(r.Assertions, assert.NewTarget(healthy[k].status, 5, body)); ok {
				t.Errorf("%s passes when its count is a string", k)
			}
		}
	}
}

// A query the target ignores answers with a browse page; the text searches
// must notice, and the hp sort must notice an ignored order.
func TestIgnoredQueryOrSortOrderFailsTheRequest(t *testing.T) {
	browse := func(first map[string]any) assert.Target {
		body, _ := json.Marshal(map[string]any{
			"total":   20635,
			"results": cards(24, first),
		})
		return assert.NewTarget(200, 5, body)
	}
	cases := map[string]assert.Target{
		"search-basics/basic-text":    browse(map[string]any{"name": "Bulbasaur", "hp": 40}),
		"search-basics/fuzzy-typo":    browse(map[string]any{"name": "Bulbasaur", "hp": 40}),
		"search-filters/sort-hp-desc": browse(map[string]any{"name": "Caterpie", "hp": 30}),
	}
	for _, c := range All() {
		for _, r := range c.Requests {
			tg, ok := cases[key(c, r)]
			if !ok {
				continue
			}
			delete(cases, key(c, r))
			if _, passed := assert.EvaluateAll(r.Assertions, tg); passed {
				t.Errorf("%s passes on an unscoped browse page", key(c, r))
			}
		}
	}
	for k := range cases {
		t.Errorf("%s: no such curated request", k)
	}
}

// The suggester answers display names in title case; the containment check
// must accept the real first suggestion and still reject a wrong one.
func TestPrefixSuggestionMatchesTheRealFirstSuggestionOnly(t *testing.T) {
	var as []assert.Assertion
	for _, c := range All() {
		for _, req := range c.Requests {
			if key(c, req) == "suggest-health/prefix-suggestions" {
				as = req.Assertions
			}
		}
	}
	if as == nil {
		t.Fatal("suggest-health/prefix-suggestions is gone")
	}
	body := func(first any) assert.Target {
		s := names(8, "")
		s[0] = first
		b, _ := json.Marshal(map[string]any{"suggestions": s})
		return assert.NewTarget(200, 5, b)
	}
	if _, ok := assert.EvaluateAll(as, body("Alakazam")); !ok {
		t.Error(`the real first suggestion "Alakazam" fails`)
	}
	for _, wrong := range []any{"Kadabra", "", 42, map[string]any{"text": "Alakazam"}} {
		if _, ok := assert.EvaluateAll(as, body(wrong)); ok {
			t.Errorf("first suggestion %v passes", wrong)
		}
	}
}

// The SLO gate is only judged on the search-basics sequence, recognised by
// its request names. Rewriting the assertions must not rename one.
func TestSearchBasicsIsStillTheCalibratedSequence(t *testing.T) {
	for _, c := range All() {
		if c.ID != "search-basics" {
			continue
		}
		entries := make([]report.Entry, len(c.Requests))
		for i, r := range c.Requests {
			entries[i] = report.Entry{Index: i, Name: r.Name}
		}
		if !report.IsCalibrated(entries) {
			t.Errorf("search-basics is no longer recognised as the calibrated sequence: %+v", entries)
		}
		return
	}
	t.Fatal("no search-basics collection")
}
