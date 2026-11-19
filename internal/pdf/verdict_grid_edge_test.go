package pdf

import (
	"strings"
	"testing"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
)

// The printed band of every functional run of up to two requests over every
// outcome and final status is the band the verdict rule gives it, and a run
// that asserted nothing never prints PASS.
func TestThePrintedBandFollowsTheVerdictRuleOverTheGrid(t *testing.T) {
	ok := []assert.Outcome{{Assertion: assert.Assertion{Type: assert.TypeStatus, Op: "eq", Value: float64(200)}, Passed: true, Expected: "200", Actual: "200"}}
	bad := []assert.Outcome{{Assertion: assert.Assertion{Type: assert.TypeStatus, Op: "eq", Value: float64(200)}, Expected: "200", Actual: "500"}}
	type row struct {
		failed, asserted bool
		r                report.RequestResult
	}
	rows := []row{
		{false, false, report.RequestResult{Name: "answered", Status: 200, Passed: true, Assertions: []assert.Outcome{}}},
		{false, true, report.RequestResult{Name: "asserted", Status: 200, Passed: true, Assertions: ok}},
		{true, true, report.RequestResult{Name: "failed", Status: 500, Assertions: bad, ErrorKind: report.KindNon2xx}},
		{true, false, report.RequestResult{Name: "refused", Error: "could not connect to the target", ErrorKind: report.KindConnection, Assertions: []assert.Outcome{}}},
		{false, false, report.RequestResult{Name: "skipped", Skipped: true, Assertions: []assert.Outcome{}}},
	}
	var seqs [][]row
	for _, a := range rows {
		seqs = append(seqs, []row{a})
		for _, b := range rows {
			seqs = append(seqs, []row{a, b})
		}
	}
	for _, seq := range seqs {
		for _, status := range []string{report.StatusCompleted, report.StatusCancelled, report.StatusExpired} {
			rep := fixtureFunctionalReport()
			rep.Status = status
			f := &report.Functional{Total: len(seq), Results: []report.RequestResult{}}
			failed, asserted := false, false
			var names []string
			for i, r := range seq {
				res := r.r
				res.Index = i
				f.Results = append(f.Results, res)
				names = append(names, res.Name)
				switch {
				case res.Skipped:
					f.Skipped++
				case res.Passed:
					f.Passed++
				default:
					f.Failed++
				}
				failed = failed || r.failed
				asserted = asserted || r.asserted
			}
			f.Verdict = report.FunctionalVerdict(status, f)
			rep.Functional = f
			want := "VERDICT: N/A - nothing was asserted"
			switch {
			case status != report.StatusCompleted:
				want = "VERDICT: N/A - partial data"
			case failed:
				want = "VERDICT: FAIL"
			case asserted:
				want = "VERDICT: PASS"
			}
			label := status + " " + strings.Join(names, ", ")
			body := text(t, rep)
			if !strings.Contains(body, want) {
				t.Errorf("%s: the page does not read %q", label, want)
			}
			if !asserted && strings.Contains(body, "VERDICT: PASS") {
				t.Errorf("%s: a run that asserted nothing reads VERDICT: PASS", label)
			}
		}
	}
}
