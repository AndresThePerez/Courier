// Package collections is Courier's curated content: the request sequences a
// first-time visitor runs before they have written anything of their own.
//
// It is data, not code. The JSON files under data/ are embedded in the binary,
// parsed once, and handed out as deep copies — a visitor editing a curated
// request must not be able to change what the next visitor sees.
//
// Every asserted value is measured against the pinned index (20,324 cards),
// never estimated, and two traps govern what may be asserted at all:
//
//   - Facet cardinalities are query-scoped. types 11 / rarity 38 / set_series
//     17 / supertype 3 hold only on an unfiltered browse. On a scoped query the
//     safe facet assertion is facets.sets, which is always 173 because it is a
//     cached global catalog.
//   - A latency bound must be able to fail. Real responses land in 1-30ms, so
//     "latency lt 300" is decoration, not a test. Search asserts 150ms and
//     suggest/healthz 100ms — roughly 4x headroom over the measured numbers,
//     leaving room for the slower deploy host.
package collections

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"maps"
	"slices"
	"sync"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

//go:embed data/*.json
var files embed.FS

// Collection is one curated group of requests, in the order the UI lists them.
type Collection struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Requests    []sandbox.Request `json:"requests"`
}

// load parses the embedded files exactly once. A parse failure is a build
// error dressed up as a panic: the files ship inside the binary, so if they do
// not parse, no amount of retrying at runtime will help.
var load = sync.OnceValue(func() []Collection {
	names, err := fs.Glob(files, "data/*.json")
	if err != nil {
		panic(fmt.Sprintf("collections: glob: %v", err))
	}
	// Filename order is the UI's order, and the files are numbered for it.
	slices.Sort(names)

	out := make([]Collection, 0, len(names))
	for _, name := range names {
		raw, err := files.ReadFile(name)
		if err != nil {
			panic(fmt.Sprintf("collections: read %s: %v", name, err))
		}
		var c Collection
		if err := json.Unmarshal(raw, &c); err != nil {
			panic(fmt.Sprintf("collections: parse %s: %v", name, err))
		}
		out = append(out, c)
	}
	return out
})

// All returns the curated collections. The result is a deep copy: the UI lets a
// visitor edit a curated request before running it, and handing out the shared
// slice would let one visitor's edit rewrite the demo for everyone.
func All() []Collection {
	src := load()
	out := make([]Collection, len(src))
	for i, c := range src {
		out[i] = c.clone()
	}
	return out
}

func (c Collection) clone() Collection {
	c.Requests = slices.Clone(c.Requests)
	for i, r := range c.Requests {
		if r.Params != nil {
			c.Requests[i].Params = maps.Clone(r.Params)
		}
		c.Requests[i].Assertions = slices.Clone(r.Assertions)
	}
	return c
}
