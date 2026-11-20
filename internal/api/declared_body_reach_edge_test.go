package api

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

// neverSent are declared bodies of which no byte is ever sent, at and around
// net/http's drain limit (maxPostHandlerReadBytes, 256 KiB): by length, and
// chunked with a chunk of that size announced and none of it sent. drained
// says whether net/http drains the body before the answer: it does for a
// length under the limit and for any chunked body, whose size it cannot know.
var neverSent = []struct {
	name, framing, first string
	drained              bool
}{
	{"1 byte", "Content-Length: 1\r\n", "", true},
	{"262143 bytes", "Content-Length: 262143\r\n", "", true},
	{"262144 bytes", "Content-Length: 262144\r\n", "", false},
	{"262145 bytes", "Content-Length: 262145\r\n", "", false},
	{"1000000 bytes", "Content-Length: 1000000\r\n", "", false},
	{"chunked, a 1-byte chunk", "Transfer-Encoding: chunked\r\n", "1\r\n", true},
	{"chunked, a 262144-byte chunk", "Transfer-Encoding: chunked\r\n", "40000\r\n", true},
	{"chunked, a 1000000-byte chunk", "Transfer-Encoding: chunked\r\n", "f4240\r\n", true},
	{"chunked, nothing", "Transfer-Encoding: chunked\r\n", "", true},
}

// A stream whose declared body never arrives is ended at the deadline with no
// result when net/http drains that body, and runs whole to run_finished when
// it does not, as the record says of each size and framing.
func TestAStreamWithANeverSentBodyIsEndedExactlyWhenNetHTTPDrainsIt(t *testing.T) {
	const deadline = 200 * time.Millisecond
	const n = 5
	s, srv := newBodyServer(t, newTarget(t, 3*deadline), deadline)
	addr := srv.Listener.Addr().String()
	id := startRun(t, s, payload(n, 0))

	type outcome struct {
		results  int
		finished bool
		status   int
		err      error
	}
	got := make([]outcome, len(neverSent))
	var wg sync.WaitGroup
	for i, c := range neverSent {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, f, st, err := streamOn(addr, id, c.framing, c.first, "", 0)
			got[i] = outcome{r, f, st, err}
		}()
	}
	wg.Wait()
	for i, c := range neverSent {
		o := got[i]
		if o.err != nil {
			t.Errorf("%s: %v", c.name, o.err)
			continue
		}
		if o.status != http.StatusOK {
			t.Errorf("%s: status %d, want the stream's 200", c.name, o.status)
		}
		if c.drained && (o.finished || o.results != 0) {
			t.Errorf("%s: the stream carried %d results, finished %v; want it ended at the deadline, before any result", c.name, o.results, o.finished)
		}
		if !c.drained && (!o.finished || o.results != n) {
			t.Errorf("%s: the stream carried %d results, finished %v; want all %d and run_finished", c.name, o.results, o.finished, n)
		}
	}
	waitIdle(t, s)
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
}

// A GET that reads no body, given one that never arrives, is answered with
// its usual status and its connection closed in every case: no sooner than
// the deadline when net/http drains the body, and without waiting for it when
// net/http does not. No body refusal is counted for any of them.
func TestAGetWithANeverSentBodyIsAnsweredAtTheDeadlineOnlyWhenDrained(t *testing.T) {
	const deadline = 3 * time.Second
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	addr := srv.Listener.Addr().String()
	id := startRun(t, s, payload(1, 0))
	waitIdle(t, s)

	paths := []string{"/api/status", "/api/runs/" + id, "/api/runs", "/healthz", "/metrics", "/"}
	type outcome struct {
		status, path, name string
		took               time.Duration
		closed             bool
	}
	var mu sync.Mutex
	var outs []outcome
	var wg sync.WaitGroup
	for _, path := range paths {
		for _, c := range neverSent {
			wg.Add(1)
			go func() {
				defer wg.Done()
				begun := time.Now()
				o := outcome{path: path, name: c.name}
				conn, err := net.Dial("tcp", addr)
				if err == nil {
					defer conn.Close()
					_, err = io.WriteString(conn, "GET "+path+" HTTP/1.1\r\nHost: example.com\r\n"+c.framing+"\r\n"+c.first)
				}
				var resp *http.Response
				if err == nil {
					_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
					resp, err = http.ReadResponse(bufio.NewReader(conn), nil)
				}
				o.took = time.Since(begun)
				if err != nil {
					o.status = err.Error()
				} else {
					resp.Body.Close()
					o.status = fmt.Sprint(resp.StatusCode)
					o.closed = resp.Close
				}
				mu.Lock()
				outs = append(outs, o)
				mu.Unlock()
			}()
		}
	}
	wg.Wait()
	drained := map[string]bool{}
	for _, c := range neverSent {
		drained[c.name] = c.drained
	}
	for _, o := range outs {
		what := "GET " + o.path + " with " + o.name + " never sent"
		if o.status != "200" {
			t.Errorf("%s = %s, want 200", what, o.status)
			continue
		}
		if !o.closed {
			t.Errorf("%s: the connection is kept, want it closed", what)
		}
		if drained[o.name] && o.took < deadline {
			t.Errorf("%s: answered after %v, before the %v deadline; net/http drains it, so the answer waits for the deadline", what, o.took, deadline)
		}
		if !drained[o.name] && o.took >= deadline {
			t.Errorf("%s: answered after %v, at or past the %v deadline; net/http does not drain it, so nothing waits", what, o.took, deadline)
		}
	}
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
	wantRefusals(t, "GETs whose declared bodies never arrive", s, [3]int{0, 0, 0})
}
