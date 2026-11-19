package api

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// The documents state the bound on bodies being read and its deadline; this
// fails when the code and the README's Caps table, docs/deviations.md or
// docs/design.md stop agreeing, and when a document stops saying what the
// bound leaves to the tunnel or calls ReadHeaderTimeout the only time limit.
func TestTheBodyReadBoundsMatchTheDocuments(t *testing.T) {
	bound := fmt.Sprintf("%d at once, each within %s of its read starting", MaxBodyReads, BodyReadDeadline)
	answer := fmt.Sprintf(`{"error":"the body did not arrive within %s","field":"body"}`, BodyReadDeadline)
	const unfair = "places are not shared between clients"
	for path, says := range map[string][]string{
		"../../README.md":          {bound},
		"../../docs/deviations.md": {bound, answer, unfair, fmt.Sprintf("`MaxBodyReads`, %d", MaxBodyReads)},
		"../../docs/design.md":     {bound, unfair},
	} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(raw)
		for _, want := range says {
			if !strings.Contains(text, want) {
				t.Errorf("%s does not say %q", path, want)
			}
		}
		if strings.Contains(text, "`ReadHeaderTimeout` as the only server timeout") {
			t.Errorf("%s calls ReadHeaderTimeout the only server timeout; the body read has a deadline of its own", path)
		}
	}
}
