package runner

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"slices"
	"strings"
	"sync"
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
	if p.Overall.StatusCounts[0] == 0 {
		t.Errorf("status 0 count %d: transport errors must land under status 0", p.Overall.StatusCounts[0])
	}
	// The sequence here is one synthetic request rather than the calibrated
	// collection, so the run itself gets no verdict. What the gate would say
	// about these numbers is still the thing worth asserting: an all-error
	// run fails it.
	if p.Verdict != report.VerdictNA {
		t.Errorf("verdict %q, want %q: a one-request sequence is not the calibrated workload", p.Verdict, report.VerdictNA)
	}
	if v, _ := report.Verdict(p.Overall, true); v != report.VerdictFail {
		t.Errorf("gate verdict on an all-error run = %q, want %q", v, report.VerdictFail)
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

// Perf mode draws a fresh word for every dispatch — that is the honest version
// of random load, and a single word repeated 18,000 times would measure the
// target's cache instead of its search. Hundreds of dispatches against a
// 76-entry pool make "at least two distinct queries" a safe assertion rather
// than a coin flip. Under -race this is also what substantiates the template
// package's claim that its generator is safe to draw from concurrently.
func TestPerfExpandsTemplatePerDispatch(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen[r.URL.RawQuery] = true
		mu.Unlock()
		fmt.Fprint(w, "{}")
	}))
	defer srv.Close()

	seq := []sandbox.Request{
		{ID: "1", Name: "tpl", Endpoint: "search", Params: map[string]string{"q": "{{randomWord}}"}},
	}
	RunPerformance(context.Background(), NewExecutor(srv.URL), perfRun(seq, 8, 1), nil)

	mu.Lock()
	defer mu.Unlock()
	if len(seen) < 2 {
		t.Errorf("expected multiple distinct expanded queries, got %d: %v", len(seen), seen)
	}
	for q := range seen {
		if strings.Contains(q, "%7B%7B") {
			t.Errorf("target received an unexpanded template: %q", q)
		}
	}
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

func TestPerfRunStartedIsStampedInUTC(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	var mu sync.Mutex
	var started *RunStarted
	RunPerformance(context.Background(), NewExecutor(srv.URL), perfRun(oneRequest(), 1, 1), func(e Event) {
		if d, ok := e.Data.(RunStarted); ok {
			mu.Lock()
			started = &d
			mu.Unlock()
		}
	})
	mu.Lock()
	defer mu.Unlock()
	if started == nil {
		t.Fatal("no run_started")
	}
	if started.StartedAt.Location() != time.UTC {
		t.Errorf("run_started started_at = %v, want UTC", started.StartedAt)
	}
}

// A dead target used to be dialled in a tight loop: 50 workers for 5s made
// 520,142 failed dials. Paced, it costs a handful per worker per second, and
// the run still lasts its full duration and completes, so its accounting holds.
func TestPerfDeadTargetIsPacedNotHammered(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	addr := srv.URL
	srv.Close()

	const secs = 2
	start := time.Now()
	res := RunPerformance(context.Background(), NewExecutor(addr), perfRun(oneRequest(), 5, secs), nil)
	wall := time.Since(start)
	o := res.Performance.Overall

	if res.Status != report.StatusCompleted {
		t.Errorf("status = %q, want %q: a dead target is measured for the whole duration", res.Status, report.StatusCompleted)
	}
	if o.Requests != o.OK+o.Errors+o.Aborted {
		t.Errorf("requests %d != ok %d + errors %d + aborted %d", o.Requests, o.OK, o.Errors, o.Aborted)
	}
	if o.ErrorKinds[report.KindConnection] != o.Requests || o.Aborted != 0 {
		t.Errorf("error kinds %v, aborted %d; want every one of %d dispatches a connection error", o.ErrorKinds, o.Aborted, o.Requests)
	}
	if o.Requests == 0 || o.Requests > 100 {
		t.Errorf("requests = %d, want between 1 and 100 for 5 workers over %ds against a refused port", o.Requests, secs)
	}
	if wall < secs*time.Second || wall > secs*time.Second+2*time.Second {
		t.Errorf("wall clock %s, want the full %ds and not much more", wall, secs)
	}
	if res.Performance.OverrunMs > 1000 {
		t.Errorf("overrun = %dms; a paced worker must wake at the deadline, not after its wait", res.Performance.OverrunMs)
	}
}

// refuseFirst closes the first n connections it accepts, the way a target
// that is coming back up refuses dials, and then serves normally.
type refuseFirst struct {
	net.Listener
	mu sync.Mutex
	n  int
}

func (l *refuseFirst) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		l.mu.Lock()
		refuse := l.n > 0
		if refuse {
			l.n--
		}
		l.mu.Unlock()
		if !refuse {
			return c, nil
		}
		c.Close()
	}
}

// Once the target answers, the next dispatch goes out without waiting: the
// backoff is for a target that is down, not one that was.
func TestPerfBackoffResetsWhenTheTargetRecovers(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"total":1}`)
	}))
	srv.Listener = &refuseFirst{Listener: srv.Listener, n: 5}
	srv.Start()
	defer srv.Close()

	o := RunPerformance(context.Background(), NewExecutor(srv.URL), perfRun(oneRequest(), 1, 2), nil).Performance.Overall
	if o.ErrorKinds[report.KindConnection] == 0 {
		t.Fatalf("no connection errors recorded (%v); the target never refused", o.ErrorKinds)
	}
	// Paced at the 250ms cap the whole way, one worker manages under ten
	// dispatches in 2s. A reset backoff runs at the target's own speed.
	if o.OK < 100 {
		t.Errorf("ok = %d after the target recovered, want the worker back at full speed (at least 100)", o.OK)
	}
}

func TestBackoffSchedule(t *testing.T) {
	refused := Response{Err: errors.New("dial: connection refused"), ErrKind: ErrKindConnection}
	var wait time.Duration
	var got []time.Duration
	for range 8 {
		wait = nextBackoff(wait, refused)
		got = append(got, wait)
	}
	ms := time.Millisecond
	want := []time.Duration{10 * ms, 20 * ms, 40 * ms, 80 * ms, 160 * ms, 250 * ms, 250 * ms, 250 * ms}
	if !slices.Equal(got, want) {
		t.Fatalf("backoff after 1..8 refusals = %v, want %v", got, want)
	}

	for name, r := range map[string]Response{
		"2xx":                          {Status: 200},
		"non-2xx":                      {Status: 503},
		"a response whose body failed": {Status: 200, Err: errors.New("unexpected EOF"), ErrKind: ErrKindConnection},
		"timeout":                      {Err: errors.New("deadline"), ErrKind: ErrKindTimeout},
		"aborted by the run":           {Err: errors.New("canceled"), ErrKind: ErrKindAborted},
	} {
		if got := nextBackoff(250*time.Millisecond, r); got != 0 {
			t.Errorf("%s: backoff = %v, want 0", name, got)
		}
	}
}

// The wait honours the deadline and Cancel at once: a worker parked in it must
// not hold the run open for the rest of its wait.
func TestBackoffWaitReturnsWhenTheRunStops(t *testing.T) {
	never := func(time.Duration) (<-chan time.Time, func() bool) { return nil, func() bool { return true } }

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan bool, 1)
	go func() { done <- pause(ctx, time.Hour, never) }()
	cancel()
	select {
	case full := <-done:
		if full {
			t.Error("pause reported a full wait after the run stopped")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("pause did not return when its context was cancelled")
	}

	fired := func(time.Duration) (<-chan time.Time, func() bool) {
		ch := make(chan time.Time, 1)
		ch <- time.Time{}
		return ch, func() bool { return false }
	}
	if !pause(context.Background(), time.Hour, fired) {
		t.Error("pause reported a stop when its timer fired")
	}
}

// A run keeps at most report.MaxSamples latencies overall and a proportional
// share per entry, so its memory is bounded whatever the target's speed.
func TestAggregatorBoundsTheSamplesARunKeeps(t *testing.T) {
	const entries, n = 3, 300_000
	results := make(chan dispatch, 1024)
	done := make(chan []report.Tally)
	go aggregate(results, done, entries, time.Now(), noopEmitter)
	for i := range n {
		results <- dispatch{index: i % entries, resp: Response{Status: 200, LatencyMs: float64(i%1000) + 1, Size: 10}}
	}
	close(results)
	all := <-done

	if got := len(all[0].Samples); got != report.MaxSamples {
		t.Errorf("overall kept %d samples, want %d", got, report.MaxSamples)
	}
	perEntry := (report.MaxSamples + entries - 1) / entries
	for i := 1; i <= entries; i++ {
		if got := len(all[i].Samples); got != perEntry {
			t.Errorf("entry %d kept %d samples, want %d", i-1, got, perEntry)
		}
		if all[i].Requests != n/entries {
			t.Errorf("entry %d counted %d requests, want %d", i-1, all[i].Requests, n/entries)
		}
	}
	if all[0].Requests != n {
		t.Errorf("overall counted %d requests, want %d", all[0].Requests, n)
	}
}

// A load run counts the redirect as the answer it is and never loads the
// server it points at.
func TestPerfRecordsRedirectsWithoutFollowingThem(t *testing.T) {
	rd := newRedirecting(t, http.StatusFound, redirectLocations["another server"])
	o := RunPerformance(context.Background(), NewExecutor(rd.target.URL), perfRun(oneRequest(), 2, 1), nil).Performance.Overall
	if o.Requests == 0 || o.StatusCounts[http.StatusFound] != o.Requests {
		t.Errorf("status counts %v over %d requests, want every one a 302", o.StatusCounts, o.Requests)
	}
	if o.Requests != o.OK+o.Errors+o.Aborted {
		t.Errorf("requests %d != ok %d + errors %d + aborted %d", o.Requests, o.OK, o.Errors, o.Aborted)
	}
	if n := rd.away.Load(); n != 0 {
		t.Errorf("the second server was asked %d times, want never", n)
	}
}
