package api

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// The documents state the bound on bodies being read and its deadline; this
// fails when the code and the README's Caps table, docs/deviations.md or
// docs/design.md stop agreeing, and when a document calls ReadHeaderTimeout
// the only time limit.
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

// noLimit is what the documents and the comments beside the bounds say about
// one client and about connections. The repository holds no configuration of
// anything in front of the server, so none of them may credit it with a limit.
const noLimit = "nothing in this server limits one client or the number of open connections"

// Every statement of what the body bounds leave out says noLimit, in N43 and
// N47 alike, and none credits a limit to what sits in front of the server.
func TestTheBodyBoundsClaimNoLimitTheRepositoryCannotShow(t *testing.T) {
	for path, times := range map[string]int{
		"../../docs/deviations.md": 2,
		"../../docs/design.md":     1,
		"body_reads.go":            1,
		"body_gate.go":             1,
	} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := strings.Join(strings.Fields(strings.NewReplacer("//", " ").Replace(string(raw))), " ")
		if n := strings.Count(strings.ToLower(text), noLimit); n < times {
			t.Errorf("%s says %q %d times, want at least %d", path, noLimit, n, times)
		}
		for _, claim := range []string{"limits one client is the tunnel", "such as the tunnel's", "tunnel in front of the server"} {
			if strings.Contains(text, claim) {
				t.Errorf("%s credits the tunnel with a limit: %q", path, claim)
			}
		}
	}
}
