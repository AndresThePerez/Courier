package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/runner"
)

// postHead is the head of a POST to path with the given extra header lines.
func postHead(path, extra string) string {
	return "POST " + path + " HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\n" + extra + "\r\n"
}

// A body sent one byte at a time is bounded by the deadline as a whole: each
// byte that arrives does not push the deadline back. The trickle would take a
// minute; the answer comes long before it ends.
func TestABodyTricklingInOneByteAtATimeIsCutByTheDeadlineAsAWhole(t *testing.T) {
	const deadline = 300 * time.Millisecond
	const size = 2000
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	c := rawPost(t, srv.Listener.Addr().String(), postHead("/api/send", fmt.Sprintf("Content-Length: %d\r\n", size)), "{")
	defer c.Close()

	answered := make(chan struct{})
	trickled := make(chan int, 1)
	go func() {
		sent := 1
		defer func() { trickled <- sent }()
		for sent < size {
			select {
			case <-answered:
				return
			case <-time.After(deadline / 10):
			}
			if _, err := io.WriteString(c, " "); err != nil {
				return
			}
			sent++
		}
	}()

	resp, body := readAnswer(t, "a trickled body", c, bufio.NewReader(c))
	close(answered)
	sent := <-trickled
	if resp.StatusCode != http.StatusRequestTimeout {
		t.Fatalf("a body trickled in a byte at a time = %d %s, want 408", resp.StatusCode, body)
	}
	if sent >= size {
		t.Errorf("the whole body of %d bytes was trickled in before the answer: each byte pushed the deadline back", size)
	}
	if !resp.Close {
		t.Error("the connection of a body cut by the deadline was kept open")
	}
	wantSecurityHeaders(t, "the trickled body's 408", resp.Header)
	waitFor(t, "the place to be given back", func() bool { return readsHeld(s) == 0 })
}

// Uploads of every framing a client can choose (chunked with no length,
// Expect: 100-continue, a length larger than what is sent) hold a place like
// any other while they stall, and with every place taken a POST of any
// framing, an empty one included, is answered 503 at once, without a
// 100 Continue that would invite its body.
func TestEveryFramingOfABodyHoldsAPlaceAndMeetsTheBound(t *testing.T) {
	s, srv := newBodyServer(t, newTarget(t, 0), time.Hour)
	addr := srv.Listener.Addr().String()
	framings := []struct{ head, body string }{
		{postHead("/api/send", "Transfer-Encoding: chunked\r\n"), "5\r\n{\"end"},
		{postHead("/api/runs", "Content-Length: 50\r\nExpect: 100-continue\r\n"), ""},
		{postHead("/api/send", "Content-Length: 100000\r\n"), `{"endpoint":"heal`},
	}
	var conns []net.Conn
	defer func() {
		for _, c := range conns {
			_ = c.Close()
		}
	}()
	for i := range MaxBodyReads {
		f := framings[i%len(framings)]
		c := rawPost(t, addr, f.head, f.body)
		conns = append(conns, c)
		if strings.Contains(f.head, "100-continue") {
			// The place is taken when the read asks for the body, which is
			// what sends the 100 Continue; the client then stalls.
			br := bufio.NewReader(c)
			_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
			line, err := br.ReadString('\n')
			if err != nil || !strings.Contains(line, "100") {
				t.Fatalf("an upload expecting 100-continue got %q (%v), want 100 Continue", line, err)
			}
			_, _ = io.WriteString(c, `{"endpoint":`)
		}
		want := int64(i + 1)
		waitFor(t, fmt.Sprintf("upload %d to take its place", i+1), func() bool { return readsHeld(s) == want })
	}

	beyond := []struct{ name, req string }{
		{"chunked", postHead("/api/send", "Transfer-Encoding: chunked\r\n") + "5\r\n{\"end"},
		{"expect 100-continue", postHead("/api/runs", "Content-Length: 20\r\nExpect: 100-continue\r\n")},
		{"empty", postHead("/api/send", "Content-Length: 0\r\n")},
		{"lying length", postHead("/api/runs", "Content-Length: 99999999\r\n") + "{"},
	}
	for _, b := range beyond {
		c, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, c)
		if _, err := io.WriteString(c, b.req); err != nil {
			t.Fatal(err)
		}
		resp, body := readAnswer(t, b.name+" beyond the places", c, bufio.NewReader(c))
		if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, bodyGateBusy) {
			t.Errorf("%s beyond the places = %d %s, want 503 %q (a 100 Continue first would read 100)", b.name, resp.StatusCode, body, bodyGateBusy)
		}
		if resp.Header.Get("Retry-After") != bodyGateRetryAfter || !resp.Close {
			t.Errorf("%s beyond the places: Retry-After %q, closed %v", b.name, resp.Header.Get("Retry-After"), resp.Close)
		}
		wantSecurityHeaders(t, b.name+" 503", resp.Header)
	}
	if n := readsHeld(s); n != MaxBodyReads {
		t.Errorf("%d places held, want %d", n, MaxBodyReads)
	}

	for _, c := range conns {
		_ = c.Close()
	}
	conns = nil
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
	code, err := exchange(addr, postHead("/api/send", fmt.Sprintf("Content-Length: %d\r\n", len(undispatchable)))+undispatchable, false)
	if err != nil || code != http.StatusBadRequest {
		t.Errorf("a post after every place came back = %d (%v), want its own 400", code, err)
	}
}

// An unread body after a 503 is never read as the next request on the
// connection: a body that is itself a well-formed request gets no answer of
// its own, and the connection ends after the 503.
func TestTheUnreadBodyOfA503IsNeverReadAsTheNextRequest(t *testing.T) {
	s, srv := newBodyServer(t, newTarget(t, 0), time.Hour)
	addr := srv.Listener.Addr().String()

	// The same connection first carries an ordinary post and keeps going.
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	br := bufio.NewReader(c)
	if _, err := io.WriteString(c, postHead("/api/send", fmt.Sprintf("Content-Length: %d\r\n", len(undispatchable)))+undispatchable); err != nil {
		t.Fatal(err)
	}
	if resp, body := readAnswer(t, "an ordinary post", c, br); resp.StatusCode != http.StatusBadRequest || resp.Close {
		t.Fatalf("an ordinary post = %d %s (closed %v), want its own 400 on a kept connection", resp.StatusCode, body, resp.Close)
	}

	_, stop := fillPlaces(t, s)
	smuggled := "GET /api/status HTTP/1.1\r\nHost: example.com\r\n\r\n"
	if _, err := io.WriteString(c, postHead("/api/send", fmt.Sprintf("Content-Length: %d\r\n", len(smuggled)))+smuggled); err != nil {
		t.Fatal(err)
	}
	resp, body := readAnswer(t, "a post beyond the places", c, br)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("a post beyond the places = %d %s, want 503", resp.StatusCode, body)
	}
	_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
	rest, err := io.ReadAll(br)
	if err != nil {
		t.Errorf("the connection after the 503 was not closed: %v", err)
	}
	if len(rest) != 0 {
		t.Errorf("after the 503 the connection carried %q: the unread body was read as a request", rest)
	}
	stop()
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 })
}

// Requests pipelined on one connection, empty, chunked and with a length, are
// each answered in turn, none held to another's deadline, and no place is left
// held.
func TestPipelinedPostsAreEachAnsweredAndHoldNoPlaceAfterwards(t *testing.T) {
	const deadline = 300 * time.Millisecond
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	c, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	br := bufio.NewReader(c)
	chunked := fmt.Sprintf("%x\r\n%s\r\n0\r\n\r\n", len(undispatchable), undispatchable)
	pipeline := postHead("/api/send", fmt.Sprintf("Content-Length: %d\r\n", len(undispatchable))) + undispatchable +
		postHead("/api/runs", "Content-Length: 0\r\n") +
		postHead("/api/send", "Transfer-Encoding: chunked\r\n") + chunked +
		"GET /healthz HTTP/1.1\r\nHost: example.com\r\n\r\n"
	if _, err := io.WriteString(c, pipeline); err != nil {
		t.Fatal(err)
	}
	want := []int{http.StatusBadRequest, http.StatusBadRequest, http.StatusBadRequest, http.StatusOK}
	for i, code := range want {
		resp, body := readAnswer(t, fmt.Sprintf("pipelined request %d", i+1), c, br)
		if resp.StatusCode != code {
			t.Errorf("pipelined request %d = %d %.200s, want %d", i+1, resp.StatusCode, body, code)
		}
		if resp.Close {
			t.Fatalf("pipelined request %d closed the connection", i+1)
		}
	}

	// Idle past several deadlines, the connection still takes a post.
	time.Sleep(3 * deadline)
	if _, err := io.WriteString(c, postHead("/api/send", "Transfer-Encoding: chunked\r\n")+chunked); err != nil {
		t.Fatal(err)
	}
	if resp, body := readAnswer(t, "a post after the connection idled", c, br); resp.StatusCode != http.StatusBadRequest || !strings.Contains(body, `"field":"endpoint"`) {
		t.Errorf("a post after the connection idled = %d %s, want its own 400", resp.StatusCode, body)
	}
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
}

// A run started with a body that arrived slowly, in two parts with a pause,
// and then streamed on the same connection, streams to its end although the
// run outlasts several body read deadlines.
func TestAStreamOnTheConnectionOfASlowBodyOutlivesTheDeadline(t *testing.T) {
	const deadline = 300 * time.Millisecond
	s, srv := newBodyServer(t, newTarget(t, deadline), deadline)
	raw, err := json.Marshal(payload(4, 0))
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	c := rawPost(t, srv.Listener.Addr().String(), postHead("/api/runs", fmt.Sprintf("Content-Length: %d\r\n", len(body))), body[:10])
	defer c.Close()
	br := bufio.NewReader(c)
	time.Sleep(deadline / 3)
	if _, err := io.WriteString(c, body[10:]); err != nil {
		t.Fatal(err)
	}
	resp, got := readAnswer(t, "a slow start", c, br)
	if resp.StatusCode != http.StatusAccepted || resp.Close {
		t.Fatalf("a slow start = %d %s (closed %v), want 202 on a kept connection", resp.StatusCode, got, resp.Close)
	}
	var started startedBody
	if err := json.Unmarshal([]byte(got), &started); err != nil {
		t.Fatal(err)
	}

	if _, err := io.WriteString(c, "GET /api/runs/"+started.RunID+"/stream HTTP/1.1\r\nHost: example.com\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(30 * time.Second))
	sresp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sresp.Body.Close()
	if sresp.StatusCode != http.StatusOK {
		t.Fatalf("the stream = %d", sresp.StatusCode)
	}
	frames, _ := readFrames(t, sresp.Body, func(f frame) bool { return f.name == runner.EventRunFinished })
	results := 0
	for _, f := range frames {
		if f.name == runner.EventRequestResult {
			results++
		}
	}
	if len(frames) == 0 || frames[len(frames)-1].name != runner.EventRunFinished || results != 4 {
		t.Errorf("the stream ended after %d frames and %d results, want 4 results and run_finished", len(frames), results)
	}
	waitIdle(t, s)
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 })
}

// goroutinesIn counts the goroutines whose stack mentions any of marks.
func goroutinesIn(marks ...string) int {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]byte, 2*len(buf))
	}
	count := 0
	for _, g := range bytes.Split(buf, []byte("\n\n")) {
		for _, m := range marks {
			if bytes.Contains(g, []byte(m)) {
				count++
				break
			}
		}
	}
	return count
}

// Every way a read ends (complete, over the cap, refused for its type, hung up
// before any byte and mid-body, cut by the deadline, refused for want of a
// place) leaves nothing behind: once the clients are gone, no goroutine is
// still reading a body or serving one of their connections.
func TestNoGoroutineOutlivesAnyWayABodyReadEnds(t *testing.T) {
	const deadline = 200 * time.Millisecond
	marks := []string{"net/http.(*conn).serve", "(*Server).decodeJSON", "(*Server).readBody"}
	before := goroutinesIn(marks...)
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	addr := srv.Listener.Addr().String()

	small := postHead("/api/send", fmt.Sprintf("Content-Length: %d\r\n", len(undispatchable))) + undispatchable
	over := strings.Repeat(" ", MaxBodyBytes+1)
	ends := []struct {
		name   string
		req    string
		hangUp bool
	}{
		{"complete", small, false},
		{"over the cap", postHead("/api/runs", fmt.Sprintf("Content-Length: %d\r\n", len(over))) + over, false},
		{"wrong type", strings.Replace(small, "application/json", "text/plain", 1), false},
		{"hung up before any byte", postHead("/api/send", "Content-Length: 100\r\n"), true},
		{"hung up mid-body", postHead("/api/runs", "Content-Length: 100\r\n") + `{"mo`, true},
		{"deadline", postHead("/api/send", "Content-Length: 100\r\n") + `{"en`, false},
		{"chunked, deadline", postHead("/api/runs", "Transfer-Encoding: chunked\r\n") + "3\r\n{\"m", false},
	}
	for range 3 {
		for _, e := range ends {
			if _, err := exchange(addr, e.req, e.hangUp); err != nil {
				t.Fatalf("%s: %v", e.name, err)
			}
		}
	}
	_, stop := fillPlaces(t, s)
	if code, err := exchange(addr, small, false); err != nil || code != http.StatusServiceUnavailable {
		t.Errorf("a post beyond the places = %d (%v), want 503", code, err)
	}
	stop()

	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
	waitFor(t, "every goroutine reading a body or serving a gone client to end", func() bool {
		return goroutinesIn(marks...) <= before
	})
}

// The place counter taken and given back from many goroutines at once, far
// more than it has places: no more than MaxBodyReads are ever held, the count
// never goes below zero, and it is back at zero once every holder has given
// its place back.
func TestThePlaceCounterHoldsItsBoundUnderContention(t *testing.T) {
	p := &readPlaces{max: MaxBodyReads}
	var holders, most, granted, refused atomic.Int64
	var negative atomic.Bool
	stop := make(chan struct{})
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		for {
			if p.held.Load() < 0 {
				negative.Store(true)
			}
			select {
			case <-stop:
				return
			default:
				runtime.Gosched()
			}
		}
	}()

	const workers, rounds = 4 * MaxBodyReads, 200
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range rounds {
				if !p.take() {
					refused.Add(1)
					continue
				}
				granted.Add(1)
				n := holders.Add(1)
				for m := most.Load(); n > m && !most.CompareAndSwap(m, n); m = most.Load() {
				}
				runtime.Gosched()
				holders.Add(-1)
				p.give()
			}
		}()
	}
	wg.Wait()
	close(stop)
	<-watched

	if m := most.Load(); m > MaxBodyReads {
		t.Errorf("%d places were held at once, want at most %d", m, MaxBodyReads)
	}
	if negative.Load() {
		t.Error("the count of places held went below zero")
	}
	if n := p.held.Load(); n != 0 {
		t.Errorf("%d places held after every holder gave its place back, want 0", n)
	}
	if granted.Load() == 0 || refused.Load() == 0 {
		t.Errorf("%d takes granted and %d refused: the case must meet the bound and pass it", granted.Load(), refused.Load())
	}
	if granted.Load()+refused.Load() != workers*rounds {
		t.Errorf("%d takes answered, want %d", granted.Load()+refused.Load(), workers*rounds)
	}
}
