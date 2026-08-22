//go:build acceptance

// Courier's end-to-end acceptance matrix (Implementation Plan, Task 20).
//
// It drives a *running* Courier over HTTP — no httptest, no injected clocks, no
// package internals — and asserts the behaviour the Design Spec promises a
// visitor. Everything here is a black-box check against the public API.
//
// # Two target modes, said out loud
//
// Most of the matrix runs against a Courier pointed at the real Pokesearch
// Milestone 3 build: that is the only way the curated fixtures get verified,
// and verifying them is the single most important item in this file.
//
// Two items cannot run there, because they need the target to *misbehave on
// command*: metrics accounting against a real 503, and the functional deadline
// against a stalling target. Pointing them at a shared instance would mean
// breaking it for everyone else. They therefore run against a second Courier
// whose target is a controllable stub, named by STUB_URL, and skip loudly when
// it is absent rather than quietly passing.
//
// # Environment
//
//	COURIER_URL       base URL of a Courier whose target is real Pokesearch.
//	                  Default http://127.0.0.1:8084.
//	STUB_URL          base URL of a *second* Courier whose target is the stub.
//	                  Unset ⇒ the two target-manipulation tests skip.
//	STUB_TARGET_URL   base URL of the stub itself, for its /__mode control
//	                  plane. Required alongside STUB_URL.
//
// # Ordering
//
// The tests are ordered, not parallel, and that is deliberate: Courier admits
// one run at a time and every finished run opens a cooldown window, so a
// parallel matrix would spend its life in 409s. Two later tests reuse run ids
// recorded by earlier ones instead of paying for another run and another
// cooldown; each skips with a clear message if its input is missing.
package acceptance

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/collections"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

var (
	courierURL     = envOr("COURIER_URL", "http://127.0.0.1:8084")
	stubURL        = os.Getenv("STUB_URL")
	stubTargetURL  = os.Getenv("STUB_TARGET_URL")
	curatedSuite   []collections.Collection
	lastFunctional string // run id recorded by TestCuratedCollectionsRunClean
	lastPerf       string // run id recorded by TestPerformanceSanity
)

// hc is the client for everything except SSE. The timeout is generous because
// one call in here (starting a run) can queue behind a cooldown poll, and mean
// because nothing in this matrix should ever take 30s to answer.
var hc = &http.Client{Timeout: 30 * time.Second}

func envOr(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}

func TestMain(m *testing.M) {
	if err := ping(courierURL); err != nil {
		fmt.Fprintf(os.Stderr, "acceptance: COURIER_URL %s is not answering: %v\n"+
			"start one with: PORT=8084 TARGET_URL=http://127.0.0.1:8081 PPROF_ADDR=off go run ./cmd/server\n",
			courierURL, err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func ping(base string) error {
	resp, err := hc.Get(base + "/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz returned %d", resp.StatusCode)
	}
	return nil
}

// ---------------------------------------------------------------- HTTP glue

func doJSON(t *testing.T, method, url string, body, out any) (int, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal %s %s: %v", method, url, err)
		}
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatalf("build %s %s: %v", method, url, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read %s %s: %v", method, url, err)
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("decode %s %s (%d): %v\nbody: %s", method, url, resp.StatusCode, err, truncate(raw))
		}
	}
	return resp.StatusCode, raw
}

func truncate(b []byte) string {
	if len(b) > 600 {
		return string(b[:600]) + "..."
	}
	return string(b)
}

// ------------------------------------------------------------- run helpers

type startResponse struct {
	RunID         string     `json:"run_id"`
	Error         string     `json:"error"`
	CooldownUntil *time.Time `json:"cooldown_until"`
}

// startRun waits out any cooldown, POSTs the run, and returns its id. Waiting
// first is what keeps the matrix linear: the budget's floor is 5s and every
// test in here finishes a run, so without this every second POST would be a
// 409 the test would have to re-handle.
func startRun(t *testing.T, base string, rr sandbox.RunRequest) string {
	t.Helper()
	waitReady(t, base)

	var out startResponse
	code, raw := doJSON(t, http.MethodPost, base+"/api/runs", rr, &out)
	if code != http.StatusAccepted {
		t.Fatalf("POST /api/runs = %d, want 202\nbody: %s", code, truncate(raw))
	}
	if out.RunID == "" {
		t.Fatalf("202 carried no run_id: %s", truncate(raw))
	}
	return out.RunID
}

// waitReady blocks until the server is idle and out of cooldown.
func waitReady(t *testing.T, base string) {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		st := status(t, base)
		switch {
		case st.Running:
			time.Sleep(250 * time.Millisecond)
		case st.CooldownUntil != nil && time.Now().Before(*st.CooldownUntil):
			wait := time.Until(*st.CooldownUntil) + 300*time.Millisecond
			t.Logf("waiting %.1fs for the cooldown window", wait.Seconds())
			time.Sleep(wait)
		default:
			return
		}
	}
	t.Fatalf("%s never became ready to accept a run", base)
}

func status(t *testing.T, base string) runner.Status {
	t.Helper()
	var st runner.Status
	code, raw := doJSON(t, http.MethodGet, base+"/api/status", nil, &st)
	if code != http.StatusOK {
		t.Fatalf("GET /api/status = %d: %s", code, truncate(raw))
	}
	return st
}

func fetchReport(t *testing.T, base, id string) *report.Report {
	t.Helper()
	var rep report.Report
	code, raw := doJSON(t, http.MethodGet, base+"/api/runs/"+id, nil, &rep)
	if code != http.StatusOK {
		t.Fatalf("GET /api/runs/%s = %d: %s", id, code, truncate(raw))
	}
	return &rep
}

// awaitRun polls until the run leaves `running`, then returns the final report.
func awaitRun(t *testing.T, base, id string, within time.Duration) *report.Report {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		rep := fetchReport(t, base, id)
		if rep.Status != report.StatusRunning {
			return rep
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatalf("run %s still running after %s", id, within)
	return nil
}

// ------------------------------------------------------------ curated input

// curated fetches the collections the *server* serves, not the ones this test
// binary embeds. The distinction matters: the whole point of the curated item
// is that the shipped artefact is right.
func curated(t *testing.T) []collections.Collection {
	t.Helper()
	if curatedSuite != nil {
		return curatedSuite
	}
	var out struct {
		Collections []collections.Collection `json:"collections"`
		Endpoints   []struct {
			ID string `json:"id"`
		} `json:"endpoints"`
		Target string `json:"target"`
	}
	code, raw := doJSON(t, http.MethodGet, courierURL+"/api/collections", nil, &out)
	if code != http.StatusOK {
		t.Fatalf("GET /api/collections = %d: %s", code, truncate(raw))
	}
	if len(out.Collections) == 0 {
		t.Fatal("the server serves no curated collections")
	}
	curatedSuite = out.Collections
	return curatedSuite
}

// searchSequence is the 5-request search-basics collection, which is what the
// performance items load the target with: real queries, real response sizes.
func searchSequence(t *testing.T) []sandbox.Request {
	t.Helper()
	for _, c := range curated(t) {
		if c.ID == "search-basics" {
			return c.Requests
		}
	}
	t.Fatal("no search-basics collection to load the target with")
	return nil
}

// ============================================================== the matrix ==

// TestCuratedCollectionsRunClean is the item the whole file exists for.
//
// NOTE.md N24 deferred exactly this: every curated fixture was measured by hand
// against the pinned 20,324-card index but never re-run end to end, and the
// error-handling collection's 400 assertions were written against a contract
// document rather than a running server. This runs all four collections through
// a real Courier against the real target and requires zero assertion failures.
func TestCuratedCollectionsRunClean(t *testing.T) {
	all := curated(t)
	t.Logf("%d curated collections from %s", len(all), courierURL)

	for _, c := range all {
		t.Run(c.ID, func(t *testing.T) {
			id := startRun(t, courierURL, sandbox.RunRequest{
				Mode:     sandbox.ModeFunctional,
				Sequence: c.Requests,
				Options:  sandbox.Options{StopOnFailure: false},
			})
			rep := awaitRun(t, courierURL, id, 3*time.Minute)
			lastFunctional = id

			if rep.Status != report.StatusCompleted {
				t.Errorf("status = %q, want %q (note: %s)", rep.Status, report.StatusCompleted, rep.Note)
			}
			if rep.Functional == nil {
				t.Fatalf("functional run produced no functional payload")
			}
			results := rep.Functional.Results
			if len(results) != len(c.Requests) {
				t.Errorf("got %d results for %d requests", len(results), len(c.Requests))
			}

			var failed, skipped int
			for _, r := range results {
				if r.Skipped {
					skipped++
					t.Errorf("%s: skipped, which a healthy target never causes", r.Name)
					continue
				}
				if r.Passed {
					continue
				}
				failed++
				// The detail is the deliverable here: a bare count would not
				// tell the next agent whether a fixture drifted or an operator
				// is wrong.
				t.Errorf("%s (%s?%s): status %d in %.1fms, err=%q kind=%q",
					r.Name, r.Endpoint, r.Query, r.Status, r.LatencyMs, r.Error, r.ErrorKind)
				for _, a := range r.Assertions {
					if a.Passed {
						continue
					}
					t.Errorf("    FAILED %s %s %s: expected %s, actual %s%s",
						a.Assertion.Type, a.Assertion.Path, a.Assertion.Op,
						a.Expected, a.Actual, errSuffix(a.Error))
				}
			}
			if failed == 0 && skipped == 0 {
				t.Logf("%s: %d/%d requests passed every assertion in %dms",
					c.Name, len(results), len(c.Requests), rep.DurationMs)
			}
		})
	}
}

func errSuffix(e string) string {
	if e == "" {
		return ""
	}
	return " (" + e + ")"
}

// TestPerformanceSanity is the plan's throughput identity: a closed-loop
// generator with C workers over D seconds at L mean latency must dispatch
// about C*D/L requests. It is the check that the engine is actually
// concurrent and that the report is actually populated.
func TestPerformanceSanity(t *testing.T) {
	const (
		workers  = 10
		duration = 5
	)
	id := startRun(t, courierURL, sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: searchSequence(t),
		Options:  sandbox.Options{Concurrency: workers, DurationSecs: duration},
	})
	rep := awaitRun(t, courierURL, id, 60*time.Second)
	lastPerf = id

	if rep.Status != report.StatusCompleted {
		t.Fatalf("status = %q, want %q (note: %s)", rep.Status, report.StatusCompleted, rep.Note)
	}
	p := rep.Performance
	if p == nil {
		t.Fatal("performance run produced no performance payload")
	}
	o := p.Overall

	// Fully populated: every field a dashboard reads has a real value in it.
	if rep.Config.Concurrency != workers || rep.Config.DurationSecs != duration {
		t.Errorf("config = %d workers / %ds, want %d/%d",
			rep.Config.Concurrency, rep.Config.DurationSecs, workers, duration)
	}
	if len(rep.Entries) != len(searchSequence(t)) {
		t.Errorf("report carries %d entries, want %d", len(rep.Entries), len(searchSequence(t)))
	}
	if o.Requests == 0 {
		t.Fatal("zero dispatches")
	}
	if o.RequestsPerSec <= 0 {
		t.Error("requests_per_sec is not populated")
	}
	if o.Latency.P50 <= 0 || o.Latency.P95 <= 0 || o.Latency.Max <= 0 {
		t.Errorf("percentiles not populated: %+v", o.Latency)
	}
	if len(o.Histogram) == 0 {
		t.Error("histogram is empty")
	}
	if len(o.StatusCounts) == 0 {
		t.Error("status_counts is empty")
	}
	if o.Apdex.Rating == "" {
		t.Error("apdex has no rating")
	}
	if p.Verdict != report.VerdictPass && p.Verdict != report.VerdictFail {
		t.Errorf("verdict = %q, want PASS or FAIL", p.Verdict)
	}
	if len(p.PerRequest) != len(rep.Entries) {
		t.Errorf("per_request has %d scopes for %d entries", len(p.PerRequest), len(rep.Entries))
	}
	// A performance report must never carry response bodies: that is the
	// difference between the two modes' memory profiles.
	if rep.Functional != nil {
		t.Error("performance run also produced a functional payload")
	}

	// The identity. Little's law for a closed loop, ±35% as the plan specifies.
	if o.Latency.Avg <= 0 {
		t.Fatal("avg latency is zero; the identity cannot be checked")
	}
	expected := float64(workers) * float64(duration) * 1000 / o.Latency.Avg
	drift := math.Abs(float64(o.Requests)-expected) / expected
	t.Logf("%d requests in %dms: %.1f req/s, avg %.2fms, p50 %.2fms, p95 %.2fms, errors %d",
		o.Requests, rep.DurationMs, o.RequestsPerSec, o.Latency.Avg, o.Latency.P50, o.Latency.P95, o.Errors)
	t.Logf("closed-loop identity: expected ~%.0f requests, got %d (%.1f%% off)", expected, o.Requests, drift*100)
	if drift > 0.35 {
		t.Errorf("requests %d is %.1f%% off the expected %.0f (C*D/L); tolerance is 35%%",
			o.Requests, drift*100, expected)
	}

	// Wall clock: the run may only overrun by the tail request it waited for.
	budget := int64(duration)*1000 + int64(o.Latency.Max) + 500
	if rep.DurationMs > budget {
		t.Errorf("wall clock %dms exceeds duration + one request latency (%dms)", rep.DurationMs, budget)
	}
	if p.OverrunMs <= 0 {
		t.Errorf("overrun_ms = %d; a closed-loop run always waits out its last in-flight request", p.OverrunMs)
	}
	if float64(p.OverrunMs) > o.Latency.Max+500 {
		t.Errorf("overrun_ms %d is larger than the slowest response (%.1fms)", p.OverrunMs, o.Latency.Max)
	}
}

// TestClampsAndBusyConflict covers three contracts that only make sense
// together: an over-cap request is answered rather than refused, the report
// records what was *honoured* rather than what was asked for, and a second
// start during that run is a 409 carrying the live run's id.
func TestClampsAndBusyConflict(t *testing.T) {
	id := startRun(t, courierURL, sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: searchSequence(t),
		// Ten times the cap on both knobs.
		Options: sandbox.Options{Concurrency: 500, DurationSecs: 600},
	})
	t.Cleanup(func() { cancelIfRunning(t, courierURL, id) })

	rep := fetchReport(t, courierURL, id)
	if rep.Config.Concurrency != sandbox.MaxConcurrency {
		t.Errorf("concurrency clamped to %d, want %d", rep.Config.Concurrency, sandbox.MaxConcurrency)
	}
	if rep.Config.DurationSecs != sandbox.MaxDurationSecs {
		t.Errorf("duration clamped to %d, want %d", rep.Config.DurationSecs, sandbox.MaxDurationSecs)
	}
	t.Logf("500 workers / 600s was accepted and clamped to %d/%ds",
		rep.Config.Concurrency, rep.Config.DurationSecs)

	// A second start while that one runs.
	var conflict struct {
		Error string `json:"error"`
		RunID string `json:"run_id"`
	}
	code, raw := doJSON(t, http.MethodPost, courierURL+"/api/runs", sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: searchSequence(t),
		Options:  sandbox.Options{Concurrency: 1, DurationSecs: 1},
	}, &conflict)
	if code != http.StatusConflict {
		t.Fatalf("second POST /api/runs = %d, want 409\nbody: %s", code, truncate(raw))
	}
	if conflict.RunID != id {
		t.Errorf("409 named run %q, want the live run %q", conflict.RunID, id)
	}
	if !strings.Contains(conflict.Error, "in progress") {
		t.Errorf("409 error = %q, want it to say a run is in progress", conflict.Error)
	}
	t.Logf("409 during a run offers spectator mode on %s: %q", conflict.RunID, conflict.Error)
}

// cancelIfRunning stops a run the test no longer needs, so the 50-worker clamp
// probe does not hold the target for its full 30 seconds.
func cancelIfRunning(t *testing.T, base, id string) {
	t.Helper()
	if st := status(t, base); st.Running && st.RunID == id {
		code, _ := doJSON(t, http.MethodDelete, base+"/api/runs/"+id, nil, nil)
		t.Logf("cleanup: DELETE /api/runs/%s = %d", id, code)
	}
}

// TestCancelDuringRun: DELETE mid-run answers fast, stores a cancelled report
// with the partial results it did measure, and frees the lock.
func TestCancelDuringRun(t *testing.T) {
	id := startRun(t, courierURL, sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: searchSequence(t),
		Options:  sandbox.Options{Concurrency: 10, DurationSecs: 30},
	})
	time.Sleep(2 * time.Second)

	start := time.Now()
	code, raw := doJSON(t, http.MethodDelete, courierURL+"/api/runs/"+id, nil, nil)
	elapsed := time.Since(start)
	if code != http.StatusNoContent {
		t.Fatalf("DELETE /api/runs/%s = %d, want 204\nbody: %s", id, code, truncate(raw))
	}
	if elapsed > 1500*time.Millisecond {
		t.Errorf("DELETE took %s; the contract is ~1s", elapsed)
	}
	t.Logf("DELETE answered 204 in %s", elapsed.Round(time.Millisecond))

	rep := awaitRun(t, courierURL, id, 30*time.Second)
	if rep.Status != report.StatusCancelled {
		t.Errorf("status = %q, want %q", rep.Status, report.StatusCancelled)
	}
	if rep.Performance == nil || rep.Performance.Overall.Requests == 0 {
		t.Fatal("a cancelled run kept no partial results")
	}
	if rep.Performance.Verdict != report.VerdictNA {
		t.Errorf("verdict = %q, want %q: a cancelled run measured real numbers but not the SLOs",
			rep.Performance.Verdict, report.VerdictNA)
	}
	if rep.Note == "" {
		t.Error("a cancelled report carries no note explaining itself")
	}
	// The abort accounting rule: requests the visitor's own Cancel killed are
	// dispatches, never target errors.
	o := rep.Performance.Overall
	if o.Requests != o.OK+o.Errors+o.Aborted {
		t.Errorf("requests %d != ok %d + errors %d + aborted %d", o.Requests, o.OK, o.Errors, o.Aborted)
	}
	t.Logf("cancelled after %dms: %d requests (%d ok, %d errors, %d aborted), note %q",
		rep.DurationMs, o.Requests, o.OK, o.Errors, o.Aborted, rep.Note)

	if st := status(t, courierURL); st.Running {
		t.Errorf("the lock is still held by %s after a cancel", st.RunID)
	}
}

// TestCooldownWindow: the run immediately after any run is refused with the
// timestamp to count down to, and the same payload succeeds once it passes.
func TestCooldownWindow(t *testing.T) {
	// A deliberately tiny run: its cost is far below the refill rate, so the
	// cooldown it buys is the budget's 5s floor rather than a real deficit.
	tiny := sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: searchSequence(t)[:1],
		Options:  sandbox.Options{Concurrency: 1, DurationSecs: 1},
	}
	first := startRun(t, courierURL, tiny)
	awaitRun(t, courierURL, first, 30*time.Second)

	var refused startResponse
	code, raw := doJSON(t, http.MethodPost, courierURL+"/api/runs", tiny, &refused)
	if code != http.StatusConflict {
		t.Fatalf("immediate rerun = %d, want 409\nbody: %s", code, truncate(raw))
	}
	if refused.CooldownUntil == nil {
		t.Fatalf("409 carried no cooldown_until: %s", truncate(raw))
	}
	wait := time.Until(*refused.CooldownUntil)
	if wait <= 0 {
		t.Errorf("cooldown_until %s is already past", refused.CooldownUntil)
	}
	if wait > 30*time.Second {
		t.Errorf("cooldown of %s is far longer than the floor; the budget is in deficit", wait)
	}
	t.Logf("immediate rerun refused: %q, %.1fs to go", refused.Error, wait.Seconds())

	// The 409 must not carry a run id: there is no live run to spectate, and
	// the UI branches on exactly that.
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	if _, ok := body["run_id"]; ok {
		t.Errorf("a cooldown 409 offered spectator mode: %s", truncate(raw))
	}

	time.Sleep(wait + 500*time.Millisecond)
	var accepted startResponse
	code, raw = doJSON(t, http.MethodPost, courierURL+"/api/runs", tiny, &accepted)
	if code != http.StatusAccepted {
		t.Fatalf("rerun after the window = %d, want 202\nbody: %s", code, truncate(raw))
	}
	t.Logf("the same payload was accepted as %s once the window passed", accepted.RunID)
	awaitRun(t, courierURL, accepted.RunID, 30*time.Second)
}

// TestPollingContract is the fallback's promise: a client with no SSE at all
// can poll GET /api/runs/{id} and render a coherent report on every single
// poll, never a half-written one.
func TestPollingContract(t *testing.T) {
	const duration = 8
	id := startRun(t, courierURL, sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: searchSequence(t),
		Options:  sandbox.Options{Concurrency: 5, DurationSecs: duration},
	})

	var polls, lastRequests int
	deadline := time.Now().Add(time.Duration(duration+20) * time.Second)
	sawRunning := false
	for time.Now().Before(deadline) {
		rep := fetchReport(t, courierURL, id)
		polls++

		if rep.ID != id || rep.Mode != sandbox.ModePerformance {
			t.Fatalf("poll %d returned a different run: %s/%s", polls, rep.ID, rep.Mode)
		}
		if rep.Config.Concurrency != 5 || rep.Config.DurationSecs != duration {
			t.Errorf("poll %d: config is not populated: %+v", polls, rep.Config)
		}
		if len(rep.Entries) == 0 {
			t.Errorf("poll %d: no entries, so the client cannot draw the sequence", polls)
		}
		if rep.Performance == nil {
			t.Fatalf("poll %d: no performance payload on a performance run", polls)
		}
		o := rep.Performance.Overall
		if o.Requests < lastRequests {
			t.Errorf("poll %d: requests went backwards, %d after %d", polls, o.Requests, lastRequests)
		}
		lastRequests = o.Requests

		if rep.Status == report.StatusRunning {
			sawRunning = true
			// Mid-run the partial carries counters only: Requests, Errors and
			// Aborted come off the progress tick, and OK is derived rather than
			// published (Manager.absorb). Percentiles are computed once, at the
			// end, so the identity to check here is the derivation, not the sum.
			if derived := o.Requests - o.Errors - o.Aborted; derived < 0 {
				t.Errorf("poll %d: errors %d + aborted %d exceed requests %d",
					polls, o.Errors, o.Aborted, o.Requests)
			}
			if o.Latency.P95 != 0 || o.Latency.P50 != 0 {
				t.Errorf("poll %d: a live report published percentiles (%+v); they are computed once, at the end",
					polls, o.Latency)
			}
			// The verdict is withheld while the run is live: N/A, never a
			// judgement made on numbers that are still moving.
			if v := rep.Performance.Verdict; v == report.VerdictPass || v == report.VerdictFail {
				t.Errorf("poll %d: a live run already claims verdict %q", polls, v)
			}
			if !rep.FinishedAt.IsZero() {
				t.Errorf("poll %d: a running report is already stamped finished", polls)
			}
			time.Sleep(400 * time.Millisecond)
			continue
		}

		// Finished: now every counter is real and the identity must hold.
		if o.Requests != o.OK+o.Errors+o.Aborted {
			t.Errorf("final: requests %d != ok %d + errors %d + aborted %d",
				o.Requests, o.OK, o.Errors, o.Aborted)
		}

		if !sawRunning {
			t.Error("the run finished before a single mid-run poll landed; the contract went unchecked")
		}
		if rep.Status != report.StatusCompleted {
			t.Errorf("final status = %q, want %q", rep.Status, report.StatusCompleted)
		}
		if rep.Performance.Verdict == "" {
			t.Error("a finished run has no verdict")
		}
		t.Logf("%d coherent polls; final: %d requests, verdict %s", polls, lastRequests, rep.Performance.Verdict)
		return
	}
	t.Fatalf("run %s never finished", id)
}

// ------------------------------------------------------------------- SSE --

type sseFrame struct {
	Name  string
	Event runner.Event
}

// openStream subscribes to a run's SSE stream and returns a channel of frames.
// It is a deliberately small reader: the point is to prove the wire format is
// consumable by something that is not the shipped frontend.
func openStream(ctx context.Context, base, id string) (<-chan sseFrame, func(), error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/runs/"+id+"/stream", nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	// No timeout: an SSE response never ends on its own.
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, nil, fmt.Errorf("stream returned %d: %s", resp.StatusCode, truncate(body))
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		resp.Body.Close()
		return nil, nil, fmt.Errorf("stream Content-Type = %q", ct)
	}

	frames := make(chan sseFrame, 512)
	go func() {
		defer close(frames)
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
		var name, data string
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if data != "" {
					var e runner.Event
					if json.Unmarshal([]byte(data), &e) == nil {
						select {
						case frames <- sseFrame{Name: name, Event: e}:
						default:
						}
					}
				}
				name, data = "", ""
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				data = strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	return frames, func() { resp.Body.Close() }, nil
}

// TestSSEReconnectAndSpectator covers the two live-transport promises the spec
// makes: a viewer whose stream drops mid-run reconnects and is made whole from
// the replay log, and a *second* viewer arriving mid-run gets that same replay
// followed by live events.
func TestSSEReconnectAndSpectator(t *testing.T) {
	const duration = 12
	id := startRun(t, courierURL, sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: searchSequence(t),
		Options:  sandbox.Options{Concurrency: 5, DurationSecs: duration},
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(duration+30)*time.Second)
	defer cancel()

	// Viewer A attaches at the start.
	frames, closeA, err := openStream(ctx, courierURL, id)
	if err != nil {
		t.Fatalf("first subscriber: %v", err)
	}
	firstA := drain(t, frames, 3, 8*time.Second)
	if len(firstA) == 0 {
		t.Fatal("first subscriber received nothing")
	}
	if firstA[0].Event.Type != runner.EventRunStarted {
		t.Errorf("first frame is %q, want %q", firstA[0].Event.Type, runner.EventRunStarted)
	}
	for _, f := range firstA {
		if f.Name != f.Event.Type {
			t.Errorf("frame name %q disagrees with envelope type %q", f.Name, f.Event.Type)
		}
		if f.Event.RunID != id {
			t.Errorf("frame carried run_id %q, want %q", f.Event.RunID, id)
		}
	}
	t.Logf("subscriber A: %d frames before the drop (%s)", len(firstA), typesOf(firstA))

	// The drop, mid-run.
	closeA()

	// Viewer B — a spectator who was never here for the start — attaches now.
	specFrames, closeB, err := openStream(ctx, courierURL, id)
	if err != nil {
		t.Fatalf("spectator: %v", err)
	}
	defer closeB()
	spec := drain(t, specFrames, 3, 8*time.Second)
	if len(spec) == 0 {
		t.Fatal("the spectator received nothing")
	}
	if spec[0].Event.Type != runner.EventRunStarted {
		t.Errorf("spectator's first frame is %q, want the replayed %q", spec[0].Event.Type, runner.EventRunStarted)
	}
	t.Logf("subscriber B (mid-run): %d frames, replay first (%s)", len(spec), typesOf(spec))

	// Viewer A reconnects, and must be made whole the same way.
	reFrames, closeC, err := openStream(ctx, courierURL, id)
	if err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	defer closeC()
	re := drain(t, reFrames, 3, 8*time.Second)
	if len(re) == 0 {
		t.Fatal("the reconnecting subscriber received nothing")
	}
	if re[0].Event.Type != runner.EventRunStarted {
		t.Errorf("reconnect's first frame is %q, want the replayed %q", re[0].Event.Type, runner.EventRunStarted)
	}
	t.Logf("subscriber A reconnected: %d frames (%s)", len(re), typesOf(re))

	// Both open streams must see the run end live, not by polling for it.
	if !awaitFrame(specFrames, runner.EventRunFinished, time.Duration(duration+25)*time.Second) {
		t.Error("the spectator never received run_finished")
	}
	if !awaitFrame(reFrames, runner.EventRunFinished, 20*time.Second) {
		t.Error("the reconnected subscriber never received run_finished")
	}
	awaitRun(t, courierURL, id, 30*time.Second)
}

// drain collects up to want frames, or whatever arrived before the deadline.
func drain(t *testing.T, ch <-chan sseFrame, want int, within time.Duration) []sseFrame {
	t.Helper()
	var out []sseFrame
	timeout := time.After(within)
	for len(out) < want {
		select {
		case f, ok := <-ch:
			if !ok {
				return out
			}
			out = append(out, f)
		case <-timeout:
			return out
		}
	}
	return out
}

func awaitFrame(ch <-chan sseFrame, typ string, within time.Duration) bool {
	timeout := time.After(within)
	for {
		select {
		case f, ok := <-ch:
			if !ok {
				return false
			}
			if f.Event.Type == typ {
				return true
			}
		case <-timeout:
			return false
		}
	}
}

func typesOf(fs []sseFrame) string {
	seen := make([]string, 0, len(fs))
	for _, f := range fs {
		seen = append(seen, f.Event.Type)
	}
	return strings.Join(seen, ", ")
}

// -------------------------------------------------------- artefacts + API --

// TestStrictParamIsRejectedNamingTheField pins the Milestone 3 error contract
// end to end, through Courier's own editor path: page_size is in the allowlist
// (so Courier forwards it), and Pokesearch answers 400 naming the field.
//
// The curated error-handling collection asserts the same thing during
// TestCuratedCollectionsRunClean; this checks it directly so a failure there
// can be told apart from a failure in the assertion engine.
func TestStrictParamIsRejectedNamingTheField(t *testing.T) {
	var out struct {
		Status int    `json:"status"`
		Body   string `json:"body"`
	}
	code, raw := doJSON(t, http.MethodPost, courierURL+"/api/send", sandbox.Request{
		ID:       "acceptance-page-size",
		Name:     "page_size is strict",
		Endpoint: "search",
		Params:   map[string]string{"q": "pikachu", "page_size": "lots"},
	}, &out)
	if code != http.StatusOK {
		t.Fatalf("POST /api/send = %d, want 200 (Courier forwards; the target judges)\nbody: %s", code, truncate(raw))
	}
	if out.Status != http.StatusBadRequest {
		t.Fatalf("target answered %d, want 400", out.Status)
	}

	var body struct {
		Error struct {
			Code    string `json:"code"`
			Field   string `json:"field"`
			Message string `json:"message"`
		} `json:"error"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal([]byte(out.Body), &body); err != nil {
		t.Fatalf("400 body is not the structured shape: %v\n%s", err, out.Body)
	}
	if body.Error.Code != "invalid_param" {
		t.Errorf("error.code = %q, want invalid_param", body.Error.Code)
	}
	if body.Error.Field != "page_size" {
		t.Errorf("error.field = %q, want page_size — the 400 must name the offending field", body.Error.Field)
	}
	if body.RequestID == "" {
		t.Error("the 400 carries no request_id")
	}
	t.Logf("400 names the field: %+v", body.Error)
}

// TestReportPDFParsesForBothModes reuses the runs the earlier tests already
// paid for, rather than buying two more cooldowns to render two more PDFs.
func TestReportPDFParsesForBothModes(t *testing.T) {
	for _, tc := range []struct{ mode, id string }{
		{"functional", lastFunctional},
		{"performance", lastPerf},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			if tc.id == "" {
				t.Skipf("no %s run was recorded earlier in this suite", tc.mode)
			}
			resp, err := hc.Get(courierURL + "/api/runs/" + tc.id + "/report.pdf")
			if err != nil {
				t.Fatalf("GET report.pdf: %v", err)
			}
			defer resp.Body.Close()
			raw, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatalf("read report.pdf: %v", err)
			}
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("GET report.pdf = %d: %s", resp.StatusCode, truncate(raw))
			}
			if ct := resp.Header.Get("Content-Type"); ct != "application/pdf" {
				t.Errorf("Content-Type = %q", ct)
			}
			if cd := resp.Header.Get("Content-Disposition"); !strings.Contains(cd, ".pdf") {
				t.Errorf("Content-Disposition = %q", cd)
			}
			if !bytes.HasPrefix(raw, []byte("%PDF-")) {
				t.Fatalf("not a PDF: % x", raw[:min(8, len(raw))])
			}
			if !bytes.HasSuffix(bytes.TrimSpace(raw), []byte("%%EOF")) {
				t.Error("PDF is not terminated with a trailing EOF marker")
			}
			if !bytes.Contains(raw, []byte("/Type /Page")) && !bytes.Contains(raw, []byte("/Type/Page")) {
				t.Error("PDF has no page object")
			}
			t.Logf("%s report.pdf: %d bytes, %s", tc.mode, len(raw), resp.Header.Get("Content-Disposition"))
		})
	}
}

// TestHistoryIsCappedAndNewestFirst asserts the *server* contract. The UI shows
// five rows (Amendment A4); twenty is what the API is allowed to return.
func TestHistoryIsCappedAndNewestFirst(t *testing.T) {
	var out struct {
		Runs []struct {
			ID         string    `json:"id"`
			Mode       string    `json:"mode"`
			Status     string    `json:"status"`
			StartedAt  time.Time `json:"started_at"`
			DurationMs int64     `json:"duration_ms"`
			Verdict    string    `json:"verdict"`
			Summary    string    `json:"summary"`
		} `json:"runs"`
	}
	code, raw := doJSON(t, http.MethodGet, courierURL+"/api/runs", nil, &out)
	if code != http.StatusOK {
		t.Fatalf("GET /api/runs = %d: %s", code, truncate(raw))
	}
	if len(out.Runs) == 0 {
		t.Fatal("history is empty after a whole acceptance suite")
	}
	if len(out.Runs) > 20 {
		t.Errorf("history returned %d rows, cap is 20", len(out.Runs))
	}
	for i, r := range out.Runs {
		if r.ID == "" || r.Mode == "" || r.Status == "" || r.Summary == "" {
			t.Errorf("row %d is incomplete: %+v", i, r)
		}
		if r.Status == report.StatusRunning {
			t.Errorf("row %d is a live run; history lists finished runs", i)
		}
		if i > 0 && r.StartedAt.After(out.Runs[i-1].StartedAt) {
			t.Errorf("row %d started after row %d; history is not newest-first", i, i-1)
		}
	}
	t.Logf("history: %d rows, newest %s (%s, %s)",
		len(out.Runs), out.Runs[0].ID, out.Runs[0].Mode, out.Runs[0].Summary)
}

// TestCourierStartsWithItsTargetDown builds the real binary and points it at a
// closed port. Courier must come up regardless: a demo whose front page is a
// stack trace because the thing it measures is down is the wrong failure mode.
func TestCourierStartsWithItsTargetDown(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "courier-acceptance")
	build := exec.Command("go", "build", "-o", bin, "../../cmd/server")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	// 127.0.0.1:1 is reserved and closed: connections are refused instantly.
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		"PORT=8094",
		"TARGET_URL=http://127.0.0.1:1",
		"TARGET_DISPLAY=dead-target",
		"PPROF_ADDR=off",
	)
	var logs bytes.Buffer
	cmd.Stdout, cmd.Stderr = &logs, &logs
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	base := "http://127.0.0.1:8094"
	var up bool
	for range 60 {
		if ping(base) == nil {
			up = true
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if !up {
		t.Fatalf("Courier never became healthy with its target down\n%s", logs.String())
	}

	// It is not merely listening — the API is fully wired.
	st := status(t, base)
	if st.Running {
		t.Error("a fresh instance reports a run in progress")
	}
	if st.BudgetBalance <= 0 {
		t.Errorf("budget balance = %v on a fresh instance", st.BudgetBalance)
	}
	var cols struct {
		Collections []collections.Collection `json:"collections"`
		Target      string                   `json:"target"`
	}
	if code, raw := doJSON(t, http.MethodGet, base+"/api/collections", nil, &cols); code != http.StatusOK {
		t.Fatalf("GET /api/collections = %d: %s", code, truncate(raw))
	}
	if len(cols.Collections) == 0 {
		t.Error("collections are not served when the target is down")
	}
	t.Logf("Courier came up clean against a dead target: %d collections, balance %.0f w-s, target %q",
		len(cols.Collections), st.BudgetBalance, cols.Target)
}

// ==================================================== stub-backed items ====
//
// Everything below needs a target that misbehaves on command. It runs against
// a second Courier (STUB_URL) whose target is a scratch stub, never against
// the shared Pokesearch instance.

func requireStub(t *testing.T) {
	t.Helper()
	if stubURL == "" || stubTargetURL == "" {
		t.Skip("STUB_URL and STUB_TARGET_URL are unset: this item needs a target that can be made to " +
			"fail on command, and the shared Pokesearch instance must never be that target")
	}
	if err := ping(stubURL); err != nil {
		t.Fatalf("STUB_URL %s is not answering: %v", stubURL, err)
	}
}

func setStubMode(t *testing.T, mode string, extra string) {
	t.Helper()
	url := stubTargetURL + "/__mode?m=" + mode
	if extra != "" {
		url += "&" + extra
	}
	resp, err := hc.Get(url)
	if err != nil {
		t.Fatalf("stub mode %s: %v", mode, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	t.Logf("stub -> %s", strings.TrimSpace(string(body)))
}

// TestMetricsAccountingAgainstA503 is the regression test for the accounting
// bug that forced the Task 6 rewrite: a non-2xx response is a *response*. It
// contributes one dispatch, one sample in the histogram, one error, and one
// frustrated Apdex band — never two of anything, and never zero.
func TestMetricsAccountingAgainstA503(t *testing.T) {
	requireStub(t)
	setStubMode(t, "fail", "")
	t.Cleanup(func() { setStubMode(t, "ok", "") })

	id := startRun(t, stubURL, sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: searchSequence(t),
		Options:  sandbox.Options{Concurrency: 10, DurationSecs: 4},
	})
	rep := awaitRun(t, stubURL, id, 60*time.Second)

	if rep.Status != report.StatusCompleted {
		t.Fatalf("status = %q, want %q: a run against a failing target still completes", rep.Status, report.StatusCompleted)
	}
	p := rep.Performance
	if p == nil {
		t.Fatal("no performance payload")
	}
	o := p.Overall

	if o.Requests == 0 {
		t.Fatal("zero dispatches against the failing stub")
	}
	// The identity the bug broke.
	if o.Requests != o.OK+o.Errors+o.Aborted {
		t.Errorf("requests %d != ok %d + errors %d + aborted %d", o.Requests, o.OK, o.Errors, o.Aborted)
	}
	if o.Aborted != 0 {
		t.Errorf("aborted = %d; nobody cancelled this run", o.Aborted)
	}
	if o.OK != 0 {
		t.Errorf("ok = %d against a target answering only 503", o.OK)
	}
	if o.Errors != o.Requests {
		t.Errorf("errors %d != requests %d", o.Errors, o.Requests)
	}
	if got := o.StatusCounts[503]; got != o.Requests {
		t.Errorf("status_counts[503] = %d, want %d", got, o.Requests)
	}
	if got := o.ErrorKinds[report.KindNon2xx]; got != o.Requests {
		t.Errorf("error_kinds[non_2xx] = %d, want %d", got, o.Requests)
	}
	if got := o.ErrorKinds[report.KindConnection]; got != 0 {
		t.Errorf("error_kinds[connection] = %d; a 503 is a response, not a transport failure", got)
	}

	// 503 latencies are real latencies and belong in the distribution.
	var binned int
	for _, b := range o.Histogram {
		binned += b.Count
	}
	if binned != o.Requests {
		t.Errorf("histogram holds %d samples for %d requests: the 503 latencies were dropped", binned, o.Requests)
	}
	if o.Latency.P50 <= 0 || o.Latency.Max <= 0 {
		t.Errorf("no latency distribution for 503 responses: %+v", o.Latency)
	}

	// Apdex counts a failed response as frustrated no matter how fast it was.
	a := o.Apdex
	if a.Frustrated != o.Requests {
		t.Errorf("apdex frustrated = %d, want %d — a fast 503 is not a satisfied user", a.Frustrated, o.Requests)
	}
	if a.Satisfied != 0 || a.Tolerating != 0 {
		t.Errorf("apdex satisfied=%d tolerating=%d against an all-503 run", a.Satisfied, a.Tolerating)
	}
	if a.Score != 0 {
		t.Errorf("apdex score = %v, want 0", a.Score)
	}
	if o.SuccessRatio != 0 {
		t.Errorf("success_ratio = %v, want 0", o.SuccessRatio)
	}
	if p.Verdict != report.VerdictFail {
		t.Errorf("verdict = %q, want FAIL", p.Verdict)
	}
	t.Logf("%d dispatches, all 503: ok %d / errors %d / aborted %d, p50 %.1fms, apdex %.2f (%s), verdict %s %v",
		o.Requests, o.OK, o.Errors, o.Aborted, o.Latency.P50, a.Score, a.Rating, p.Verdict, p.VerdictReasons)
}

// TestFunctionalDeadlineAgainstAStallingTarget: a sequence that cannot finish
// must finalize at the wall-clock deadline with the remainder skipped, and it
// must give the lock back. Holding it would take the demo down for everyone
// until the process restarted.
//
// This one is slow by construction — the deadline is runner.FunctionalDeadline,
// two minutes — because a stalling target is exactly what it is for.
func TestFunctionalDeadlineAgainstAStallingTarget(t *testing.T) {
	requireStub(t)
	if testing.Short() {
		t.Skip("the functional deadline is 120s of wall clock by design")
	}
	// Longer than the executor's 10s per-request timeout, so every dispatch
	// burns its full timeout and the sequence cannot possibly finish.
	setStubMode(t, "stall", "stall_ms=20000")
	t.Cleanup(func() { setStubMode(t, "ok", "") })

	seq := make([]sandbox.Request, 0, sandbox.MaxSequence)
	for i := range sandbox.MaxSequence {
		seq = append(seq, sandbox.Request{
			ID:       fmt.Sprintf("stall-%02d", i),
			Name:     fmt.Sprintf("%02d - stalls forever", i),
			Endpoint: "search",
			Params:   map[string]string{"q": fmt.Sprintf("stall%d", i)},
		})
	}

	started := time.Now()
	id := startRun(t, stubURL, sandbox.RunRequest{
		Mode:     sandbox.ModeFunctional,
		Sequence: seq,
		Options:  sandbox.Options{StopOnFailure: false},
	})
	rep := awaitRun(t, stubURL, id, runner.FunctionalDeadline+60*time.Second)
	elapsed := time.Since(started)

	if rep.Status != report.StatusExpired {
		t.Errorf("status = %q, want %q (note: %s)", rep.Status, report.StatusExpired, rep.Note)
	}
	if rep.Functional == nil {
		t.Fatal("no functional payload")
	}
	var dispatched, skipped int
	for _, r := range rep.Functional.Results {
		if r.Skipped {
			skipped++
			continue
		}
		dispatched++
	}
	if len(rep.Functional.Results) != len(seq) {
		t.Errorf("%d results for %d requests: an expired run still accounts for every request",
			len(rep.Functional.Results), len(seq))
	}
	if skipped == 0 {
		t.Error("nothing was skipped; the deadline did not cut the sequence short")
	}
	if dispatched == 0 {
		t.Error("nothing was dispatched before the deadline")
	}
	if rep.Note == "" || !strings.Contains(rep.Note, "deadline") {
		t.Errorf("note = %q, want it to explain the deadline", rep.Note)
	}
	// The deadline is a wall-clock bound, not a suggestion. One in-flight
	// request is allowed to finish past it (the two-context design), which for
	// a stalling target is one 10s executor timeout.
	if elapsed > runner.FunctionalDeadline+30*time.Second {
		t.Errorf("the run took %s; the deadline is %s", elapsed.Round(time.Second), runner.FunctionalDeadline)
	}
	if st := status(t, stubURL); st.Running {
		t.Errorf("the lock is still held by %s after the deadline", st.RunID)
	}
	t.Logf("expired after %s: %d dispatched, %d skipped, note %q, lock released",
		elapsed.Round(time.Second), dispatched, skipped, rep.Note)
}
