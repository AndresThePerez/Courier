package api

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

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
			_ = conn.SetReadDeadline(time.Now().Add(20 * time.Second))
			if n, err := br.Read(make([]byte, 1)); err == nil {
				t.Errorf("%s with %s: %d more bytes after the answer, want the connection closed", c.name, how, n)
			}
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
