package runner

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

func perfRun(seq []sandbox.Request, workers, secs int) sandbox.RunRequest {
	return sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: seq,
		Options:  sandbox.Options{Concurrency: workers, DurationSecs: secs},
	}
}

func oneRequest() []sandbox.Request {
	return []sandbox.Request{{ID: "1", Name: "a", Endpoint: "search"}}
}

func TestPerfScalesWithConcurrency(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(10 * time.Millisecond)
		fmt.Fprint(w, `{"total":1}`)
	}))
	defer srv.Close()

	run := func(workers int) int {
		return RunPerformance(context.Background(), NewExecutor(srv.URL),
			perfRun(oneRequest(), workers, 1), nil).Performance.Overall.Requests
	}
	one, ten := run(1), run(10)
	if ten < one*3 {
		t.Errorf("10 workers sent %d vs 1 worker %d; the pool is not fanning out", ten, one)
	}
}

func TestPerfStopsDispatchingAtDeadline(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		fmt.Fprint(w, "{}")
	}))
	defer srv.Close()

	start := time.Now()
	res := RunPerformance(context.Background(), NewExecutor(srv.URL), perfRun(oneRequest(), 4, 1), nil)
	elapsed := time.Since(start)
	p := res.Performance

	if elapsed > 1600*time.Millisecond {
		t.Errorf("run took %v; in-flight completion should overrun by about one request latency, not more", elapsed)
	}
	if p.Overall.Errors != 0 || p.Overall.Aborted != 0 {
		t.Errorf("in-flight requests were cancelled instead of completing: %+v", p.Overall)
	}
	if p.OverrunMs <= 0 {
		t.Errorf("OverrunMs = %d, want the honest overrun recorded", p.OverrunMs)
	}
	if res.Status != report.StatusCompleted {
		t.Errorf("status = %q; reaching the deadline is completion, not expiry", res.Status)
	}
}

func TestPerfEmitsProgressAboutEvery250ms(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "{}") }))
	defer srv.Close()

	rec := &recorder{}
	RunPerformance(context.Background(), NewExecutor(srv.URL), perfRun(oneRequest(), 2, 2), rec.emit)

	if n := rec.count(EventProgress); n < 6 || n > 12 {
		t.Errorf("emitted %d progress events in 2s, want ~8 (250ms cadence)", n)
	}
}

func TestPerfPerRequestBreakdown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("q") == "slow" {
			time.Sleep(80 * time.Millisecond)
		}
		fmt.Fprint(w, "{}")
	}))
	defer srv.Close()

	p := RunPerformance(context.Background(), NewExecutor(srv.URL), perfRun([]sandbox.Request{
		{ID: "1", Name: "fast", Endpoint: "search", Params: map[string]string{"q": "fast"}},
		{ID: "2", Name: "slow", Endpoint: "search", Params: map[string]string{"q": "slow"}},
	}, 4, 1), nil).Performance

	if len(p.PerRequest) != 2 {
		t.Fatalf("PerRequest = %d entries, want 2", len(p.PerRequest))
	}
	if p.PerRequest[0].Name != "fast" || p.PerRequest[1].Name != "slow" {
		t.Errorf("per-request entries must stay index-aligned with the sequence")
	}
	if p.PerRequest[0].Index != 0 || p.PerRequest[1].Index != 1 || p.Overall.Index != -1 {
		t.Errorf("scope indexes wrong: %d %d overall %d", p.PerRequest[0].Index, p.PerRequest[1].Index, p.Overall.Index)
	}
	if p.PerRequest[1].Latency.P50 <= p.PerRequest[0].Latency.P50 {
		t.Errorf("slow entry p50 %v should exceed fast entry p50 %v", p.PerRequest[1].Latency.P50, p.PerRequest[0].Latency.P50)
	}
	if sum := p.PerRequest[0].Requests + p.PerRequest[1].Requests; sum != p.Overall.Requests {
		t.Errorf("per-request totals %d != overall %d", sum, p.Overall.Requests)
	}
}

func TestPerfTargetDownProducesAnAllErrorReport(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	addr := srv.URL
	srv.Close()

	p := RunPerformance(context.Background(), NewExecutor(addr), perfRun(oneRequest(), 4, 1), nil).Performance

	if p.Overall.Requests == 0 || p.Overall.Errors != p.Overall.Requests {
		t.Errorf("target-down run = %+v, want every request counted as an error", p.Overall)
	}
	if p.Verdict != report.VerdictFail || p.Overall.StatusCounts[0] == 0 {
		t.Errorf("verdict %q, status 0 count %d — transport errors must land under status 0", p.Verdict, p.Overall.StatusCounts[0])
	}
	// Transport failures contribute no samples, so the distribution is empty.
	// An all-error report with a confident p95 would be a fabricated number.
	if p.Overall.Latency.P95 != 0 || p.Overall.Latency.Max != 0 {
		t.Errorf("transport failures must contribute no latency samples: %+v", p.Overall.Latency)
	}
	if p.Overall.SuccessRatio != 0 {
		t.Errorf("success ratio = %v, want 0", p.Overall.SuccessRatio)
	}
}

// A non-2xx is a completed response: one dispatch, one latency sample, one
// error, and never two of anything.
func TestPerfNon2xxIsCountedOnce(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":{"code":"es_unavailable"}}`, http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	p := RunPerformance(context.Background(), NewExecutor(srv.URL), perfRun(oneRequest(), 2, 1), nil).Performance
	o := p.Overall

	if o.Requests == 0 {
		t.Fatal("no dispatches")
	}
	if o.Errors != o.Requests || o.OK != 0 {
		t.Errorf("every 503 must count as exactly one error: %+v", o)
	}
	if o.StatusCounts[503] != o.Requests || o.StatusCounts[0] != 0 {
		t.Errorf("status counts = %v; a 503 is a response, not a transport failure", o.StatusCounts)
	}
	if o.ErrorKinds[report.KindNon2xx] != o.Requests {
		t.Errorf("error kinds = %v, want %d non_2xx", o.ErrorKinds, o.Requests)
	}
	if o.Latency.P95 <= 0 {
		t.Error("a non-2xx still contributes a latency sample")
	}
	if o.Apdex.Frustrated != o.Requests {
		t.Errorf("every non-2xx is frustrated regardless of latency: %+v", o.Apdex)
	}
}

// The test that matters: a visitor pressing Cancel must never look like a
// target failure.
func TestPerfCancellationReturnsPromptlyAndCountsAborts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		fmt.Fprint(w, "{}")
	}))
	defer srv.Close()

	ctx, abort := context.WithCancelCause(context.Background())
	go func() {
		time.Sleep(200 * time.Millisecond)
		abort(ErrRunAborted)
	}()

	start := time.Now()
	res := RunPerformance(ctx, NewExecutor(srv.URL), perfRun(oneRequest(), 20, 30), nil)
	elapsed := time.Since(start)

	if elapsed > time.Second {
		t.Errorf("cancel took %v to unwind, want < 1s", elapsed)
	}
	if res.Status != report.StatusCancelled {
		t.Errorf("status = %q, want cancelled", res.Status)
	}
	o := res.Performance.Overall
	if o.Errors != 0 {
		t.Errorf("cancelling manufactured %d errors: %+v", o.Errors, o)
	}
	if o.Aborted != o.Requests || o.Requests == 0 {
		t.Errorf("every abandoned dispatch must be counted as aborted: %+v", o)
	}
	if len(o.StatusCounts) != 0 {
		t.Errorf("an abort has no status: %v", o.StatusCounts)
	}
	if res.Performance.Verdict != report.VerdictNA {
		t.Errorf("verdict = %q, want N/A for partial data", res.Performance.Verdict)
	}
}

func TestPerfNoGoroutineLeak(t *testing.T) {
	runtime.GC()
	before := runtime.NumGoroutine()

	func() {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "{}") }))
		defer srv.Close()
		ex := NewExecutor(srv.URL)
		RunPerformance(context.Background(), ex, perfRun(oneRequest(), 8, 1), nil)
		// Pooled keep-alive connections each hold a transport goroutine pair.
		// They are the pool doing its job, not the engine leaking, so release
		// them before counting.
		ex.CloseIdleConnections()
	}()

	// Goroutines unwind asynchronously; poll rather than guess a sleep.
	deadline := time.Now().Add(3 * time.Second)
	after := runtime.NumGoroutine()
	for time.Now().Before(deadline) {
		runtime.GC()
		if after = runtime.NumGoroutine(); after <= before+2 {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Errorf("goroutines %d → %d; the pool or aggregator leaked", before, after)
}

// Workers start at their own sequence offset, so a sequence shorter than the
// worker count is still exercised evenly rather than all workers hammering
// entry zero in lockstep.
func TestPerfSpreadsAcrossAShortSequence(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "{}") }))
	defer srv.Close()

	seq := []sandbox.Request{
		{ID: "1", Name: "a", Endpoint: "search", Params: map[string]string{"q": "a"}},
		{ID: "2", Name: "b", Endpoint: "search", Params: map[string]string{"q": "b"}},
		{ID: "3", Name: "c", Endpoint: "search", Params: map[string]string{"q": "c"}},
	}
	p := RunPerformance(context.Background(), NewExecutor(srv.URL), perfRun(seq, 6, 1), nil).Performance
	for i, s := range p.PerRequest {
		if s.Requests == 0 {
			t.Errorf("entry %d received no load", i)
		}
	}
}
