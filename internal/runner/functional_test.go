package runner

import (
	"context"
	"encoding/json"
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

// PreviewN is the primitive both callers share: the run path passes the 16KB
// preview cap, the editor's Send passes its own larger one.
func TestPreviewNCapsAtN(t *testing.T) {
	body := []byte(strings.Repeat("a", 100))
	s, trunc := PreviewN(body, 40)
	if len(s) != 40 || !trunc {
		t.Errorf("PreviewN = len %d trunc %v, want 40 true", len(s), trunc)
	}
	s, trunc = PreviewN(body, 200)
	if len(s) != 100 || trunc {
		t.Errorf("PreviewN under cap = len %d trunc %v, want 100 false", len(s), trunc)
	}
}

func TestFunctionalRunStartedIsStampedInUTC(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	rec := &recorder{}
	RunFunctional(context.Background(), NewExecutor(srv.URL), sandbox.RunRequest{
		Mode:     sandbox.ModeFunctional,
		Sequence: []sandbox.Request{{ID: "1", Name: "a", Endpoint: "search"}},
	}, rec.emit)
	e, ok := rec.first(EventRunStarted)
	if !ok {
		t.Fatal("no run_started")
	}
	if at := e.Data.(RunStarted).StartedAt; at.Location() != time.UTC {
		t.Errorf("run_started started_at = %v, want UTC", at)
	}
}

// redirectLoopTarget answers every request with a redirect to itself.
func redirectLoopTarget(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", r.URL.Path)
		w.WriteHeader(http.StatusFound)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// A functional row, as stored and as streamed, carries a fixed sentence for a
// failed dispatch: never Go's error text, never the target's address.
func TestFunctionalRowsCarryFixedMessagesAndNoAddress(t *testing.T) {
	type scenario struct {
		name, msg string
		ex        func() (*Executor, string)
	}
	plain := func(base string) (*Executor, string) { return NewExecutor(base), base }
	cases := []scenario{
		{"refused", MsgConnection, func() (*Executor, string) { return plain(closedTarget(t)) }},
		{"unresolvable host", MsgConnection, func() (*Executor, string) { return plain("http://target.invalid") }},
		{"dropped mid-body", MsgDropped, func() (*Executor, string) { return plain(droppingTarget(t).URL) }},
		{"timeout", MsgTimeout, func() (*Executor, string) {
			base := hangingTarget(t).URL
			return withTimeout(NewExecutor(base), 150*time.Millisecond), base
		}},
		{"tls to a plain server", MsgConnection, func() (*Executor, string) {
			srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
			t.Cleanup(srv.Close)
			return plain(strings.Replace(srv.URL, "http://", "https://", 1))
		}},
		// A loop is either recorded as the redirect it is or reported in a
		// fixed sentence; it never echoes the address it bounced between.
		{"redirect loop", "", func() (*Executor, string) { return plain(redirectLoopTarget(t).URL) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ex, base := tc.ex()
			rec := &recorder{}
			res := RunFunctional(context.Background(), ex, sandbox.RunRequest{Mode: sandbox.ModeFunctional,
				Sequence: []sandbox.Request{{ID: "1", Name: "a", Endpoint: "search", Params: map[string]string{"q": "a"},
					Assertions: []assert.Assertion{{Type: "status", Op: "eq", Value: float64(200)}}}}}, rec.emit)
			row := res.Functional.Results[0]
			if tc.msg != "" && row.Error != tc.msg {
				t.Errorf("row error = %q, want %q", row.Error, tc.msg)
			}
			stored, err := json.Marshal(res.Functional)
			if err != nil {
				t.Fatal(err)
			}
			checkNoLeak(t, "the stored functional result", stored, base)
			rec.mu.Lock()
			streamed, err := json.Marshal(rec.events)
			rec.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			checkNoLeak(t, "the streamed events", streamed, base)
		})
	}
}

// A dispatch Courier stopped reads as Courier's doing, in a fixed sentence.
func TestFunctionalAbortedRowCarriesTheFixedMessage(t *testing.T) {
	srv := hangingTarget(t)
	ctx, abort := context.WithCancelCause(context.Background())
	time.AfterFunc(100*time.Millisecond, func() { abort(ErrRunAborted) })
	rec := &recorder{}
	res := RunFunctional(ctx, NewExecutor(srv.URL), sandbox.RunRequest{Mode: sandbox.ModeFunctional,
		Sequence: []sandbox.Request{{ID: "1", Name: "a", Endpoint: "search"}}}, rec.emit)
	row := res.Functional.Results[0]
	if !row.Skipped || row.ErrorKind != ErrKindAborted || row.Error != MsgAborted {
		t.Errorf("aborted row = skipped %v kind %q error %q, want skipped, aborted, %q", row.Skipped, row.ErrorKind, row.Error, MsgAborted)
	}
	b, _ := json.Marshal(res.Functional)
	checkNoLeak(t, "the aborted run", b, srv.URL)
}

// The raw error rides on the emitted row so the manager can log it, and is
// dropped by every encoding of that row.
func TestTheRawErrorIsNeverSerialized(t *testing.T) {
	base := closedTarget(t)
	rec := &recorder{}
	RunFunctional(context.Background(), NewExecutor(base), sandbox.RunRequest{Mode: sandbox.ModeFunctional,
		Sequence: []sandbox.Request{{ID: "1", Name: "a", Endpoint: "search"}}}, rec.emit)
	e, ok := rec.first(EventRequestResult)
	if !ok {
		t.Fatal("no request_result")
	}
	row := e.Data.(report.RequestResult)
	if row.Cause == nil || !strings.Contains(row.Cause.Error(), "connection refused") {
		t.Fatalf("the emitted row carries cause %v, want the raw transport error", row.Cause)
	}
	b, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), row.Cause.Error()) || strings.Contains(string(b), "connection refused") {
		t.Errorf("the raw error was serialized: %s", b)
	}
	checkNoLeak(t, "the encoded event", b, base)
}

// everyKind is one assertion of each type, including two that a request with
// no response used to satisfy: a latency bound (the failure was fast) and a
// negated status (0 is not 200).
func everyKind() []assert.Assertion {
	return []assert.Assertion{
		{Type: assert.TypeStatus, Op: "eq", Value: float64(200)},
		{Type: assert.TypeStatus, Op: "neq", Value: float64(500)},
		{Type: assert.TypeLatency, Op: "lt", Value: float64(150)},
		{Type: assert.TypeBodyContains, Op: "contains", Value: "total"},
		{Type: assert.TypeJSON, Path: "$.total", Op: "gt", Value: float64(0)},
	}
}

// Without a response there is nothing to hold an assertion to: every outcome
// fails as not evaluated, rather than a latency bound passing on a request
// that never connected.
func TestAssertionsAreNotEvaluatedWithoutAResponse(t *testing.T) {
	for name, ex := range map[string]*Executor{
		"refused": NewExecutor(closedTarget(t)),
		"timeout": withTimeout(NewExecutor(hangingTarget(t).URL), 150*time.Millisecond),
	} {
		t.Run(name, func(t *testing.T) {
			res := RunFunctional(context.Background(), ex, sandbox.RunRequest{Mode: sandbox.ModeFunctional,
				Sequence: []sandbox.Request{{ID: "1", Name: "a", Endpoint: "search", Assertions: everyKind()}}}, nil)
			row := res.Functional.Results[0]
			if row.Passed || res.Functional.Failed != 1 {
				t.Errorf("row passed = %v, failed count %d; a request with no response fails", row.Passed, res.Functional.Failed)
			}
			if len(row.Assertions) != len(everyKind()) {
				t.Fatalf("%d outcomes, want %d", len(row.Assertions), len(everyKind()))
			}
			for _, o := range row.Assertions {
				if o.Passed || o.Actual != NoResponse || o.Error != NotEvaluated || o.Expected == "" {
					t.Errorf("outcome %+v, want failed, actual %q, error %q, and the expectation kept", o, NoResponse, NotEvaluated)
				}
			}
			if v := report.FunctionalVerdict(res.Status, res.Functional); v != report.VerdictFail {
				t.Errorf("verdict = %q, want FAIL", v)
			}
		})
	}
}

// A body that dropped after its status line did get a response: its status is
// real and is what a status assertion reads.
func TestAssertionsReadTheStatusOfADroppedBody(t *testing.T) {
	res := RunFunctional(context.Background(), NewExecutor(droppingTarget(t).URL), sandbox.RunRequest{Mode: sandbox.ModeFunctional,
		Sequence: []sandbox.Request{{ID: "1", Name: "a", Endpoint: "search",
			Assertions: []assert.Assertion{{Type: assert.TypeStatus, Op: "eq", Value: float64(200)}}}}}, nil)
	row := res.Functional.Results[0]
	if row.Passed || row.Status != 200 || len(row.Assertions) != 1 || row.Assertions[0].Actual != "200" {
		t.Errorf("row = passed %v status %d outcomes %+v, want a failed row whose status assertion read 200", row.Passed, row.Status, row.Assertions)
	}
}

// A functional row records the redirect itself and the walk goes no further.
func TestFunctionalRecordsARedirectWithoutFollowingIt(t *testing.T) {
	rd := newRedirecting(t, http.StatusFound, redirectLocations["another server"])
	res := RunFunctional(context.Background(), NewExecutor(rd.target.URL), sandbox.RunRequest{Mode: sandbox.ModeFunctional,
		Sequence: []sandbox.Request{{ID: "1", Name: "a", Endpoint: "search",
			Assertions: []assert.Assertion{{Type: assert.TypeStatus, Op: "eq", Value: float64(302)}}}}}, nil)
	row := res.Functional.Results[0]
	if row.Status != http.StatusFound || row.Error != "" || !row.Passed {
		t.Errorf("row = status %d error %q passed %v, want the 302 recorded and asserted", row.Status, row.Error, row.Passed)
	}
	if n := rd.away.Load(); n != 0 {
		t.Errorf("the second server was asked %d times, want never", n)
	}
}
