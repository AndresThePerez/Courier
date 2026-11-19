package api

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// gridRow is one request's outcome as the functional walk records it.
type gridRow struct {
	name string
	row  report.RequestResult
}

// gridRows are the outcomes a request can have: answered or not, cut off,
// timed out, skipped, each with and without assertions that pass or fail.
func gridRows() []gridRow {
	ok := []assert.Outcome{{Passed: true}}
	bad := []assert.Outcome{{Passed: false}}
	none := []assert.Outcome{}
	return []gridRow{
		{"answered, unasserted", report.RequestResult{Status: 200, Passed: true, Assertions: none}},
		{"answered 500, unasserted", report.RequestResult{Status: 500, Passed: true, Assertions: none}},
		{"answered, assertion passed", report.RequestResult{Status: 200, Passed: true, Assertions: ok}},
		{"answered, assertion failed", report.RequestResult{Status: 200, Assertions: bad}},
		{"refused, unasserted", report.RequestResult{Error: "could not connect", ErrorKind: report.KindConnection, Assertions: none}},
		{"refused, asserted", report.RequestResult{Error: "could not connect", ErrorKind: report.KindConnection, Assertions: bad}},
		{"timed out, unasserted", report.RequestResult{Error: "timed out", ErrorKind: "timeout", Assertions: none}},
		{"cut off, unasserted", report.RequestResult{Status: 200, Error: "dropped", Assertions: none}},
		{"cut off, assertion passed", report.RequestResult{Status: 200, Error: "dropped", Assertions: ok}},
		{"skipped", report.RequestResult{Skipped: true, Assertions: none}},
	}
}

// gridOracle is the functional verdict rule as the record states it, written
// from the table, not from the code.
func gridOracle(status string, rows []gridRow) string {
	if status != report.StatusCompleted {
		return report.VerdictNA
	}
	anyFailed, anyAsserted := false, false
	for _, r := range rows {
		switch {
		case strings.HasPrefix(r.name, "skipped"):
		case strings.Contains(r.name, "failed"), strings.HasPrefix(r.name, "refused"),
			strings.HasPrefix(r.name, "timed out"), strings.HasPrefix(r.name, "cut off"):
			anyFailed = true
		case strings.Contains(r.name, "assertion passed"):
			anyAsserted = true
		}
	}
	switch {
	case anyFailed:
		return report.VerdictFail
	case anyAsserted:
		return report.VerdictPass
	}
	return report.VerdictNA
}

var summaryShape = regexp.MustCompile(`^(\d+) passed / (\d+) failed / (\d+) skipped(, nothing asserted)?$`)

// gridRuns calls f with every run of 0 to 4 requests over every outcome and
// every final status.
func gridRuns(maxN int, f func(status string, rows []gridRow)) {
	all := gridRows()
	var walk func(rows []gridRow)
	walk = func(rows []gridRow) {
		for _, status := range []string{report.StatusCompleted, report.StatusCancelled, report.StatusExpired} {
			f(status, rows)
		}
		if len(rows) == maxN {
			return
		}
		for _, r := range all {
			walk(append(append([]gridRow(nil), rows...), r))
		}
	}
	walk(nil)
}

// gridReport is the stored report of one grid run, counted as the walk
// counts it.
func gridReport(status string, rows []gridRow) *report.Report {
	f := &report.Functional{Total: len(rows), Results: []report.RequestResult{}}
	for i, r := range rows {
		res := r.row
		res.Index = i
		f.Results = append(f.Results, res)
		switch {
		case res.Skipped:
			f.Skipped++
		case res.Passed:
			f.Passed++
		default:
			f.Failed++
		}
	}
	f.Verdict = report.FunctionalVerdict(status, f)
	return &report.Report{Mode: sandbox.ModeFunctional, Status: status, Functional: f}
}

func gridLabel(status string, rows []gridRow) string {
	names := make([]string, len(rows))
	for i, r := range rows {
		names[i] = r.name
	}
	return status + " [" + strings.Join(names, "; ") + "]"
}

// Every functional run over the whole grid gets the rule's verdict, and its
// history row states that verdict with a well-formed summary whose counts add
// up and which says nothing was asserted exactly when a completed run that
// answered requests is N/A.
func TestEveryFunctionalRunOfTheGridGetsTheRulesVerdictAndAWellFormedSummary(t *testing.T) {
	runs := 0
	gridRuns(4, func(status string, rows []gridRow) {
		runs++
		label := gridLabel(status, rows)
		rep := gridReport(status, rows)
		want := gridOracle(status, rows)
		if got := verdictOf(rep); got != want {
			t.Errorf("%s: verdict %q, want %q", label, got, want)
		}
		sum := summarize(rep)
		m := summaryShape.FindStringSubmatch(sum)
		if m == nil {
			t.Errorf("%s: summary %q is not well formed", label, sum)
			return
		}
		p, _ := strconv.Atoi(m[1])
		fl, _ := strconv.Atoi(m[2])
		sk, _ := strconv.Atoi(m[3])
		if p+fl+sk != len(rows) || p != rep.Functional.Passed || fl != rep.Functional.Failed || sk != rep.Functional.Skipped {
			t.Errorf("%s: summary %q does not count the %d requests", label, sum, len(rows))
		}
		saysNothing := m[4] != ""
		if wantSays := status == report.StatusCompleted && want == report.VerdictNA && p > 0; saysNothing != wantSays {
			t.Errorf("%s: summary %q says nothing was asserted %v, want %v", label, sum, saysNothing, wantSays)
		}
		if saysNothing && want != report.VerdictNA {
			t.Errorf("%s: summary %q says nothing was asserted on a %s run", label, sum, want)
		}
	})
	if runs < 10000 {
		t.Fatalf("the grid held %d runs", runs)
	}
}

// A performance run's verdict and summary do not follow the functional rule,
// whatever its status.
func TestAPerformanceRunsVerdictIsItsOwn(t *testing.T) {
	for _, v := range []string{report.VerdictPass, report.VerdictFail, report.VerdictNA} {
		for _, status := range []string{report.StatusCompleted, report.StatusCancelled, report.StatusExpired} {
			rep := &report.Report{Mode: sandbox.ModePerformance, Status: status, Performance: &report.Performance{Verdict: v}}
			if got := verdictOf(rep); got != v {
				t.Errorf("performance %s %s: verdict %q", status, v, got)
			}
			if sum := summarize(rep); !strings.HasSuffix(sum, ", "+v) || strings.Contains(sum, "asserted") {
				t.Errorf("performance %s %s: summary %q", status, v, sum)
			}
		}
	}
}

// Through the real handlers, against a target that answers, refuses to
// answer or cuts its answer off, every run of one and two requests with and
// without assertions is stored and listed with the rule's verdict.
func TestRealRunsOverTheGridAreStoredAndListedWithTheRulesVerdict(t *testing.T) {
	target := serveTarget(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("q") {
		case "drop":
			if hj, ok := w.(http.Hijacker); ok {
				if c, _, err := hj.Hijack(); err == nil {
					_ = c.Close()
				}
			}
		case "cut":
			dropAfterHeaders(w, r)
		default:
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"total":107}`)
		}
	})
	c := &clock{}
	s := newServer(t, target, c)
	type kind struct {
		name, q string
		as      []assert.Assertion
	}
	pass := []assert.Assertion{{Type: assert.TypeStatus, Op: "eq", Value: 200}}
	fail := []assert.Assertion{{Type: assert.TypeStatus, Op: "eq", Value: 404}}
	kinds := []kind{
		{"answered, unasserted", "ok", nil},
		{"answered, assertion passed", "ok", pass},
		{"answered, assertion failed", "ok", fail},
		{"refused, unasserted", "drop", nil},
		{"cut off, unasserted", "cut", nil},
	}
	byName := map[string]gridRow{}
	for _, r := range gridRows() {
		byName[r.name] = r
	}
	var seqs [][]kind
	for _, a := range kinds {
		seqs = append(seqs, []kind{a})
		for _, b := range kinds {
			seqs = append(seqs, []kind{a, b})
		}
	}
	for _, seq := range seqs {
		rr := sandbox.RunRequest{Mode: sandbox.ModeFunctional}
		var rows []gridRow
		for i, k := range seq {
			rr.Sequence = append(rr.Sequence, sandbox.Request{
				ID: fmt.Sprint(i), Name: k.name, Endpoint: "search",
				Params: map[string]string{"q": k.q}, Assertions: k.as,
			})
			rows = append(rows, byName[k.name])
		}
		label := gridLabel(report.StatusCompleted, rows)
		id := startRun(t, s, rr)
		waitIdle(t, s)
		want := gridOracle(report.StatusCompleted, rows)
		got := decode[struct {
			Status     string `json:"status"`
			Functional struct {
				Verdict string `json:"verdict"`
			} `json:"functional"`
		}](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
		if got.Status != report.StatusCompleted || got.Functional.Verdict != want {
			t.Errorf("%s: stored %s with verdict %q, want completed with %q", label, got.Status, got.Functional.Verdict, want)
		}
		rows0 := historyRows(t, s)
		if len(rows0) == 0 || rows0[0].ID != id || rows0[0].Verdict != want {
			t.Errorf("%s: history row %+v, want verdict %q", label, rows0, want)
		} else if says := strings.HasSuffix(rows0[0].Summary, ", nothing asserted"); says != (want == report.VerdictNA) {
			t.Errorf("%s: history summary %q", label, rows0[0].Summary)
		}
		c.advance(time.Hour)
	}
}
