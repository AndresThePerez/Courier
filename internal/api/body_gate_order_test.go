package api

import (
	"context"
	"fmt"
	"io"
	"math/rand/v2"
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

// weighedChecks parks every body that reaches the check, records its weight in
// arrival order, and lets bodies leave one at a time when told to.
type weighedChecks struct {
	mu      sync.Mutex
	order   []int64
	inside  atomic.Int64
	next    chan struct{} // one send lets one parked body leave
	release chan struct{} // closed: every body leaves
	once    sync.Once
}

func weighChecks(t *testing.T, s *Server) *weighedChecks {
	t.Helper()
	wc := &weighedChecks{next: make(chan struct{}), release: make(chan struct{})}
	s.bodies.checking = func(n int64) {
		wc.mu.Lock()
		wc.order = append(wc.order, n)
		wc.mu.Unlock()
		wc.inside.Add(1)
		defer wc.inside.Add(-1)
		select {
		case <-wc.next:
		case <-wc.release:
		}
	}
	t.Cleanup(wc.open)
	return wc
}

func (wc *weighedChecks) open() { wc.once.Do(func() { close(wc.release) }) }

func (wc *weighedChecks) entered() []int64 {
	wc.mu.Lock()
	defer wc.mu.Unlock()
	return append([]int64(nil), wc.order...)
}

// sized is an undispatchable send body padded with spaces to exactly n bytes,
// or a prefix of one when n is shorter than the smallest such body.
func sized(n int) string {
	const b = `{"endpoint":"nowhere"}`
	if n < len(b) {
		return b[:n]
	}
	return b + strings.Repeat(" ", n-len(b))
}

// A small post that arrives behind fifteen bodies at the cap, with two more in
// the check, waits for exactly the bodies ahead of it: it is let in at the
// sixteenth check to end, not before (arrival order) and not later (no lost
// wake-up). With the line full of bodies at the cap it is answered 503 at once.
func TestASmallPostBehindBodiesAtTheCapWaitsOnlyForThoseAheadOfIt(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	wc := weighChecks(t, s)
	const ahead = MaxBodyWaiters - 1
	out := make(chan *httptest.ResponseRecorder, MaxBodyChecks+MaxBodyWaiters+2)
	for range MaxBodyChecks {
		serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(heavyBody), out)
	}
	waitFor(t, "the check to fill", func() bool { return wc.inside.Load() == MaxBodyChecks })
	for i := range ahead {
		serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(heavyBody), out)
		waitFor(t, "a body at the cap to wait", func() bool { return s.bodies.waiting.Load() == int64(i+1) })
	}
	serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(undispatchable), out)
	waitFor(t, "the small post to wait", func() bool { return s.bodies.waiting.Load() == ahead+1 })

	for done := 1; done <= ahead+1; done++ {
		wc.next <- struct{}{}
		<-out
		want := MaxBodyChecks + min(done, ahead)
		if done == ahead+1 {
			want++ // the small post itself
		}
		waitFor(t, fmt.Sprintf("the body after check %d ended", done), func() bool { return len(wc.entered()) == want })
		got := wc.entered()
		for i, n := range got {
			if wantN := int64(MaxBodyBytes); i < MaxBodyChecks+ahead && n != wantN {
				t.Fatalf("after %d checks ended, body %d let in weighs %d, want a body at the cap: %v", done, i, n, got)
			}
		}
	}
	if got := wc.entered(); got[len(got)-1] != minBodyWeight {
		t.Errorf("the last body let in weighs %d, want the small post (%d)", got[len(got)-1], minBodyWeight)
	}

	// The line full of bodies at the cap: a small post is turned away at once.
	wc.open()
	for range MaxBodyChecks {
		<-out
	}
	waitFor(t, "the gate to empty", func() bool { return gateIdle(s) })
	wc2 := weighChecks(t, s)
	full := fillGateWith(t, s, func() int64 { return wc2.inside.Load() })
	rec := postRaw(t, s, "/api/send", strings.NewReader(undispatchable), "application/json")
	wantAPIError(t, rec, http.MethodPost, "/api/send", http.StatusServiceUnavailable)
	if rec.Header().Get("Retry-After") == "" {
		t.Error("a small post turned away by a full line has no Retry-After")
	}
	wc2.open()
	for range MaxBodyChecks + MaxBodyWaiters {
		awaitAnswer(t, "a queued body", full)
	}
	waitFor(t, "the gate to empty", func() bool { return gateIdle(s) })
}

// fillGateWith parks bodies at the cap in the check and the line until both
// are full, counting those in the check with inside.
func fillGateWith(t *testing.T, s *Server, inside func() int64) <-chan *httptest.ResponseRecorder {
	t.Helper()
	n := MaxBodyChecks + MaxBodyWaiters
	out := make(chan *httptest.ResponseRecorder, n)
	for range n {
		serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(heavyBody), out)
	}
	waitFor(t, "the check and the line to fill", func() bool {
		return inside() == MaxBodyChecks && s.bodies.waiting.Load() == MaxBodyWaiters
	})
	return out
}

// The head of the line leaving wakes the body behind it when that one fits,
// without any check ending.
func TestTheHeadOfTheLineLeavingLetsInTheOneBehindIt(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	wc := weighChecks(t, s)
	out := make(chan *httptest.ResponseRecorder, 4)
	serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(heavyBody), out)
	serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(undispatchable), out)
	waitFor(t, "two bodies in the check", func() bool { return wc.inside.Load() == 2 })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	head := make(chan *httptest.ResponseRecorder, 1)
	serveAsync(ctx, s, "/api/send", "application/json", strings.NewReader(heavyBody), head)
	waitFor(t, "the body at the cap to wait", func() bool { return s.bodies.waiting.Load() == 1 })
	serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(undispatchable), out)
	waitFor(t, "the small body to wait behind it", func() bool { return s.bodies.waiting.Load() == 2 })

	cancel()
	awaitAnswer(t, "the head that left", head)
	waitFor(t, "the small body behind the head to be let in", func() bool { return wc.inside.Load() == 3 })
	if w := s.bodies.waiting.Load(); w != 0 {
		t.Errorf("%d bodies still waiting, want 0", w)
	}

	wc.open()
	for range 3 {
		awaitAnswer(t, "a body", out)
	}
	waitFor(t, "the gate to empty", func() bool { return gateIdle(s) })
}

// Two checks ending at the same moment let in both bodies at the cap waiting
// behind them.
func TestTwoChecksEndingTogetherLetInTwoWaiters(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	wc := weighChecks(t, s)
	out := make(chan *httptest.ResponseRecorder, 4)
	for range 2 {
		serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(heavyBody), out)
	}
	waitFor(t, "the check to fill", func() bool { return wc.inside.Load() == 2 })
	for range 2 {
		serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(heavyBody), out)
	}
	waitFor(t, "two bodies to wait", func() bool { return s.bodies.waiting.Load() == 2 })

	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); wc.next <- struct{}{} }()
	}
	wg.Wait()
	waitFor(t, "both waiters to be let in", func() bool { return len(wc.entered()) == 4 && wc.inside.Load() == 2 })
	wc.open()
	for range 4 {
		awaitAnswer(t, "a body", out)
	}
	waitFor(t, "the gate to empty", func() bool { return gateIdle(s) })
}

// straightIn reports whether a body of weight n goes into the check without
// waiting: with its context already ended, a body that would have to wait
// gives up at once.
func straightIn(g *bodyGate, n int64) bool {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return g.enter(ctx, n)
}

// A waiter cancelled at the very moment room is handed to it either goes in
// and leaves, or gives its room back; either way the gate ends empty and the
// next body goes straight in.
func TestAWaiterCancelledAsItIsLetInLeavesNoWeight(t *testing.T) {
	g := newBodyGate(MaxBodyBytes, MaxBodyBytes)
	for i := range 500 {
		if !straightIn(g, MaxBodyBytes) {
			t.Fatalf("round %d: the first body did not go straight in", i)
		}
		ctx, cancel := context.WithCancel(context.Background())
		got := make(chan bool, 1)
		go func() { got <- g.enter(ctx, MaxBodyBytes) }()
		for g.waiting.Load() != 1 {
			runtime.Gosched()
		}
		go cancel()
		g.leave(MaxBodyBytes)
		if <-got {
			g.leave(MaxBodyBytes)
		}
		cancel()
		if in, q := g.load(); in != 0 || q != 0 || g.waiting.Load() != 0 {
			t.Fatalf("round %d: %d bytes inside, %d in line, %d waiting, want none", i, in, q, g.waiting.Load())
		}
	}
	if !straightIn(g, MaxBodyBytes) {
		t.Error("a body at the cap did not go straight into an empty gate")
	}
}

// Rounds of bodies of random weight that complete, give up or are cancelled
// leave the gate empty at the end of every round, with no goroutine left, and
// a body at the cap then goes straight in.
func TestEveryQuietMomentFindsTheGateEmpty(t *testing.T) {
	g := newBodyGate(MaxBodyChecks*MaxBodyBytes, MaxBodyWaiters*MaxBodyBytes)
	goroutines := runtime.NumGoroutine()
	rng := rand.New(rand.NewPCG(3, 5))
	for round := range 40 {
		var wg sync.WaitGroup
		for range 48 {
			n := bodyWeight(rng.IntN(MaxBodyBytes + 1))
			mode, before, during := rng.IntN(4), rng.IntN(8), rng.IntN(8)
			wg.Add(1)
			go func() {
				defer wg.Done()
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				switch mode {
				case 0:
					cancel()
				case 1:
					go func() {
						for range before {
							runtime.Gosched()
						}
						cancel()
					}()
				}
				if g.enter(ctx, n) {
					for range during {
						runtime.Gosched()
					}
					g.leave(n)
				}
			}()
		}
		wg.Wait()
		if in, q := g.load(); in != 0 || q != 0 || g.waiting.Load() != 0 {
			t.Fatalf("round %d: %d bytes inside, %d in line, %d waiting, want none", round, in, q, g.waiting.Load())
		}
		if !straightIn(g, MaxBodyBytes) {
			t.Fatalf("round %d: a body at the cap did not go straight into a quiet gate", round)
		}
		g.leave(MaxBodyBytes)
	}
	waitFor(t, "the bodies' goroutines to end", func() bool { return runtime.NumGoroutine() <= goroutines })
}

// The room in the check and in the line is exact: weights summing to the room
// fit, one byte more does not, and the newcomer's own weight is counted before
// the comparison.
func TestTheGatesRoomIsExact(t *testing.T) {
	const room, line = 2 * MaxBodyBytes, 4 * MaxBodyBytes
	g := newBodyGate(room, line)
	for _, n := range []int64{MaxBodyBytes, MaxBodyBytes - 1, 1} {
		if !straightIn(g, n) {
			t.Fatalf("a body of %d did not fit with %d of %d taken", n, func() int64 { in, _ := g.load(); return in }(), room)
		}
	}
	if straightIn(g, 1) {
		t.Fatal("a body went into a check already at its room")
	}

	// The line: weights summing to exactly its room wait; one byte more is
	// refused at once.
	waiters := []int64{MaxBodyBytes, MaxBodyBytes, MaxBodyBytes, MaxBodyBytes - 4096, 4096}
	results := make(chan int64, len(waiters)) // the weight let in, or -1
	for i, n := range waiters {
		go func() {
			if g.enter(context.Background(), n) {
				results <- n
			} else {
				results <- -1
			}
		}()
		waitFor(t, "a body to wait", func() bool { return g.waiting.Load() == int64(i+1) })
	}
	if _, q := g.load(); q != line {
		t.Fatalf("%d bytes in line, want exactly %d", q, line)
	}
	refused := make(chan bool, 1)
	go func() { refused <- g.enter(context.Background(), 1) }()
	select {
	case ok := <-refused:
		if ok {
			t.Error("a body one byte past the line's room was let in")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("a body one byte past the line's room was made to wait")
	}

	g.leave(MaxBodyBytes)
	g.leave(MaxBodyBytes - 1)
	g.leave(1)
	for range waiters {
		select {
		case n := <-results:
			if n < 0 {
				t.Fatal("a waiter was refused")
			}
			g.leave(n)
		case <-time.After(20 * time.Second):
			t.Fatal("a waiter was never let in")
		}
	}
	if in, q := g.load(); in != 0 || q != 0 {
		t.Errorf("%d bytes inside and %d in line at the end, want none", in, q)
	}
}

// A body weighs the bytes actually read, never what Content-Length claims,
// with the floor below it: 0, 1, 4095, 4096, 4097 bytes and the cap, and a
// body whose Content-Length lies either way.
func TestABodyWeighsTheBytesRead(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	var mu sync.Mutex
	var got []int64
	s.bodies.checking = func(n int64) {
		mu.Lock()
		got = append(got, n)
		mu.Unlock()
	}
	cases := []struct {
		size   int
		length int64 // the Content-Length the request claims; -1 for none
	}{
		{0, 0}, {1, 1}, {minBodyWeight - 1, -1}, {minBodyWeight, minBodyWeight}, {minBodyWeight + 1, minBodyWeight + 1},
		{MaxBodyBytes, MaxBodyBytes}, {10000, 10}, {10000, MaxBodyBytes}, {10000, -1},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPost, "/api/send", strings.NewReader(sized(c.size)))
		r.Header.Set("Content-Type", "application/json")
		r.ContentLength = c.length
		if c.length >= 0 {
			r.Header.Set("Content-Length", strconv.FormatInt(c.length, 10))
		}
		s.ServeHTTP(httptest.NewRecorder(), r)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != len(cases) {
		t.Fatalf("%d bodies reached the check, want %d", len(got), len(cases))
	}
	for i, c := range cases {
		if want := bodyWeight(c.size); got[i] != want {
			t.Errorf("a %d-byte body claiming %d bytes weighed %d, want %d", c.size, c.length, got[i], want)
		}
	}
	if !gateIdle(s) {
		t.Error("the bodies left weight in the gate")
	}
}

// A chunked body with no Content-Length, arriving over a real connection,
// weighs the bytes that arrived.
func TestAChunkedBodyWeighsWhatArrived(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	weights := make(chan int64, 1)
	s.bodies.checking = func(n int64) { weights <- n }
	srv := httptest.NewServer(s)
	defer srv.Close()

	const size = 3 * minBodyWeight
	pr, pw := io.Pipe()
	go func() {
		body := sized(size)
		for i := 0; i < len(body); i += 1000 {
			_, _ = pw.Write([]byte(body[i:min(i+1000, len(body))]))
		}
		_ = pw.Close()
	}()
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/send", pr)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("chunked body = %d, want its own 400", resp.StatusCode)
	}
	select {
	case n := <-weights:
		if n != size {
			t.Errorf("a chunked %d-byte body weighed %d", size, n)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the chunked body never reached the check")
	}
}

// 128 bodies at the floor fit in the check at once; the 129th waits.
func TestTheCheckHoldsExactlyAsManyBodiesAtTheFloorAsItsRoom(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	wc := weighChecks(t, s)
	const fit = MaxBodyChecks * MaxBodyBytes / minBodyWeight
	out := make(chan *httptest.ResponseRecorder, fit+1)
	for range fit + 1 {
		serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(undispatchable), out)
	}
	waitFor(t, "the check to fill with small bodies", func() bool {
		return wc.inside.Load() == fit && s.bodies.waiting.Load() == 1
	})
	wc.open()
	for range fit + 1 {
		if rec := awaitAnswer(t, "a small body", out); rec.Code != http.StatusBadRequest {
			t.Errorf("a small body = %d, want its own 400", rec.Code)
		}
	}
	waitFor(t, "the gate to empty", func() bool { return gateIdle(s) })
}

// burst fires bodies at once on alternating routes and returns their answers.
func burst(s *Server, n int, send, run string) []*httptest.ResponseRecorder {
	go1 := make(chan struct{})
	out := make(chan *httptest.ResponseRecorder, n)
	var wg sync.WaitGroup
	for i := range n {
		path, body := "/api/send", send
		if i%2 == 1 {
			path, body = "/api/runs", run
		}
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-go1
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, r)
			out <- rec
		}()
	}
	close(go1)
	wg.Wait()
	close(out)
	var recs []*httptest.ResponseRecorder
	for rec := range out {
		recs = append(recs, rec)
	}
	return recs
}

// Two hundred and a thousand small starts and sends fired at once are never
// answered 503: their weight is far inside the check's room and the line's.
func TestLargeBurstsOfSmallPostsNeverSeeTheBodyGate(t *testing.T) {
	allowed := map[int]bool{http.StatusOK: true, http.StatusAccepted: true, http.StatusConflict: true, http.StatusTooManyRequests: true}
	for _, n := range []int{200, 1000} {
		s := newServer(t, newTarget(t, 0), nil)
		for _, rec := range burst(s, n,
			`{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":200}]}`,
			`{"mode":"functional","sequence":[{"endpoint":"healthz"}]}`) {
			if !allowed[rec.Code] {
				t.Errorf("burst of %d: a small post = %d %.200s, want 200, 202, 409 or 429", n, rec.Code, rec.Body.String())
			}
		}
		waitIdle(t, s)
		waitFor(t, "the gate to empty", func() bool { return gateIdle(s) })
	}
}

// Fifty legitimate bodies of 100 KiB at once: the check holds five and the line
// forty, so at most five are turned away with the 503 the record describes,
// and every other one gets its ordinary answer.
func TestABurstOfLargeBodiesTurnsAwayOnlyWhatTheRoomCannotHold(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	const size, n = 100 << 10, 50
	pad := func(prefix, suffix string) string {
		return prefix + strings.Repeat("x", size-len(prefix)-len(suffix)) + suffix
	}
	recs := burst(s, n,
		pad(`{"endpoint":"healthz","name":"`, `"}`),
		pad(`{"mode":"functional","sequence":[{"endpoint":"healthz","name":"`, `"}]}`))
	const roomFor = MaxBodyChecks*MaxBodyBytes/size + MaxBodyWaiters*MaxBodyBytes/size
	busy := 0
	for _, rec := range recs {
		switch rec.Code {
		case http.StatusOK, http.StatusAccepted, http.StatusConflict, http.StatusTooManyRequests:
		case http.StatusServiceUnavailable:
			busy++
			if eb := checkSmallCleanError(t, "a large body turned away", rec); eb.Error != bodyGateBusy {
				t.Errorf("503 says %q, want %q", eb.Error, bodyGateBusy)
			}
			if rec.Header().Get("Retry-After") == "" {
				t.Error("a 503 has no Retry-After")
			}
		default:
			t.Errorf("a large body = %d %.200s", rec.Code, rec.Body.String())
		}
	}
	t.Logf("%d of %d bodies of %d bytes turned away; room for %d", busy, n, size, roomFor)
	if busy > n-roomFor {
		t.Errorf("%d of %d bodies turned away, want at most %d", busy, n, n-roomFor)
	}
	waitIdle(t, s)
	waitFor(t, "the gate to empty", func() bool { return gateIdle(s) })
}

// Bodies at the cap refused by every early exit after the gate is entered give
// back their weight: more of each than the gate could hold if each kept it.
func TestBodiesRefusedByEveryCheckGiveBackTheirWeight(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	refusals := []struct{ name, body, field string }{
		{"syntax error", `{"endpoint":}`, "body"},
		{"trailing data", `{"endpoint":"healthz"} 1`, "body"},
		{"unknown key", `{"endpoint":"healthz","url":"http://192.0.2.1/"}`, "body"},
		{"duplicate key", `{"endpoint":"healthz","endpoint":"search"}`, "endpoint"},
		{"object assertion value", `{"endpoint":"healthz","assertions":[{"type":"json","path":"$.a","op":"exists","value":{}}]}`, "assertions[0].value"},
		{"type mismatch", `{"endpoint":1}`, "endpoint"},
		{"not an object", `[]`, "body"},
		{"empty", ``, "body"},
	}
	for _, rf := range refusals {
		body := rf.body + strings.Repeat(" ", MaxBodyBytes-len(rf.body))
		for range MaxBodyChecks + MaxBodyWaiters + 2 {
			rec := postRaw(t, s, "/api/send", strings.NewReader(body), "application/json")
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("%s: %d %.200s, want 400", rf.name, rec.Code, rec.Body.String())
			}
			if eb := decode[errorBody](t, rec); eb.Field != rf.field {
				t.Errorf("%s: field %q, want %q", rf.name, eb.Field, rf.field)
			}
		}
		if !gateIdle(s) {
			in, q := s.bodies.load()
			t.Fatalf("%s: %d bytes inside and %d in line after the refusals, want none", rf.name, in, q)
		}
	}
	if !straightIn(s.bodies, MaxBodyBytes) {
		t.Fatal("a body at the cap did not go straight into the gate")
	}
	s.bodies.leave(MaxBodyBytes)
}
