package sandbox

import (
	"slices"
	"testing"
)

// The Pokesearch Milestone 3 search contract. `requiredSearchParams` are keys
// the catalog must expose today; `knownSearchParams` is every key the contract
// may ever legitimately contain, including `highlight`, which Pokesearch may
// yet flip to an opt-in param.
//
// These two sets are deliberately not a count and not an exact list: the
// allowlist itself lives in catalog.go and is the single source of truth, so
// adding a key there must not require editing a test. The subset check still
// catches a key that is not part of the contract at all.
var (
	requiredSearchParams = []string{
		"q", "id", "rarity", "series", "set", "types", "supertype",
		"hp_min", "hp_max", "sort", "order", "page", "page_size", "debug",
	}
	knownSearchParams = append(slices.Clone(requiredSearchParams), "highlight")
)

func TestSearchAllowlistMatchesPokesearchContract(t *testing.T) {
	ep, ok := Lookup("search")
	if !ok {
		t.Fatal("search endpoint missing")
	}
	if ep.Path != "/api/search" || ep.Method != "GET" {
		t.Errorf("search = %s %s, want GET /api/search", ep.Method, ep.Path)
	}
	for _, p := range requiredSearchParams {
		if !ep.Allows(p) {
			t.Errorf("search must allow %q", p)
		}
	}
	for _, p := range ep.Params {
		if !slices.Contains(knownSearchParams, p) {
			t.Errorf("search allows %q, which is not part of the Pokesearch contract", p)
		}
	}
	if len(ep.Params) != len(slices.Compact(slices.Sorted(slices.Values(ep.Params)))) {
		t.Errorf("search allowlist has duplicate keys: %v", ep.Params)
	}
}

// page_size arrived with Milestone 3 (1-100, default 24, strict-validated).
// The plan predates it and says the param does not exist; it does now.
func TestSearchAllowsPageSize(t *testing.T) {
	ep, _ := Lookup("search")
	if !ep.Allows("page_size") {
		t.Error("page_size is a Milestone 3 search param and must be allowed")
	}
}

// Nothing that would let a payload point Courier somewhere else, and nothing
// invented. The allowlist is a boundary, not a convenience.
func TestSearchRejectsParamsOutsideTheContract(t *testing.T) {
	ep, _ := Lookup("search")
	for _, p := range []string{"url", "target", "host", "limit", "offset", "size", "Q", "q ", ""} {
		if ep.Allows(p) {
			t.Errorf("search must not allow %q", p)
		}
	}
}

func TestSuggestAndHealthz(t *testing.T) {
	sug, ok := Lookup("suggest")
	if !ok {
		t.Fatal("suggest endpoint missing")
	}
	if !slices.Equal(sug.Params, []string{"q"}) {
		t.Errorf("suggest params = %v, want [q] (handleSuggest reads only p.Q)", sug.Params)
	}
	hz, ok := Lookup("healthz")
	if !ok {
		t.Fatal("healthz endpoint missing")
	}
	if len(hz.Params) != 0 || hz.Path != "/healthz" {
		t.Errorf("healthz = %s with %v, want /healthz with no params", hz.Path, hz.Params)
	}
}

func TestLookupUnknown(t *testing.T) {
	for _, id := range []string{"", "SEARCH", "admin", "../healthz", "http://evil.example"} {
		if _, ok := Lookup(id); ok {
			t.Errorf("Lookup(%q) resolved; the catalog must be a closed set", id)
		}
	}
}

// The first three are the v1 catalog and the UI's order depends on them.
// Milestone 3's additive endpoints, when they land, append after these.
func TestEndpointsOrderIsStable(t *testing.T) {
	got := Endpoints()
	want := []string{"search", "suggest", "healthz"}
	if len(got) < len(want) {
		t.Fatalf("Endpoints() = %v, want at least %v", got, want)
	}
	for i, id := range want {
		if got[i].ID != id {
			t.Errorf("Endpoints()[%d].ID = %q, want %q", i, got[i].ID, id)
		}
	}
	seen := map[string]bool{}
	for _, e := range got {
		if seen[e.ID] {
			t.Errorf("duplicate endpoint id %q", e.ID)
		}
		seen[e.ID] = true
		if e.Method != "GET" {
			t.Errorf("%s: method %q, want GET (v1 is read-only)", e.ID, e.Method)
		}
		if e.Path == "" || e.Path[0] != '/' {
			t.Errorf("%s: path %q must be a server-owned absolute path", e.ID, e.Path)
		}
		if e.Label == "" {
			t.Errorf("%s: needs a label for the UI", e.ID)
		}
	}
}

// The catalog is the security boundary; a caller must not be able to widen it.
func TestEndpointsIsADefensiveCopy(t *testing.T) {
	got := Endpoints()
	got[0].ID = "hacked"
	got[0].Path = "http://evil.example"
	got[0].Params[0] = "url"

	fresh, ok := Lookup("search")
	if !ok || fresh.Path != "/api/search" {
		t.Fatalf("catalog was mutated through Endpoints(): %+v", fresh)
	}
	if fresh.Allows("url") {
		t.Error("catalog params were mutated through Endpoints()")
	}
	if again := Endpoints(); again[0].ID != "search" {
		t.Errorf("Endpoints()[0].ID = %q after mutation, want search", again[0].ID)
	}
}

func TestLookupIsADefensiveCopy(t *testing.T) {
	ep, _ := Lookup("search")
	ep.Params[0] = "url"
	if fresh, _ := Lookup("search"); fresh.Allows("url") {
		t.Error("catalog params were mutated through Lookup()")
	}
}
