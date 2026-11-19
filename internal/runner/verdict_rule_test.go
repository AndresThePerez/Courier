package runner

import (
	"context"
	"testing"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// A functional run whose requests were all answered and carried no assertion
// is stored, listed and announced as N/A; one assertion makes the same run a
// PASS.
func TestAFunctionalRunThatAssertedNothingIsNotAPass(t *testing.T) {
	srv := okServer(t)
	for _, tc := range []struct {
		name       string
		assertions []assert.Assertion
		want       string
	}{
		{"nothing asserted", nil, report.VerdictNA},
		{"one assertion", []assert.Assertion{{Type: assert.TypeStatus, Op: "eq", Value: 200}}, report.VerdictPass},
	} {
		m, _, pub := newTestManager(t, srv.URL)
		rr := sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: []sandbox.Request{
			{ID: "1", Name: "a", Endpoint: "search", Params: map[string]string{"q": "charizard"}},
			{ID: "2", Name: "b", Endpoint: "search", Params: map[string]string{"q": "eevee"}, Assertions: tc.assertions},
		}}
		id, err := m.Start(context.Background(), rr)
		if err != nil {
			t.Fatalf("%s: Start: %v", tc.name, err)
		}
		m.Wait()

		rep, ok := m.Report(id)
		if !ok || rep.Status != report.StatusCompleted {
			t.Fatalf("%s: report %v, %+v; want a completed run", tc.name, ok, rep)
		}
		if got := rep.Functional.Verdict; got != tc.want {
			t.Errorf("%s: functional.verdict = %q, want %q", tc.name, got, tc.want)
		}
		if h := m.History(); len(h) != 1 || h[0].Functional.Verdict != tc.want {
			t.Errorf("%s: the history holds %d runs, want one with verdict %q", tc.name, len(h), tc.want)
		}
		var finished []RunFinished
		for _, e := range pub.Replay() {
			if e.Type == EventRunFinished {
				finished = append(finished, e.Data.(RunFinished))
			}
		}
		if len(finished) != 1 || finished[0].Verdict != tc.want {
			t.Errorf("%s: run_finished = %+v, want one with verdict %q", tc.name, finished, tc.want)
		}
	}
}
