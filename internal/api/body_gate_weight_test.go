package api

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// A body at the cap that has to wait is let in before every body that arrived
// after it, however small: the line is kept in arrival order, so a stream of
// small posts cannot hold a large one out.
func TestABodyAtTheCapIsAdmittedBeforeSmallerOnesBehindIt(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	heavy, light := make(chan struct{}), make(chan struct{})
	var heavyOnce, lightOnce sync.Once
	openLight := func() { lightOnce.Do(func() { close(light) }) }
	openAll := func() { openLight(); heavyOnce.Do(func() { close(heavy) }) }
	t.Cleanup(openAll)
	var mu sync.Mutex
	var order []int64
	s.bodies.checking = func(n int64) {
		mu.Lock()
		order = append(order, n)
		mu.Unlock()
		if n == MaxBodyBytes {
			<-heavy
		} else {
			<-light
		}
	}
	entered := func() []int64 {
		mu.Lock()
		defer mu.Unlock()
		return append([]int64(nil), order...)
	}

	const small = `{"endpoint":"nowhere"}`
	const behind = 5
	out := make(chan *httptest.ResponseRecorder, 3+behind)
	post := func(body string) {
		serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(body), out)
	}
	// One body at the cap and one small one in the check leave less than a
	// body at the cap of room.
	post(heavyBody)
	waitFor(t, "the first body at the cap to be checked", func() bool { return len(entered()) == 1 })
	post(small)
	waitFor(t, "the small body to be checked", func() bool { return len(entered()) == 2 })
	post(heavyBody)
	waitFor(t, "the second body at the cap to wait", func() bool { return s.bodies.waiting.Load() == 1 })
	for range behind {
		post(small)
	}
	waitFor(t, "every small body to wait or be let in", func() bool {
		return s.bodies.waiting.Load()+int64(len(entered())-2) == 1+behind
	})
	if got := entered(); len(got) != 2 {
		t.Fatalf("bodies checked so far weigh %v: a small body went ahead of the body at the cap waiting before it", got)
	}

	// The small body leaves; the body at the cap now fits, and the small ones
	// behind it no longer do.
	openLight()
	waitFor(t, "the waiting body at the cap to be let in", func() bool { return len(entered()) == 3 })
	if got := entered(); got[2] != MaxBodyBytes {
		t.Errorf("third body let in weighs %d, want the body at the cap (%d) that arrived first", got[2], MaxBodyBytes)
	}
	if w := s.bodies.waiting.Load(); w != behind {
		t.Errorf("%d bodies waiting, want the %d small ones behind it", w, behind)
	}

	openAll()
	for range 3 + behind {
		if rec := awaitAnswer(t, "a body", out); rec.Code != http.StatusBadRequest {
			t.Errorf("a body = %d %.200s, want its own 400", rec.Code, rec.Body.String())
		}
	}
	waitFor(t, "the gate to empty", func() bool { return gateIdle(s) })
}

// A body weighs its length, and never less than minBodyWeight: a check costs
// something beside its body's bytes, and an empty body must still count. The
// floor covers that cost at the same ratio a body at the cap is held to.
func TestAShortBodyWeighsTheFloor(t *testing.T) {
	for _, tc := range []struct{ n, want int }{
		{0, minBodyWeight}, {1, minBodyWeight}, {minBodyWeight, minBodyWeight},
		{minBodyWeight + 1, minBodyWeight + 1}, {MaxBodyBytes, MaxBodyBytes},
	} {
		if got := bodyWeight(tc.n); got != int64(tc.want) {
			t.Errorf("a %d-byte body weighs %d, want %d", tc.n, got, tc.want)
		}
	}

	ratio := uint64(wideDecodeBound / MaxBodyBytes)
	for _, body := range []string{"", "{", `{}`, `{"endpoint":"nowhere"}`, `{"mode":"functional","sequence":[{"endpoint":"healthz"}]}`} {
		alloc := minAlloc(t, func() {
			r := httptest.NewRequest(http.MethodPost, "/api/runs", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			decodeJSON(httptest.NewRecorder(), r, new(sandbox.RunRequest))
		})
		if limit := ratio * minBodyWeight; alloc > limit {
			t.Errorf("checking %q allocated %d bytes, more than %d x the floor (%d)", body, alloc, ratio, limit)
		}
	}

	s := newServer(t, newTarget(t, 0), nil)
	for _, body := range []string{"", "{"} {
		for _, path := range []string{"/api/send", "/api/runs"} {
			wantError(t, postRaw(t, s, path, strings.NewReader(body), "application/json"), http.StatusBadRequest, "body")
		}
	}
	if !gateIdle(s) {
		t.Error("short bodies left weight in the gate")
	}
}

// enterDeadline bounds an enter that is not cancelled on purpose, so a body
// left waiting while room is free fails an assertion instead of hanging the
// test. Generous: suites running alongside must never trip it.
const enterDeadline = 10 * time.Second

// Bodies of every weight, completing, giving up or cancelled while room is
// handed to them, never put more than the gate's weight in the check or in
// line, and leave both at zero.
func TestTheBodyGateWeighsMixedSizesThroughCancelAndComplete(t *testing.T) {
	const maxInside, maxQueued = 2 * MaxBodyBytes, 4 * MaxBodyBytes
	g := newBodyGate(maxInside, maxQueued)
	var inside, most, stuck atomic.Int64
	var bad atomic.Value
	const workers, rounds = 64, 80
	var wg sync.WaitGroup
	for w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rng := rand.New(rand.NewPCG(uint64(w), 11))
			for range rounds {
				if stuck.Load() > 0 {
					return
				}
				n := bodyWeight(rng.IntN(MaxBodyBytes + 1))
				ctx, cancel := context.WithTimeout(context.Background(), enterDeadline)
				switch rng.IntN(3) {
				case 0:
					cancel()
				case 1:
					go func() { runtime.Gosched(); cancel() }()
				}
				ok := g.enter(ctx, n)
				if !ok && errors.Is(ctx.Err(), context.DeadlineExceeded) {
					stuck.Add(1)
				}
				if ok {
					v := inside.Add(n)
					for m := most.Load(); v > m && !most.CompareAndSwap(m, v); m = most.Load() {
					}
					runtime.Gosched()
					inside.Add(-n)
					g.leave(n)
				}
				cancel()
				in, q := g.load()
				if in < 0 || in > maxInside || q < 0 || q > maxQueued {
					bad.Store(fmt.Sprintf("%d bytes inside and %d in line", in, q))
				}
			}
		}()
	}
	wg.Wait()
	if n := stuck.Load(); n > 0 {
		t.Errorf("%d bodies waited out their %s deadline while room was free: a wake-up was lost or room was kept", n, enterDeadline)
	}
	if v := bad.Load(); v != nil {
		t.Errorf("the gate's weights left their bounds: %s", v)
	}
	if m := most.Load(); m > maxInside {
		t.Errorf("%d bytes were checked at once, want at most %d", m, maxInside)
	}
	if in, q := g.load(); in != 0 || q != 0 || g.waiting.Load() != 0 || len(g.line) != 0 {
		t.Errorf("after every body ended: %d bytes inside, %d bytes and %d bodies in line, want none", in, q, g.waiting.Load())
	}
}

// A body the shape check refuses gives its room back. More such bodies at the
// cap than the gate could hold if each kept its room are posted one after
// another; every one is answered, and the gate is empty afterwards.
func TestABodyTheShapeCheckRefusesGivesBackItsRoom(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	refused := `{"endpoint":1}` + strings.Repeat(" ", MaxBodyBytes-len(`{"endpoint":1}`))
	for i := range MaxBodyChecks + MaxBodyWaiters + 2 {
		out := make(chan *httptest.ResponseRecorder, 1)
		serveAsync(context.Background(), s, "/api/send", "application/json", strings.NewReader(refused), out)
		rec := awaitAnswer(t, fmt.Sprintf("refused body %d", i), out)
		wantError(t, rec, http.StatusBadRequest, "endpoint")
	}
	if !gateIdle(s) {
		inside, queued := s.bodies.load()
		t.Fatalf("after refused bodies: %d bytes inside and %d in line, want none", inside, queued)
	}
	wantError(t, do(t, s, http.MethodPost, "/api/send", undispatchable), http.StatusBadRequest, "endpoint")
}
