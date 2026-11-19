package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/runner"
)

// answerAfterContinue reads the first final answer on br, past any 100
// Continue.
func answerAfterContinue(t *testing.T, what string, c net.Conn, br *bufio.Reader) (*http.Response, string) {
	t.Helper()
	for {
		resp, body := readAnswer(t, what, c, br)
		if resp.StatusCode != http.StatusContinue {
			return resp, body
		}
	}
}

// streamOn opens the run's stream on a new connection with the given framing
// lines and first bytes, waits before sending later (if any), and reports the
// frames it carried and whether the connection was closed after it.
func streamOn(addr, id, framing, first, later string, pause time.Duration) (results int, finished bool, status int, err error) {
	c, err := net.Dial("tcp", addr)
	if err != nil {
		return 0, false, 0, err
	}
	defer c.Close()
	if _, err := io.WriteString(c, "GET /api/runs/"+id+"/stream HTTP/1.1\r\nHost: example.com\r\n"+framing+"\r\n"+first); err != nil {
		return 0, false, 0, err
	}
	if later != "" {
		time.Sleep(pause)
		if _, err := io.WriteString(c, later); err != nil {
			return 0, false, 0, err
		}
	}
	_ = c.SetReadDeadline(time.Now().Add(30 * time.Second))
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		return 0, false, 0, err
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for sc.Scan() {
		switch strings.TrimPrefix(sc.Text(), "event: ") {
		case runner.EventRequestResult:
			results++
		case runner.EventRunFinished:
			finished = true
		}
	}
	return results, finished, resp.StatusCode, nil
}

// A stream whose request declares a body is cut only when that body never
// arrives and is short enough for net/http to drain. With no body, with its
// five declared bytes sent with the head or a little later, chunked with an
// immediate end, or with Expect: 100-continue (the body is then never asked
// for), the stream of a run that lasts several body read deadlines is carried
// to run_finished. Before the first byte of an answer, net/http reads and
// discards what is left of a body the handler did not read, but only while
// less than 256 KiB of it is left: a declared body under that which never
// arrives holds the answer until the deadline, which then ends the stream
// before any result; one of 256 KiB or more is never drained, so the deadline
// never fires on it and the stream runs whole.
func TestAStreamWithADeclaredBodyIsCutOnlyWhenADrainableBodyNeverArrives(t *testing.T) {
	const deadline = 200 * time.Millisecond
	const n = 6
	// Each request takes three deadlines, so the first result comes well after
	// a cut stream has ended, even on a starved machine.
	s, srv := newBodyServer(t, newTarget(t, 3*deadline), deadline)
	addr := srv.Listener.Addr().String()
	id := startRun(t, s, payload(n, 0))

	// drainLimit is net/http's maxPostHandlerReadBytes.
	const drainLimit = 256 << 10
	cases := []struct {
		name, framing, first, later string
		whole                       bool
	}{
		{"no body", "", "", "", true},
		{"five bytes with the head", "Content-Length: 5\r\n", "abcde", "", true},
		{"five bytes a little later", "Content-Length: 5\r\n", "ab", "cde", true},
		{"chunked, ended at once", "Transfer-Encoding: chunked\r\n", "0\r\n\r\n", "", true},
		{"expecting 100-continue", "Content-Length: 5\r\nExpect: 100-continue\r\n", "", "", true},
		{"five bytes never sent", "Content-Length: 5\r\n", "", "", false},
		{"just under the drain limit never sent", fmt.Sprintf("Content-Length: %d\r\n", drainLimit-1), "", "", false},
		{"the drain limit never sent", fmt.Sprintf("Content-Length: %d\r\n", drainLimit), "", "", true},
		{"over the drain limit never sent", fmt.Sprintf("Content-Length: %d\r\n", drainLimit+40000), "", "", true},
	}
	type outcome struct {
		results  int
		finished bool
		status   int
		err      error
	}
	got := make([]outcome, len(cases))
	var wg sync.WaitGroup
	for i, c := range cases {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, f, st, err := streamOn(addr, id, c.framing, c.first, c.later, deadline/4)
			got[i] = outcome{r, f, st, err}
		}()
	}
	wg.Wait()
	for i, c := range cases {
		o := got[i]
		t.Logf("%s: status %d, %d results, finished %v, err %v", c.name, o.status, o.results, o.finished, o.err)
		if o.err != nil {
			t.Errorf("%s: %v", c.name, o.err)
			continue
		}
		if o.status != http.StatusOK {
			t.Errorf("%s: status %d, want the stream's 200", c.name, o.status)
		}
		if c.whole && (!o.finished || o.results != n) {
			t.Errorf("%s: the stream carried %d results, finished %v; want all %d and run_finished",
				c.name, o.results, o.finished, n)
		}
		if !c.whole && (o.finished || o.results != 0) {
			t.Errorf("%s: the stream carried %d results, finished %v; want it ended at the deadline, before any result",
				c.name, o.results, o.finished)
		}
	}
	waitIdle(t, s)
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 })
}

// The PDF and the status, given a declared body that is sent whole, answer
// as usual and keep the connection for the next request, idle past several
// deadlines; given one that never arrives they still answer, within the
// deadline, and close the connection.
func TestReadsWithADeclaredBodyAnswerAndKeepTheirConnectionWhenItArrives(t *testing.T) {
	const deadline = 200 * time.Millisecond
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	addr := srv.Listener.Addr().String()
	id := startRun(t, s, payload(1, 0))
	waitIdle(t, s)

	for _, path := range []string{"/api/runs/" + id + "/report.pdf", "/api/status"} {
		for _, f := range []struct{ name, framing, body string }{
			{"five bytes", "Content-Length: 5\r\n", "abcde"},
			{"chunked", "Transfer-Encoding: chunked\r\n", "3\r\nabc\r\n0\r\n\r\n"},
		} {
			c := rawPost(t, addr, "GET "+path+" HTTP/1.1\r\nHost: example.com\r\n"+f.framing+"\r\n", f.body)
			br := bufio.NewReader(c)
			resp, body := readAnswer(t, path+" with "+f.name, c, br)
			if resp.StatusCode != http.StatusOK || resp.Close {
				t.Errorf("GET %s with %s sent whole = %d (closed %v) %.100s, want 200 on a kept connection", path, f.name, resp.StatusCode, resp.Close, body)
			}
			time.Sleep(3 * deadline)
			if _, err := io.WriteString(c, "GET /healthz HTTP/1.1\r\nHost: example.com\r\n\r\n"); err != nil {
				t.Fatal(err)
			}
			if resp, body := readAnswer(t, "the next request after "+path, c, br); resp.StatusCode != http.StatusOK {
				t.Errorf("the next request after GET %s with %s = %d %.100s", path, f.name, resp.StatusCode, body)
			}
			_ = c.Close()
		}

		c := rawPost(t, addr, "GET "+path+" HTTP/1.1\r\nHost: example.com\r\nContent-Length: 5\r\n\r\n", "")
		t.Cleanup(func() { _ = c.Close() })
		br := bufio.NewReader(c)
		resp, body := readAnswer(t, path+" with a body never sent", c, br)
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s with a body never sent = %d %.100s, want 200", path, resp.StatusCode, body)
		}
		wantClosed(t, path+" with a body never sent", c, br)
		_ = c.Close()
	}
}

// A Send and a Start whose body arrives in a later packet, well inside the
// deadline, are answered in full although the target takes several deadlines
// to answer; and the connection takes the next request.
func TestASendAndAStartWhoseBodyArrivesLateButInTimeOutliveTheDeadline(t *testing.T) {
	const deadline = 200 * time.Millisecond
	s, srv := newBodyServer(t, newTarget(t, 4*deadline), deadline)
	addr := srv.Listener.Addr().String()
	send := `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":200}]}`
	start, err := json.Marshal(payload(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		path, body string
		want       int
	}{
		{"/api/send", send, http.StatusOK},
		{"/api/runs", string(start), http.StatusAccepted},
	} {
		conn := rawPost(t, addr, postHead(c.path, fmt.Sprintf("Content-Length: %d\r\n", len(c.body))), c.body[:3])
		br := bufio.NewReader(conn)
		time.Sleep(deadline / 4)
		if _, err := io.WriteString(conn, c.body[3:]); err != nil {
			t.Fatal(err)
		}
		resp, body := readAnswer(t, c.path, conn, br)
		if resp.StatusCode != c.want || resp.Close {
			t.Fatalf("%s with a late body and a slow target = %d (closed %v) %s, want %d on a kept connection", c.path, resp.StatusCode, resp.Close, body, c.want)
		}
		if c.path == "/api/send" && !strings.Contains(body, `"passed":true`) {
			t.Errorf("the Send was cut: %s", body)
		}
		if _, err := io.WriteString(conn, "GET /healthz HTTP/1.1\r\nHost: example.com\r\n\r\n"); err != nil {
			t.Fatal(err)
		}
		if resp, _ := readAnswer(t, "the next request after "+c.path, conn, br); resp.StatusCode != http.StatusOK {
			t.Errorf("the next request after %s = %d", c.path, resp.StatusCode)
		}
		_ = conn.Close()
	}
	waitIdle(t, s)
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 })
}

// routeTable reads the routes server.go registers, so a route added later is
// covered without editing this list.
func routeTable(t *testing.T) [][2]string {
	t.Helper()
	src, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	var routes [][2]string
	for _, m := range regexp.MustCompile(`s\.mux\.HandleFunc\("([A-Z]+) ([^"]+)"`).FindAllStringSubmatch(string(src), -1) {
		routes = append(routes, [2]string{m[1], m[2]})
	}
	if !strings.Contains(string(src), "s.mux.Handle(staticPattern,") {
		t.Fatal("server.go no longer registers the file server as staticPattern")
	}
	method, path, _ := strings.Cut(staticPattern, " ")
	routes = append(routes, [2]string{method, path})
	if len(routes) < 10 {
		t.Fatalf("read %d routes from server.go; the table's form has changed", len(routes))
	}
	return routes
}

// Every route the server registers, and a verb no route takes, given a
// declared body that never arrives (by length, chunked, or expecting
// 100-continue), is answered and its connection closed within the body read
// deadline, with the security headers, and under /api in the one error shape;
// and nothing is left serving those connections afterwards.
func TestEveryRouteGivenADeclaredBodyThatNeverArrivesIsAnsweredAndClosed(t *testing.T) {
	const deadline = 100 * time.Millisecond
	marks := []string{"net/http.(*conn).serve", "(*Server).decodeJSON", "(*Server).readBody"}
	s, srv := newBodyServer(t, newTarget(t, 0), deadline)
	addr := srv.Listener.Addr().String()
	id := startRun(t, s, payload(1, 0))
	waitIdle(t, s)
	// Counted once the run's own connections to the target are open.
	before := goroutinesIn(marks...)

	routes := append(routeTable(t), [2]string{http.MethodPut, "/api/runs/{id}"}, [2]string{http.MethodPatch, "/api/nope"})
	framings := map[string]string{
		"a length":            "Content-Length: 1000\r\n",
		"chunked":             "Transfer-Encoding: chunked\r\n",
		"expecting 100":       "Content-Length: 1000\r\nExpect: 100-continue\r\n",
		"a length, one byte":  "Content-Length: 1000\r\n",
		"chunked, half a hex": "Transfer-Encoding: chunked\r\n",
	}
	first := map[string]string{"a length, one byte": "{", "chunked, half a hex": "1"}
	for _, r := range routes {
		path := strings.ReplaceAll(r[1], "{id}", id)
		for how, framing := range framings {
			what := r[0] + " " + path + " with " + how
			c := rawPost(t, addr, r[0]+" "+path+" HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\n"+framing+"\r\n", first[how])
			t.Cleanup(func() { _ = c.Close() })
			br := bufio.NewReader(c)
			resp, body := answerAfterContinue(t, what, c, br)
			wantSecurityHeaders(t, what, resp.Header)
			if isAPIPath(path) && resp.StatusCode >= 400 {
				var eb errorBody
				if resp.Header.Get("Content-Type") != "application/json" || json.Unmarshal([]byte(body), &eb) != nil || eb.Error == "" {
					t.Errorf("%s = %d %q (%s), want the one error shape", what, resp.StatusCode, body, resp.Header.Get("Content-Type"))
				}
			}
			wantClosed(t, what, c, br)
			_ = c.Close()
		}
	}
	waitFor(t, "every place to be given back", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
	waitFor(t, "every goroutine serving those connections to end", func() bool { return goroutinesIn(marks...) <= before })
}

// Bursts of 200 and 1,000 small posts over real connections, at the
// production deadline, each body in the same packet as its head or in a later
// one, see no 503 and no 408: the bounds are not met by ordinary use.
func TestWireBurstsOfSmallPostsMeetNeitherBound(t *testing.T) {
	allowed := map[int]bool{http.StatusOK: true, http.StatusAccepted: true, http.StatusConflict: true, http.StatusTooManyRequests: true}
	send := `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":200}]}`
	start := `{"mode":"functional","sequence":[{"endpoint":"healthz"}]}`
	for _, n := range []int{200, 1000} {
		s, srv := newBodyServer(t, newTarget(t, 0), 0)
		addr := srv.Listener.Addr().String()
		codes := make(chan string, n)
		var wg sync.WaitGroup
		for i := range n {
			path, body := "/api/send", send
			if i%2 == 1 {
				path, body = "/api/runs", start
			}
			split := i%3 == 0
			wg.Add(1)
			go func() {
				defer wg.Done()
				c, err := net.Dial("tcp", addr)
				if err != nil {
					codes <- err.Error()
					return
				}
				defer c.Close()
				head := postHead(path, fmt.Sprintf("Content-Length: %d\r\n", len(body)))
				if split {
					if _, err := io.WriteString(c, head+body[:4]); err != nil {
						codes <- err.Error()
						return
					}
					time.Sleep(time.Millisecond)
					_, err = io.WriteString(c, body[4:])
				} else {
					_, err = io.WriteString(c, head+body)
				}
				if err != nil {
					codes <- err.Error()
					return
				}
				_ = c.SetReadDeadline(time.Now().Add(60 * time.Second))
				resp, err := http.ReadResponse(bufio.NewReader(c), nil)
				if err != nil {
					codes <- err.Error()
					return
				}
				resp.Body.Close()
				if !allowed[resp.StatusCode] {
					codes <- fmt.Sprintf("%s = %d", path, resp.StatusCode)
				}
			}()
		}
		wg.Wait()
		close(codes)
		for c := range codes {
			t.Errorf("burst of %d: %s", n, c)
		}
		waitIdle(t, s)
		waitFor(t, "every place and the gate to empty", func() bool { return readsHeld(s) == 0 && gateIdle(s) })
	}
}
