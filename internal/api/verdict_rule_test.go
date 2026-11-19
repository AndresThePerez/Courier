package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/runner"
)

// A functional run that asserted nothing is N/A wherever the server states a
// verdict: the finished report, the history row and its summary, the stream's
// final event while the run's events are held and after they are gone. One
// assertion turns the same run into a PASS with the summary as before.
func TestAFunctionalRunThatAssertedNothingIsNAEverywhere(t *testing.T) {
	c := &clock{}
	s := newServer(t, newTarget(t, 0), c)
	srv := httptest.NewServer(s)
	defer srv.Close()

	unasserted := payload(3, 0)
	for i := range unasserted.Sequence {
		unasserted.Sequence[i].Assertions = nil
	}
	asserted := payload(3, 0)
	asserted.Sequence[0].Assertions, asserted.Sequence[2].Assertions = nil, nil

	for _, tc := range []struct {
		name, verdict, summary string
	}{
		{"nothing asserted", report.VerdictNA, "3 passed / 0 failed / 0 skipped, nothing asserted"},
		{"one request asserted", report.VerdictPass, "3 passed / 0 failed / 0 skipped"},
	} {
		rr := unasserted
		if tc.verdict == report.VerdictPass {
			rr = asserted
		}
		id := startRun(t, s, rr)
		frames, _ := openStream(t, srv.URL, id, func(f frame) bool { return f.name == runner.EventRunFinished })
		waitIdle(t, s)
		if data, _ := frames[len(frames)-1].data["data"].(map[string]any); data["verdict"] != tc.verdict {
			t.Errorf("%s: live run_finished data = %v, want verdict %s", tc.name, frames[len(frames)-1].data["data"], tc.verdict)
		}

		got := decode[struct {
			Functional struct {
				Verdict string `json:"verdict"`
			} `json:"functional"`
		}](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
		if got.Functional.Verdict != tc.verdict {
			t.Errorf("%s: functional.verdict = %q, want %q", tc.name, got.Functional.Verdict, tc.verdict)
		}
		rows := historyRows(t, s)
		if len(rows) == 0 || rows[0].ID != id || rows[0].Verdict != tc.verdict || rows[0].Summary != tc.summary {
			t.Errorf("%s: history row = %+v, want verdict %q and summary %q", tc.name, rows[0], tc.verdict, tc.summary)
		}
		c.advance(time.Hour)
	}

	// The first run's events are gone from the broadcaster: its stream is the
	// terminal event rebuilt from the stored report.
	first := historyRows(t, s)[1].ID
	frames, _ := openStream(t, srv.URL, first, func(f frame) bool { return f.name == runner.EventRunFinished })
	if len(frames) != 1 || !strings.Contains(frames[0].name, runner.EventRunFinished) {
		t.Fatalf("a finished run's stream = %+v, want only run_finished", frames)
	}
	if data, _ := frames[0].data["data"].(map[string]any); data["verdict"] != report.VerdictNA {
		t.Errorf("rebuilt run_finished data = %v, want verdict N/A", frames[0].data["data"])
	}
}
