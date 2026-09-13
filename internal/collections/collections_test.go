package collections

import (
	"strings"
	"testing"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// The curated set is the first thing every visitor runs. If one request is
// invalid the demo opens broken, so validation is a build-time guarantee rather
// than something discovered live.
//
// The bounds started as an earlier budget: 15-18 requests across 3-4
// collections. One collection per kind is enough signal, and every request cut
// is one fewer hand-verified fixture coupled to the index snapshot.
//
// The upper bounds are now 5 and 20, for the one collection that budget could
// not have covered: 05-random-traffic demonstrates the template variables, and
// its two requests carry no hand-verified fixture at all — their assertions are
// loose on purpose, because the query changes on every dispatch. That budget's
// reasoning (fixtures cost verification) does not price them, so it does not
// bound them.
func TestEveryCuratedRequestPassesTheSandbox(t *testing.T) {
	all := All()
	if len(all) < 3 || len(all) > 5 {
		t.Fatalf("len(All()) = %d, want 3-5 collections", len(all))
	}

	total := 0
	ids := map[string]bool{}
	for _, c := range all {
		if c.ID == "" || c.Name == "" || c.Description == "" || len(c.Requests) == 0 {
			t.Errorf("collection %q is incomplete", c.ID)
		}
		if ids[c.ID] {
			t.Errorf("duplicate collection id %q", c.ID)
		}
		ids[c.ID] = true

		for _, r := range c.Requests {
			total++
			key := c.ID + "/" + r.ID
			if r.ID == "" || r.Name == "" {
				t.Errorf("%s: a curated request needs an id and a name", key)
			}
			if ids[key] {
				t.Errorf("duplicate request id %q", key)
			}
			ids[key] = true

			if _, err := sandbox.ValidateRequest(r); err != nil {
				t.Errorf("%s: %v", key, err)
			}
			if n := len(r.Assertions); n < 2 || n > 4 {
				t.Errorf("%s has %d assertions; curated requests carry 2-4", key, n)
			}
		}
	}
	if total < 15 || total > 20 {
		t.Errorf("curated request count = %d, want 15-20", total)
	}
}

// Revision 2 trap: an assertion that can never fail is decoration. Real
// latencies are 1-30ms, so anything looser than 300ms is not a test.
func TestLatencyAssertionsAreMeaningful(t *testing.T) {
	for _, c := range All() {
		for _, r := range c.Requests {
			for _, a := range r.Assertions {
				if a.Type != assert.TypeLatency {
					continue
				}
				ms, ok := a.Value.(float64)
				if !ok {
					t.Errorf("%s/%s: latency value is not numeric", c.ID, r.ID)
					continue
				}
				if ms > 300 {
					t.Errorf("%s/%s: latency lt %v can never fail (measured range is 1-30ms)", c.ID, r.ID, ms)
				}
			}
		}
	}
}

// Revision 2 trap: facet cardinalities are query-scoped. Asserting
// facets.types/rarity/set_series/supertype on anything but an unfiltered browse
// bakes in a number that only holds for one query.
func TestUnscopedFacetCountsOnlyOnBrowse(t *testing.T) {
	scoped := map[string]bool{
		"$.facets.types":      true,
		"$.facets.rarity":     true,
		"$.facets.set_series": true,
		"$.facets.supertype":  true,
	}
	for _, c := range All() {
		for _, r := range c.Requests {
			isBrowse := r.Endpoint == "search" && len(r.Params) == 0
			for _, a := range r.Assertions {
				if a.Type != assert.TypeJSON || a.Op != "count" || !scoped[a.Path] || isBrowse {
					continue
				}
				// The one documented exception is the request whose entire
				// point is that the number changes: types narrows from 11 to 9
				// under q=pikachu while sets stays 173.
				if c.ID == "search-basics" && r.ID == "scoped-facets" {
					continue
				}
				t.Errorf("%s/%s asserts a count on %s outside a browse; use $.facets.sets (always 173) instead",
					c.ID, r.ID, a.Path)
			}
		}
	}
}

// PokéSearch's Milestone 3 contract, asserted both ways. The old spec item
// "Pokesearch never returns 4xx" is superseded: strict params are now rejected
// before Elasticsearch is called, while list members, unknown keys, and
// out-of-range integers stay lenient. A collection that asserted only one half
// would document the API wrongly.
func TestErrorCollectionAssertsBothHalvesOfTheContract(t *testing.T) {
	strict := map[string]bool{
		"sort": true, "order": true, "supertype": true,
		"hp_min": true, "hp_max": true, "page": true, "page_size": true,
	}

	var found *Collection
	for _, c := range All() {
		if c.ID == "error-handling" {
			found = &c
			break
		}
	}
	if found == nil {
		t.Fatal("no error-handling collection; the API's error contract is undocumented")
	}

	rejections, lenient := 0, 0
	for _, r := range found.Requests {
		want := 0
		for _, a := range r.Assertions {
			if a.Type == assert.TypeStatus && a.Op == "eq" {
				if v, ok := a.Value.(float64); ok {
					want = int(v)
				}
			}
		}
		switch want {
		case 400:
			rejections++
			var code, field string
			for _, a := range r.Assertions {
				switch a.Path {
				case "$.error.code":
					code, _ = a.Value.(string)
				case "$.error.field":
					field, _ = a.Value.(string)
				}
			}
			if code != "invalid_param" {
				t.Errorf("%s: a 400 must assert error.code invalid_param, got %q", r.ID, code)
			}
			if !strict[field] {
				t.Errorf("%s: error.field %q is not one of the strict params", r.ID, field)
			}
			if !hasParam(r, field) {
				t.Errorf("%s: asserts error.field %q but never sends that parameter", r.ID, field)
			}
		case 200:
			lenient++
		default:
			t.Errorf("%s: asserts status %d; the contract is 400 for strict params and 200 for everything else", r.ID, want)
		}
	}
	if rejections < 2 {
		t.Errorf("only %d requests assert the 400 contract; the strict half is under-documented", rejections)
	}
	if lenient < 1 {
		t.Error("nothing asserts preserved leniency; clamping and dropped values are half the contract")
	}
}

func hasParam(r sandbox.Request, key string) bool {
	_, ok := r.Params[key]
	return ok
}

// Only endpoints the catalog knows, only parameters it allows. sandbox.Validate
// enforces this at run time; asserting it here means a bad curated request is a
// failing test rather than a broken demo.
func TestCuratedEndpointsAreCatalogued(t *testing.T) {
	for _, c := range All() {
		for _, r := range c.Requests {
			ep, ok := sandbox.Lookup(r.Endpoint)
			if !ok {
				t.Errorf("%s/%s: unknown endpoint %q", c.ID, r.ID, r.Endpoint)
				continue
			}
			for key := range r.Params {
				if !ep.Allows(key) {
					t.Errorf("%s/%s: %q is not on the %s allowlist", c.ID, r.ID, key, ep.ID)
				}
			}
		}
	}
}

func TestAllIsImmutableAcrossCalls(t *testing.T) {
	first := All()
	first[0].Requests[0].Name = "mutated"
	if All()[0].Requests[0].Name == "mutated" {
		t.Fatal("All() handed out the shared slice; a visitor edit would corrupt the curated set for everyone")
	}

	// The params map is the one that a UI edit actually writes to.
	for i, c := range All() {
		for j, r := range c.Requests {
			if len(r.Params) == 0 {
				continue
			}
			for key := range r.Params {
				All()[i].Requests[j].Params[key] = "mutated"
			}
			for key, v := range All()[i].Requests[j].Params {
				if v == "mutated" {
					t.Fatalf("%s/%s: params map is shared across All() calls (key %q)", c.ID, r.ID, key)
				}
			}
			return
		}
	}
}

// The names are what a visitor reads first. Numbering them keeps the sidebar in
// the order the files are in, which is the order the story is meant to be told.
func TestCollectionNamesAreOrdered(t *testing.T) {
	for i, c := range All() {
		if !strings.HasPrefix(c.Name, "0"+string(rune('1'+i))+" - ") {
			t.Errorf("collection %d is named %q; the sidebar order comes from these prefixes", i, c.Name)
		}
	}
}
