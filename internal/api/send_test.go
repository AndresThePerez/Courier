package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

func sendable() sandbox.Request {
	return sandbox.Request{
		ID:       "editor",
		Name:     "search",
		Endpoint: "search",
		Params:   map[string]string{"q": "charizard"},
		Assertions: []assert.Assertion{
			{Type: assert.TypeStatus, Op: "eq", Value: 200},
			{Type: assert.TypeJSON, Path: "$.total", Op: "eq", Value: 107},
		},
	}
}

func TestSendExecutesOneRequestAndEvaluatesIt(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)

	rec := do(t, s, http.MethodPost, "/api/send", sendable())
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s, want 200", rec.Code, rec.Body.String())
	}
	got := decode[sendResult](t, rec)

	if got.Status != http.StatusOK {
		t.Errorf("target status = %d, want 200", got.Status)
	}
	if got.Endpoint != "search" || !strings.Contains(got.Query, "q=charizard") {
		t.Errorf("result identity = %q %q, want the resolved search request", got.Endpoint, got.Query)
	}
	if got.Body == "" || got.SizeBytes == 0 {
		t.Error("the editor needs the response body back; that is the whole point of Send")
	}
	if len(got.Assertions) != 2 {
		t.Fatalf("got %d assertion outcomes, want 2", len(got.Assertions))
	}
	if !got.Passed {
		t.Errorf("passed = false, outcomes %+v", got.Assertions)
	}
	for _, o := range got.Assertions {
		if o.Expected == "" || o.Actual == "" {
			t.Errorf("outcome %+v has no expected/actual to render", o)
		}
	}
}

// A failing assertion is a 200 with passed=false, not an HTTP error: the
// request succeeded, the expectation did not hold, and those are different
// facts.
func TestSendReportsFailedAssertionsWithoutFailingTheRequest(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	req := sendable()
	req.Assertions = []assert.Assertion{{Type: assert.TypeJSON, Path: "$.total", Op: "eq", Value: 1}}

	rec := do(t, s, http.MethodPost, "/api/send", req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	got := decode[sendResult](t, rec)
	if got.Passed {
		t.Error("passed = true on an assertion that cannot hold")
	}
	if len(got.Assertions) != 1 || got.Assertions[0].Passed {
		t.Errorf("outcomes = %+v, want one failed outcome", got.Assertions)
	}
}

// The same validator a run payload passes through. The sandbox has one door.
func TestSendRejectsAnUnknownParameter(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	req := sendable()
	req.Params = map[string]string{"highlight": "1"}

	rec := do(t, s, http.MethodPost, "/api/send", req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if body := decode[errorBody](t, rec); !strings.Contains(body.Error, "highlight") {
		t.Errorf("error = %q, want it to name the rejected parameter", body.Error)
	}
}

// One in flight globally, so the editor cannot be turned into a load generator
// by a for loop in a browser console. 429, not 409: this is a rate limit, not a
// state conflict.
func TestSendIsLimitedToOneInFlight(t *testing.T) {
	s := newServer(t, newTarget(t, 750*time.Millisecond), nil)

	done := make(chan int, 1)
	go func() {
		done <- do(t, s, http.MethodPost, "/api/send", sendable()).Code
	}()
	waitFor(t, "the first send to be in flight", func() bool { return s.sending.Load() })

	rec := do(t, s, http.MethodPost, "/api/send", sendable())
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second send = %d %s, want 429", rec.Code, rec.Body.String())
	}
	if first := <-done; first != http.StatusOK {
		t.Errorf("first send = %d, want 200", first)
	}

	// And the limit lifts the moment the first one lands.
	if rec := do(t, s, http.MethodPost, "/api/send", sendable()); rec.Code != http.StatusOK {
		t.Errorf("send after the first finished = %d, want 200", rec.Code)
	}
}

// Documented behaviour: a send during a run is allowed. One request is not a
// run, and taking the editor offline while somebody else's collection walks
// would be a strange product.
func TestSendIsAllowedWhileARunIsInProgress(t *testing.T) {
	s := newServer(t, newTarget(t, 200*time.Millisecond), nil)
	id := startRun(t, s, payload(4, 0))
	waitFor(t, "the run to be live", func() bool { return s.mgr.Status().Running })

	rec := do(t, s, http.MethodPost, "/api/send", sendable())
	if rec.Code != http.StatusOK {
		t.Fatalf("send during run %s = %d %s, want 200", id, rec.Code, rec.Body.String())
	}
	waitIdle(t, s)
}

// A send debits the ledger runs draw on, but never opens a cooldown window of
// its own: pressing Send must not put the Start button into a five-second
// countdown.
func TestSendDebitsTheBudgetWithoutStartingACooldown(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)

	if rec := do(t, s, http.MethodPost, "/api/send", sendable()); rec.Code != http.StatusOK {
		t.Fatalf("send = %d, want 200", rec.Code)
	}
	if until := s.mgr.Status().CooldownUntil; until != nil {
		t.Errorf("a send opened a cooldown until %s; only runs do that", until)
	}
	if rec := do(t, s, http.MethodPost, "/api/runs", payload(1, 0)); rec.Code != http.StatusAccepted {
		t.Fatalf("run after a send = %d %s, want 202", rec.Code, rec.Body.String())
	}
	waitIdle(t, s)
}

// One truncation rule everywhere: the 16KB preview a run stores is the 16KB
// preview the editor gets.
func TestSendTruncatesALargeBody(t *testing.T) {
	big := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"padding":"`+strings.Repeat("x", report.MaxBodyPreview*2)+`"}`)
	}))
	defer big.Close()

	s := newServer(t, big.URL, nil)
	req := sendable()
	req.Assertions = nil

	rec := do(t, s, http.MethodPost, "/api/send", req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	got := decode[sendResult](t, rec)
	if !got.BodyTruncated {
		t.Error("body_truncated = false on a body twice the preview cap")
	}
	if len(got.Body) > report.MaxBodyPreview {
		t.Errorf("body is %d bytes, want at most the %d byte preview", len(got.Body), report.MaxBodyPreview)
	}
	if got.SizeBytes <= report.MaxBodyPreview {
		t.Errorf("size_bytes = %d, want the full response size, not the preview's", got.SizeBytes)
	}
	if got.Assertions == nil {
		t.Error("assertions must be an empty array, not null; the UI ranges over it")
	}
}
