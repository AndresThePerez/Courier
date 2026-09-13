package api

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sandbox"
	"github.com/AndresThePerez/courier/internal/sse"
)

// clock is real time plus an offset the test controls. Runs still take the
// wall-clock they really take — which is what the budget charges — but the
// 5s cooldown floor between them can be stepped over instead of slept through.
type clock struct {
	mu     sync.Mutex
	offset time.Duration
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Add(c.offset)
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.offset += d
}

// newTarget stands in for PokéSearch. delay is per request, so a test can make
// a run last long enough to catch it mid-flight.
func newTarget(t *testing.T, delay time.Duration) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/healthz":
			_, _ = io.WriteString(w, `{"status":"ok","docs":20324}`)
		case "/api/suggest":
			_, _ = io.WriteString(w, `{"suggestions":["Alakazam"]}`)
		default:
			_, _ = io.WriteString(w, `{"total":107,"page":1,"pages":5,"took_ms":9,"results":[{"name":"Charizard"}]}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func newServer(t *testing.T, targetURL string, c *clock) *Server {
	t.Helper()
	var now func() time.Time
	if c != nil {
		now = c.now
	}
	s := New(testStatic(), Options{TargetURL: targetURL, TargetDisplay: "test-target", Now: now})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := s.Close(ctx); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	return s
}

// payload builds a functional run of n identical search requests.
func payload(n, delayMs int) sandbox.RunRequest {
	rr := sandbox.RunRequest{Mode: sandbox.ModeFunctional, Options: sandbox.Options{DelayMs: delayMs}}
	for i := range n {
		rr.Sequence = append(rr.Sequence, sandbox.Request{
			ID:       "r" + string(rune('a'+i)),
			Name:     "search",
			Endpoint: "search",
			Params:   map[string]string{"q": "charizard"},
			Assertions: []assert.Assertion{
				{Type: assert.TypeStatus, Op: "eq", Value: 200},
			},
		})
	}
	return rr
}

func do(t *testing.T, s *Server, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	switch b := body.(type) {
	case nil:
		r = httptest.NewRequest(method, path, nil)
	case string:
		r = httptest.NewRequest(method, path, strings.NewReader(b))
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			t.Fatalf("marshal payload: %v", err)
		}
		r = httptest.NewRequest(method, path, strings.NewReader(string(raw)))
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, r)
	return rec
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return v
}

func startRun(t *testing.T, s *Server, rr sandbox.RunRequest) string {
	t.Helper()
	rec := do(t, s, http.MethodPost, "/api/runs", rr)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("POST /api/runs = %d %s, want 202", rec.Code, rec.Body.String())
	}
	id := decode[map[string]string](t, rec)["run_id"]
	if !strings.HasPrefix(id, "run-") {
		t.Fatalf("run_id = %q, want a run-... id", id)
	}
	return id
}

// waitFor polls until cond holds, so a test never sleeps a fixed guess.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func waitIdle(t *testing.T, s *Server) {
	t.Helper()
	waitFor(t, "the run to finish", func() bool { return !s.mgr.Status().Running })
}

func TestPostRunsValidatesAndAccepts(t *testing.T) {
	t.Run("accepts a valid payload", func(t *testing.T) {
		s := newServer(t, newTarget(t, 0), nil)
		id := startRun(t, s, payload(2, 0))
		waitIdle(t, s)
		if _, ok := s.mgr.Report(id); !ok {
			t.Errorf("run %s was accepted but never stored", id)
		}
	})

	t.Run("rejects an unknown parameter", func(t *testing.T) {
		s := newServer(t, newTarget(t, 0), nil)
		rr := payload(1, 0)
		// "highlight" is not on the search allowlist today. If it is ever
		// added, catalog.go is the one place that changes and this test names
		// a different key — the allowlist stays a single source of truth.
		rr.Sequence[0].Params = map[string]string{"highlight": "1"}
		rec := do(t, s, http.MethodPost, "/api/runs", rr)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		body := decode[errorBody](t, rec)
		if !strings.Contains(body.Error, "highlight") {
			t.Errorf("error = %q, want it to name the offending parameter", body.Error)
		}
		if s.mgr.Status().Running {
			t.Error("a rejected payload took the run lock")
		}
	})

	t.Run("rejects an oversized body", func(t *testing.T) {
		s := newServer(t, newTarget(t, 0), nil)
		huge := `{"mode":"functional","sequence":[{"endpoint":"search","params":{"q":"` +
			strings.Repeat("a", MaxBodyBytes+1024) + `"}}]}`
		rec := do(t, s, http.MethodPost, "/api/runs", huge)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}

func TestPostRunsConflictWhileRunning(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	id := startRun(t, s, payload(4, 1000)) // ~3s of walking

	rec := do(t, s, http.MethodPost, "/api/runs", payload(1, 0))
	if rec.Code != http.StatusConflict {
		t.Fatalf("second POST = %d %s, want 409", rec.Code, rec.Body.String())
	}
	body := decode[conflictBody](t, rec)
	if body.RunID != id {
		t.Errorf("run_id = %q, want the live run %q — the UI offers spectator mode from it", body.RunID, id)
	}
	if body.CooldownUntil != nil {
		t.Error("a busy conflict must not carry cooldown_until; the UI branches on which field is present")
	}
}

func TestPostRunsConflictWhileCoolingDown(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	startRun(t, s, payload(1, 0))
	waitIdle(t, s)

	rec := do(t, s, http.MethodPost, "/api/runs", payload(1, 0))
	if rec.Code != http.StatusConflict {
		t.Fatalf("POST during cooldown = %d %s, want 409", rec.Code, rec.Body.String())
	}
	body := decode[conflictBody](t, rec)
	if body.RunID != "" {
		t.Errorf("run_id = %q, want empty: nothing is running to spectate", body.RunID)
	}
	if body.CooldownUntil == nil || !body.CooldownUntil.After(time.Now()) {
		t.Fatalf("cooldown_until = %v, want a future timestamp to count down to", body.CooldownUntil)
	}
}

func TestDeleteRunCancels(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	id := startRun(t, s, payload(5, 1000))

	// Cancel once at least one result is in, so the partial report is real.
	waitFor(t, "the first result", func() bool {
		rep, ok := s.mgr.Report(id)
		return ok && rep.Functional != nil && len(rep.Functional.Results) > 0
	})

	rec := do(t, s, http.MethodDelete, "/api/runs/"+id, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d %s, want 204", rec.Code, rec.Body.String())
	}
	waitIdle(t, s)

	st := decode[runner.Status](t, do(t, s, http.MethodGet, "/api/status", nil))
	if st.Running {
		t.Error("/api/status still reports a live run after the cancel")
	}

	rep := decode[report.Report](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
	if rep.Status != report.StatusCancelled {
		t.Errorf("report status = %q, want %q", rep.Status, report.StatusCancelled)
	}
	if rep.Functional == nil || len(rep.Functional.Results) == 0 {
		t.Fatal("a cancelled run must keep the partial results it did produce")
	}
	// The remainder is recorded as skipped rather than dropped, so the results
	// table still describes the whole sequence.
	executed := 0
	for _, res := range rep.Functional.Results {
		if !res.Skipped {
			executed++
		}
	}
	switch {
	case executed == 0:
		t.Error("no request completed; the partial report has nothing in it")
	case executed == 5:
		t.Error("every request ran; the cancel did not actually stop anything")
	}
}

func TestDeleteNonLiveRunIs404(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	id := startRun(t, s, payload(1, 0))
	waitIdle(t, s)

	for _, target := range []string{id, "run-nope"} {
		rec := do(t, s, http.MethodDelete, "/api/runs/"+target, nil)
		if rec.Code != http.StatusNotFound {
			t.Errorf("DELETE /api/runs/%s = %d, want 404 (a finished run is not cancellable)", target, rec.Code)
		}
	}
}

// The polling fallback's contract: a mid-run GET is valid, coherent, and
// body-free.
func TestGetRunWhileRunningReturnsPartialReport(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	id := startRun(t, s, payload(5, 500))

	waitFor(t, "a partial report", func() bool {
		rep, ok := s.mgr.Report(id)
		return ok && rep.Functional != nil && len(rep.Functional.Results) > 0
	})

	rec := do(t, s, http.MethodGet, "/api/runs/"+id, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET = %d, want 200", rec.Code)
	}
	rep := decode[report.Report](t, rec)
	if rep.Status != report.StatusRunning {
		t.Errorf("status = %q, want %q", rep.Status, report.StatusRunning)
	}
	if rep.ID != id || rep.Mode != sandbox.ModeFunctional {
		t.Errorf("report identity = %q/%q, want %q/functional", rep.ID, rep.Mode, id)
	}
	if len(rep.Entries) != 5 {
		t.Errorf("entries = %d, want 5 — the UI draws the whole sequence before results land", len(rep.Entries))
	}
	if n := len(rep.Functional.Results); n == 0 || n == 5 {
		t.Errorf("results = %d, want a partial count (the run should still be walking)", n)
	}
	for _, res := range rep.Functional.Results {
		if res.BodyPreview != "" {
			t.Error("a partial report must not carry body previews; polled twice a second that is megabits through the tunnel")
		}
	}
}

func TestGetRunNotFound(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	if rec := do(t, s, http.MethodGet, "/api/runs/nope", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestGetReportPDF(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	id := startRun(t, s, payload(3, 0))
	waitIdle(t, s)

	rec := do(t, s, http.MethodGet, "/api/runs/"+id+"/report.pdf", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET report.pdf = %d %s, want 200", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/pdf" {
		t.Errorf("Content-Type = %q, want application/pdf", ct)
	}
	want := `attachment; filename="courier-` + id + `.pdf"`
	if cd := rec.Header().Get("Content-Disposition"); cd != want {
		t.Errorf("Content-Disposition = %q, want %q", cd, want)
	}
	body := rec.Body.Bytes()
	if len(body) < 2000 || string(body[:5]) != "%PDF-" {
		t.Fatalf("body is %d bytes starting %q, want a PDF document", len(body), body[:min(len(body), 8)])
	}
	if cl := rec.Header().Get("Content-Length"); cl != strconv.Itoa(len(body)) {
		t.Errorf("Content-Length = %q, want %d", cl, len(body))
	}
}

// The download 404s on exactly what GET /api/runs/{id} 404s on: an id the
// manager has never heard of.
func TestGetReportPDFNotFound(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	if rec := do(t, s, http.MethodGet, "/api/runs/nope/report.pdf", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestStatusEndpoint(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)

	before := decode[runner.Status](t, do(t, s, http.MethodGet, "/api/status", nil))
	if before.Running {
		t.Fatal("a fresh server reports a live run")
	}
	if before.CooldownUntil != nil {
		t.Error("a fresh server reports a cooldown nobody earned")
	}

	id := startRun(t, s, payload(4, 500))
	during := decode[runner.Status](t, do(t, s, http.MethodGet, "/api/status", nil))
	if !during.Running || during.RunID != id || during.Mode != sandbox.ModeFunctional {
		t.Errorf("during = %+v, want running %s in functional mode", during, id)
	}
	if during.StartedAt == nil {
		t.Error("a live run must report started_at")
	}

	do(t, s, http.MethodDelete, "/api/runs/"+id, nil)
	waitIdle(t, s)

	after := decode[runner.Status](t, do(t, s, http.MethodGet, "/api/status", nil))
	if after.Running {
		t.Error("still running after the run finished")
	}
	if after.CooldownUntil == nil {
		t.Error("after a run, status must carry the cooldown to count down to")
	}
}

func TestHistoryEndpointNewestFirst(t *testing.T) {
	c := &clock{}
	s := newServer(t, newTarget(t, 0), c)

	var ids []string
	for range 3 {
		ids = append(ids, startRun(t, s, payload(1, 0)))
		waitIdle(t, s)
		// Step over the cooldown floor rather than sleeping through it.
		c.advance(10 * time.Second)
	}

	rec := do(t, s, http.MethodGet, "/api/runs", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	got := decode[struct {
		Runs []historyEntry `json:"runs"`
	}](t, rec).Runs
	if len(got) != 3 {
		t.Fatalf("history has %d runs, want 3", len(got))
	}
	for i, want := range []string{ids[2], ids[1], ids[0]} {
		if got[i].ID != want {
			t.Errorf("history[%d] = %s, want %s (newest first)", i, got[i].ID, want)
		}
	}
	for _, entry := range got {
		if entry.Summary == "" {
			t.Errorf("%s has no summary; the history rail has nothing to label it with", entry.ID)
		}
		if entry.Status != report.StatusCompleted {
			t.Errorf("%s status = %q, want completed", entry.ID, entry.Status)
		}
	}
}

// ---- SSE ----------------------------------------------------------------

type frame struct {
	name string
	data map[string]any
}

// readFrames parses the SSE wire format until stop says so or the stream ends.
// Comment lines (the heartbeat) are counted, not returned.
func readFrames(t *testing.T, body io.Reader, stop func(frame) bool) ([]frame, int) {
	t.Helper()
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)

	var out []frame
	var pings int
	cur := frame{}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, ":"):
			pings++
		case strings.HasPrefix(line, "event: "):
			cur.name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &cur.data); err != nil {
				t.Errorf("event %q has undecodable data: %v", cur.name, err)
			}
		case line == "":
			if cur.name != "" {
				out = append(out, cur)
				if stop(cur) {
					return out, pings
				}
				cur = frame{}
			}
		}
	}
	return out, pings
}

// openStream connects to the SSE endpoint and reads until stop or timeout.
func openStream(t *testing.T, base, id string, stop func(frame) bool) ([]frame, *http.Response) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/runs/"+id+"/stream", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatalf("open stream: %v", err)
	}
	t.Cleanup(func() {
		resp.Body.Close()
		cancel()
	})

	type result struct {
		frames []frame
	}
	done := make(chan result, 1)
	go func() {
		f, _ := readFrames(t, resp.Body, stop)
		done <- result{f}
	}()
	select {
	case r := <-done:
		// The reader is done, so the client hangs up. The handler holds the
		// stream open after run_finished — a browser keeps watching for the
		// next run rather than reconnecting into one — so nothing else will
		// release it, and httptest.Server.Close waits on live requests.
		resp.Body.Close()
		cancel()
		return r.frames, resp
	case <-time.After(20 * time.Second):
		t.Fatal("timed out reading the stream")
		return nil, nil
	}
}

func TestStreamEmitsFunctionalResultsInOrder(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	srv := httptest.NewServer(s)
	defer srv.Close()

	id := startRun(t, s, payload(3, 100))
	frames, _ := openStream(t, srv.URL, id, func(f frame) bool {
		return f.name == runner.EventRunFinished
	})

	if len(frames) < 5 {
		t.Fatalf("got %d events, want run_started + 3 results + run_finished: %+v", len(frames), frames)
	}
	if frames[0].name != runner.EventRunStarted {
		t.Errorf("first event = %q, want %q", frames[0].name, runner.EventRunStarted)
	}
	if last := frames[len(frames)-1]; last.name != runner.EventRunFinished {
		t.Errorf("last event = %q, want %q", last.name, runner.EventRunFinished)
	}

	var indexes []float64
	for _, f := range frames {
		if f.name != runner.EventRequestResult {
			continue
		}
		data, _ := f.data["data"].(map[string]any)
		idx, _ := data["index"].(float64)
		indexes = append(indexes, idx)
	}
	if len(indexes) != 3 {
		t.Fatalf("got %d request_result events, want one per sequence entry", len(indexes))
	}
	for i, idx := range indexes {
		if int(idx) != i {
			t.Errorf("result %d carries index %v; functional mode is ordered by definition", i, idx)
		}
	}
	for _, f := range frames {
		if f.data["run_id"] != id {
			t.Errorf("event %q carries run_id %v, want %s", f.name, f.data["run_id"], id)
		}
	}
}

func TestStreamSetsSSEHeaders(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	srv := httptest.NewServer(s)
	defer srv.Close()

	id := startRun(t, s, payload(1, 0))
	_, resp := openStream(t, srv.URL, id, func(f frame) bool { return f.name == runner.EventRunFinished })

	for header, want := range map[string]string{
		"Content-Type":      "text/event-stream",
		"Cache-Control":     "no-cache",
		"X-Accel-Buffering": "no",
	} {
		if got := resp.Header.Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	// Compression buffers, and buffering is indistinguishable from a dead
	// stream. Nothing may gzip this route.
	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q, want none", got)
	}
	if resp.Uncompressed {
		t.Error("the response was transparently decompressed; something gzipped the stream")
	}
}

func TestStreamMidRunReconnectReplays(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	srv := httptest.NewServer(s)
	defer srv.Close()

	// Slow enough that two results are in the log well before the third.
	id := startRun(t, s, payload(5, 400))
	waitFor(t, "two results", func() bool {
		rep, ok := s.mgr.Report(id)
		return ok && rep.Functional != nil && len(rep.Functional.Results) >= 2
	})

	start := time.Now()
	frames, _ := openStream(t, srv.URL, id, func(f frame) bool {
		return f.name == runner.EventRequestResult && f.data["run_id"] == id && len(f.data) > 0
	})
	// The first result arrives from the replay log, not from the wire: a
	// spectator must not have to wait for the next live event to see state.
	if elapsed := time.Since(start); elapsed > 300*time.Millisecond {
		t.Errorf("first replayed event took %s; it should be immediate", elapsed)
	}
	if len(frames) < 2 || frames[0].name != runner.EventRunStarted {
		t.Fatalf("replay = %+v, want run_started then the results so far", frames)
	}

	// And the stream stays live afterwards.
	more, _ := openStream(t, srv.URL, id, func(f frame) bool { return f.name == runner.EventRunFinished })
	if len(more) == 0 || more[len(more)-1].name != runner.EventRunFinished {
		t.Errorf("reconnect did not carry through to run_finished: %+v", more)
	}
}

func TestStreamOfAnUnknownRunIs404(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	if rec := do(t, s, http.MethodGet, "/api/runs/nope/stream", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// A run the broadcaster has already moved past still gets a terminal event.
// Without one a client cannot tell "this run finished" from "the stream died",
// which is exactly the distinction the polling fallback has to make.
func TestStreamOfAFinishedRunSendsATerminalEvent(t *testing.T) {
	c := &clock{}
	s := newServer(t, newTarget(t, 0), c)
	srv := httptest.NewServer(s)
	defer srv.Close()

	first := startRun(t, s, payload(1, 0))
	waitIdle(t, s)
	c.advance(10 * time.Second)
	startRun(t, s, payload(1, 0)) // the broadcaster now describes this run
	waitIdle(t, s)

	frames, _ := openStream(t, srv.URL, first, func(f frame) bool {
		return f.name == runner.EventRunFinished
	})
	if len(frames) != 1 || frames[0].name != runner.EventRunFinished {
		t.Fatalf("stream of a finished run = %+v, want exactly one run_finished", frames)
	}
	data, _ := frames[0].data["data"].(map[string]any)
	if data["status"] != report.StatusCompleted {
		t.Errorf("terminal status = %v, want %q", data["status"], report.StatusCompleted)
	}
	if frames[0].data["run_id"] != first {
		t.Errorf("terminal run_id = %v, want %s", frames[0].data["run_id"], first)
	}
}

// The one deliberate ceiling on this fan-out. Past it the client is told to
// poll — not queued, and not silently starved.
func TestStreamOverTheSubscriberCapTellsTheClientToPoll(t *testing.T) {
	s := newServer(t, newTarget(t, 500*time.Millisecond), nil)
	id := startRun(t, s, payload(4, 0))

	for i := range sse.MaxSubscribers {
		_, cancel, err := s.bus.Subscribe()
		if err != nil {
			t.Fatalf("filling subscriber %d: %v", i, err)
		}
		defer cancel()
	}

	rec := do(t, s, http.MethodGet, "/api/runs/"+id+"/stream", nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d %s, want 503", rec.Code, rec.Body.String())
	}
	if body := decode[errorBody](t, rec); !body.Poll {
		t.Error(`body must carry {"poll": true}: the ceiling will not clear because the client retried`)
	}
	waitIdle(t, s)
}

// The heartbeat is what proves liveness when the run has nothing to say. The
// client's fallback trigger is "no bytes for 5s", so a slow target must not
// look like a dead stream.
func TestStreamHeartbeatsThroughAQuietRun(t *testing.T) {
	s := newServer(t, newTarget(t, 3*Heartbeat/2), nil)
	srv := httptest.NewServer(s)
	defer srv.Close()

	id := startRun(t, s, payload(2, 0))
	resp, err := http.Get(srv.URL + "/api/runs/" + id + "/stream")
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer resp.Body.Close()

	_, pings := readFrames(t, resp.Body, func(f frame) bool { return f.name == runner.EventRunFinished })
	if pings == 0 {
		t.Error("no `: ping` comment in a run that went quiet for longer than the heartbeat interval")
	}
}

// Graceful shutdown must not hang on a stream that, by design, never ends.
func TestCloseReleasesLiveStreams(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	srv := httptest.NewServer(s)
	defer srv.Close()

	id := startRun(t, s, payload(1, 0))
	waitIdle(t, s)
	openStream(t, srv.URL, id, func(f frame) bool { return f.name == runner.EventRunFinished })

	done := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		done <- s.Close(ctx)
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("close: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Close blocked on a live SSE handler")
	}
}
