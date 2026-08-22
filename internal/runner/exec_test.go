package runner

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
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
