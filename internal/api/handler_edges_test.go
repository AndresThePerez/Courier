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
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// historyRows reads GET /api/runs.
func historyRows(t *testing.T, s *Server) []historyEntry {
	t.Helper()
	return decode[struct {
		Runs []historyEntry `json:"runs"`
	}](t, do(t, s, http.MethodGet, "/api/runs", nil)).Runs
}

// cancelAndWait stops the live run and waits for the manager to be idle.
func cancelAndWait(t *testing.T, s *Server, id string) {
	t.Helper()
	if rec := do(t, s, http.MethodDelete, "/api/runs/"+id, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE = %d %s, want 204", rec.Code, rec.Body.String())
	}
	waitIdle(t, s)
}

func noNonNumbers(t *testing.T, what, s string) {
	t.Helper()
	for _, bad := range []string{"NaN", "Inf", "inf", "nan"} {
		if strings.Contains(s, bad) {
			t.Errorf("%s = %q carries %q", what, s, bad)
		}
	}
}

var perfSummary = regexp.MustCompile(`^\d+ requests, p95 \d+\.\d+ms, (PASS|FAIL|N/A)$`)

// A performance run that was cancelled keeps its row in the history list: the
// row says what it dispatched, its p95 is a finite number, and its verdict is
// withheld (N/A) rather than judged on a run stopped part-way.
func TestHistoryRowOfACancelledPerformanceRunKeepsTheSummaryFormat(t *testing.T) {
	s, id := liveRun(t)
	cancelAndWait(t, s, id)

	rows := historyRows(t, s)
	if len(rows) != 1 || rows[0].ID != id {
		t.Fatalf("history = %+v, want the cancelled run", rows)
	}
	row := rows[0]
	if row.Status != report.StatusCancelled || row.Mode != sandbox.ModePerformance {
		t.Errorf("row = %+v, want a cancelled performance run", row)
	}
	if !perfSummary.MatchString(row.Summary) {
		t.Errorf("summary = %q, want \"<n> requests, p95 <x>ms, <verdict>\"", row.Summary)
	}
	noNonNumbers(t, "summary", row.Summary)
	if row.Verdict != report.VerdictNA || !strings.HasSuffix(row.Summary, ", "+report.VerdictNA) {
		t.Errorf("verdict %q, summary %q; a cancelled run is not judged", row.Verdict, row.Summary)
	}
}

// A performance run whose every dispatch fails (a dead target) still has a
// well-formed row: no division by zero in the p95 or in the error rate.
func TestHistoryRowOfAPerformanceRunAgainstADeadTargetIsWellFormed(t *testing.T) {
	s := newServer(t, closedTarget(t), nil)
	id := startRun(t, s, sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: payload(1, 0).Sequence,
		Options:  sandbox.Options{Concurrency: 1, DurationSecs: 1},
	})
	waitIdle(t, s)

	rows := historyRows(t, s)
	if len(rows) != 1 || rows[0].ID != id {
		t.Fatalf("history = %+v, want the one run", rows)
	}
	if !perfSummary.MatchString(rows[0].Summary) {
		t.Errorf("summary = %q, want \"<n> requests, p95 <x>ms, <verdict>\"", rows[0].Summary)
	}
	noNonNumbers(t, "summary", rows[0].Summary)
	if body := do(t, s, http.MethodGet, "/api/runs/"+id, nil).Body.String(); strings.Contains(body, "NaN") {
		t.Errorf("the stored report carries NaN: %.300s", body)
	}
}

// The summary's number is the p95, not another percentile: a target with a
// slow tail has a p95 far from its median, and the row must carry the former.
func TestPerformanceSummaryCarriesTheP95NotTheMedian(t *testing.T) {
	var n atomic.Int64
	target := serveTarget(t, func(w http.ResponseWriter, r *http.Request) {
		// One request in seven is slow: the median stays fast, the p95 does not.
		if n.Add(1)%7 == 0 {
			select {
			case <-time.After(60 * time.Millisecond):
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"total":1,"page":1,"pages":1,"took_ms":1,"results":[]}`)
	})
	s := newServer(t, target, nil)
	id := startRun(t, s, sandbox.RunRequest{
		Mode:     sandbox.ModePerformance,
		Sequence: payload(1, 0).Sequence,
		Options:  sandbox.Options{Concurrency: 1, DurationSecs: 2},
	})
	waitIdle(t, s)

	rep := decode[report.Report](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
	lat := rep.Performance.Overall.Latency
	if lat.P95 < lat.P50+30 {
		t.Fatalf("p50 %.1fms, p95 %.1fms: the fixture did not separate them, so the test proves nothing", lat.P50, lat.P95)
	}
	rows := historyRows(t, s)
	if len(rows) != 1 {
		t.Fatalf("history = %+v, want one row", rows)
	}
	want := regexp.MustCompile(` requests, p95 ` + regexp.QuoteMeta(formatMs(lat.P95)) + `ms, `)
	if !want.MatchString(rows[0].Summary) {
		t.Errorf("summary = %q, want p95 %sms (p50 was %.1fms)", rows[0].Summary, formatMs(lat.P95), lat.P50)
	}
}

func formatMs(v float64) string { return fmt.Sprintf("%.1f", v) }

// A functional run in which nothing was asserted (every request skipped
// because the run was stopped first) is counted, not judged, and its verdict
// is withheld.
func TestHistoryRowOfAFunctionalRunWithEverySkipSaysSo(t *testing.T) {
	s := newServer(t, serveTarget(t, hang), nil)
	id := startRun(t, s, payload(3, 0))
	waitFor(t, "the run to be announced", func() bool { return s.bus.RunID() == id })
	cancelAndWait(t, s, id)

	rep := decode[report.Report](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
	if rep.Functional == nil || rep.Functional.Passed != 0 || rep.Functional.Failed != 0 {
		t.Fatalf("functional = %+v, want nothing passed or failed", rep.Functional)
	}
	rows := historyRows(t, s)
	if len(rows) != 1 {
		t.Fatalf("history = %+v, want one row", rows)
	}
	if want := "0 passed / 0 failed / 3 skipped"; rows[0].Summary != want {
		t.Errorf("summary = %q, want %q", rows[0].Summary, want)
	}
	if rows[0].Verdict != report.VerdictNA {
		t.Errorf("verdict = %q, want %q: nothing was asserted", rows[0].Verdict, report.VerdictNA)
	}
}

// A payload that is not JSON is a 400 whether or not a run is live: the body
// is judged before the run lock is asked, so a visitor with a typo is told
// about the typo, not that someone else is running.
func TestMalformedJSONWhileARunIsLiveIsStillA400(t *testing.T) {
	s, id := liveRun(t)

	for range 3 { // stable across repeats, not a race with the lock
		rec := postRaw(t, s, "/api/runs", strings.NewReader(`{"mode":`), "application/json")
		wantError(t, rec, http.StatusBadRequest, "body")
	}
	rec := postRaw(t, s, "/api/runs", strings.NewReader(`{"mode":"functional"}`), "text/plain")
	wantError(t, rec, http.StatusUnsupportedMediaType, "body")

	// A well-formed payload is the one that meets the lock.
	rec = do(t, s, http.MethodPost, "/api/runs", payload(1, 0))
	if rec.Code != http.StatusConflict {
		t.Fatalf("well-formed POST = %d %s, want 409", rec.Code, rec.Body.String())
	}
	if got := decode[conflictBody](t, rec).RunID; got != id {
		t.Errorf("conflict run_id = %q, want the live run %q", got, id)
	}
	stillLive(t, s, id, "after the refused payloads")
}

// Malformed JSON is refused on the one-off Send route as well, naming the
// byte, and nothing reaches the target.
func TestSendRefusesMalformedJSONWithoutDispatching(t *testing.T) {
	ct := newCountingTarget(t)
	s := newServer(t, ct.URL, nil)
	for _, body := range []string{`{"endpoint":`, `{"endpoint":"search",}`, `[`, ``} {
		rec := postRaw(t, s, "/api/send", strings.NewReader(body), "application/json")
		got := wantError(t, rec, http.StatusBadRequest, "body")
		if got.Error == "" {
			t.Errorf("body %q: empty error text", body)
		}
		noNonNumbers(t, "error", got.Error)
	}
	if ct.hits.Load() != 0 {
		t.Errorf("target hits = %d after malformed sends, want 0", ct.hits.Load())
	}
}

// countingReader fails every read and counts them.
type countingReader struct{ reads atomic.Int64 }

func (c *countingReader) Read([]byte) (int, error) {
	c.reads.Add(1)
	return 0, errors.New("read tcp 192.0.2.10:443: connection reset by peer")
}

// The Content-Type is judged before the body is read: a request that is
// declared wrongly and whose body would also fail to read is a 415, and the
// body is never touched.
func TestWrongContentTypeIsRefusedBeforeTheBodyIsRead(t *testing.T) {
	s := newServer(t, newCountingTarget(t).URL, nil)
	for _, path := range []string{"/api/send", "/api/runs"} {
		for _, ct := range []string{"text/plain", "application/x-www-form-urlencoded", ""} {
			r := &countingReader{}
			var rec *httptest.ResponseRecorder
			if ct == "" {
				rec = postRaw(t, s, path, r)
			} else {
				rec = postRaw(t, s, path, r, ct)
			}
			wantError(t, rec, http.StatusUnsupportedMediaType, "body")
			if n := r.reads.Load(); n != 0 {
				t.Errorf("%s with Content-Type %q: the body was read %d times before the type was refused", path, ct, n)
			}
			if strings.Contains(rec.Body.String(), "192.0.2.10") {
				t.Errorf("%s: the read error leaked: %s", path, rec.Body.String())
			}
		}
	}
}

// failingWriter fails the first write that match selects, then records
// whatever is still written or flushed after the failure.
type failingWriter struct {
	hdr   http.Header
	match func(p []byte) bool

	mu           sync.Mutex
	buf          bytes.Buffer
	broke        bool
	bytesAfter   int
	flushesAfter int
}

func newFailingWriter(match func(p []byte) bool) *failingWriter {
	return &failingWriter{hdr: http.Header{}, match: match}
}

func (w *failingWriter) Header() http.Header { return w.hdr }
func (w *failingWriter) WriteHeader(int)     {}

func (w *failingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.broke {
		w.bytesAfter += len(p)
		return 0, errors.New("write: broken pipe")
	}
	if w.match(p) {
		w.broke = true
		return 0, errors.New("write: broken pipe")
	}
	return w.buf.Write(p)
}

func (w *failingWriter) FlushError() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.broke {
		w.flushesAfter++
	}
	return nil
}

func (w *failingWriter) written() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func (w *failingWriter) state() (broke bool, bytesAfter, flushesAfter int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.broke, w.bytesAfter, w.flushesAfter
}

// serveStreamWith runs the stream handler for id with the given Last-Event-ID
// and context.
func serveStreamWith(ctx context.Context, s *Server, id, lastEventID string, w http.ResponseWriter) <-chan struct{} {
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/runs/"+id+"/stream", nil)
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	handled := make(chan struct{})
	go func() {
		defer close(handled)
		s.ServeHTTP(w, req)
	}()
	return handled
}

// A stream to a viewer whose connection fails ends at once wherever the
// failure falls in a finished run's answer, and after it nothing more is
// written or flushed to the dead connection. In particular a terminal event
// that could not be delivered is never followed by the retry: line that says
// the stream completed.
func TestStreamOfAFinishedRunEndsOnAWriteErrorAtEachStep(t *testing.T) {
	has := func(sub string) func([]byte) bool {
		return func(p []byte) bool { return bytes.Contains(p, []byte(sub)) }
	}
	cases := []struct {
		name string
		// moveOn starts a second run, so the broadcaster no longer holds this
		// one and the terminal event is rebuilt from the stored report.
		moveOn      bool
		lastEventID string
		breaks      func([]byte) bool
		wantNoEvent string
	}{
		{"the first replayed event", false, "", has("event: " + runner.EventRunStarted), runner.EventRunFinished},
		{"the replayed run_finished", false, "", has("event: " + runner.EventRunFinished), "retry: "},
		{"the retry line after the replayed run_finished", false, "", has("retry: "), ""},
		{"the terminal event a viewer past the end is told again", false, "999999", has("event: " + runner.EventRunFinished), "retry: "},
		{"the rebuilt terminal event", true, "", has("event: " + runner.EventRunFinished), "retry: "},
		{"the retry line after the rebuilt terminal event", true, "", has("retry: "), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			clk := &clock{}
			s := newServer(t, newTarget(t, 0), clk)
			id := startRun(t, s, payload(1, 0))
			waitIdle(t, s)
			if c.moveOn {
				clk.advance(time.Minute)
				startRun(t, s, payload(1, 0))
				waitIdle(t, s)
			}

			w := newFailingWriter(c.breaks)
			handled := serveStreamWith(t.Context(), s, id, c.lastEventID, w)
			awaitHandler(t, handled, c.name)

			broke, bytesAfter, flushesAfter := w.state()
			if !broke {
				t.Fatalf("the write never failed; written:\n%.600s", w.written())
			}
			if bytesAfter != 0 {
				t.Errorf("%d bytes were written after the failure", bytesAfter)
			}
			if flushesAfter != 0 {
				t.Errorf("%d flushes after the failure", flushesAfter)
			}
			if c.wantNoEvent != "" && strings.Contains(w.written(), c.wantNoEvent) {
				t.Errorf("%q was written although the write before it failed:\n%.600s", c.wantNoEvent, w.written())
			}
			waitFor(t, "the slot to be released", func() bool { return s.bus.Subscribers() == 0 })
		})
	}
}

// A viewer whose request is already cancelled when its stream starts gets
// nothing it can use, ends at once, and leaves no subscriber slot behind: the
// run it asked about carries on.
func TestStreamWithACancelledRequestEndsAtOnceAndFreesItsSlot(t *testing.T) {
	s, id := liveRun(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	rec := httptest.NewRecorder()
	handled := serveStreamWith(ctx, s, id, "", rec)
	awaitHandler(t, handled, "a stream with a cancelled context")
	waitFor(t, "the slot to be released", func() bool { return s.bus.Subscribers() == 0 })
	stillLive(t, s, id, "after the cancelled viewer")
	if out := rec.Body.String(); strings.Contains(out, "event: "+runner.EventRunFinished) || strings.Contains(out, "retry: ") {
		t.Errorf("a viewer that had gone was told the run is over:\n%.400s", out)
	}
}
