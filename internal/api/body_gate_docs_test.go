package api

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// The documents state the gate's constants; this fails when the code and the
// README's Caps row, docs/deviations.md N43 or docs/design.md stop agreeing.
func TestTheBodyGateConstantsMatchTheDocuments(t *testing.T) {
	want := fmt.Sprintf("%d × 256 KiB of bodies at once, with up to %d × 256 KiB more waiting", MaxBodyChecks, MaxBodyWaiters)
	if MaxBodyBytes != 256<<10 {
		t.Fatalf("MaxBodyBytes is %d; the documents say 256 KiB", MaxBodyBytes)
	}
	for _, path := range []string{"../../README.md", "../../docs/deviations.md"} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), want) {
			t.Errorf("%s does not say %q", path, want)
		}
	}
	small := fmt.Sprintf("up to %d small ones", MaxBodyChecks*MaxBodyBytes/minBodyWeight)
	for path, says := range map[string][]string{
		"../../docs/deviations.md": {fmt.Sprintf("never less than %d KiB", minBodyWeight>>10), small},
		"../../docs/design.md":     {small},
	} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range says {
			if !strings.Contains(string(raw), want) {
				t.Errorf("%s does not say %q", path, want)
			}
		}
	}
}
