package runner

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// searchBody is the size of a real Pokesearch search response (34-42KB), so the
// drain path is benchmarked against the bytes it will actually move.
var searchBody = `{"total":107,"page":1,"pages":5,"took_ms":9,"results":[` +
	strings.Repeat(`{"id":"base1-1","name":"Alakazam","supertype":"Pokemon","hp":80},`, 600) +
	`{"id":"x","name":"y"}]}`

func benchServer(b *testing.B) *httptest.Server {
	b.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(searchBody))
	}))
	b.Cleanup(srv.Close)
	return srv
}

// BenchmarkDispatchDrain is the performance-mode hot path end to end: build the
// URL, dispatch, drain to io.Discard, classify. It includes a loopback HTTP
// round trip, so it is an upper bound on Courier's own per-dispatch cost rather
// than an isolated measurement of it — subtract BenchmarkDispatchBaseline.
func BenchmarkDispatchDrain(b *testing.B) {
	srv := benchServer(b)
	ex := NewExecutor(srv.URL)
	req := sandbox.Request{ID: "1", Name: "a", Endpoint: "search", Params: map[string]string{"q": "charizard"}}
	ep, _ := sandbox.Lookup("search")
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if res := ex.DoResolved(ctx, ep, req, false); res.Err != nil {
			b.Fatal(res.Err)
		}
	}
}

// BenchmarkDispatchKeepBody is the functional-mode path: the body is retained
// up to the 1MB cap for assertion evaluation instead of discarded.
func BenchmarkDispatchKeepBody(b *testing.B) {
	srv := benchServer(b)
	ex := NewExecutor(srv.URL)
	req := sandbox.Request{ID: "1", Name: "a", Endpoint: "search", Params: map[string]string{"q": "charizard"}}
	ep, _ := sandbox.Lookup("search")
	ctx := context.Background()

	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		if res := ex.DoResolved(ctx, ep, req, true); res.Err != nil {
			b.Fatal(res.Err)
		}
	}
}

// BenchmarkDispatchBaseline is the same round trip with a bare http.Client and
// no Courier code in the path. The difference between this and
// BenchmarkDispatchDrain is the engine overhead the README quotes.
func BenchmarkDispatchBaseline(b *testing.B) {
	srv := benchServer(b)
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxIdleConns, tr.MaxIdleConnsPerHost = 256, 256
	client := &http.Client{Timeout: ClientTimeout, Transport: tr}
	url := srv.URL + "/api/search?q=charizard"

	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		req, _ := http.NewRequestWithContext(context.Background(), "GET", url, nil)
		resp, err := client.Do(req)
		if err != nil {
			b.Fatal(err)
		}
		_, _ = drain(resp)
	}
}

// BenchmarkURLBuild isolates the per-dispatch string work: catalog-resolved
// path plus the sorted query render.
func BenchmarkURLBuild(b *testing.B) {
	ex := NewExecutor("http://target.internal")
	req := sandbox.Request{ID: "1", Name: "a", Endpoint: "search",
		Params: map[string]string{"q": "charizard", "sort": "hp", "order": "desc", "page": "2"}}

	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		_ = ex.Query(req)
	}
}

// BenchmarkAggregatorRecord is the fan-in cost per result: two tally updates,
// no locks, no atomics. At 1,800 req/s this runs 1,800 times a second on one
// goroutine, so it is the number that decides whether the aggregator can be a
// single goroutine at all.
func BenchmarkAggregatorRecord(b *testing.B) {
	results := make(chan dispatch, 1024)
	done := make(chan []report.Tally)
	go aggregate(results, done, 5, time.Now(), noopEmitter)

	b.ReportAllocs()
	b.ResetTimer()
	i := 0
	for b.Loop() {
		results <- dispatch{index: i % 5, resp: Response{Status: 200, LatencyMs: 3.2, Size: 38000}}
		i++
	}
	b.StopTimer()
	close(results)
	<-done
}

// drain mirrors the executor's discard path for the baseline comparison.
func drain(resp *http.Response) (int64, error) {
	defer resp.Body.Close()
	return io.Copy(io.Discard, resp.Body)
}
