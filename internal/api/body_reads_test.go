package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/runner"
)

// readsHeld is how many bodies hold a place: how many are being read.
func readsHeld(s *Server) int64 { return s.reads.held.Load() }

// newBodyServer is a Server with its body read deadline set to d, behind a
// real listener, so the deadline reaches a real connection.
func newBodyServer(t *testing.T, target string, d time.Duration) (*Server, *httptest.Server) {
	t.Helper()
	s := New(testStatic(), Options{TargetURL: target, TargetDisplay: "test-target", BodyReadDeadline: d})
	srv := httptest.NewServer(s)
	t.Cleanup(func() {
		srv.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := s.Close(ctx); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	return s, srv
}

// readAnswer reads one response from c, waiting a generous while.
func readAnswer(t *testing.T, what string, c net.Conn, br *bufio.Reader) (*http.Response, string) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("%s: no answer: %v", what, err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(b)
}

// wantSecurityHeaders fails when an answer lacks the headers every route sets.
func wantSecurityHeaders(t *testing.T, what string, h http.Header) {
	t.Helper()
	for _, k := range []string{"Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy", "X-Frame-Options"} {
		if h.Get(k) == "" {
			t.Errorf("%s has no %s header", what, k)
		}
	}
}

// fillPlaces starts MaxBodyReads uploads on both routes that stall after their
// first bytes, and returns once every one of them is being read. stop ends
// them; their answers arrive on the returned channel.
func fillPlaces(t *testing.T, s *Server) (<-chan *httptest.ResponseRecorder, func()) {
	t.Helper()
	out := make(chan *httptest.ResponseRecorder, MaxBodyReads)
	var stops []func()
	for i := range MaxBodyReads {
		path := "/api/send"
		if i%2 == 1 {
			path = "/api/runs"
		}
		body, read, stop := stallingBody(`{"endpoint":"heal`)
		stops = append(stops, stop)
		serveAsync(context.Background(), s, path, "application/json", body, out)
		select {
		case <-read:
		case <-time.After(20 * time.Second):
			t.Fatal("a stalled upload was never read")
		}
	}
	var once sync.Once
	stopAll := func() {
		once.Do(func() {
			for _, stop := range stops {
				stop()
			}
		})
	}
	t.Cleanup(stopAll)
	return out, stopAll
}

// With MaxBodyReads uploads in hand, the next POST on either route is answered
// 503 at once, in the gate's shape and with its Retry-After, and its body is
// never read. Content-Type is still judged first.
func TestAPostBeyondMaxBodyReadsIsAnswered503WithoutBeingRead(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	stalled, stop := fillPlaces(t, s)

	for _, path := range []string{"/api/send", "/api/runs"} {
		r := &countingReader{}
		rec := postRaw(t, s, path, r, "application/json")
		if n := r.reads.Load(); n != 0 {
			t.Errorf("%s with every place taken: the body was read %d times", path, n)
		}
		eb := wantError(t, rec, http.StatusServiceUnavailable, "")
		if eb.Error != bodyGateBusy {
			t.Errorf("%s: 503 says %q, want %q", path, eb.Error, bodyGateBusy)
		}
		if got := rec.Header().Get("Retry-After"); got != bodyGateRetryAfter {
			t.Errorf("%s: Retry-After = %q, want %q", path, got, bodyGateRetryAfter)
		}
		if got := rec.Header().Get("Connection"); got != "close" {
			t.Errorf("%s: Connection = %q, want close: the unread body must not be drained before the answer", path, got)
		}
		wantSecurityHeaders(t, path+" 503", rec.Header())
		checkSmallCleanError(t, path+" 503", rec)

		wantError(t, postRaw(t, s, path, &countingReader{}, "text/plain"), http.StatusUnsupportedMediaType, "body")
	}
	if n := readsHeld(s); n != MaxBodyReads {
		t.Errorf("%d places held with every stalled upload still arriving, want %d", n, MaxBodyReads)
	}

	stop()
	for range MaxBodyReads {
		wantError(t, awaitAnswer(t, "a broken upload", stalled), http.StatusBadRequest, "body")
	}
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
	wantError(t, postRaw(t, s, "/api/send", strings.NewReader(undispatchable), "application/json"), http.StatusBadRequest, "endpoint")
}

// Over a real connection the 503 does not wait for a body that is not coming:
// a POST that declares a body and sends none of it is answered at once, and
// the connection is closed rather than drained.
func TestAPostBeyondMaxBodyReadsIsAnsweredAtOnceOverTheWire(t *testing.T) {
	s, srv := newBodyServer(t, newTarget(t, 0), time.Hour)
	addr := srv.Listener.Addr().String()
	head := "POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n"
	var conns []net.Conn
	defer func() {
		for _, c := range conns {
			_ = c.Close()
		}
	}()
	for range MaxBodyReads {
		conns = append(conns, rawPost(t, addr, head, `{"endpoint":"heal`))
	}
	waitFor(t, "every place to be taken", func() bool { return readsHeld(s) == MaxBodyReads })

	c := rawPost(t, addr, head, "")
	defer c.Close()
	resp, body := readAnswer(t, "a POST beyond the places", c, bufio.NewReader(c))
	if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, bodyGateBusy) {
		t.Errorf("a POST beyond the places = %d %s, want 503 %q", resp.StatusCode, body, bodyGateBusy)
	}
	if !resp.Close {
		t.Error("the connection of an unread body was kept open")
	}

	for _, c := range conns {
		_ = c.Close()
	}
	conns = nil
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
}

// An upload that stops arriving is answered 408 once the body read deadline
// passes, in the one error shape, and its place is given back.
func TestAStalledUploadIsEndedByTheBodyReadDeadline(t *testing.T) {
	const deadline = 300 * time.Millisecond
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	for _, path := range []string{"/api/send", "/api/runs"} {
		c := rawPost(t, srv.Listener.Addr().String(),
			"POST "+path+" HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n",
			`{"endpoint":"heal`)
		t.Cleanup(func() { _ = c.Close() })
		br := bufio.NewReader(c)
		resp, body := readAnswer(t, path+" stalled", c, br)
		if resp.StatusCode != http.StatusRequestTimeout {
			t.Fatalf("%s stalled = %d %s, want 408", path, resp.StatusCode, body)
		}
		if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("%s: Content-Type = %q, want application/json", path, ct)
		}
		var eb errorBody
		if err := json.Unmarshal([]byte(body), &eb); err != nil {
			t.Fatalf("%s: %q is not the error shape: %v", path, body, err)
		}
		if want := "the body did not arrive within " + deadline.String(); eb.Field != "body" || eb.Error != want {
			t.Errorf("%s: 408 says %+v, want field body and %q", path, eb, want)
		}
		if !resp.Close {
			t.Errorf("%s: the connection was kept open after a body that never arrived", path)
		}
		wantSecurityHeaders(t, path+" 408", resp.Header)
		wantClosed(t, path+" 408", c, br)
		_ = c.Close()
		waitFor(t, "the place to be given back", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
	}
}

// A handler that works longer than the body read deadline after its body has
// arrived still answers: a Send waits on the target, not on the client.
func TestTheBodyReadDeadlineDoesNotReachTheHandlersOwnWork(t *testing.T) {
	const deadline = 200 * time.Millisecond
	s, srv := newBodyServer(t, newTarget(t, 5*deadline), deadline)
	resp, err := http.Post(srv.URL+"/api/send", "application/json",
		strings.NewReader(`{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":200}]}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("a Send slower than the body read deadline = %d %s, want 200", resp.StatusCode, b)
	}
	var res sendResult
	if err := json.Unmarshal(b, &res); err != nil || res.Status != http.StatusOK || !res.Passed || res.Error != "" {
		t.Errorf("a Send slower than the body read deadline answered %s (%v)", b, err)
	}
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 })
}

// A body that arrives slowly but within the deadline is read rather than cut,
// a body that arrived in time does not close its connection, and the next
// request on that connection, sent after it sat idle for longer than the
// deadline, is answered. The reset of the read deadline between requests is
// the standard library's own (net/http sets it afresh for every request and
// clears it when a body reaches its end), so this does not depend on
// readBody's explicit clear; it guards the first two against a deadline that
// is too short or a connection closed after a good body.
func TestTheNextRequestOnAConnectionIsNotHeldToTheLastBodysDeadline(t *testing.T) {
	const deadline = time.Second
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	body := `{"endpoint":"nowhere"}`
	head := fmt.Sprintf("POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n", len(body))
	c := rawPost(t, srv.Listener.Addr().String(), head, body[:5])
	defer c.Close()
	br := bufio.NewReader(c)
	time.Sleep(deadline / 10)
	if _, err := io.WriteString(c, body[5:]); err != nil {
		t.Fatal(err)
	}
	resp, got := readAnswer(t, "a slow first body", c, br)
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(got, `"field":"endpoint"`) {
		t.Fatalf("a slow first body = %d %s, want its own 400", resp.StatusCode, got)
	}
	if resp.Close {
		t.Fatal("the connection was closed after a body that arrived in time")
	}

	time.Sleep(2 * deadline)
	if _, err := io.WriteString(c, head+body); err != nil {
		t.Fatal(err)
	}
	resp, got = readAnswer(t, "the next request on the connection", c, br)
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(got, `"field":"endpoint"`) {
		t.Errorf("the next request on the connection = %d %s, want its own 400", resp.StatusCode, got)
	}
	if _, err := io.WriteString(c, "GET /healthz HTTP/1.1\r\nHost: example.com\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	if resp, got = readAnswer(t, "a GET after it", c, br); resp.StatusCode != http.StatusOK {
		t.Errorf("a GET after it = %d %s, want 200", resp.StatusCode, got)
	}
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 })
}

// A stream opened on the connection a run was started on stays open past the
// body read deadline, for the whole run.
func TestAStreamOutlivesTheBodyReadDeadline(t *testing.T) {
	const deadline = 200 * time.Millisecond
	s, srv := newBodyServer(t, newTarget(t, 2*deadline), deadline)
	client := &http.Client{Transport: &http.Transport{MaxConnsPerHost: 1}}
	defer client.CloseIdleConnections()

	raw, _ := json.Marshal(payload(3, 0))
	resp, err := client.Post(srv.URL+"/api/runs", "application/json", strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("POST /api/runs = %d %s, want 202", resp.StatusCode, b)
	}
	var started startedBody
	if err := json.Unmarshal(b, &started); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/runs/"+started.RunID+"/stream", nil)
	sresp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer sresp.Body.Close()
	frames, _ := readFrames(t, sresp.Body, func(f frame) bool { return f.name == runner.EventRunFinished })
	results := 0
	for _, f := range frames {
		if f.name == runner.EventRequestResult {
			results++
		}
	}
	if len(frames) == 0 || frames[len(frames)-1].name != runner.EventRunFinished || results != 3 {
		t.Errorf("the stream ended after %d frames and %d results, want 3 results and run_finished", len(frames), results)
	}
	waitIdle(t, s)
}

// While every place is taken by stalled uploads, the routes that read no body
// are answered as usual: the reads, the stream, the PDF and the page.
func TestEveryRouteWithoutABodyIsAnsweredWhileEveryPlaceIsTaken(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	id := startRun(t, s, payload(1, 0))
	waitIdle(t, s)
	stalled, stop := fillPlaces(t, s)

	cases := []struct {
		method, path string
		want         int
	}{
		{http.MethodGet, "/healthz", http.StatusOK},
		{http.MethodGet, "/metrics", http.StatusOK},
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
		rec := awaitAnswer(t, c.method+" "+c.path+" with every place taken", out)
		if rec.Code != c.want {
			t.Errorf("%s %s with every place taken = %d %.200s, want %d", c.method, c.path, rec.Code, rec.Body.String(), c.want)
		}
	}
	if n := readsHeld(s); n != MaxBodyReads {
		t.Errorf("%d places held, want the %d stalled uploads", n, MaxBodyReads)
	}
	stop()
	for range MaxBodyReads {
		awaitAnswer(t, "a broken upload", stalled)
	}
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 })
}

// panickingReader panics on its first read.
type panickingReader struct{}

func (panickingReader) Read([]byte) (int, error) { panic("read fault") }

// A read that panics gives its place back.
func TestAPanicWhileReadingGivesBackItsPlace(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	for range MaxBodyReads + 1 {
		func() {
			defer func() { _ = recover() }()
			r := httptest.NewRequest(http.MethodPost, "/api/send", panickingReader{})
			r.Header.Set("Content-Type", "application/json")
			s.decodeJSON(httptest.NewRecorder(), r, new(struct{}))
		}()
	}
	if n := readsHeld(s); n != 0 {
		t.Errorf("%d places held after reads that panicked, want 0", n)
	}
}

// A body waiting in the gate's line holds no place: the line is bounded by
// its own bytes, and a place held there too would leave an ordinary burst of
// small posts a 503 whenever the check filled for a moment.
func TestABodyWaitingInTheGatesLineHoldsNoPlace(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	h := holdChecks(t, s)
	queued := fillGate(t, s, h)
	if n := readsHeld(s); n != 0 {
		t.Errorf("%d places held by bodies in the check and in line, want 0", n)
	}
	h.open()
	for range MaxBodyChecks + MaxBodyWaiters {
		awaitAnswer(t, "a queued body", queued)
	}
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
}

// Thousands of reads ending every way a read can end (in full, over the cap,
// broken off by the client, broken chunking, cut by the deadline) and refused
// for want of a place never hold more than MaxBodyReads places, and leave
// none held.
func TestEveryWayABodyReadEndsGivesBackItsPlace(t *testing.T) {
	const deadline = 150 * time.Millisecond
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	addr := srv.Listener.Addr().String()
	head := func(path, extra string) string {
		return "POST " + path + " HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\n" + extra + "\r\n"
	}
	small := `{"endpoint":"nowhere"}`
	over := strings.Repeat(" ", MaxBodyBytes+1)
	kinds := []struct {
		name string
		run  func(path string) (int, error)
	}{
		{"complete", func(path string) (int, error) {
			return exchange(addr, head(path, fmt.Sprintf("Content-Length: %d\r\n", len(small)))+small, false)
		}},
		{"over the cap", func(path string) (int, error) {
			return exchange(addr, head(path, fmt.Sprintf("Content-Length: %d\r\n", len(over)))+over, false)
		}},
		{"hung up", func(path string) (int, error) {
			return exchange(addr, head(path, "Content-Length: 100\r\n")+small[:5], true)
		}},
		{"broken chunking", func(path string) (int, error) {
			return exchange(addr, head(path, "Transfer-Encoding: chunked\r\n")+"zz\r\n", false)
		}},
		{"deadline", func(path string) (int, error) {
			return exchange(addr, head(path, "Content-Length: 100\r\n")+small[:5], false)
		}},
	}
	want := map[string][]int{
		"complete":        {http.StatusBadRequest, http.StatusServiceUnavailable},
		"over the cap":    {http.StatusRequestEntityTooLarge, http.StatusServiceUnavailable, http.StatusRequestTimeout},
		"hung up":         {0},
		"broken chunking": {http.StatusBadRequest, http.StatusServiceUnavailable},
		"deadline":        {http.StatusRequestTimeout, http.StatusServiceUnavailable},
	}

	var most atomic.Int64
	stopWatch := make(chan struct{})
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		for {
			if n := readsHeld(s); n > most.Load() {
				most.Store(n)
			}
			select {
			case <-stopWatch:
				return
			default:
				time.Sleep(time.Millisecond)
			}
		}
	}()

	const workers, rounds = 160, 15
	var wg sync.WaitGroup
	var bad atomic.Value
	for w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rng := rand.New(rand.NewPCG(uint64(w), 29))
			for range rounds {
				k := kinds[rng.IntN(len(kinds))]
				path := "/api/send"
				if rng.IntN(2) == 1 {
					path = "/api/runs"
				}
				code, err := k.run(path)
				if err != nil {
					bad.Store(fmt.Sprintf("%s on %s: %v", k.name, path, err))
					return
				}
				ok := false
				for _, c := range want[k.name] {
					ok = ok || c == code
				}
				if !ok {
					bad.Store(fmt.Sprintf("%s on %s = %d, want one of %v", k.name, path, code, want[k.name]))
				}
			}
		}()
	}
	wg.Wait()
	close(stopWatch)
	<-watched
	if v := bad.Load(); v != nil {
		t.Error(v)
	}
	if m := most.Load(); m > MaxBodyReads {
		t.Errorf("%d places were held at once, want at most %d", m, MaxBodyReads)
	}
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
}

// exchange writes req on a new connection and returns the status of the
// answer, or 0 when hangUp closes the connection without waiting for one.
func exchange(addr, req string, hangUp bool) (int, error) {
	c, err := net.Dial("tcp", addr)
	if err != nil {
		return 0, err
	}
	defer c.Close()
	if _, err := io.WriteString(c, req); err != nil {
		return 0, err
	}
	if hangUp {
		return 0, nil
	}
	_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

// Stalled uploads, bodies at the cap and small posts arriving together: the
// places and the gate each stay within their bounds, every request is
// answered with one of the answers the bounds give, and both empty afterwards.
//
// The deadline is long enough that a starved server (a shared runner, -race)
// still reads every body that was sent whole: under a short one a body at the
// cap could be answered 408 with no defect anywhere. Nothing here waits for
// it: each stalled upload hangs up once every other request has its answer,
// which ends its read and gives its place back as surely as the deadline does.
func TestThePlacesAndTheGateHoldTogetherUnderAMixedFlood(t *testing.T) {
	const deadline = 10 * time.Second
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	addr := srv.Listener.Addr().String()
	stallHead := "POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n"
	capHead := fmt.Sprintf("POST /api/runs HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n", MaxBodyBytes)

	var most, mostInside, mostQueued atomic.Int64
	stopWatch := make(chan struct{})
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		for {
			if n := readsHeld(s); n > most.Load() {
				most.Store(n)
			}
			in, q := s.bodies.load()
			if in > mostInside.Load() {
				mostInside.Store(in)
			}
			if q > mostQueued.Load() {
				mostQueued.Store(q)
			}
			select {
			case <-stopWatch:
				return
			default:
				time.Sleep(time.Millisecond)
			}
		}
	}()

	type answer struct {
		kind string
		code int
		err  error
	}
	out := make(chan answer, 3*2*MaxBodyReads)
	var sent, stalls sync.WaitGroup
	fire := func(kind, req string) {
		sent.Add(1)
		go func() {
			defer sent.Done()
			code, err := exchange(addr, req, false)
			out <- answer{kind, code, err}
		}()
	}
	// stall sends the head and the first bytes of a body, then waits for its
	// answer until every other request has had its own, and hangs up. A stall
	// still being read when it hangs up is reported as code 0; a connection
	// that ends with no answer before then is an error.
	othersAnswered := make(chan struct{})
	stall := func() {
		stalls.Add(1)
		go func() {
			defer stalls.Done()
			c, err := net.Dial("tcp", addr)
			if err != nil {
				out <- answer{"stalled", 0, err}
				return
			}
			defer c.Close()
			if _, err := io.WriteString(c, stallHead+`{"endpoint":"heal`); err != nil {
				out <- answer{"stalled", 0, err}
				return
			}
			got := make(chan answer, 1)
			go func() {
				resp, err := http.ReadResponse(bufio.NewReader(c), nil)
				if err != nil {
					got <- answer{"stalled", 0, err}
					return
				}
				resp.Body.Close()
				got <- answer{"stalled", resp.StatusCode, nil}
			}()
			select {
			case a := <-got:
				out <- a
			case <-othersAnswered:
				c.Close()
				a := <-got
				a.err = nil
				out <- a
			}
		}()
	}
	small := fmt.Sprintf("POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s", len(undispatchable), undispatchable)
	for i := range 2 * MaxBodyReads {
		if i%5 < 2 {
			fire("at the cap", capHead+heavyBody)
		}
		fire("small", small)
		stall()
	}
	sent.Wait()
	close(othersAnswered)
	stalls.Wait()
	close(out)
	close(stopWatch)
	<-watched

	allowed := map[string]map[int]bool{
		"stalled":    {0: true, http.StatusRequestTimeout: true, http.StatusServiceUnavailable: true},
		"at the cap": {http.StatusBadRequest: true, http.StatusServiceUnavailable: true},
		"small":      {http.StatusBadRequest: true, http.StatusServiceUnavailable: true},
	}
	counts := map[string]int{}
	for a := range out {
		if a.err != nil {
			t.Errorf("%s: %v", a.kind, a.err)
			continue
		}
		counts[fmt.Sprintf("%s %d", a.kind, a.code)]++
		if !allowed[a.kind][a.code] {
			t.Errorf("%s = %d", a.kind, a.code)
		}
	}
	t.Logf("answers: %v", counts)
	if m := most.Load(); m > MaxBodyReads {
		t.Errorf("%d places were held at once, want at most %d", m, MaxBodyReads)
	}
	if m := mostInside.Load(); m > MaxBodyChecks*MaxBodyBytes {
		t.Errorf("%d bytes were checked at once, want at most %d", m, MaxBodyChecks*MaxBodyBytes)
	}
	if m := mostQueued.Load(); m > MaxBodyWaiters*MaxBodyBytes {
		t.Errorf("%d bytes waited at once, want at most %d", m, MaxBodyWaiters*MaxBodyBytes)
	}
	waitFor(t, "every place and the gate to empty", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
	code, err := exchange(addr, small, false)
	if err != nil || code != http.StatusBadRequest {
		t.Errorf("a small post after the flood = %d (%v), want its own 400", code, err)
	}
}
