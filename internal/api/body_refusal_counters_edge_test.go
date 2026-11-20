package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// refusalTally counts the answers clients received, by the counter each one
// belongs to. A 503 for want of a read place is the only 503 that closes the
// connection (the body is left unread); the line's 503 comes after the body
// was read whole, so the connection is kept.
type refusalTally struct {
	read, line, late, other atomic.Int64
	bad                     atomic.Value
}

func (r *refusalTally) add(resp *http.Response) {
	switch {
	case resp.StatusCode == http.StatusServiceUnavailable && resp.Close:
		r.read.Add(1)
	case resp.StatusCode == http.StatusServiceUnavailable:
		r.line.Add(1)
	case resp.StatusCode == http.StatusRequestTimeout:
		r.late.Add(1)
	default:
		r.other.Add(1)
	}
}

func (r *refusalTally) got() [3]int {
	return [3]int{int(r.read.Load()), int(r.line.Load()), int(r.late.Load())}
}

// readAll reads every answer that arrives on c until it closes, the reader
// gives up, or want answers have come, and tallies each.
func (r *refusalTally) readAll(c net.Conn, want int) {
	_ = c.SetReadDeadline(time.Now().Add(60 * time.Second))
	br := bufio.NewReader(c)
	for range want {
		resp, err := http.ReadResponse(br, nil)
		if err != nil {
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		r.add(resp)
		if resp.Close {
			return
		}
	}
}

// flood sends every kind of request the two POST routes answer, in every
// framing, from workers connections at once, and tallies what comes back.
func flood(t *testing.T, addr string, tally *refusalTally, workers, rounds int, seed uint64) {
	t.Helper()
	send := `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":200}]}`
	start := `{"mode":"functional","sequence":[{"endpoint":"healthz"}]}`
	paths := []string{"/api/send", "/api/runs"}
	whole := func(path, body string) string {
		return postHead(path, fmt.Sprintf("Content-Length: %d\r\n", len(body))) + body
	}
	chunked := func(path, body string) string {
		return postHead(path, "Transfer-Encoding: chunked\r\n") + fmt.Sprintf("%x\r\n%s\r\n0\r\n\r\n", len(body), body)
	}
	kinds := []func(c net.Conn, path string) (int, error){
		// a small body, sent whole: 400 or a 503 of either kind
		func(c net.Conn, path string) (int, error) {
			_, err := io.WriteString(c, whole(path, undispatchable))
			return 1, err
		},
		// the same, chunked
		func(c net.Conn, path string) (int, error) {
			_, err := io.WriteString(c, chunked(path, undispatchable))
			return 1, err
		},
		// malformed JSON: a 400 of its own kind
		func(c net.Conn, path string) (int, error) {
			_, err := io.WriteString(c, whole(path, `{"endpoint":`))
			return 1, err
		},
		// a body at the cap
		func(c net.Conn, path string) (int, error) {
			_, err := io.WriteString(c, postHead(path, fmt.Sprintf("Content-Length: %d\r\n", MaxBodyBytes))+heavyBody)
			return 1, err
		},
		// a stalled upload: 408 or the read place's 503
		func(c net.Conn, path string) (int, error) {
			_, err := io.WriteString(c, postHead(path, "Content-Length: 1000\r\n")+`{"endpoint":"heal`)
			return 1, err
		},
		// a 415
		func(c net.Conn, path string) (int, error) {
			_, err := io.WriteString(c, "POST "+path+" HTTP/1.1\r\nHost: example.com\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\n{}")
			return 1, err
		},
		// two posts pipelined in one write: the second is answered only when
		// the first keeps the connection
		func(c net.Conn, path string) (int, error) {
			_, err := io.WriteString(c, whole(path, undispatchable)+chunked(path, undispatchable))
			return 2, err
		},
		// a valid send or start: 200, 202, a 409 from the lock or the
		// cooldown, a 429, or a 503
		func(c net.Conn, path string) (int, error) {
			body := send
			if path == "/api/runs" {
				body = start
			}
			_, err := io.WriteString(c, whole(path, body))
			return 1, err
		},
	}
	// expect sends its head alone with Expect: 100-continue and its body only
	// once asked for it; a 503 for want of a place is given without asking.
	expect := func(c net.Conn, path string) {
		head := postHead(path, fmt.Sprintf("Content-Length: %d\r\nExpect: 100-continue\r\n", len(undispatchable)))
		if _, err := io.WriteString(c, head); err != nil {
			tally.bad.Store(err.Error())
			return
		}
		_ = c.SetReadDeadline(time.Now().Add(60 * time.Second))
		br := bufio.NewReader(c)
		resp, err := http.ReadResponse(br, nil)
		if err != nil {
			tally.bad.Store("expect: " + err.Error())
			return
		}
		if resp.StatusCode == http.StatusContinue {
			if _, err := io.WriteString(c, undispatchable); err != nil {
				tally.bad.Store(err.Error())
				return
			}
			if resp, err = http.ReadResponse(br, nil); err != nil {
				tally.bad.Store("expect, after 100: " + err.Error())
				return
			}
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		tally.add(resp)
	}

	var wg sync.WaitGroup
	for w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rng := rand.New(rand.NewPCG(seed, uint64(w)))
			for range rounds {
				path := paths[rng.IntN(len(paths))]
				c, err := net.Dial("tcp", addr)
				if err != nil {
					tally.bad.Store(err.Error())
					return
				}
				if k := rng.IntN(len(kinds) + 1); k == len(kinds) {
					expect(c, path)
				} else {
					want, err := kinds[k](c, path)
					if err != nil {
						tally.bad.Store(err.Error())
					} else {
						tally.readAll(c, want)
					}
				}
				_ = c.Close()
			}
		}()
	}
	wg.Wait()
}

// A flood in three stages, every request kind and framing in each, on both
// routes, with /metrics scraped throughout: first with every read place held
// (the place's 503s), then with the places free and the gate's line full
// (the line's 503s), then with the check open (ordinary answers, 409s from
// the lock and the cooldown, 429s); stalled uploads meet the deadline in
// every stage. Each counter ends equal to the answers of its own cause the
// clients received, told apart on the wire, and every cause occurred.
func TestEachRefusalCounterEqualsTheAnswersOfItsOwnCauseInAStagedFlood(t *testing.T) {
	const deadline = 2 * time.Second
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	addr := srv.Listener.Addr().String()
	h := holdChecks(t, s)
	queued := fillGate(t, s, h)

	var tally refusalTally
	var holders sync.WaitGroup
	for i := range MaxBodyReads {
		path := "/api/send"
		if i%2 == 1 {
			path = "/api/runs"
		}
		c := rawPost(t, addr, postHead(path, "Content-Length: 1000\r\n"), `{"endpoint":"heal`)
		holders.Add(1)
		go func() {
			defer holders.Done()
			defer c.Close()
			tally.readAll(c, 1)
		}()
	}
	waitFor(t, "every place to be taken", func() bool { return readsHeld(s) == MaxBodyReads })

	stopScrape := make(chan struct{})
	scraped := make(chan error, 1)
	go func() { scraped <- scrapeUntil(addr, stopScrape) }()

	// Stage one: every place held, so a read is refused at once.
	flood(t, addr, &tally, 64, 2, 1)
	if tally.read.Load() == 0 {
		t.Fatal("no post met every place taken")
	}
	holders.Wait()
	waitFor(t, "the held places to be given back", func() bool { return readsHeld(s) < MaxBodyReads })

	// Stage two: the line is full, so a body read whole is refused.
	flood(t, addr, &tally, 64, 2, 2)
	if tally.line.Load() == 0 {
		t.Fatal("no post met the line full")
	}

	// Stage three: the check open.
	h.open()
	for range MaxBodyChecks + MaxBodyWaiters {
		awaitAnswer(t, "a queued body", queued)
	}
	flood(t, addr, &tally, 64, 2, 3)

	close(stopScrape)
	if err := <-scraped; err != nil {
		t.Error(err)
	}
	if v := tally.bad.Load(); v != nil {
		t.Fatal(v)
	}
	waitIdle(t, s)
	waitFor(t, "every place and the gate to empty", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
	got, want := bodyRefusals(t, s), tally.got()
	t.Logf("received %v (and %d other answers); counters %v", want, tally.other.Load(), got)
	if got != want {
		t.Errorf("%v = %v, but the clients received %v answers of each cause", bodyRefusalKeys, got, want)
	}
	if want[2] == 0 {
		t.Error("no post met the deadline")
	}
}

// scrapeUntil reads /metrics over the wire until stop is closed: each answer
// is a JSON object of numbers with the same keys, and the three counters
// never go back.
func scrapeUntil(addr string, stop <-chan struct{}) error {
	var keys []string
	var last [3]float64
	for n := 0; ; n++ {
		select {
		case <-stop:
			if n == 0 {
				return fmt.Errorf("/metrics was never scraped")
			}
			return nil
		default:
		}
		code, body, err := get(addr, "GET /metrics HTTP/1.1\r\nHost: example.com\r\n\r\n")
		if err != nil {
			return fmt.Errorf("scrape %d: %v", n, err)
		}
		if code != http.StatusOK {
			return fmt.Errorf("scrape %d: %d", n, code)
		}
		var m map[string]any
		if err := json.Unmarshal(body, &m); err != nil {
			return fmt.Errorf("scrape %d: %v in %s", n, err, body)
		}
		got := slices.Sorted(func(yield func(string) bool) {
			for k := range m {
				if !yield(k) {
					return
				}
			}
		})
		if keys == nil {
			keys = got
		} else if !slices.Equal(keys, got) {
			return fmt.Errorf("scrape %d: keys %v, were %v", n, got, keys)
		}
		for i, k := range bodyRefusalKeys {
			v, ok := m[k].(float64)
			if !ok {
				return fmt.Errorf("scrape %d: %q = %v", n, k, m[k])
			}
			if v < last[i] {
				return fmt.Errorf("scrape %d: %q went back from %v to %v", n, k, last[i], v)
			}
			last[i] = v
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// get sends req on a new connection and returns the answer's status and body.
func get(addr, req string) (int, []byte, error) {
	c, err := net.Dial("tcp", addr)
	if err != nil {
		return 0, nil, err
	}
	defer c.Close()
	if _, err := io.WriteString(c, req); err != nil {
		return 0, nil, err
	}
	_ = c.SetReadDeadline(time.Now().Add(30 * time.Second))
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	return resp.StatusCode, b, err
}

// A client that hangs up before its body, during it, or once it has sent it
// whole while its body waits in the gate's line, is answered by no one and
// counted nowhere; nor is a body that waited in line and was then let in.
func TestAClientThatHangsUpAnywhereIsNotCounted(t *testing.T) {
	s, srv := newBodyServer(t, newTarget(t, 0), time.Minute)
	addr := srv.Listener.Addr().String()
	h := holdChecks(t, s)
	// Two bodies at the cap fill the check; the rest wait in line with room.
	inside := make([]net.Conn, 0, MaxBodyChecks)
	for range MaxBodyChecks {
		inside = append(inside, rawPost(t, addr, postHead("/api/send", fmt.Sprintf("Content-Length: %d\r\n", MaxBodyBytes)), heavyBody))
	}
	waitFor(t, "the check to fill", func() bool { return h.inside.Load() == MaxBodyChecks })

	for _, path := range []string{"/api/send", "/api/runs"} {
		// before the body
		c := rawPost(t, addr, postHead(path, "Content-Length: 100\r\n"), "")
		waitFor(t, "the read to begin", func() bool { return readsHeld(s) == 1 })
		_ = c.Close()
		waitFor(t, "its place to be given back", func() bool { return readsHeld(s) == 0 })
		// during the body
		c = rawPost(t, addr, postHead(path, "Content-Length: 100\r\n"), `{"endpoint":`)
		waitFor(t, "the read to begin", func() bool { return readsHeld(s) == 1 })
		_ = c.Close()
		waitFor(t, "its place to be given back", func() bool { return readsHeld(s) == 0 })
		// after the body, while it waits in line
		c = rawPost(t, addr, postHead(path, fmt.Sprintf("Content-Length: %d\r\n", len(undispatchable))), undispatchable)
		waitFor(t, "the body to wait in line", func() bool { return s.bodies.waiting() == 1 })
		_ = c.Close()
		waitFor(t, "the body to leave the line", func() bool { return s.bodies.waiting() == 0 })
	}
	wantRefusals(t, "clients that hung up", s, [3]int{0, 0, 0})

	// A body that waits in line and is let in is not a refusal either.
	c := rawPost(t, addr, postHead("/api/runs", fmt.Sprintf("Content-Length: %d\r\n", len(undispatchable))), undispatchable)
	defer c.Close()
	waitFor(t, "the body to wait in line", func() bool { return s.bodies.waiting() == 1 })
	h.open()
	if resp, body := readAnswer(t, "a body let in after waiting", c, bufio.NewReader(c)); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("a body let in after waiting = %d %s, want 400", resp.StatusCode, body)
	}
	for _, ic := range inside {
		if resp, body := readAnswer(t, "a body at the cap", ic, bufio.NewReader(ic)); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("a body at the cap = %d %s, want 400", resp.StatusCode, body)
		}
		_ = ic.Close()
	}
	waitFor(t, "the gate to empty", func() bool { return gateIdle(s) })
	wantRefusals(t, "clients that hung up, and a body let in", s, [3]int{0, 0, 0})
}

// What /metrics prints is the same JSON, with the same keys in the same
// order, whatever requests came before it: hostile paths, headers, methods
// and bodies on both routes and elsewhere leave no trace of themselves in it.
func TestMetricsCarryNothingAClientSent(t *testing.T) {
	s, srv := newBodyServer(t, newTarget(t, 0), 200*time.Millisecond)
	addr := srv.Listener.Addr().String()
	const sentinel = "zz-sentinel-0000"
	const sentinelSend = `{"endpoint":"` + sentinel + `"}`
	const sentinelRun = `{"` + sentinel + `":1}`
	_, before, err := get(addr, "GET /metrics HTTP/1.1\r\nHost: example.com\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	h := holdChecks(t, s)
	queued := fillGate(t, s, h)
	for _, req := range []string{
		"POST /api/send?" + sentinel + "=1 HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nX-" + sentinel + ": " + sentinel + "\r\nUser-Agent: " + sentinel + fmt.Sprintf("\r\nContent-Length: %d\r\n\r\n", len(sentinelSend)) + sentinelSend,
		"POST /api/runs/" + sentinel + " HTTP/1.1\r\nHost: " + sentinel + "\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
		"POST /api/runs HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json; " + sentinel + fmt.Sprintf("=1\r\nContent-Length: %d\r\n\r\n", len(sentinelRun)) + sentinelRun,
		"GET /metrics?" + sentinel + " HTTP/1.1\r\nHost: example.com\r\nCookie: " + sentinel + "=1\r\n\r\n",
		postHead("/api/send", "Content-Length: 100\r\n") + `{"` + sentinel,
	} {
		if _, _, err := get(addr, req); err != nil {
			t.Fatal(err)
		}
	}
	h.open()
	for range MaxBodyChecks + MaxBodyWaiters {
		awaitAnswer(t, "a queued body", queued)
	}
	waitFor(t, "every place and the gate to empty", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
	_, after, err := get(addr, "GET /metrics HTTP/1.1\r\nHost: example.com\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(bytes.ToLower(after), []byte(sentinel)) {
		t.Errorf("/metrics carries what a client sent: %s", after)
	}
	if got := bodyRefusals(t, s); got[1] == 0 || got[2] == 0 {
		t.Errorf("counters %v: the hostile posts must meet the line and the deadline", got)
	}
	if k1, k2 := jsonKeyOrder(t, before), jsonKeyOrder(t, after); !slices.Equal(k1, k2) || !slices.IsSorted(k1) {
		t.Errorf("keys before %v, after %v: want the same, in sorted order", k1, k2)
	}
	for _, k := range bodyRefusalKeys {
		if !bytes.Contains(before, []byte(`"`+k+`": 0`)) {
			t.Errorf("a fresh /metrics does not print %q at zero: %s", k, before)
		}
	}
}

// jsonKeyOrder is the top-level keys of a JSON object in the order written.
func jsonKeyOrder(t *testing.T, b []byte) []string {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(b))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		t.Fatalf("not an object: %s", b)
	}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, tok.(string))
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			t.Fatal(err)
		}
	}
	return keys
}
