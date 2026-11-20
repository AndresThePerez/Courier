package api

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// wantClosed fails unless the server closes conn after its answer within a
// generous wait. A read that times out is a connection still open, not one
// closed.
func wantClosed(t *testing.T, what string, conn net.Conn, br *bufio.Reader) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(20 * time.Second))
	n, err := br.Read(make([]byte, 1))
	var ne net.Error
	switch {
	case err == nil:
		t.Errorf("%s: %d more bytes after the answer, want the connection closed", what, n)
	case errors.As(err, &ne) && ne.Timeout():
		t.Errorf("%s: the connection was still open 20s after the answer", what)
	}
}

// A request that declares a body and then sends none of it, on a path that
// answers without reading it, is still answered, and its connection closed,
// within the body read deadline: net/http drains a declared body before an
// answer goes out, and nothing else would bound that drain.
func TestAnAnswerThatReadsNoBodyIsNotHeldByOneThatNeverArrives(t *testing.T) {
	const deadline = 300 * time.Millisecond
	_, srv := newBodyServer(t, newTarget(t, 0), deadline)
	addr := srv.Listener.Addr().String()
	declared := map[string]string{
		"a Content-Length": "Content-Length: 1000\r\n",
		"chunked":          "Transfer-Encoding: chunked\r\n",
	}
	cases := []struct {
		name, method, path, contentType string
		want                            int
	}{
		{"a POST that is not JSON", http.MethodPost, "/api/send", "text/plain", http.StatusUnsupportedMediaType},
		{"a POST to runs that is not JSON", http.MethodPost, "/api/runs", "text/plain", http.StatusUnsupportedMediaType},
		{"a verb a route does not take", http.MethodPut, "/api/runs", "application/json", http.StatusMethodNotAllowed},
		{"an unknown API path", http.MethodPost, "/api/nope", "application/json", http.StatusNotFound},
		{"a cancel", http.MethodDelete, "/api/runs/run-x", "application/json", http.StatusNotFound},
		{"a read", http.MethodGet, "/healthz", "application/json", http.StatusOK},
		{"a POST to the page", http.MethodPost, "/", "application/json", http.StatusMethodNotAllowed},
	}
	for _, c := range cases {
		for how, header := range declared {
			conn := rawPost(t, addr, c.method+" "+c.path+" HTTP/1.1\r\nHost: example.com\r\nContent-Type: "+c.contentType+"\r\n"+header+"\r\n", "")
			t.Cleanup(func() { _ = conn.Close() })
			br := bufio.NewReader(conn)
			resp, body := readAnswer(t, c.name+" with "+how+" and no body", conn, br)
			if resp.StatusCode != c.want {
				t.Errorf("%s with %s and no body = %d %.200s, want %d", c.name, how, resp.StatusCode, body, c.want)
			}
			wantClosed(t, c.name+" with "+how, conn, br)
		}
	}
}

// A 415 whose small body was sent whole is answered as before: the same
// status, shape and headers, and its connection is closed.
func TestA415WithItsWholeBodyIsAnsweredAsBefore(t *testing.T) {
	_, srv := newBodyServer(t, newTarget(t, 0), 300*time.Millisecond)
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/send", strings.NewReader(`{"endpoint":"healthz"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "text/plain")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d %s, want 415", resp.StatusCode, raw)
	}
	var eb errorBody
	if err := json.Unmarshal(raw, &eb); err != nil || eb.Field != "body" || eb.Error != "Content-Type must be application/json" {
		t.Errorf("body = %s (%v), want the one error shape naming the body", raw, err)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q", ct)
	}
	wantSecurityHeaders(t, "the 415", resp.Header)
	if !resp.Close {
		t.Error("the 415 of a declared body kept its connection open")
	}
}

// With every place taken, a POST that declares a body and sends none is
// answered 503 at once, and its connection is closed within the body read
// deadline rather than held open while net/http waits to drain the body. An
// answer that closes its connection (this 503, a 415) is not held for the
// body, but the connection lasts to the deadline while net/http reads on.
func TestAnUnread503IsClosedWithinTheBodyReadDeadline(t *testing.T) {
	s, srv := newBodyServer(t, newTarget(t, 0), 300*time.Millisecond)
	fillPlaces(t, s)
	for how, header := range map[string]string{"a Content-Length": "Content-Length: 1000\r\n", "chunked": "Transfer-Encoding: chunked\r\n"} {
		conn := rawPost(t, srv.Listener.Addr().String(), "POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: application/json\r\n"+header+"\r\n", "")
		t.Cleanup(func() { _ = conn.Close() })
		br := bufio.NewReader(conn)
		resp, body := readAnswer(t, "a POST beyond the places with "+how, conn, br)
		if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, bodyGateBusy) {
			t.Errorf("a POST beyond the places with %s = %d %s, want 503", how, resp.StatusCode, body)
		}
		wantClosed(t, "the unread 503 with "+how, conn, br)
	}

	const deadline = 3 * time.Second
	long, longSrv := newBodyServer(t, newTarget(t, 0), deadline)
	fillPlaces(t, long)
	for what, contentType := range map[string]string{"the 503": "application/json", "a 415": "text/plain"} {
		begun := time.Now()
		conn := rawPost(t, longSrv.Listener.Addr().String(), "POST /api/send HTTP/1.1\r\nHost: example.com\r\nContent-Type: "+contentType+"\r\nContent-Length: 1000\r\n\r\n", "")
		t.Cleanup(func() { _ = conn.Close() })
		br := bufio.NewReader(conn)
		readAnswer(t, what, conn, br)
		if took := time.Since(begun); took >= deadline {
			t.Errorf("%s with its body never sent: answered after %v, at or past the %v deadline", what, took, deadline)
		}
		wantClosed(t, what, conn, br)
		if ended := time.Since(begun); ended < deadline {
			t.Errorf("%s with its body never sent: the connection ended after %v, before the %v deadline", what, ended, deadline)
		}
	}
}
