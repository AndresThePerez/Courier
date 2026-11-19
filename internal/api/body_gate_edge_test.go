package api

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// awaitAnswer waits a generous while for one answer, so a test never relies on
// timing and still fails rather than hangs when an answer never comes.
func awaitAnswer(t *testing.T, what string, ch <-chan *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	select {
	case rec := <-ch:
		return rec
	case <-time.After(20 * time.Second):
		t.Fatalf("%s was never answered", what)
		return nil
	}
}

// A check slot is given back as soon as the body is decoded, before the send
// goes out to the target: a send that waits on a slow target holds no slot,
// and every send behind it is answered by the one-send limit, not the gate.
func TestACheckSlotIsGivenBackBeforeASendGoesOut(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	open := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(open)
	base := serveTarget(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"total":107,"results":[]}`)
	})
	s := newServer(t, base, nil)

	first := make(chan int, 1)
	go func() { first <- do(t, s, http.MethodPost, "/api/send", sendable()).Code }()
	waitFor(t, "the first send to be in flight", func() bool { return s.sending.Load() })
	if n := checkedBytes(s); n != 0 {
		t.Errorf("%d bytes of the check held while a send waits on its target, want 0", n)
	}

	const behind = 3 * (MaxBodyChecks + MaxBodyWaiters)
	codes := make(chan int, behind)
	var wg sync.WaitGroup
	for range behind {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- do(t, s, http.MethodPost, "/api/send", sendable()).Code
		}()
	}
	wg.Wait()
	close(codes)
	for code := range codes {
		if code != http.StatusTooManyRequests {
			t.Errorf("a send behind one in flight = %d, want 429", code)
		}
	}

	open()
	select {
	case code := <-first:
		if code != http.StatusOK {
			t.Errorf("the send in flight = %d, want 200", code)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the send in flight was never answered")
	}
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
}

// With every check slot and every place in the queue taken, the routes that
// read no body answer as they always do: the gate guards the body check only.
func TestAFullBodyGateLeavesEveryOtherRouteAnswered(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	id := startRun(t, s, payload(1, 0))
	waitIdle(t, s)

	h := holdChecks(t, s)
	queued := fillGate(t, s, h)

	cases := []struct {
		method, path string
		want         int
	}{
		{http.MethodGet, "/healthz", http.StatusOK},
		{http.MethodGet, "/api/status", http.StatusOK},
		{http.MethodGet, "/api/collections", http.StatusOK},
		{http.MethodGet, "/api/runs", http.StatusOK},
		{http.MethodGet, "/api/runs/" + id, http.StatusOK},
		{http.MethodGet, "/api/runs/" + id + "/report.pdf", http.StatusOK},
		{http.MethodGet, "/api/runs/" + id + "/stream", http.StatusOK},
		{http.MethodDelete, "/api/runs/" + id, http.StatusNotFound},
		{http.MethodGet, "/", http.StatusOK},
	}
	for _, c := range cases {
		out := make(chan *httptest.ResponseRecorder, 1)
		go func() {
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, httptest.NewRequest(c.method, c.path, nil))
			out <- rec
		}()
		rec := awaitAnswer(t, c.method+" "+c.path+" with the body gate full", out)
		if rec.Code != c.want {
			t.Errorf("%s %s with the body gate full = %d %.200s, want %d", c.method, c.path, rec.Code, rec.Body.String(), c.want)
		}
	}
	if n := h.inside.Load(); n != MaxBodyChecks {
		t.Errorf("%d bodies in the check, want the %d still held", n, MaxBodyChecks)
	}
	if w := s.bodies.waiting(); w != MaxBodyWaiters {
		t.Errorf("%d bodies waiting, want the %d still queued", w, MaxBodyWaiters)
	}

	h.open()
	for range MaxBodyChecks + MaxBodyWaiters {
		awaitAnswer(t, "a queued body", queued)
	}
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
}

// rawPost opens a connection to addr and writes head and then body exactly as
// given, leaving the connection open: the upload stops wherever body stops.
func rawPost(t *testing.T, addr, head, body string) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(c, head+body); err != nil {
		t.Fatal(err)
	}
	return c
}

// An upload that stops before its first byte, halfway, one byte before its
// declared end or inside a chunk holds no check slot and no place in the
// queue, however many there are: a small post sent alongside them is answered,
// and when they all go away nothing is left held.
func TestUploadsStalledAnywhereHoldNoSlotOrPlace(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	srv := httptest.NewServer(s)
	defer srv.Close()
	addr := srv.Listener.Addr().String()

	full := `{"endpoint":"nowhere","name":"` + strings.Repeat("x", 200) + `"}`
	head := func(extra string) string {
		return "POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\n" + extra + "\r\n"
	}
	length := fmt.Sprintf("Content-Length: %d\r\n", len(full))
	stalls := []struct{ name, head, body string }{
		{"before the first byte", head(length), ""},
		{"halfway", head(length), full[:len(full)/2]},
		{"one byte before the end", head(length), full[:len(full)-1]},
		{"inside a chunk", head("Transfer-Encoding: chunked\r\n"), fmt.Sprintf("%x\r\n%s", len(full), full[:10])},
		{"between chunks", head("Transfer-Encoding: chunked\r\n"), fmt.Sprintf("%x\r\n%s\r\n", 10, full[:10])},
		{"longer than declared", head("Content-Length: 1000\r\n"), full},
	}
	var conns []net.Conn
	defer func() {
		for _, c := range conns {
			_ = c.Close()
		}
	}()
	for _, st := range stalls {
		for range MaxBodyChecks + MaxBodyWaiters + 1 {
			conns = append(conns, rawPost(t, addr, st.head, st.body))
		}
	}

	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	post := func(what string) {
		t.Helper()
		resp, err := client.Post(srv.URL+"/api/send", "application/json", strings.NewReader(`{"endpoint":"nowhere"}`))
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			b, _ := io.ReadAll(resp.Body)
			t.Errorf("%s = %d %.200s, want its own 400", what, resp.StatusCode, b)
		}
	}
	post("a small post while uploads stall")
	if !gateIdle(s) {
		t.Errorf("stalled uploads hold %d bytes of the check and %d places, want none", checkedBytes(s), s.bodies.waiting())
	}

	for _, c := range conns {
		_ = c.Close()
	}
	conns = nil
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
	post("a small post after the stalled clients left")
}

// A body shorter than its declared length is read up to that length and
// checked like any other; the bytes after it are the connection's next
// request, never part of this body.
func TestABodyLongerThanItsContentLengthIsCheckedOnlyUpToIt(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	srv := httptest.NewServer(s)
	defer srv.Close()

	body := `{"endpoint":"nowhere"}` + `{"url":"http://192.0.2.1/"}`
	c := rawPost(t, srv.Listener.Addr().String(),
		"POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: 22\r\n\r\n", body)
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(b), `"field":"endpoint"`) {
		t.Errorf("first request = %d %s, want a 400 naming the endpoint", resp.StatusCode, b)
	}
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
}

// A waiter whose client closes its connection, rather than cancelling a
// context in-process, stops waiting and gives back its place.
func TestAWaiterOnAClosedConnectionStopsWaiting(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	h := holdChecks(t, s)
	srv := httptest.NewServer(s)
	defer srv.Close()
	addr := srv.Listener.Addr().String()

	body := `{"endpoint":"nowhere"}`
	req := fmt.Sprintf("POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n", len(body))
	heavyReq := fmt.Sprintf("POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n", len(heavyBody))
	var held []net.Conn
	for range MaxBodyChecks {
		held = append(held, rawPost(t, addr, heavyReq, heavyBody))
	}
	defer func() {
		for _, c := range held {
			_ = c.Close()
		}
	}()
	waitFor(t, "the checks to fill", func() bool { return h.inside.Load() == MaxBodyChecks })

	waiters := make([]net.Conn, MaxBodyWaiters)
	for i := range waiters {
		waiters[i] = rawPost(t, addr, req, body)
	}
	waitFor(t, "the queue to fill", func() bool { return s.bodies.waiting() == MaxBodyWaiters })
	for _, c := range waiters {
		_ = c.Close()
	}
	waitFor(t, "the closed waiters to give back their places", func() bool { return s.bodies.waiting() == 0 })
	if n := h.calls.Load(); n != MaxBodyChecks {
		t.Errorf("%d bodies reached the check, want %d: a closed waiter must not", n, MaxBodyChecks)
	}

	h.open()
	for _, c := range held {
		_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
		resp, err := http.ReadResponse(bufio.NewReader(c), nil)
		if err != nil {
			t.Fatalf("a held post: %v", err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("a held post = %d, want its own 400", resp.StatusCode)
		}
	}
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
}

// Every waiter cancelled at the same moment gives its place back, and the
// queue then takes the same number again rather than turning them away.
func TestWaitersCancelledAllAtOnceGiveBackEveryPlace(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	h := holdChecks(t, s)
	before := runtime.NumGoroutine()

	held := make(chan *httptest.ResponseRecorder, MaxBodyChecks)
	for range MaxBodyChecks {
		serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(heavyBody), held)
	}
	waitFor(t, "the checks to fill", func() bool { return h.inside.Load() == MaxBodyChecks })

	for round := range 3 {
		ctx, cancel := context.WithCancel(context.Background())
		left := make(chan *httptest.ResponseRecorder, MaxBodyWaiters)
		for range MaxBodyWaiters {
			serveAsync(ctx, s, "/api/runs", "application/json", strings.NewReader(`{"mode":"functional"}`), left)
		}
		waitFor(t, "the queue to fill", func() bool { return s.bodies.waiting() == MaxBodyWaiters })
		cancel()
		for range MaxBodyWaiters {
			awaitAnswer(t, fmt.Sprintf("round %d: a cancelled waiter", round), left)
		}
		if w := s.bodies.waiting(); w != 0 {
			t.Fatalf("round %d: %d places still taken after every waiter left, want 0", round, w)
		}
	}
	if n := h.calls.Load(); n != MaxBodyChecks {
		t.Errorf("%d bodies reached the check, want only the %d held", n, MaxBodyChecks)
	}

	h.open()
	for range MaxBodyChecks {
		awaitAnswer(t, "a held body", held)
	}
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
	waitFor(t, "the waiters' goroutines to end", func() bool { return runtime.NumGoroutine() <= before })
}

// Thousands of entries that complete, give up or are cancelled while a slot is
// being handed to them leave the gate exactly as they found it: never more
// than its slots inside, never more than its bound waiting, never a negative
// count, and nothing held at the end.
func TestTheBodyGateKeepsItsCountsThroughMixedCancelAndComplete(t *testing.T) {
	g := newBodyGate(MaxBodyChecks*MaxBodyBytes, MaxBodyWaiters*MaxBodyBytes)
	var inside, most, refused, stuck atomic.Int64
	var overWait, underWait atomic.Bool
	stop := make(chan struct{})
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		for {
			select {
			case <-stop:
				return
			default:
			}
			switch w := g.waiting(); {
			case w < 0:
				underWait.Store(true)
			case w > MaxBodyWaiters: // every entry weighs MaxBodyBytes, and one that does not fit is refused before it joins the line
				overWait.Store(true)
			}
			runtime.Gosched()
		}
	}()

	const workers, rounds = 64, 60
	var wg sync.WaitGroup
	for w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rng := rand.New(rand.NewPCG(uint64(w), 7))
			for range rounds {
				if stuck.Load() > 0 {
					return
				}
				ctx, cancel := context.WithTimeout(context.Background(), enterDeadline)
				switch rng.IntN(3) {
				case 0:
					cancel()
				case 1:
					go func() { runtime.Gosched(); cancel() }()
				}
				ok := g.enter(ctx, MaxBodyBytes)
				if !ok && errors.Is(ctx.Err(), context.DeadlineExceeded) {
					stuck.Add(1)
				}
				if ok {
					n := inside.Add(1)
					for m := most.Load(); n > m && !most.CompareAndSwap(m, n); m = most.Load() {
					}
					runtime.Gosched()
					inside.Add(-1)
					g.leave(MaxBodyBytes)
				} else {
					refused.Add(1)
				}
				cancel()
			}
		}()
	}
	wg.Wait()
	close(stop)
	<-watched

	if n := stuck.Load(); n > 0 {
		t.Errorf("%d entries waited out their %s deadline while a slot was free: a wake-up was lost or a slot was kept", n, enterDeadline)
	}
	if m := most.Load(); m > MaxBodyChecks {
		t.Errorf("%d entries held a slot at once, want at most %d", m, MaxBodyChecks)
	}
	if underWait.Load() {
		t.Error("the waiting count went below zero")
	}
	if overWait.Load() {
		t.Errorf("more than %d bodies at the cap waited at once", MaxBodyWaiters)
	}
	if n, w := g.inside, g.waiting(); n != 0 || w != 0 || g.queued != 0 {
		t.Errorf("after every entry ended: %d bytes inside, %d bytes and %d bodies waiting, want 0", n, g.queued, w)
	}
	if refused.Load() == workers*rounds {
		t.Error("every entry was refused; the gate admitted nothing")
	}
}

// panickingPayload decodes by panicking, standing in for any fault inside the
// decode once a slot is held.
type panickingPayload struct {
	A int `json:"a"`
}

func (*panickingPayload) UnmarshalJSON([]byte) error { panic("decode fault") }

// A panic while a body is decoded still gives back its check slot: net/http
// recovers a handler's panic, and a slot lost to each one would close the
// gate for good after MaxBodyChecks of them.
func TestAPanicInsideTheDecodeGivesBackItsSlot(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	for range MaxBodyChecks + 1 {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatal("the decode did not panic")
				}
			}()
			r := httptest.NewRequest(http.MethodPost, "/api/send", strings.NewReader(`{"a":1}`))
			r.Header.Set("Content-Type", "application/json")
			s.decodeJSON(httptest.NewRecorder(), r, new(panickingPayload))
		}()
	}
	if !gateIdle(s) {
		t.Fatalf("after panicking decodes: %d bytes of the check held and %d waiting, want none", checkedBytes(s), s.bodies.waiting())
	}
	wantError(t, do(t, s, http.MethodPost, "/api/send", undispatchable), http.StatusBadRequest, "endpoint")
}

// refusingWriter fails every write, the way a client that has already gone
// looks to a handler.
type refusingWriter struct{ hdr http.Header }

func (w *refusingWriter) Header() http.Header       { return w.hdr }
func (w *refusingWriter) WriteHeader(int)           {}
func (w *refusingWriter) Write([]byte) (int, error) { return 0, errors.New("connection reset") }

// A 503 that cannot be written takes nothing: the slots and the queue are
// exactly as full as before, and drain to empty afterwards.
func TestA503ThatCannotBeWrittenTakesNoSlotOrPlace(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	h := holdChecks(t, s)
	queued := fillGate(t, s, h)

	for range 2 * MaxBodyWaiters {
		r := httptest.NewRequest(http.MethodPost, "/api/send", strings.NewReader(undispatchable))
		r.Header.Set("Content-Type", "application/json")
		s.ServeHTTP(&refusingWriter{hdr: http.Header{}}, r)
	}
	if n, w := h.inside.Load(), s.bodies.waiting(); n != MaxBodyChecks || w != MaxBodyWaiters {
		t.Errorf("after unwritable 503s: %d in the check and %d waiting, want %d and %d", n, w, MaxBodyChecks, MaxBodyWaiters)
	}

	h.open()
	for range MaxBodyChecks + MaxBodyWaiters {
		awaitAnswer(t, "a queued body", queued)
	}
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
}

// Fifty small starts and sends fired at the same moment get the answers they
// got before the gate existed: started, busy, cooling down, rate limited or
// sent, never a 503 from the body check.
func TestAnOrdinaryBurstOfSmallPostsNeverSeesTheBodyGate(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	const posts = 50
	allowed := map[int]bool{http.StatusOK: true, http.StatusAccepted: true, http.StatusConflict: true, http.StatusTooManyRequests: true}

	go1 := make(chan struct{})
	codes := make(chan *httptest.ResponseRecorder, posts)
	var wg sync.WaitGroup
	for i := range posts {
		path, body := "/api/send", `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":200}]}`
		if i%2 == 1 {
			path, body = "/api/runs", `{"mode":"functional","sequence":[{"endpoint":"healthz"}]}`
		}
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-go1
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, r)
			codes <- rec
		}()
	}
	close(go1)
	wg.Wait()
	close(codes)
	var started int
	for rec := range codes {
		if !allowed[rec.Code] {
			t.Errorf("a small post in a burst = %d %.200s, want 200, 202, 409 or 429", rec.Code, rec.Body.String())
		}
		if rec.Code == http.StatusAccepted {
			started++
		}
	}
	if started != 1 {
		t.Errorf("%d runs started from one burst, want exactly 1", started)
	}
	waitIdle(t, s)
	waitFor(t, "the slots and the queue to empty", func() bool { return gateIdle(s) })
}
