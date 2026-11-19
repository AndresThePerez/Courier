package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// atCap pads prefix + unit, unit, ... + suffix to exactly MaxBodyBytes, so the
// body is as large as the cap lets a client make it.
func atCap(t *testing.T, prefix, unit, suffix, pad string) string {
	t.Helper()
	var b strings.Builder
	b.WriteString(prefix)
	for i := 0; b.Len()+1+len(unit)+len(suffix) <= MaxBodyBytes; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(unit)
	}
	for b.Len()+len(suffix) < MaxBodyBytes {
		b.WriteString(pad)
	}
	b.WriteString(suffix)
	if b.Len() != MaxBodyBytes {
		t.Fatalf("body is %d bytes, want %d", b.Len(), MaxBodyBytes)
	}
	return b.String()
}

// heldChecks parks every body that reaches the check until released, and
// counts how many are parked at once.
type heldChecks struct {
	inside, most, calls atomic.Int64
	release             chan struct{}
	once                sync.Once
}

func holdChecks(t *testing.T, s *Server) *heldChecks {
	t.Helper()
	h := &heldChecks{release: make(chan struct{})}
	s.bodies.checking = func() {
		h.calls.Add(1)
		n := h.inside.Add(1)
		for m := h.most.Load(); n > m && !h.most.CompareAndSwap(m, n); m = h.most.Load() {
		}
		<-h.release
		h.inside.Add(-1)
	}
	t.Cleanup(h.open)
	return h
}

func (h *heldChecks) open() { h.once.Do(func() { close(h.release) }) }

// serveAsync serves one request on its own goroutine and hands back its answer.
func serveAsync(ctx context.Context, s *Server, path, contentType string, body io.Reader, out chan<- *httptest.ResponseRecorder) {
	r := httptest.NewRequestWithContext(ctx, http.MethodPost, path, body)
	r.Header.Set("Content-Type", contentType)
	go func() {
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, r)
		out <- rec
	}()
}

// gateIdle reports whether no body holds or waits for a check slot.
func gateIdle(s *Server) bool { return len(s.bodies.slots) == 0 && s.bodies.waiting.Load() == 0 }

// Sixty-four bodies at the size cap, posted at once to both routes, are
// checked and decoded at most MaxBodyChecks at a time; MaxBodyWaiters of the
// rest wait their turn and every other one is turned away with a 503.
func TestNoMoreThanMaxBodyChecksBodiesAreCheckedAtOnce(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	h := holdChecks(t, s)
	before := runtime.NumGoroutine()

	bodies := map[string]string{
		"/api/runs": atCap(t, `{"mode":"functional","sequence":[`, `{}`, `]}`, " "),
		"/api/send": atCap(t, `{"endpoint":"healthz","assertions":[`, `{"type":"status","op":"eq","value":200}`, `]}`, " "),
	}
	const posts = 64
	out := make(chan *httptest.ResponseRecorder, posts)
	for i := range posts {
		path := "/api/runs"
		if i%2 == 1 {
			path = "/api/send"
		}
		serveAsync(context.Background(), s, path, "application/json", strings.NewReader(bodies[path]), out)
	}

	var early []*httptest.ResponseRecorder
	waitFor(t, "every post to be inside, waiting, or answered", func() bool {
		for {
			select {
			case rec := <-out:
				early = append(early, rec)
				continue
			default:
			}
			return h.inside.Load()+s.bodies.waiting.Load()+int64(len(early)) == posts
		}
	})
	if most := h.most.Load(); most != MaxBodyChecks {
		t.Errorf("%d bodies were checked at once, want at most and exactly %d", most, MaxBodyChecks)
	}
	if w := s.bodies.waiting.Load(); w != MaxBodyWaiters {
		t.Errorf("%d bodies wait for a check, want %d", w, MaxBodyWaiters)
	}
	if want := posts - MaxBodyChecks - MaxBodyWaiters; len(early) != want {
		t.Errorf("%d posts were answered while the checks were held, want %d", len(early), want)
	}
	for _, rec := range early {
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("a post answered while the checks were held: %d %.200s, want 503", rec.Code, rec.Body.String())
		}
	}

	h.open()
	for range posts - len(early) {
		select {
		case rec := <-out:
			if rec.Code != http.StatusBadRequest {
				t.Errorf("a checked post: %d %.200s, want 400", rec.Code, rec.Body.String())
			}
		case <-time.After(20 * time.Second):
			t.Fatal("a checked post was never answered")
		}
	}
	if most := h.most.Load(); most > MaxBodyChecks {
		t.Errorf("%d bodies were checked at once, want at most %d", most, MaxBodyChecks)
	}
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
	waitFor(t, "the burst's goroutines to end", func() bool { return runtime.NumGoroutine() <= before })
}

// fillGate parks MaxBodyChecks bodies in the check and MaxBodyWaiters behind
// them, and returns the channel their answers arrive on.
func fillGate(t *testing.T, s *Server, h *heldChecks) <-chan *httptest.ResponseRecorder {
	t.Helper()
	n := MaxBodyChecks + MaxBodyWaiters
	out := make(chan *httptest.ResponseRecorder, n)
	for range n {
		serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(`{"endpoint":"nowhere"}`), out)
	}
	waitFor(t, "the checks and the queue to fill", func() bool {
		return h.inside.Load() == MaxBodyChecks && s.bodies.waiting.Load() == MaxBodyWaiters
	})
	return out
}

// With every check slot held and the queue full, a body is answered at once
// with a 503 in the one error shape, before any of it is checked: a malformed
// body gets the 503, not a 400. The answers that need no slot are unchanged.
func TestABodyBeyondMaxBodyWaitersIsAnswered503WithoutBeingChecked(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	h := holdChecks(t, s)
	queued := fillGate(t, s, h)
	calls := h.calls.Load()

	for _, path := range []string{"/api/send", "/api/runs"} {
		rec := postRaw(t, s, path, strings.NewReader(`{"endpoint":`), "application/json")
		eb := wantAPIError(t, rec, http.MethodPost, path, http.StatusServiceUnavailable)
		if eb.Error != bodyGateBusy || eb.Field != "" || eb.Poll {
			t.Errorf("%s: 503 body = %+v, want only the error %q", path, eb, bodyGateBusy)
		}
		if n, err := strconv.Atoi(rec.Header().Get("Retry-After")); err != nil || n < 1 {
			t.Errorf("%s: Retry-After = %q, want a whole number of seconds", path, rec.Header().Get("Retry-After"))
		}

		rec = postRaw(t, s, path, strings.NewReader(`{}`), "text/plain")
		wantAPIError(t, rec, http.MethodPost, path, http.StatusUnsupportedMediaType)
		rec = postRaw(t, s, path, strings.NewReader(strings.Repeat(" ", MaxBodyBytes+1)), "application/json")
		wantAPIError(t, rec, http.MethodPost, path, http.StatusRequestEntityTooLarge)
	}
	if n := h.calls.Load(); n != calls {
		t.Errorf("%d bodies were checked while the queue was full, want none", n-calls)
	}

	h.open()
	for range MaxBodyChecks + MaxBodyWaiters {
		select {
		case rec := <-queued:
			if rec.Code != http.StatusBadRequest {
				t.Errorf("a queued body: %d %.200s, want its own 400", rec.Code, rec.Body.String())
			}
		case <-time.After(20 * time.Second):
			t.Fatal("a queued body was never answered")
		}
	}
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
}

// stallingBody hands out its first bytes and then blocks until it is closed,
// the way a client that stops mid-upload looks to the server.
func stallingBody(first string) (io.Reader, chan struct{}, func()) {
	pr, pw := io.Pipe()
	read := make(chan struct{})
	go func() {
		_, _ = pw.Write([]byte(first))
		close(read)
	}()
	return pr, read, func() { _ = pw.CloseWithError(io.ErrUnexpectedEOF) }
}

// An upload in progress holds no check slot: with ReadHeaderTimeout the only
// server timeout, a slot held while a body arrives would let MaxBodyChecks
// idle connections stop every POST for everyone.
func TestAStalledUploadHoldsNoCheckSlot(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	out := make(chan *httptest.ResponseRecorder, MaxBodyChecks+1)
	var stops []func()
	for range MaxBodyChecks + 1 {
		body, read, stop := stallingBody(`{"endpoint":"heal`)
		stops = append(stops, stop)
		serveAsync(context.Background(), s, "/api/send", "application/json", body, out)
		select {
		case <-read:
		case <-time.After(20 * time.Second):
			t.Fatal("the stalled upload was never read")
		}
	}
	if n := len(s.bodies.slots); n != 0 {
		t.Errorf("%d check slots are held by uploads still arriving, want 0", n)
	}

	done := make(chan *httptest.ResponseRecorder, 1)
	serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(`{"endpoint":"nowhere"}`), done)
	select {
	case rec := <-done:
		wantError(t, rec, http.StatusBadRequest, "endpoint")
	case <-time.After(20 * time.Second):
		t.Fatal("a small body was not answered while other uploads stalled")
	}

	for _, stop := range stops {
		stop()
	}
	for range MaxBodyChecks + 1 {
		select {
		case rec := <-out:
			wantError(t, rec, http.StatusBadRequest, "body")
		case <-time.After(20 * time.Second):
			t.Fatal("a broken upload was never answered")
		}
	}
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
}

// A body waiting for a slot whose client goes away stops waiting at once and
// gives its place back.
func TestAWaiterWhoseClientLeavesStopsWaiting(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	h := holdChecks(t, s)
	held := make(chan *httptest.ResponseRecorder, MaxBodyChecks)
	for range MaxBodyChecks {
		serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(`{"endpoint":"nowhere"}`), held)
	}
	waitFor(t, "the checks to fill", func() bool { return h.inside.Load() == MaxBodyChecks })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	left := make(chan *httptest.ResponseRecorder, 1)
	serveAsync(ctx, s, "/api/runs", "application/json", strings.NewReader(`{"mode":"functional"}`), left)
	waitFor(t, "the third body to wait", func() bool { return s.bodies.waiting.Load() == 1 })

	cancel()
	select {
	case <-left:
	case <-time.After(20 * time.Second):
		t.Fatal("a waiter whose client left was still waiting")
	}
	if w := s.bodies.waiting.Load(); w != 0 {
		t.Errorf("%d waiters after the client left, want 0", w)
	}
	if n := h.inside.Load(); n != MaxBodyChecks {
		t.Errorf("%d bodies in the check, want the %d still held", n, MaxBodyChecks)
	}
	if n := h.calls.Load(); n != MaxBodyChecks {
		t.Errorf("%d bodies reached the check, want %d: the one that left must not", n, MaxBodyChecks)
	}

	h.open()
	for range MaxBodyChecks {
		<-held
	}
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
}
