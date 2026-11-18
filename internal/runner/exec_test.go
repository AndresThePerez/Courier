package runner

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

func searchReq(params map[string]string) sandbox.Request {
	return sandbox.Request{ID: "r", Name: "r", Endpoint: "search", Params: params}
}

func TestDoBuildsSandboxedURL(t *testing.T) {
	var gotPath, gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		fmt.Fprint(w, `{"total":1}`)
	}))
	defer srv.Close()

	res := NewExecutor(srv.URL).Do(context.Background(), searchReq(map[string]string{"q": "pika chu", "sort": "hp"}), true)
	if res.Err != nil {
		t.Fatalf("Do: %v", res.Err)
	}
	if gotPath != "/api/search" {
		t.Errorf("path = %q, want /api/search", gotPath)
	}
	if !strings.Contains(gotQuery, "q=pika+chu") || !strings.Contains(gotQuery, "sort=hp") {
		t.Errorf("query = %q, want encoded q and sort", gotQuery)
	}
	if res.Status != 200 || string(res.Body) != `{"total":1}` {
		t.Errorf("res = %d %q", res.Status, res.Body)
	}
}

func TestQueryIsStableAndEmptyWithoutParams(t *testing.T) {
	ex := NewExecutor("http://example.invalid")
	if q := ex.Query(searchReq(nil)); q != "" {
		t.Errorf("Query(no params) = %q, want empty", q)
	}
	// Sorted by key, so a report renders the same string every time.
	want := "?q=pikachu&sort=hp"
	if q := ex.Query(searchReq(map[string]string{"sort": "hp", "q": "pikachu"})); q != want {
		t.Errorf("Query = %q, want %q", q, want)
	}
}

func TestURLResolvesThroughTheCatalogOnly(t *testing.T) {
	ex := NewExecutor("http://target.internal/")
	got, err := ex.URL(searchReq(map[string]string{"q": "a"}))
	if err != nil {
		t.Fatalf("URL: %v", err)
	}
	if got != "http://target.internal/api/search?q=a" {
		t.Errorf("URL = %q", got)
	}
	if _, err := ex.URL(sandbox.Request{Endpoint: "admin"}); err == nil {
		t.Error("URL must refuse an endpoint that is not in the catalog")
	}
}

func TestDoRejectsUnknownEndpoint(t *testing.T) {
	res := NewExecutor("http://127.0.0.1:1").Do(context.Background(), sandbox.Request{Endpoint: "admin"}, false)
	if res.Err == nil {
		t.Fatal("unknown endpoint must not produce a request")
	}
}

func TestDoMeasuresToEndOfBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		time.Sleep(120 * time.Millisecond) // headers early, body late
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer srv.Close()

	res := NewExecutor(srv.URL).Do(context.Background(), searchReq(nil), true)
	if res.LatencyMs < 100 {
		t.Errorf("latency = %vms, want >= 100 (measured to end-of-body)", res.LatencyMs)
	}
}

func TestDoCountsSizeWithoutKeepingBody(t *testing.T) {
	body := strings.Repeat("x", 5000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
	defer srv.Close()

	res := NewExecutor(srv.URL).Do(context.Background(), searchReq(nil), false)
	if res.Size != len(body) {
		t.Errorf("size = %d, want %d", res.Size, len(body))
	}
	if res.Body != nil {
		t.Error("keepBody=false must not retain the body")
	}
}

func TestDoCountsWholeBodyBeyondTheReadCap(t *testing.T) {
	body := strings.Repeat("y", MaxBodyBytes+4096)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
	defer srv.Close()

	res := NewExecutor(srv.URL).Do(context.Background(), searchReq(nil), true)
	if res.Err != nil {
		t.Fatalf("Do: %v", res.Err)
	}
	if len(res.Body) != MaxBodyBytes {
		t.Errorf("retained %d bytes, want the %d cap", len(res.Body), MaxBodyBytes)
	}
	if res.Size != len(body) {
		t.Errorf("size = %d, want the full %d — the remainder must still be drained and counted", res.Size, len(body))
	}
}

func TestDoReusesConnections(t *testing.T) {
	var conns int64
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"ok":true}`)
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			atomic.AddInt64(&conns, 1)
		}
	}
	srv.Start()
	defer srv.Close()

	ex := NewExecutor(srv.URL)
	for i := 0; i < 20; i++ {
		if res := ex.Do(context.Background(), searchReq(nil), false); res.Err != nil {
			t.Fatalf("Do: %v", res.Err)
		}
	}
	if n := atomic.LoadInt64(&conns); n > 2 {
		t.Errorf("opened %d connections for 20 sequential requests; bodies are not being drained or the transport is untuned", n)
	}
}

func TestDoClassifiesErrors(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer slow.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if res := NewExecutor(slow.URL).Do(ctx, searchReq(nil), false); res.ErrKind != ErrKindTimeout {
		t.Errorf("ErrKind = %q, want timeout (err %v)", res.ErrKind, res.Err)
	}

	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	addr := dead.URL
	dead.Close()
	if res := NewExecutor(addr).Do(context.Background(), searchReq(nil), false); res.ErrKind != ErrKindConnection {
		t.Errorf("ErrKind = %q, want connection (err %v)", res.ErrKind, res.Err)
	}
}

// A run's own abort must be distinguishable from a target failure. This is the
// discriminator the whole aborted-dispatch accounting rule rests on.
func TestDoClassifiesOurOwnAbort(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, abort := context.WithCancelCause(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		abort(ErrRunAborted)
	}()
	res := NewExecutor(srv.URL).Do(ctx, searchReq(nil), false)
	if res.ErrKind != ErrKindAborted {
		t.Errorf("ErrKind = %q, want aborted (err %v)", res.ErrKind, res.Err)
	}
}

// A plain cancellation with no sentinel cause is somebody else's cancel, not
// ours, and must not be laundered into an abort.
func TestDoDoesNotClaimForeignCancellationsAsAborts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	res := NewExecutor(srv.URL).Do(ctx, searchReq(nil), false)
	if res.ErrKind == ErrKindAborted {
		t.Errorf("ErrKind = %q; only this run's own sentinel may mark a dispatch aborted", res.ErrKind)
	}
}

func TestDoRecordsNon2xxWithoutError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"elasticsearch unavailable"}`, http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	res := NewExecutor(srv.URL).Do(context.Background(), searchReq(nil), true)
	if res.Err != nil || res.Status != 503 {
		t.Errorf("non-2xx must be a normal response: status %d err %v", res.Status, res.Err)
	}
}

func TestEntriesResolvePathsFromTheCatalog(t *testing.T) {
	ex := NewExecutor("http://target.internal")
	got := Entries(ex, []sandbox.Request{
		{ID: "1", Name: "search", Endpoint: "search", Params: map[string]string{"q": "a"}},
		{ID: "2", Name: "health", Endpoint: "healthz"},
	})
	if len(got) != 2 {
		t.Fatalf("got %d entries", len(got))
	}
	if got[0].Path != "/api/search" || got[0].Query != "?q=a" || got[0].Index != 0 {
		t.Errorf("entry 0 = %+v", got[0])
	}
	if got[1].Path != "/healthz" || got[1].Query != "" || got[1].Index != 1 {
		t.Errorf("entry 1 = %+v", got[1])
	}
}

// closedTarget is the base URL of a port nothing listens on any more.
func closedTarget(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	addr := srv.URL
	srv.Close()
	return addr
}

// droppingTarget sends a status line and half a body, then hangs up.
func droppingTarget(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"total\":")
		_ = buf.Flush()
	}))
	t.Cleanup(srv.Close)
	return srv
}

// hangingTarget never answers until the client gives up.
func hangingTarget(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	return srv
}

// withTimeout is the executor with its per-request ceiling shortened, so a
// test of the timeout path does not wait out the real one.
func withTimeout(ex *Executor, d time.Duration) *Executor {
	ex.client.Timeout = d
	return ex
}

// goErrorText is text only a Go transport error carries. None of it may reach
// a visitor.
var goErrorText = []string{
	"dial tcp", "lookup", "connection refused", "i/o timeout", "context deadline",
	"EOF", "Client.Timeout", "x509", "tls:", "http: ", "Get \"", "stopped after",
	"no such host", "connect:", "reset by peer", "run aborted by courier",
}

// checkNoLeak fails when b carries the target's address or Go's error text.
func checkNoLeak(t *testing.T, where string, b []byte, base string) {
	t.Helper()
	s := string(b)
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse %q: %v", base, err)
	}
	for _, bad := range []string{u.Host, u.Hostname(), u.Scheme + "://" + u.Hostname()} {
		if bad != "" && strings.Contains(s, bad) {
			t.Errorf("%s carries the target address %q: %.400s", where, bad, s)
		}
	}
	if port := u.Port(); port != "" {
		if regexp.MustCompile(`(^|[^0-9.])` + port + `([^0-9]|$)`).MatchString(s) {
			t.Errorf("%s carries the target port %s: %.400s", where, port, s)
		}
	}
	for _, bad := range goErrorText {
		if strings.Contains(s, bad) {
			t.Errorf("%s carries Go error text %q: %.400s", where, bad, s)
		}
	}
}

// Every failure a visitor can see reads as one of four fixed sentences, and the
// kind that classifies it is unchanged.
func TestFailedDispatchesCarryFixedMessages(t *testing.T) {
	if MsgTimeout != "the target did not respond within 10s" {
		t.Errorf("MsgTimeout = %q", MsgTimeout)
	}
	cases := []struct {
		name, kind, msg string
		do              func() (Response, string)
	}{
		{"refused", ErrKindConnection, "could not connect to the target", func() (Response, string) {
			base := closedTarget(t)
			return NewExecutor(base).Do(context.Background(), searchReq(nil), true), base
		}},
		{"unresolvable host", ErrKindConnection, "could not connect to the target", func() (Response, string) {
			base := "http://target.invalid"
			return NewExecutor(base).Do(context.Background(), searchReq(nil), true), base
		}},
		{"tls to a plain server", ErrKindConnection, "could not connect to the target", func() (Response, string) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
			t.Cleanup(srv.Close)
			base := strings.Replace(srv.URL, "http://", "https://", 1)
			return NewExecutor(base).Do(context.Background(), searchReq(nil), true), base
		}},
		{"untrusted certificate", ErrKindConnection, "could not connect to the target", func() (Response, string) {
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
			t.Cleanup(srv.Close)
			srv.Config.ErrorLog = log.New(io.Discard, "", 0)
			return NewExecutor(srv.URL).Do(context.Background(), searchReq(nil), true), srv.URL
		}},
		{"timeout", ErrKindTimeout, "the target did not respond within 10s", func() (Response, string) {
			srv := hangingTarget(t)
			return withTimeout(NewExecutor(srv.URL), 150*time.Millisecond).Do(context.Background(), searchReq(nil), true), srv.URL
		}},
		{"dropped mid-body", ErrKindConnection, "the connection dropped while reading the response", func() (Response, string) {
			srv := droppingTarget(t)
			return NewExecutor(srv.URL).Do(context.Background(), searchReq(nil), true), srv.URL
		}},
		{"aborted", ErrKindAborted, "stopped by Courier before a response arrived", func() (Response, string) {
			srv := hangingTarget(t)
			ctx, abort := context.WithCancelCause(context.Background())
			time.AfterFunc(50*time.Millisecond, func() { abort(ErrRunAborted) })
			return NewExecutor(srv.URL).Do(ctx, searchReq(nil), true), srv.URL
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp, base := tc.do()
			if resp.Err == nil {
				t.Fatalf("dispatch succeeded: status %d", resp.Status)
			}
			if resp.ErrKind != tc.kind {
				t.Errorf("ErrKind = %q, want %q (err %v)", resp.ErrKind, tc.kind, resp.Err)
			}
			got := resp.PublicError()
			if got != tc.msg {
				t.Errorf("PublicError() = %q, want %q", got, tc.msg)
			}
			checkNoLeak(t, "the public message", []byte(got), base)
		})
	}

	if got := (Response{Status: 200}).PublicError(); got != "" {
		t.Errorf("a response with no error has the public error %q, want none", got)
	}
}
