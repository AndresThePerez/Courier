package api

import (
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The sandbox posture in one test: nothing on the public interface hands out a
// heap dump, the process command line, or a handler that will pin a core for
// thirty seconds because an anonymous visitor asked it to.
func TestPprofIsNotReachableFromThePublicMux(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)

	for _, path := range []string{
		"/debug/pprof/",
		"/debug/pprof/heap",
		"/debug/pprof/goroutine",
		"/debug/pprof/cmdline",
		"/debug/pprof/profile?seconds=1",
		"/debug/pprof/trace",
		"/debug/pprof/symbol",
		"/debug/vars",
	} {
		rec := do(t, s, http.MethodGet, path, nil)
		if rec.Code == http.StatusOK {
			t.Errorf("%s answered 200 on the public mux", path)
		}
		if body := rec.Body.String(); strings.Contains(body, "Types of profiles available") {
			t.Errorf("%s served the pprof index from the public mux", path)
		}
	}
}

func TestPprofRefusesToBindOffTheBox(t *testing.T) {
	for _, addr := range []string{
		"0.0.0.0:0",     // every interface, the mistake this guard exists for
		":0",            // the same mistake, in the shape a copied snippet has
		"10.0.0.55:0",   // a real LAN address
		"example.com:0", // a name that is not localhost
		"garbage",       // not host:port at all
	} {
		p, err := StartPprof(addr, nil)
		if err == nil {
			p.Close()
			t.Errorf("StartPprof(%q) bound successfully; profiling must be loopback only", addr)
		}
	}
}

func TestPprofServesProfilesOnLoopback(t *testing.T) {
	p, err := StartPprof("127.0.0.1:0", nil)
	if err != nil {
		t.Fatalf("StartPprof: %v", err)
	}
	defer p.Close()

	host, _, err := net.SplitHostPort(p.Addr())
	if err != nil {
		t.Fatalf("split %q: %v", p.Addr(), err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		t.Fatalf("pprof bound to %s, want a loopback address", p.Addr())
	}

	client := &http.Client{Timeout: 10 * time.Second}
	for path, want := range map[string]string{
		"/debug/pprof/":             "Types of profiles available",
		"/debug/pprof/heap?debug=1": "heap profile",
	} {
		resp, err := client.Get("http://" + p.Addr() + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, resp.StatusCode)
		}
		if !strings.Contains(string(body), want) {
			t.Errorf("GET %s did not look like a profile response", path)
		}
	}

	// "localhost" is the other spelling a deploy is likely to use.
	q, err := StartPprof("localhost:0", nil)
	if err != nil {
		t.Fatalf(`StartPprof("localhost:0"): %v`, err)
	}
	q.Close()
}

// Addendum Task 31's counter list, end to end. A run that is started and then
// cancelled must show up as started, cancelled, and aborted — the three numbers
// that describe how the load budget is actually being spent.
func TestMetricsCountsTheRunLifecycle(t *testing.T) {
	s := newServer(t, newTarget(t, 300*time.Millisecond), nil)

	before := readMetrics(t, s)
	for _, key := range []string{"runs_started", "runs_cancelled", "runs_aborted", "sends_completed", "sends_refused"} {
		if got := num(t, before, key); got != 0 {
			t.Errorf("a fresh server reports %s = %v, want 0", key, got)
		}
	}
	if num(t, before, "budget_balance") <= 0 {
		t.Errorf("budget_balance = %v, want a full bucket on a fresh server", before["budget_balance"])
	}
	if num(t, before, "goroutines") <= 0 {
		t.Error("goroutines = 0; the gauge is not reading the runtime")
	}
	if before["run_in_progress"] != false {
		t.Errorf("run_in_progress = %v on a fresh server", before["run_in_progress"])
	}

	id := startRun(t, s, payload(5, 0))
	waitFor(t, "the run to be live", func() bool { return s.mgr.Status().Running })

	during := readMetrics(t, s)
	if during["run_in_progress"] != true || num(t, during, "runs_started") != 1 {
		t.Errorf("during a run: %v, want run_in_progress with runs_started 1", during)
	}

	if rec := do(t, s, http.MethodDelete, "/api/runs/"+id, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d, want 204", rec.Code)
	}
	waitIdle(t, s)

	after := readMetrics(t, s)
	if got := num(t, after, "runs_started"); got != 1 {
		t.Errorf("runs_started = %v, want 1", got)
	}
	if got := num(t, after, "runs_cancelled"); got != 1 {
		t.Errorf("runs_cancelled = %v, want 1", got)
	}
	// A cancelled run did not complete. Counting this in the cancel handler
	// would miss an expired run and a run stopped by shutdown.
	if got := num(t, after, "runs_aborted"); got != 1 {
		t.Errorf("runs_aborted = %v, want 1", got)
	}
	if after["run_in_progress"] != false {
		t.Error("run_in_progress is still true after the run finished")
	}
	if num(t, after, "uptime_secs") < 0 {
		t.Errorf("uptime_secs = %v", after["uptime_secs"])
	}
}

func TestMetricsCountsSendsAndRefusals(t *testing.T) {
	s := newServer(t, newTarget(t, 750*time.Millisecond), nil)

	done := make(chan struct{})
	go func() {
		do(t, s, http.MethodPost, "/api/send", sendable())
		close(done)
	}()
	waitFor(t, "the first send to be in flight", func() bool { return s.sending.Load() })
	if rec := do(t, s, http.MethodPost, "/api/send", sendable()); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second send = %d, want 429", rec.Code)
	}
	<-done

	got := readMetrics(t, s)
	if n := num(t, got, "sends_completed"); n != 1 {
		t.Errorf("sends_completed = %v, want 1", n)
	}
	if n := num(t, got, "sends_refused"); n != 1 {
		t.Errorf("sends_refused = %v, want 1 — a rate limit nobody counts is a rate limit nobody can tune", n)
	}
}

func TestMetricsReportsLiveSubscribers(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	_, cancel, err := s.bus.Subscribe()
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if n := num(t, readMetrics(t, s), "sse_subscribers"); n != 1 {
		t.Errorf("sse_subscribers = %v, want 1", n)
	}
	cancel()
	if n := num(t, readMetrics(t, s), "sse_subscribers"); n != 0 {
		t.Errorf("sse_subscribers = %v after the viewer left, want 0", n)
	}
}

// The metrics endpoint is public on purpose — it is part of the demo — so it
// must expose counters and nothing else. expvar's default handler also renders
// cmdline and memstats; this one must not, because os.Args on a public URL is a
// disclosure, not a feature.
func TestMetricsExposesCountersOnly(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	rec := do(t, s, http.MethodGet, "/metrics", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	for _, forbidden := range []string{"cmdline", "memstats"} {
		if strings.Contains(rec.Body.String(), forbidden) {
			t.Errorf("/metrics exposes %q; that is expvar's default handler, not ours", forbidden)
		}
	}
	body := decode[map[string]any](t, rec)
	want := []string{
		"runs_started", "runs_cancelled", "runs_aborted",
		"budget_balance", "sse_subscribers", "goroutines", "uptime_secs",
	}
	for _, key := range want {
		if _, ok := body[key]; !ok {
			t.Errorf("/metrics is missing %q", key)
		}
	}
}

func readMetrics(t *testing.T, s *Server) map[string]any {
	t.Helper()
	rec := do(t, s, http.MethodGet, "/metrics", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /metrics = %d %s, want 200", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	return decode[map[string]any](t, rec)
}

func num(t *testing.T, m map[string]any, key string) float64 {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("/metrics has no %q: %v", key, m)
	}
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("/metrics %q = %v (%T), want a number", key, v, v)
	}
	return f
}
