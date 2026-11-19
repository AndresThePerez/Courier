package web

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"

	"github.com/AndresThePerez/courier/internal/report"
)

// TestVerdictTableIsTheServers runs every case of the table in
// web/test/verdict-grid.test.mjs through report.FunctionalVerdict: the
// verdict each case states must be the one the server gives its rows. The
// node suite holds the page to the same cases, so neither rule can change
// without the other's test failing.
func TestVerdictTableIsTheServers(t *testing.T) {
	src, err := os.ReadFile("test/verdict-grid.test.mjs")
	if err != nil {
		t.Fatalf("read the table: %v", err)
	}
	block := regexp.MustCompile(`(?s)// table:begin\nconst TABLE = (\{.*?\n\});\n// table:end`).FindAllSubmatch(src, -1)
	if len(block) != 1 {
		t.Fatalf("verdict-grid.test.mjs: expected exactly one table between the markers, found %d", len(block))
	}
	var table struct {
		Rows  map[string]report.RequestResult `json:"rows"`
		Cases [][3]json.RawMessage            `json:"cases"`
	}
	if err := json.Unmarshal(block[0][1], &table); err != nil {
		t.Fatalf("the table is not JSON the server reads: %v", err)
	}
	if len(table.Rows) != 9 || len(table.Cases) < 100 {
		t.Fatalf("the table holds %d rows and %d cases; it lost some", len(table.Rows), len(table.Cases))
	}
	seen := map[string]int{}
	for i, c := range table.Cases {
		var status, want string
		var kinds []string
		if json.Unmarshal(c[0], &status) != nil || json.Unmarshal(c[1], &kinds) != nil || json.Unmarshal(c[2], &want) != nil {
			t.Fatalf("case %d is not [status, [rows], verdict]: %s", i, c)
		}
		results := []report.RequestResult{}
		for j, k := range kinds {
			r, ok := table.Rows[k]
			if !ok {
				t.Fatalf("case %d names a row the table does not hold: %q", i, k)
			}
			r.Index = j
			results = append(results, r)
		}
		got := report.FunctionalVerdict(status, &report.Functional{Results: results})
		if got != want {
			t.Errorf("case %d, %s %v: the server gives %s, the table says %s", i, status, kinds, got, want)
		}
		seen[want]++
	}
	for _, v := range []string{report.VerdictPass, report.VerdictFail, report.VerdictNA} {
		if seen[v] == 0 {
			t.Errorf("no case gives %s: the table should hold every verdict", v)
		}
	}
}
