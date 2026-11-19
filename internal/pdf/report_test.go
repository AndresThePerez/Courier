package pdf

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// fixtureStart is the one timestamp every fixture starts at, so a rendered
// document is a pure function of the fixture and the determinism test means
// something.
var fixtureStart = time.Date(2026, 8, 22, 14, 30, 0, 0, time.UTC)

func fixtureFunctionalReport() *report.Report {
	pass := func(i int, name string, status int, ms float64) report.RequestResult {
		return report.RequestResult{
			Index: i, Name: name, Endpoint: "search", Query: "q=charizard",
			Status: status, LatencyMs: ms, SizeBytes: 36 << 10, Passed: true,
			Assertions: []assert.Outcome{{
				Assertion: assert.Assertion{Type: assert.TypeStatus, Op: "eq", Value: float64(200)},
				Passed:    true, Expected: "200", Actual: "200",
			}},
		}
	}
	return &report.Report{
		ID:         "run-20260822143000-a1b2",
		Mode:       "functional",
		Status:     report.StatusCompleted,
		StartedAt:  fixtureStart,
		FinishedAt: fixtureStart.Add(1200 * time.Millisecond),
		DurationMs: 1200,
		Target:     "pokesearch.andrestheperez.com",
		Config:     report.Config{DelayMs: 100},
		Entries: []report.Entry{
			{Index: 0, Name: "search charizard", Endpoint: "search", Path: "/api/search", Query: "q=charizard"},
			{Index: 1, Name: "suggest", Endpoint: "suggest", Path: "/api/suggest", Query: "q=char"},
		},
		Functional: &report.Functional{
			Total: 4, Passed: 2, Failed: 1, Skipped: 1,
			Results: []report.RequestResult{
				pass(0, "search charizard", 200, 12.4),
				pass(1, "suggest char", 200, 4.1),
				{
					Index: 2, Name: "type filter", Endpoint: "search", Query: "type=fire",
					Status: 500, LatencyMs: 31.7, SizeBytes: 512, Passed: false,
					ErrorKind: report.KindNon2xx,
					Assertions: []assert.Outcome{{
						Assertion: assert.Assertion{Type: assert.TypeStatus, Op: "eq", Value: float64(200)},
						Passed:    false, Expected: "200", Actual: "500",
					}},
				},
				{Index: 3, Name: "pokemon by id", Endpoint: "pokemon", Skipped: true},
			},
		},
		Note: "",
	}
}

func fixturePerformanceReport() *report.Report {
	var overall report.Tally
	for i := range 900 {
		overall.AddResponse(200, 4+float64(i%30), 36<<10)
	}
	for range 8 {
		overall.AddResponse(503, 2.5, 120)
	}
	for range 3 {
		overall.AddTransportFailure(report.KindTimeout)
	}
	overall.AddAborted()

	stats := report.ComputeStats(-1, "overall", overall, 30*time.Second)
	verdict, reasons := report.Verdict(stats, true)

	var one report.Tally
	for i := range 450 {
		one.AddResponse(200, 3+float64(i%20), 36<<10)
	}

	return &report.Report{
		ID:         "run-20260822143000-c3d4",
		Mode:       "performance",
		Status:     report.StatusCompleted,
		StartedAt:  fixtureStart,
		FinishedAt: fixtureStart.Add(30 * time.Second),
		DurationMs: 30_000,
		Target:     "pokesearch.andrestheperez.com",
		Config:     report.Config{Concurrency: 25, DurationSecs: 30},
		Entries: []report.Entry{
			{Index: 0, Name: "search charizard", Endpoint: "search", Path: "/api/search", Query: "q=charizard"},
		},
		Performance: &report.Performance{
			Verdict:        verdict,
			VerdictReasons: reasons,
			Overall:        stats,
			PerRequest:     []report.Stats{report.ComputeStats(0, "search charizard", one, 30*time.Second)},
			OverrunMs:      42,
		},
	}
}

// renderOK renders and fails the test on any error.
func renderOK(t *testing.T, rep *report.Report) []byte {
	t.Helper()
	out, err := Render(rep)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	return out
}

// assertPDF checks the structural envelope every rendered document must have.
func assertPDF(t *testing.T, out []byte) {
	t.Helper()
	if len(out) < 2000 {
		t.Errorf("pdf is %d bytes, want a real document", len(out))
	}
	if len(out) < 5 || string(out[:5]) != "%PDF-" {
		t.Errorf("missing PDF header: %q", out[:min(len(out), 8)])
	}
	if !bytes.HasSuffix(bytes.TrimSpace(out), []byte("%%EOF")) {
		t.Error("PDF is not terminated")
	}
}

// text renders with compression off so the assertions below can read the page's
// literal strings out of the content stream.
func text(t *testing.T, rep *report.Report) string {
	t.Helper()
	doc := build(rep, false)
	var buf bytes.Buffer
	if err := doc.pdf.Output(&buf); err != nil {
		t.Fatalf("Output: %v", err)
	}
	return buf.String()
}

func TestRenderFunctionalReport(t *testing.T) {
	out := renderOK(t, fixtureFunctionalReport())
	assertPDF(t, out)
}

func TestRenderPerformanceReport(t *testing.T) {
	perf := renderOK(t, fixturePerformanceReport())
	assertPDF(t, perf)

	fn := renderOK(t, fixtureFunctionalReport())
	if len(perf) <= len(fn) {
		t.Errorf("performance pdf is %d bytes and functional is %d; the percentile "+
			"and ladder tables should make the performance report the larger document",
			len(perf), len(fn))
	}
}

func TestRenderEmptyEdgeCases(t *testing.T) {
	t.Run("zero-request performance run", func(t *testing.T) {
		rep := fixturePerformanceReport()
		stats := report.ComputeStats(-1, "overall", report.Tally{}, 0)
		verdict, reasons := report.Verdict(stats, true)
		rep.Performance = &report.Performance{
			Verdict: verdict, VerdictReasons: reasons, Overall: stats, PerRequest: nil,
		}
		rep.DurationMs = 0
		assertPDF(t, renderOK(t, rep))
	})

	t.Run("all-skipped functional run", func(t *testing.T) {
		rep := fixtureFunctionalReport()
		rep.Status = report.StatusCancelled
		rep.Functional = &report.Functional{Total: 3, Skipped: 3}
		for i := range 3 {
			rep.Functional.Results = append(rep.Functional.Results,
				report.RequestResult{Index: i, Name: "search", Endpoint: "search", Skipped: true})
		}
		assertPDF(t, renderOK(t, rep))
	})

	t.Run("report with neither mode populated", func(t *testing.T) {
		rep := fixtureFunctionalReport()
		rep.Functional = nil
		rep.Status = report.StatusRunning
		assertPDF(t, renderOK(t, rep))
	})

	t.Run("nil report", func(t *testing.T) {
		if _, err := Render(nil); err == nil {
			t.Error("Render(nil) = nil error, want a refusal rather than a panic")
		}
	})
}

func TestRenderIsDeterministic(t *testing.T) {
	for _, rep := range []*report.Report{fixtureFunctionalReport(), fixturePerformanceReport()} {
		first := renderOK(t, rep)
		second := renderOK(t, rep)
		if !bytes.Equal(first, second) {
			t.Errorf("%s: two renders of the same report differ (%d vs %d bytes); "+
				"the creation date must be pinned to StartedAt, not time.Now",
				rep.Mode, len(first), len(second))
		}
	}
}

// A1 descoped this renderer to a single page. Nothing in it may flow onto a
// second one, however long the sequence is.
func TestRenderIsSinglePage(t *testing.T) {
	long := fixtureFunctionalReport()
	long.Functional = &report.Functional{Total: 50}
	for i := range 50 {
		long.Functional.Results = append(long.Functional.Results, report.RequestResult{
			Index: i, Name: "search charizard", Endpoint: "search", Query: "q=charizard",
			Status: 200, LatencyMs: 9.5, Passed: true,
		})
		long.Functional.Passed++
	}

	for _, rep := range []*report.Report{fixtureFunctionalReport(), fixturePerformanceReport(), long} {
		doc := build(rep, true)
		if got := doc.pdf.PageCount(); got != 1 {
			t.Errorf("%s report rendered %d pages, want exactly 1", rep.Mode, got)
		}
	}

	if body := text(t, long); !strings.Contains(body, "more request") {
		t.Error("a 50-request sequence must truncate with an \"and N more\" line, not overflow the page")
	}
}

func TestRenderHeaderAndFootnote(t *testing.T) {
	body := text(t, fixturePerformanceReport())
	for _, want := range []string{
		"COURIER",
		"run-20260822143000-c3d4",
		"performance",
		"2026-08-22",
		"25 workers",
		"pokesearch.andrestheperez.com",
		"executed via internal network",
		"closed-loop",
		"coordinated omission",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("rendered page does not mention %q", want)
		}
	}
}

func TestRenderPerformanceBody(t *testing.T) {
	body := text(t, fixturePerformanceReport())
	for _, want := range []string{
		"VERDICT", "p95", "p99", "Apdex", "SLA ladder",
		"under 50ms", "under 150ms", "under 300ms",
		"req/s", "Errors", "Aborted",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("performance page does not mention %q", want)
		}
	}
}

func TestRenderFunctionalCountsComeFromResults(t *testing.T) {
	rep := fixtureFunctionalReport()
	// The struct counters are json:"-" (docs/deviations.md N6), so a report that came back
	// through JSON has them zeroed. The page must still be right.
	rep.Functional.Total, rep.Functional.Passed = 0, 0
	rep.Functional.Failed, rep.Functional.Skipped = 0, 0

	body := text(t, rep)
	for _, want := range []string{"2 passed", "1 failed", "1 skipped"} {
		if !strings.Contains(body, want) {
			t.Errorf("functional page does not mention %q; counts must be derived from Results", want)
		}
	}
}

// N15: a cancelled or expired run measured something real but did not measure
// what the SLOs describe, so the verdict is withheld rather than coloured.
func TestRenderWithholdsVerdictForPartialRuns(t *testing.T) {
	for _, status := range []string{report.StatusCancelled, report.StatusExpired} {
		t.Run(status, func(t *testing.T) {
			rep := fixturePerformanceReport()
			rep.Status = status
			rep.Performance.Verdict = report.VerdictNA
			body := text(t, rep)
			if !strings.Contains(body, "N/A") || !strings.Contains(body, "partial data") {
				t.Errorf("%s run must render the neutral \"N/A - partial data\" verdict", status)
			}
			if strings.Contains(body, "VERDICT: PASS") || strings.Contains(body, "VERDICT: FAIL") {
				t.Errorf("%s run rendered a PASS/FAIL verdict it did not earn", status)
			}
		})
	}
}

// N35: a completed run of an uncalibrated sequence has complete numbers and no
// judgement. The "partial data" label belongs to a truncated run, so putting it
// on this band would contradict the reason printed right beside it.
func TestRenderWithheldVerdictIsNotLabelledPartialData(t *testing.T) {
	rep := fixturePerformanceReport()
	rep.Status = report.StatusCompleted
	rep.Performance.Verdict = report.VerdictNA
	rep.Performance.VerdictReasons = []string{
		"no verdict: the gate was calibrated on " + report.CalibrationDate +
			" against the " + report.CalibrationSequence + " sequence, and this run dispatched a different one",
	}

	body := text(t, rep)
	if !strings.Contains(body, "N/A") {
		t.Error("a withheld verdict must still render the neutral N/A band")
	}
	if strings.Contains(body, "partial data") {
		t.Error("a completed run's data is not partial; only the judgement is withheld")
	}
	if !strings.Contains(body, report.CalibrationSequence) {
		t.Errorf("the withheld verdict must carry its reason, naming the %s sequence", report.CalibrationSequence)
	}
	if strings.Contains(body, "VERDICT: PASS") || strings.Contains(body, "VERDICT: FAIL") {
		t.Error("an uncalibrated run rendered a PASS/FAIL verdict it did not earn")
	}
}

func TestRenderFunctionalVerdict(t *testing.T) {
	rep := fixtureFunctionalReport()
	if body := text(t, rep); !strings.Contains(body, "VERDICT: FAIL") {
		t.Error("a functional run with a failed request must render FAIL")
	}

	clean := fixtureFunctionalReport()
	clean.Functional.Results = clean.Functional.Results[:2]
	if body := text(t, clean); !strings.Contains(body, "VERDICT: PASS") {
		t.Error("a functional run with no failures must render PASS")
	}
}

// Every other test in this file renders a fixture that records no SLO, which
// is the shape of a report stored before the gate was recorded, so all of them
// exercise the fallback. A run from this build carries its gate, and the page
// it produces is the one a visitor downloads: the provenance has to be printed
// on it, the ladder labels have to come from the tiers the run was judged by,
// and the page has to still be one page.
func TestRenderPrintsTheRecordedGate(t *testing.T) {
	rep := fixturePerformanceReport()
	rep.Performance.SLO = report.DemoSLO()

	if got := build(rep, true).pdf.PageCount(); got != 1 {
		t.Errorf("a report carrying its gate rendered %d pages, want exactly 1", got)
	}

	body := text(t, rep)
	for _, want := range []string{
		"Gate: p95 under 150ms and error rate under 1.00%",
		"calibrated 2026-08-22 against the search-basics sequence.",
		"under 50ms", "under 150ms", "under 300ms",
		"T=50ms",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("the rendered page never says %q", want)
		}
	}

	// The provenance is report data, so it cannot be the thing that makes two
	// renders of one report differ.
	first, second := renderOK(t, rep), renderOK(t, rep)
	if !bytes.Equal(first, second) {
		t.Errorf("two renders of a report carrying its gate differ (%d vs %d bytes); "+
			"the provenance line must be formatted from the report and from nothing that varies",
			len(first), len(second))
	}
}

// The band label is the PDF's verdict as a visitor reads it. Moving the rule
// into the report package must not change one of them.
func TestFunctionalVerdictLabelsAreUnchanged(t *testing.T) {
	results := func(rs ...report.RequestResult) *report.Report {
		rep := fixtureFunctionalReport()
		rep.Functional.Results = rs
		return rep
	}
	pass := report.RequestResult{Passed: true, Assertions: []assert.Outcome{{Passed: true}}}
	fail := report.RequestResult{}
	skip := report.RequestResult{Skipped: true}
	for _, tc := range []struct {
		name   string
		rep    *report.Report
		status string
		want   string
	}{
		{"passed", results(pass, pass), report.StatusCompleted, "PASS"},
		{"failed", results(pass, fail), report.StatusCompleted, "FAIL"},
		{"nothing asserted", results(skip), report.StatusCompleted, "N/A - nothing was asserted"},
		{"cancelled", results(fail, skip), report.StatusCancelled, "N/A - partial data"},
		{"expired", results(pass, skip), report.StatusExpired, "N/A - partial data"},
	} {
		tc.rep.Status = tc.status
		if got, _, _ := verdictOf(tc.rep); got != tc.want {
			t.Errorf("%s: label = %q, want %q", tc.name, got, tc.want)
		}
		if body := text(t, tc.rep); !strings.Contains(body, "VERDICT: "+tc.want) {
			t.Errorf("%s: the page does not read VERDICT: %s", tc.name, tc.want)
		}
	}
}

// runAgainst runs a functional sequence through the real engine and returns
// the finished report, as the API would hand it to Render.
func runAgainst(t *testing.T, base string, assertions []assert.Assertion) *report.Report {
	t.Helper()
	m := runner.NewManager(runner.NewExecutor(base), "test-target", nil, nil)
	id, err := m.Start(context.Background(), sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: []sandbox.Request{
		{ID: "1", Name: "search", Endpoint: "search", Params: map[string]string{"q": "a"}, Assertions: assertions},
	}})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	m.Wait()
	rep, ok := m.Report(id)
	if !ok {
		t.Fatal("no report")
	}
	return rep
}

// The printed report of a run against a dead target carries a fixed sentence
// and nothing of the target's address.
func TestRenderedFailureCarriesNoTargetAddress(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	base := srv.URL
	srv.Close()
	u, _ := url.Parse(base)

	rep := runAgainst(t, base, []assert.Assertion{{Type: assert.TypeStatus, Op: "eq", Value: float64(200)}})
	body := strings.ReplaceAll(text(t, rep), "%%EOF", "")
	for _, bad := range []string{u.Host, u.Hostname(), ":" + u.Port(), "dial tcp", "connection refused", "lookup", "EOF", "Get "} {
		if strings.Contains(body, bad) {
			t.Errorf("the PDF carries %q", bad)
		}
	}
	if !strings.Contains(body, runner.MsgConnection) {
		t.Error("the PDF does not carry the fixed connection sentence")
	}
}

// A run whose only request got no response is a failed run on paper too, even
// when its only assertion is a latency bound the failure was quick enough for.
func TestRenderedRunWithNoResponseFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	base := srv.URL
	srv.Close()
	rep := runAgainst(t, base, []assert.Assertion{{Type: assert.TypeLatency, Op: "lt", Value: float64(150)}})
	if rep.Functional.Verdict != report.VerdictFail {
		t.Errorf("verdict = %q, want FAIL", rep.Functional.Verdict)
	}
	if o := rep.Functional.Results[0].Assertions[0]; o.Passed || o.Actual != runner.NoResponse {
		t.Errorf("outcome = %+v, want failed with actual %q", o, runner.NoResponse)
	}
	if body := text(t, rep); !strings.Contains(body, "VERDICT: FAIL") {
		t.Error("the PDF does not print VERDICT: FAIL")
	}
}
