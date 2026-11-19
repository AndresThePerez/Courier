package api

import (
	"fmt"
	"math/rand/v2"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// bodyRefusalKeys are the /metrics counters of the bodies the bounds turn
// away: no read place, no room in the gate's line, the read deadline.
var bodyRefusalKeys = [3]string{"body_reads_refused", "body_line_refused", "body_reads_timed_out"}

// bodyRefusals reads the three counters off /metrics.
func bodyRefusals(t *testing.T, s *Server) [3]int {
	t.Helper()
	m := readMetrics(t, s)
	var got [3]int
	for i, k := range bodyRefusalKeys {
		got[i] = int(num(t, m, k))
	}
	return got
}

func wantRefusals(t *testing.T, what string, s *Server, want [3]int) {
	t.Helper()
	if got := bodyRefusals(t, s); got != want {
		t.Errorf("%s: %v = %v, want %v", what, bodyRefusalKeys, got, want)
	}
}

const smallPost = "POST %s HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s"

// Each way the bounds turn a body away, met over the wire on both POST routes,
// adds one to its own counter per answer and nothing to the others; what
// happens to the bodies after (the stalled reads hung up, the queued bodies
// checked) adds nothing.
func TestEachBodyRefusalIsCountedOnceUnderItsOwnName(t *testing.T) {
	paths := []string{"/api/send", "/api/runs"}
	small := func(path string) string {
		return fmt.Sprintf(smallPost, path, len(undispatchable), undispatchable)
	}

	t.Run("every read place taken", func(t *testing.T) {
		s, srv := newBodyServer(t, newTarget(t, 0), time.Minute)
		addr := srv.Listener.Addr().String()
		stalls := make([]net.Conn, 0, MaxBodyReads)
		for range MaxBodyReads {
			stalls = append(stalls, rawPost(t, addr, postHead("/api/send", "Content-Length: 1000\r\n"), `{"endpoint":"heal`))
		}
		waitFor(t, "every place to be taken", func() bool { return readsHeld(s) == MaxBodyReads })
		for _, path := range paths {
			if code, err := exchange(addr, small(path), false); err != nil || code != http.StatusServiceUnavailable {
				t.Fatalf("%s with every place taken = %d (%v), want 503", path, code, err)
			}
		}
		wantRefusals(t, "two posts finding every place taken", s, [3]int{2, 0, 0})
		for _, c := range stalls {
			_ = c.Close()
		}
		waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 })
		wantRefusals(t, "the stalled uploads hung up", s, [3]int{2, 0, 0})
	})

	t.Run("the gate's line full", func(t *testing.T) {
		s, srv := newBodyServer(t, newTarget(t, 0), time.Minute)
		addr := srv.Listener.Addr().String()
		h := holdChecks(t, s)
		queued := fillGate(t, s, h)
		for _, path := range paths {
			if code, err := exchange(addr, small(path), false); err != nil || code != http.StatusServiceUnavailable {
				t.Fatalf("%s with the line full = %d (%v), want 503", path, code, err)
			}
		}
		wantRefusals(t, "two posts finding the line full", s, [3]int{0, 2, 0})
		h.open()
		for range MaxBodyChecks + MaxBodyWaiters {
			awaitAnswer(t, "a queued body", queued)
		}
		waitFor(t, "the gate to empty", func() bool { return gateIdle(s) })
		wantRefusals(t, "the queued bodies checked", s, [3]int{0, 2, 0})
	})

	t.Run("the read deadline", func(t *testing.T) {
		s, srv := newBodyServer(t, newTarget(t, 0), 200*time.Millisecond)
		addr := srv.Listener.Addr().String()
		for _, path := range paths {
			if code, err := exchange(addr, postHead(path, "Content-Length: 1000\r\n")+`{"endpoint":"heal`, false); err != nil || code != http.StatusRequestTimeout {
				t.Fatalf("%s stalled = %d (%v), want 408", path, code, err)
			}
		}
		waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 })
		wantRefusals(t, "two stalled bodies", s, [3]int{0, 0, 2})
	})
}

// The answers that are not one of the three are not counted: a 400, a 413, a
// 415, a client that hangs up mid-body, a start the one-run lock refuses, and
// a declared body that never arrives on a route that reads none (the
// middleware's deadline answers it, and the counters leave it out).
func TestAnswersThatAreNotBodyRefusalsAreNotCounted(t *testing.T) {
	s, srv := newBodyServer(t, newTarget(t, 400*time.Millisecond), 200*time.Millisecond)
	addr := srv.Listener.Addr().String()
	for _, c := range []struct {
		name, req string
		want      int
	}{
		{"a 400", fmt.Sprintf(smallPost, "/api/send", len(undispatchable), undispatchable), http.StatusBadRequest},
		{"a 413", postHead("/api/runs", fmt.Sprintf("Content-Length: %d\r\n", MaxBodyBytes+1)) + strings.Repeat(" ", MaxBodyBytes+1), http.StatusRequestEntityTooLarge},
		{"a 415", "POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\n{}", http.StatusUnsupportedMediaType},
		{"a body no route reads, never sent", "PUT /api/runs HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n", http.StatusMethodNotAllowed},
	} {
		if code, err := exchange(addr, c.req, false); err != nil || code != c.want {
			t.Errorf("%s = %d (%v), want %d", c.name, code, err, c.want)
		}
	}
	if _, err := exchange(addr, postHead("/api/send", "Content-Length: 1000\r\n")+`{"endpoint":"heal`, true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the hung-up read to give its place back", func() bool { return readsHeld(s) == 0 })

	startRun(t, s, payload(3, 0))
	start := `{"mode":"functional","sequence":[{"endpoint":"healthz"}]}`
	if code, err := exchange(addr, fmt.Sprintf(smallPost, "/api/runs", len(start), start), false); err != nil || code != http.StatusConflict {
		t.Errorf("a second start during a run = %d (%v), want 409", code, err)
	}
	waitIdle(t, s)
	wantRefusals(t, "answers that are not body refusals", s, [3]int{0, 0, 0})
}

// Thousands of posts ending every way a client can wait for (sent whole and
// small, at the cap, stalled past the deadline) on both routes, from many
// connections at once: the counters end equal to the answers the clients
// received, the two 503 counters together to the 503s and the deadline's to
// the 408s. The check is held until the line has turned bodies away, so the
// flood meets the line's 503 on any machine, however few cores it has.
func TestTheBodyRefusalCountersMatchTheAnswersUnderAMixedFlood(t *testing.T) {
	const deadline = 150 * time.Millisecond
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	addr := srv.Listener.Addr().String()
	h := holdChecks(t, s)
	go func() {
		defer h.open()
		for end := time.Now().Add(20 * time.Second); time.Now().Before(end) && s.metrics.bodyLineRefused.Value() < 20; {
			time.Sleep(time.Millisecond)
		}
	}()
	kinds := []func(path string) string{
		func(path string) string { return fmt.Sprintf(smallPost, path, len(undispatchable), undispatchable) },
		func(path string) string {
			return postHead(path, fmt.Sprintf("Content-Length: %d\r\n", MaxBodyBytes)) + heavyBody
		},
		func(path string) string { return postHead(path, "Content-Length: 100\r\n") + `{"end` },
	}

	const workers, rounds = 160, 15
	var busy, late atomic.Int64
	var bad atomic.Value
	var wg sync.WaitGroup
	for w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rng := rand.New(rand.NewPCG(uint64(w), 41))
			for range rounds {
				path := "/api/send"
				if rng.IntN(2) == 1 {
					path = "/api/runs"
				}
				code, err := exchange(addr, kinds[rng.IntN(len(kinds))](path), false)
				switch {
				case err != nil:
					bad.Store(err.Error())
				case code == http.StatusServiceUnavailable:
					busy.Add(1)
				case code == http.StatusRequestTimeout:
					late.Add(1)
				case code != http.StatusBadRequest:
					bad.Store(fmt.Sprintf("%s = %d", path, code))
				}
			}
		}()
	}
	wg.Wait()
	if v := bad.Load(); v != nil {
		t.Fatal(v)
	}
	waitFor(t, "every place and the gate to empty", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
	got := bodyRefusals(t, s)
	t.Logf("503s %d, 408s %d; counters %v", busy.Load(), late.Load(), got)
	if int64(got[0]+got[1]) != busy.Load() {
		t.Errorf("%s + %s = %d, but the clients received %d 503s", bodyRefusalKeys[0], bodyRefusalKeys[1], got[0]+got[1], busy.Load())
	}
	if int64(got[2]) != late.Load() {
		t.Errorf("%s = %d, but the clients received %d 408s", bodyRefusalKeys[2], got[2], late.Load())
	}
	if busy.Load() == 0 || late.Load() == 0 {
		t.Errorf("%d 503s and %d 408s: the flood must meet both", busy.Load(), late.Load())
	}
}

// The counters are on /metrics, as numbers, at zero on a fresh server.
func TestTheBodyRefusalCountersAreOnMetrics(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	wantRefusals(t, "a fresh server", s, [3]int{0, 0, 0})
}
