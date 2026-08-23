package runner

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// recorder collects events without racing the run's goroutines.
type recorder struct {
	mu     sync.Mutex
	events []Event
}

func (r *recorder) emit(e Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, e)
}

func (r *recorder) count(typ string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.events {
		if e.Type == typ {
			n++
		}
	}
	return n
}

// first returns the earliest event of a type, so a test can assert on a
// payload rather than only on the shape of the stream.
func (r *recorder) first(typ string) (Event, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.events {
		if e.Type == typ {
			return e, true
		}
	}
	return Event{}, false
}

func (r *recorder) types() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.events))
	for i, e := range r.events {
		out[i] = e.Type
	}
	return out
}

func TestFunctionalRunsInOrderAndEmits(t *testing.T) {
	var mu sync.Mutex
	var order []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		order = append(order, r.URL.Query().Get("q"))
		mu.Unlock()
		fmt.Fprint(w, `{"total":3,"results":[{"name":"Charizard"}]}`)
	}))
	defer srv.Close()

	rr := sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: []sandbox.Request{
		{ID: "1", Name: "one", Endpoint: "search", Params: map[string]string{"q": "a"},
			Assertions: []assert.Assertion{{Type: "status", Op: "eq", Value: float64(200)}}},
		{ID: "2", Name: "two", Endpoint: "search", Params: map[string]string{"q": "b"},
			Assertions: []assert.Assertion{{Type: "json", Path: "$.total", Op: "gt", Value: float64(0)}}},
		{ID: "3", Name: "three", Endpoint: "search", Params: map[string]string{"q": "c"}},
	}}
	rec := &recorder{}
	res := RunFunctional(context.Background(), NewExecutor(srv.URL), rr, rec.emit)
	got := res.Functional

	mu.Lock()
	gotOrder := strings.Join(order, ",")
	mu.Unlock()
	if gotOrder != "a,b,c" {
		t.Errorf("execution order = %v, want a,b,c", gotOrder)
	}
	if res.Status != report.StatusCompleted {
		t.Errorf("status = %q, want completed", res.Status)
	}
	if got.Total != 3 || got.Passed != 3 || got.Failed != 0 || got.Skipped != 0 {
		t.Errorf("summary = %+v", got)
	}
	if n := rec.count(EventRequestResult); n != 3 {
		t.Errorf("emitted %d request_result events, want 3", n)
	}
	if rec.count(EventRunStarted) != 1 {
		t.Errorf("event stream = %v, want exactly one run_started", rec.types())
	}
	if got.Results[0].Index != 0 || got.Results[2].Index != 2 {
		t.Error("results must carry their sequence index")
	}
	if got.Results[0].SizeBytes == 0 || got.Results[0].BodyPreview == "" {
		t.Errorf("functional results must retain size and a body preview: %+v", got.Results[0])
	}
}

func failingSequence() []sandbox.Request {
	return []sandbox.Request{
		{ID: "1", Name: "fails", Endpoint: "search",
			Assertions: []assert.Assertion{{Type: "json", Path: "$.total", Op: "gt", Value: float64(0)}}},
		{ID: "2", Name: "never runs", Endpoint: "search"},
		{ID: "3", Name: "also never", Endpoint: "search"},
	}
}

func emptyTotalServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"total":0}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFunctionalStopOnFailureSkipsRemainder(t *testing.T) {
	srv := emptyTotalServer(t)

	res := RunFunctional(context.Background(), NewExecutor(srv.URL),
		sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: failingSequence(),
			Options: sandbox.Options{StopOnFailure: true}}, nil)
	got := res.Functional

	if got.Failed != 1 || got.Skipped != 2 || got.Passed != 0 {
		t.Fatalf("summary = %+v, want 1 failed 2 skipped", got)
	}
	if len(got.Results) != 3 || !got.Results[1].Skipped || !got.Results[2].Skipped {
		t.Error("skipped entries must still appear in the results, flagged")
	}
	if got.Results[0].Assertions[0].Actual != "0" {
		t.Errorf("expected-vs-actual lost: %+v", got.Results[0].Assertions[0])
	}
	// A sequence that stopped early still completed — it did what it was told.
	if res.Status != report.StatusCompleted {
		t.Errorf("status = %q, want completed", res.Status)
	}
}

func TestFunctionalWithoutStopOnFailureRunsEverything(t *testing.T) {
	srv := emptyTotalServer(t)

	rec := &recorder{}
	got := RunFunctional(context.Background(), NewExecutor(srv.URL),
		sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: failingSequence()}, rec.emit).Functional

	if got.Failed != 1 || got.Skipped != 0 || got.Passed != 2 {
		t.Fatalf("summary = %+v, want 1 failed 2 passed 0 skipped", got)
	}
	if n := rec.count(EventRequestResult); n != 3 {
		t.Errorf("emitted %d request_result events, want 3", n)
	}
}

func TestFunctionalHonorsDelay(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "{}") }))
	defer srv.Close()
	seq := []sandbox.Request{
		{ID: "1", Name: "a", Endpoint: "search"},
		{ID: "2", Name: "b", Endpoint: "search"},
		{ID: "3", Name: "c", Endpoint: "search"},
	}
	start := time.Now()
	RunFunctional(context.Background(), NewExecutor(srv.URL),
		sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: seq, Options: sandbox.Options{DelayMs: 60}}, nil)
	elapsed := time.Since(start)
	if elapsed < 120*time.Millisecond {
		t.Errorf("elapsed %v, want >= 120ms (delay between requests, not after the last)", elapsed)
	}
	if elapsed > 400*time.Millisecond {
		t.Errorf("elapsed %v, want ~120ms — the delay must not trail the final request", elapsed)
	}
}

func TestFunctionalTargetDownStillReports(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	addr := srv.URL
	srv.Close()

	got := RunFunctional(context.Background(), NewExecutor(addr),
		sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: []sandbox.Request{
			{ID: "1", Name: "a", Endpoint: "search",
				Assertions: []assert.Assertion{{Type: "status", Op: "eq", Value: float64(200)}}}}}, nil).Functional

	if got.Failed != 1 || got.Results[0].Error == "" || got.Results[0].ErrorKind != ErrKindConnection {
		t.Errorf("target-down result = %+v", got.Results[0])
	}
	if len(got.Results[0].Assertions) != 1 || got.Results[0].Assertions[0].Passed {
		t.Errorf("assertions must still be evaluated and reported against a dead target: %+v", got.Results[0].Assertions)
	}
}

func TestFunctionalCancellationSkipsRemainder(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "{}") }))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	seq := make([]sandbox.Request, 10)
	for i := range seq {
		seq[i] = sandbox.Request{ID: fmt.Sprint(i), Name: fmt.Sprint(i), Endpoint: "search"}
	}

	var once sync.Once
	start := time.Now()
	res := RunFunctional(ctx, NewExecutor(srv.URL),
		sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: seq}, func(e Event) {
			if e.Type == EventRequestResult {
				once.Do(cancel)
			}
		})

	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("cancellation took %v to unwind", elapsed)
	}
	if res.Status != report.StatusCancelled {
		t.Errorf("status = %q, want cancelled", res.Status)
	}
	got := res.Functional
	if got.Skipped == 0 {
		t.Fatalf("nothing was skipped after cancellation: %+v", got)
	}
	if got.Passed+got.Failed+got.Skipped != 10 || len(got.Results) != 10 {
		t.Errorf("every entry must appear in the results: %+v", got)
	}
}

// The deadline is injected so the test does not take two minutes. What it
// proves is the two-context rule: the request in flight when the wall clock
// expires completes and counts, and only the entries after it are skipped.
func TestFunctionalDeadlineExpiresWithoutFakingATransportError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(250 * time.Millisecond)
		fmt.Fprint(w, `{"total":1}`)
	}))
	defer srv.Close()

	seq := []sandbox.Request{
		{ID: "1", Name: "in flight at expiry", Endpoint: "search"},
		{ID: "2", Name: "skipped", Endpoint: "search"},
		{ID: "3", Name: "skipped too", Endpoint: "search"},
	}
	res := runFunctional(context.Background(), NewExecutor(srv.URL),
		sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: seq}, nil, 100*time.Millisecond)

	if res.Status != report.StatusExpired {
		t.Fatalf("status = %q, want expired", res.Status)
	}
	got := res.Functional
	first := got.Results[0]
	if first.Status != 200 || first.Error != "" || first.Skipped {
		t.Errorf("the request in flight at expiry must complete and count, not be faked into an error: %+v", first)
	}
	if first.LatencyMs < 200 {
		t.Errorf("latency = %vms, want the real end-of-body time", first.LatencyMs)
	}
	if got.Skipped != 2 || !got.Results[1].Skipped || !got.Results[2].Skipped {
		t.Errorf("remainder must be skipped: %+v", got)
	}
}

// A template param expands per dispatch: the target sees a real word, each
// result row records the query that dispatch actually sent, and the run_started
// entries keep the literal template so the sequence stays readable.
func TestFunctionalExpandsTemplatePerDispatch(t *testing.T) {
	var mu sync.Mutex
	var sent []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		sent = append(sent, r.URL.RawQuery)
		mu.Unlock()
		fmt.Fprint(w, `{"total":1}`)
	}))
	defer srv.Close()

	tpl := func(id string) sandbox.Request {
		return sandbox.Request{ID: id, Name: "tpl", Endpoint: "search",
			Params: map[string]string{"q": "{{randomPokemon}}"}}
	}
	rec := &recorder{}
	res := RunFunctional(context.Background(), NewExecutor(srv.URL),
		sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: []sandbox.Request{tpl("1"), tpl("2")}}, rec.emit)

	mu.Lock()
	got := slices.Clone(sent)
	mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("target received %d requests, want 2: %v", len(got), got)
	}

	// The row is the record of one dispatch, so it must carry that dispatch's
	// resolved word — not the template, and not the other entry's draw.
	for i, row := range res.Functional.Results {
		if strings.Contains(row.Query, "{{") || strings.Contains(row.Query, "%7B%7B") {
			t.Errorf("result row %d query not expanded: %q", i, row.Query)
		}
		if row.Query != "?"+got[i] {
			t.Errorf("result row %d query = %q, target received %q", i, row.Query, got[i])
		}
	}

	e, ok := rec.first(EventRunStarted)
	if !ok {
		t.Fatal("no run_started event")
	}
	started := e.Data.(RunStarted)
	if !strings.Contains(started.Entries[0].Query, "%7B%7Brandom") {
		t.Errorf("run_started entry should keep the literal template, got %q", started.Entries[0].Query)
	}
}

func TestBodyPreviewTruncatesAtTheCap(t *testing.T) {
	body := []byte(strings.Repeat("z", report.MaxBodyPreview+100))
	preview, truncated := Preview(body)
	if !truncated || len(preview) != report.MaxBodyPreview {
		t.Errorf("preview = %d bytes truncated=%v, want %d truncated", len(preview), truncated, report.MaxBodyPreview)
	}

	// A multi-byte rune straddling the cap must not be cut in half.
	runes := []byte(strings.Repeat("é", report.MaxBodyPreview))
	preview, truncated = Preview(runes)
	if !truncated {
		t.Fatal("want truncated")
	}
	if !utf8.ValidString(preview) {
		t.Error("preview must remain valid UTF-8")
	}

	if p, tr := Preview(nil); p != "" || tr {
		t.Errorf("empty body preview = %q %v", p, tr)
	}
}
