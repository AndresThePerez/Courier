package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/iotest"
	"time"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// A run payload that is not JSON is refused by the decoder, naming the byte,
// before any run is admitted.
func TestStartRunRefusesMalformedJSON(t *testing.T) {
	ct := newCountingTarget(t)
	s := newServer(t, ct.URL, nil)
	for _, c := range []struct{ name, body, msg string }{
		{"syntax error", `{"mode":"functional","sequence":[}`, "malformed JSON at byte 34"},
		{"cut short", `{"mode":"functional","sequence":[{"endpoint":"sea`, "malformed JSON at byte 49"},
		{"bare word", `functional`, "malformed JSON at byte 2"},
	} {
		t.Run(c.name, func(t *testing.T) {
			rec := postRaw(t, s, "/api/runs", strings.NewReader(c.body), "application/json")
			body := wantError(t, rec, http.StatusBadRequest, "body")
			if body.Error != c.msg {
				t.Errorf("error = %q, want %q", body.Error, c.msg)
			}
		})
	}
	if st := s.mgr.Status(); st.Running || st.RunID != "" {
		t.Errorf("status = %+v after refused payloads, want no run", st)
	}
	if len(s.mgr.History()) != 0 || ct.hits.Load() != 0 {
		t.Errorf("history %d, target hits %d after refused payloads; want none", len(s.mgr.History()), ct.hits.Load())
	}
}

// A body whose connection fails part-way through is a 400 with a fixed
// sentence on both POST routes: the read error is the transport's, and its
// text is not the visitor's to read.
func TestABodyThatFailsMidReadIsA400(t *testing.T) {
	ct := newCountingTarget(t)
	s := newServer(t, ct.URL, nil)
	for _, path := range []string{"/api/send", "/api/runs"} {
		body := io.MultiReader(strings.NewReader(`{"endpoint":"search","params":{"q":"char`),
			iotest.ErrReader(errors.New("read tcp 192.0.2.10:443: connection reset by peer")))
		rec := postRaw(t, s, path, body, "application/json")
		got := wantError(t, rec, http.StatusBadRequest, "body")
		if got.Error != "the body could not be read" {
			t.Errorf("%s: error = %q, want the fixed sentence", path, got.Error)
		}
		if strings.Contains(rec.Body.String(), "192.0.2.10") || strings.Contains(rec.Body.String(), "reset") {
			t.Errorf("%s: the read error leaked into the answer: %s", path, rec.Body.String())
		}
	}
	if ct.hits.Load() != 0 || s.mgr.Status().Running {
		t.Errorf("target hits %d, running %v after unreadable bodies; want nothing dispatched", ct.hits.Load(), s.mgr.Status().Running)
	}
}

// A performance run's history row carries the number its verdict was made on:
// "<requests> requests, p95 <x>ms, <verdict>", agreeing with the stored report.
// This sequence is not the calibrated one, so its verdict is N/A; the row must
// say so rather than drop it.
func TestHistoryRowOfAPerformanceRun(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	id := startRun(t, s, sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: payload(1, 0).Sequence,
		Options:  sandbox.Options{Concurrency: 1, DurationSecs: 1},
	})
	waitIdle(t, s)

	rep := decode[report.Report](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
	if rep.Performance == nil || rep.Performance.Overall.Requests == 0 {
		t.Fatalf("performance payload = %+v, want a run that dispatched", rep.Performance)
	}
	rows := decode[struct {
		Runs []historyEntry `json:"runs"`
	}](t, do(t, s, http.MethodGet, "/api/runs", nil)).Runs
	if len(rows) != 1 || rows[0].ID != id {
		t.Fatalf("history = %+v, want the one performance run", rows)
	}
	row := rows[0]

	m := regexp.MustCompile(`^(\d+) requests, p95 (\d+\.\d)ms, (PASS|FAIL|N/A)$`).FindStringSubmatch(row.Summary)
	if m == nil {
		t.Fatalf("summary = %q, want \"<n> requests, p95 <x>ms, <verdict>\"", row.Summary)
	}
	o := rep.Performance.Overall
	if n, _ := strconv.Atoi(m[1]); n != o.Requests {
		t.Errorf("summary counts %s requests, the report %d", m[1], o.Requests)
	}
	if want := fmt.Sprintf("%.1f", o.Latency.P95); m[2] != want {
		t.Errorf("summary p95 %sms, the report %sms", m[2], want)
	}
	if m[3] != rep.Performance.Verdict || row.Verdict != rep.Performance.Verdict {
		t.Errorf("summary verdict %q, row verdict %q, report verdict %q; want all the same",
			m[3], row.Verdict, rep.Performance.Verdict)
	}
	if row.Mode != sandbox.ModePerformance || row.Status != report.StatusCompleted {
		t.Errorf("row = %+v, want a completed performance run", row)
	}
}

// liveRun starts a performance run against a target that never answers, so it
// stays running for far longer than any stream test needs, and waits until the
// broadcaster describes it.
func liveRun(t *testing.T) (*Server, string) {
	t.Helper()
	s := newServer(t, serveTarget(t, hang), nil)
	id := startRun(t, s, sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: payload(1, 0).Sequence,
		Options:  sandbox.Options{Concurrency: 1, DurationSecs: sandbox.MaxDurationSecs},
	})
	waitFor(t, "the run to be announced", func() bool { return s.bus.RunID() == id })
	return s, id
}

// serveStream runs the stream handler for id on w and returns a channel closed
// when the handler returns.
func serveStream(t *testing.T, s *Server, id string, w http.ResponseWriter) <-chan struct{} {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/runs/"+id+"/stream", nil)
	handled := make(chan struct{})
	go func() {
		defer close(handled)
		s.ServeHTTP(w, req)
	}()
	return handled
}

func awaitHandler(t *testing.T, handled <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-handled:
	case <-time.After(20 * time.Second):
		t.Fatalf("%s: the stream handler did not return", what)
	}
}

// stillLive fails unless run id is still running: a stream that ended while
// its run was live ended for its own reason, not because the run did.
func stillLive(t *testing.T, s *Server, id, what string) {
	t.Helper()
	if st := s.mgr.Status(); !st.Running || st.RunID != id {
		t.Fatalf("%s: run %s is no longer live (%+v); the test proves nothing", what, id, st)
	}
}

// A viewer the broadcaster drops for falling behind has its stream ended with
// no terminal event and no retry: line, while the run carries on: its
// EventSource reconnects at once and the replay log restores what it missed.
func TestStreamEndsWhenItsViewerIsDroppedAsSlow(t *testing.T) {
	s, id := liveRun(t)
	w := newStallWriter()
	handled := serveStream(t, s, id, w)
	select {
	case <-w.first:
	case <-time.After(20 * time.Second):
		t.Fatal("the viewer was never written to")
	}

	// The handler is parked in its first write. Overfill its buffer.
	for range 2 * 64 {
		s.bus.Publish(runner.Event{Type: runner.EventProgress, RunID: id})
	}
	waitFor(t, "the broadcaster to drop the slow viewer", func() bool { return s.bus.Subscribers() == 0 })

	close(w.gate)
	awaitHandler(t, handled, "the dropped viewer")
	stillLive(t, s, id, "the dropped viewer")
	out := w.String()
	if strings.Contains(out, "event: "+runner.EventRunFinished) || strings.Contains(out, "retry: ") {
		t.Errorf("a dropped viewer was told the run is over:\n%.600s", out)
	}
	if !strings.Contains(out, "event: "+runner.EventRunStarted) {
		t.Errorf("the dropped viewer was not sent what it had before it fell behind:\n%.600s", out)
	}
}

// brokenWriter is a response writer that fails a chosen write or flush once
// armed, the way a write to a viewer whose connection has gone fails.
type brokenWriter struct {
	hdr   http.Header
	armed atomic.Bool
	// breaks reports whether op ("write" or "flush") fails. For a write, p is
	// what is being written; for a flush, the last write.
	breaks func(op string, p []byte) bool
	broke  chan struct{}
	once   sync.Once

	mu    sync.Mutex
	buf   bytes.Buffer
	last  []byte
	after int // bytes written after the failure
}

func newBrokenWriter(breaks func(op string, p []byte) bool) *brokenWriter {
	return &brokenWriter{hdr: http.Header{}, breaks: breaks, broke: make(chan struct{})}
}

func (w *brokenWriter) Header() http.Header { return w.hdr }
func (w *brokenWriter) WriteHeader(int)     {}

func (w *brokenWriter) fail() error {
	w.once.Do(func() { close(w.broke) })
	return errors.New("write: broken pipe")
}

func (w *brokenWriter) failed() bool {
	select {
	case <-w.broke:
		return true
	default:
		return false
	}
}

func (w *brokenWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.failed() {
		w.after += len(p)
	}
	if w.armed.Load() && w.breaks("write", p) {
		return 0, w.fail()
	}
	w.last = append(w.last[:0], p...)
	return w.buf.Write(p)
}

func (w *brokenWriter) FlushError() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.armed.Load() && w.breaks("flush", w.last) {
		return w.fail()
	}
	return nil
}

func (w *brokenWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// A failed write or flush ends the stream at once, wherever it happens, and
// gives the slot back while the run carries on. Nothing more is written to a
// connection that has already failed.
func TestStreamEndsOnAWriteError(t *testing.T) {
	isPing := func(p []byte) bool { return bytes.HasPrefix(p, []byte(": ping")) }
	cases := []struct {
		name string
		// armLate arms the writer only once the replay is written, so the
		// failure lands on a live event rather than on the replay.
		armLate bool
		breaks  func(op string, p []byte) bool
	}{
		{"the first flush", false, func(op string, p []byte) bool { return op == "flush" && len(p) == 0 }},
		{"a live event", true, func(op string, p []byte) bool { return op == "write" && bytes.HasPrefix(p, []byte("id: ")) }},
		{"a heartbeat write", false, func(op string, p []byte) bool { return op == "write" && isPing(p) }},
		{"a heartbeat flush", false, func(op string, p []byte) bool { return op == "flush" && isPing(p) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, id := liveRun(t)
			w := newBrokenWriter(c.breaks)
			w.armed.Store(!c.armLate)
			handled := serveStream(t, s, id, w)
			if c.armLate {
				waitFor(t, "the replay to be written", func() bool {
					return strings.Contains(w.String(), "event: "+runner.EventRunStarted)
				})
				w.armed.Store(true)
			}

			select {
			case <-w.broke:
			case <-time.After(20 * time.Second):
				t.Fatalf("the write never failed; written so far:\n%.600s", w.String())
			}
			awaitHandler(t, handled, c.name)
			stillLive(t, s, id, c.name)
			waitFor(t, "the slot to be released", func() bool { return s.bus.Subscribers() == 0 })
			w.mu.Lock()
			after := w.after
			w.mu.Unlock()
			if after != 0 {
				t.Errorf("%d bytes were written after the failure", after)
			}
		})
	}
}
