package collections

import (
	"maps"
	"testing"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// Every curated request, and so every knee preset (they queue the
// search-basics collection), goes out exactly as written: the parameter
// limits cut nothing in the curated data, and a run of a whole collection
// reports nothing truncated.
func TestTheParameterLimitsCutNothingCurated(t *testing.T) {
	all := All()
	if len(all) == 0 {
		t.Fatal("no curated collections")
	}
	knee := false
	for _, c := range all {
		knee = knee || c.ID == "search-basics"
		for i, r := range c.Requests {
			if cut := sandbox.RequestTruncations(r); cut != nil {
				t.Errorf("%s request %d (%s): %v would be cut", c.ID, i, r.Name, cut)
			}
			out, err := sandbox.ValidateRequest(r)
			if err != nil {
				t.Errorf("%s request %d (%s): refused: %v", c.ID, i, r.Name, err)
				continue
			}
			if !maps.Equal(out.Params, r.Params) {
				t.Errorf("%s request %d (%s): params %v went out as %v", c.ID, i, r.Name, r.Params, out.Params)
			}
		}
		rr := sandbox.RunRequest{Mode: sandbox.ModePerformance, Sequence: c.Requests}
		if cut := sandbox.Truncations(rr); cut != nil {
			t.Errorf("a run of %s reports %v truncated", c.ID, cut)
		}
	}
	if !knee {
		t.Error("the search-basics collection the knee presets queue is not curated")
	}
}
