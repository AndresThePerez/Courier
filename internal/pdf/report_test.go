package pdf

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
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
	verdict, reasons := report.Verdict(stats)

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
		verdict, reasons := report.Verdict(stats)
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
		"under 25ms", "under 50ms", "under 100ms",
		"req/s", "Errors", "Aborted",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("performance page does not mention %q", want)
		}
	}
}

func TestRenderFunctionalCountsComeFromResults(t *testing.T) {
	rep := fixtureFunctionalReport()
	// The struct counters are json:"-" (NOTE.md N6), so a report that came back
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
