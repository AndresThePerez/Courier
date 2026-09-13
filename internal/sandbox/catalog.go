// Package sandbox is Courier's security core: the closed set of endpoints a
// run may target and the validator every request passes through. The client
// sends an endpoint ID, never a URL; this package owns the mapping.
package sandbox

import "slices"

// Endpoint is one target the catalog will resolve. Path is server-owned and is
// the only thing that ever reaches the wire — a client sends ID.
type Endpoint struct {
	ID     string   `json:"id"`
	Label  string   `json:"label"`
	Method string   `json:"method"` // always GET in v1
	Path   string   `json:"path"`   // server-owned; never from the client
	Params []string `json:"params"` // ordered allowlist, for the UI dropdown
}

// endpoints is the catalog: the single source of truth for what Courier can
// reach and which query parameters each target accepts. Adding a parameter to
// the contract means editing exactly this literal — no count, no duplicate list
// in a test, nowhere else to keep in sync.
//
// Verified against the Pokesearch source and updated for the Milestone 3
// contract (2026-08-22): `page_size` (1-100, default 24) joins the search
// allowlist. Match highlighting may later become opt-in via `highlight`, in
// which case it is one more entry in the search Params slice and nothing else.
//
// Milestone 3 also adds /livez, /api/meta, /api/stats, and /api/explain. They
// are deliberately absent: their parameter allowlists have not been documented,
// and inventing one would defeat the point of an allowlist. Append them here
// (never insert) once their contracts are known — the order is the UI's order.
var endpoints = []Endpoint{
	{ID: "search", Label: "Search", Method: "GET", Path: "/api/search",
		Params: []string{"q", "id", "rarity", "series", "set", "types", "supertype", "hp_min", "hp_max", "sort", "order", "page", "page_size", "debug"}},
	{ID: "suggest", Label: "Autocomplete", Method: "GET", Path: "/api/suggest",
		Params: []string{"q"}},
	{ID: "healthz", Label: "Health", Method: "GET", Path: "/healthz", Params: nil},
}

// clone returns a copy no caller can use to widen the catalog.
func (e Endpoint) clone() Endpoint {
	e.Params = slices.Clone(e.Params)
	return e
}

// Endpoints returns the catalog in UI order. The result is a deep copy: the
// catalog is a security boundary, so handing out an aliased slice would let any
// caller edit the allowlist it is supposed to be constrained by.
func Endpoints() []Endpoint {
	out := make([]Endpoint, len(endpoints))
	for i, e := range endpoints {
		out[i] = e.clone()
	}
	return out
}

// Lookup resolves an endpoint ID against the closed set. Matching is exact:
// no case folding, no trimming, no path traversal, no fallback.
//
// The result is a copy, so resolve an endpoint once when a run is built rather
// than once per dispatch.
func Lookup(id string) (Endpoint, bool) {
	for _, e := range endpoints {
		if e.ID == id {
			return e.clone(), true
		}
	}
	return Endpoint{}, false
}

// Allows reports whether param is on this endpoint's allowlist. An endpoint
// with no params allows nothing.
func (e Endpoint) Allows(param string) bool { return slices.Contains(e.Params, param) }
