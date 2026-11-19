package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/runner"
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

// Send expands templates too, and reports the resolved query — that is how the
// editor can show which word was drawn. Expansion happens after validation: a
// placeholder is an ordinary param value to the sandbox on the way in.
func TestSendExpandsTemplate(t *testing.T) {
	var mu sync.Mutex
	var received string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		received = r.URL.RawQuery
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"total":107}`)
	}))
	defer target.Close()

	s := newServer(t, target.URL, nil)
	req := sendable()
	req.Params = map[string]string{"q": "{{randomPokemon}}"}
	req.Assertions = nil

	rec := do(t, s, http.MethodPost, "/api/send", req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s, want 200", rec.Code, rec.Body.String())
	}
	got := decode[sendResult](t, rec)

	if strings.Contains(got.Query, "{{") || strings.Contains(got.Query, "%7B%7B") {
		t.Errorf("reported query is still a template: %q", got.Query)
	}
	mu.Lock()
	defer mu.Unlock()
	if got.Query != "?"+received {
		t.Errorf("reported query %q is not what the target received (%q)", got.Query, received)
	}
}

// A search response is 34-42KB, so the run path's 16KB preview truncates the
// normal case. That is right for a stored history and wrong for the one
// response a visitor is actively inspecting: Send must hand back all of it.
func TestSendReturnsATypicalSearchBodyWhole(t *testing.T) {
	const padding = 40 << 10
	big := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"padding":"`+strings.Repeat("x", padding)+`"}`)
	}))
	defer big.Close()

	s := newServer(t, big.URL, nil)
	req := sendable()
	req.Assertions = nil

	rec := do(t, s, http.MethodPost, "/api/send", req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s, want 200", rec.Code, rec.Body.String())
	}
	got := decode[sendResult](t, rec)
	if got.BodyTruncated {
		t.Error("body_truncated = true on a 40KB body; a typical search response must arrive whole")
	}
	if len(got.Body) != got.SizeBytes {
		t.Errorf("body is %d bytes of a %d byte response; Send returns all of it", len(got.Body), got.SizeBytes)
	}
}

// Two caps, deliberately: a run stores a 16KB preview, Send carries
// SendBodyMax. A body past even the larger cap is still cut, and the reported
// size stays the target's, not the preview's.
func TestSendTruncatesALargeBody(t *testing.T) {
	big := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"padding":"`+strings.Repeat("x", SendBodyMax*2)+`"}`)
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
		t.Error("body_truncated = false on a body twice the send cap")
	}
	if len(got.Body) > SendBodyMax {
		t.Errorf("body is %d bytes, want at most the %d byte send cap", len(got.Body), SendBodyMax)
	}
	if len(got.Body) <= report.MaxBodyPreview {
		t.Errorf("body is %d bytes: Send is capped at SendBodyMax, not the run path's %d byte preview", len(got.Body), report.MaxBodyPreview)
	}
	if got.SizeBytes <= SendBodyMax {
		t.Errorf("size_bytes = %d, want the full response size, not the truncated body's", got.SizeBytes)
	}
	if got.Assertions == nil {
		t.Error("assertions must be an empty array, not null; the UI ranges over it")
	}
}

// An over-long parameter is cut, not refused, and the response says so: a
// visitor who pasted 5000 characters must be able to tell that 500 were sent.
func TestSendReportsTruncatedParameters(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	req := sendable()
	req.Params = map[string]string{"q": strings.Repeat("a", 5000)}

	rec := do(t, s, http.MethodPost, "/api/send", req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s, want 200", rec.Code, rec.Body.String())
	}
	var got struct {
		Query     string   `json:"query"`
		Truncated []string `json:"truncated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if want := "?q=" + strings.Repeat("a", sandbox.MaxParamValueLen); got.Query != want {
		t.Errorf("query carries %d characters, want %d", len(got.Query)-3, sandbox.MaxParamValueLen)
	}
	if !slices.Equal(got.Truncated, []string{"params.q"}) {
		t.Errorf("truncated = %v, want [params.q]", got.Truncated)
	}

	rec = do(t, s, http.MethodPost, "/api/send", sendable())
	if strings.Contains(rec.Body.String(), `"truncated"`) {
		t.Errorf("a send with nothing cut carries a truncated key: %s", rec.Body.String())
	}
}

func TestSendRefusesAMeaninglessAssertion(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	for _, a := range []assert.Assertion{
		{Type: assert.TypeLatency, Op: "lt", Value: -5},
		{Type: assert.TypeStatus, Op: "eq", Value: 200.5},
		{Type: assert.TypeBodyContains, Op: "contains", Value: strings.Repeat("x", sandbox.MaxAssertionTextLen+1)},
	} {
		req := sendable()
		req.Assertions = []assert.Assertion{{Type: assert.TypeStatus, Op: "eq", Value: 200}, a}
		rec := do(t, s, http.MethodPost, "/api/send", req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%+v: status = %d, want 400", a, rec.Code)
		}
		if body := decode[errorBody](t, rec); body.Field != "assertions[1]" {
			t.Errorf("%+v: field = %q, want assertions[1]", a, body.Field)
		}
	}
}

// ---- failed dispatches: fixed messages, nothing of the target ---------------

// goErrorText is text only a Go transport error carries.
var goErrorText = []string{
	"dial tcp", "lookup", "connection refused", "i/o timeout", "context deadline",
	"EOF", "Client.Timeout", "x509", "tls:", "http: ", "Get \"", "stopped after",
	"no such host", "connect:", "reset by peer", "run aborted by courier",
}

// checkNoLeak fails when b carries the target's host, port or scheme+host, or
// Go's error text.
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

// syncBuffer is a log sink the test can read while the server writes.
type syncBuffer struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// lines returns the decoded log lines that carry event.
func (b *syncBuffer) lines(t *testing.T, event string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(b.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line is not JSON: %q", line)
		}
		if m["event"] == event {
			out = append(out, m)
		}
	}
	return out
}

// newLoggedServer is newServer with its log captured.
func newLoggedServer(t *testing.T, targetURL string) (*Server, *syncBuffer) {
	t.Helper()
	logs := &syncBuffer{}
	s := New(testStatic(), Options{TargetURL: targetURL, TargetDisplay: "test-target",
		Logger: slog.New(slog.NewJSONHandler(logs, nil))})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := s.Close(ctx); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	return s, logs
}

// closedTarget is a loopback address nothing listens on, held for the test.
// A port merely closed again can be handed by the OS to another test's
// listener, which turns a refused dial into some other failure. A socket bound
// to the port but never listening keeps it: a dial is refused, and no listener
// can bind it until the test ends.
func closedTarget(t *testing.T) string {
	t.Helper()
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	syscall.CloseOnExec(fd)
	t.Cleanup(func() { _ = syscall.Close(fd) })
	if err := syscall.Bind(fd, &syscall.SockaddrInet4{Addr: [4]byte{127, 0, 0, 1}}); err != nil {
		t.Fatal(err)
	}
	sa, err := syscall.Getsockname(fd)
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("http://127.0.0.1:%d", sa.(*syscall.SockaddrInet4).Port)
}

// The refused target stays refused for the whole test: no listener another
// test opens can take its port, so a dial there can only be refused.
func TestAClosedTargetsPortCannotBeTakenByAnotherListener(t *testing.T) {
	base := closedTarget(t)
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if ln, err := net.Listen("tcp", u.Host); err == nil {
			_ = ln.Close()
			t.Fatalf("a listener opened on the refused target's address %s: a send there would no longer be refused", u.Host)
		}
	}
	if c, err := net.Dial("tcp", u.Host); err == nil {
		_ = c.Close()
		t.Fatal("a dial to the refused target connected")
	} else if !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("a dial to the refused target failed with %v, want connection refused", err)
	}
}

func serveTarget(t *testing.T, h http.HandlerFunc) string {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv.URL
}

// dropAfterHeaders sends a status line and half a body, then hangs up.
func dropAfterHeaders(w http.ResponseWriter, _ *http.Request) {
	conn, buf, err := w.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"total\":")
	_ = buf.Flush()
}

func hang(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() }

func redirectToSelf(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Location", r.URL.Path)
	w.WriteHeader(http.StatusFound)
}

func oversized(w http.ResponseWriter, _ *http.Request) {
	_, _ = io.WriteString(w, strings.Repeat("y", runner.MaxBodyBytes+4096))
}

// failingTargets are the targets a visitor's request can fail against, each
// with the sentence its failure must read as ("" where the dispatch is not a
// transport failure).
func failingTargets(t *testing.T) []struct{ name, base, msg string } {
	t.Helper()
	plainForTLS := serveTarget(t, func(http.ResponseWriter, *http.Request) {})
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	tlsSrv.Config.ErrorLog = log.New(io.Discard, "", 0)
	t.Cleanup(tlsSrv.Close)
	return []struct{ name, base, msg string }{
		{"refused", closedTarget(t), runner.MsgConnection},
		{"unresolvable host", "http://target.invalid", runner.MsgConnection},
		{"dropped mid-body", serveTarget(t, dropAfterHeaders), runner.MsgDropped},
		{"tls to a plain server", strings.Replace(plainForTLS, "http://", "https://", 1), runner.MsgConnection},
		{"untrusted certificate", tlsSrv.URL, runner.MsgConnection},
		{"redirect loop", serveTarget(t, redirectToSelf), ""},
		{"body over the cap", serveTarget(t, oversized), ""},
	}
}

// A failed Send reads as one fixed sentence and carries nothing of the target.
func TestSendFailuresCarryFixedMessagesAndNoAddress(t *testing.T) {
	for _, tc := range failingTargets(t) {
		t.Run(tc.name, func(t *testing.T) {
			s := newServer(t, tc.base, nil)
			rec := do(t, s, http.MethodPost, "/api/send", sendable())
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d %s, want 200", rec.Code, rec.Body.String())
			}
			got := decode[sendResult](t, rec)
			if tc.msg != "" && got.Error != tc.msg {
				t.Errorf("error = %q, want %q", got.Error, tc.msg)
			}
			checkNoLeak(t, "the Send response", rec.Body.Bytes(), tc.base)
		})
	}

	t.Run("timeout", func(t *testing.T) {
		base := serveTarget(t, hang)
		s := newServer(t, base, nil)
		raw, _ := json.Marshal(sendable())
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		defer cancel()
		r := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/send", strings.NewReader(string(raw)))
		r.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, r)
		got := decode[sendResult](t, rec)
		if got.ErrorKind != report.KindTimeout || got.Error != runner.MsgTimeout {
			t.Errorf("error = %q (%s), want %q (timeout)", got.Error, got.ErrorKind, runner.MsgTimeout)
		}
		checkNoLeak(t, "the Send response", rec.Body.Bytes(), base)
	})
}

// The raw error is logged once per failed Send, under its own event, with the
// endpoint; the send_executed line carries only the fixed sentence.
func TestSendLogsTheRawErrorOnce(t *testing.T) {
	base := closedTarget(t)
	s, logs := newLoggedServer(t, base)
	if rec := do(t, s, http.MethodPost, "/api/send", sendable()); rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	failed := logs.lines(t, runner.EventDispatchFailed)
	if len(failed) != 1 {
		t.Fatalf("%d %s lines, want 1", len(failed), runner.EventDispatchFailed)
	}
	if errText, _ := failed[0]["err"].(string); failed[0]["endpoint"] != "search" || !strings.Contains(errText, "connection refused") {
		t.Errorf("%s line = %v, want endpoint search and the raw error", runner.EventDispatchFailed, failed[0])
	}
	host := strings.TrimPrefix(base, "http://")
	carrying := 0
	for _, line := range strings.Split(logs.String(), "\n") {
		if strings.Contains(line, host) {
			carrying++
		}
	}
	if carrying != 1 {
		t.Errorf("%d log lines carry the target address, want only the %s line", carrying, runner.EventDispatchFailed)
	}
	if ex := logs.lines(t, EventSendExecuted); len(ex) != 1 || ex[0]["err"] != runner.MsgConnection {
		t.Errorf("send_executed = %v, want err %q", ex, runner.MsgConnection)
	}
}

// readStream reads a finished run's stream to its end.
func readStream(t *testing.T, base, id string) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/runs/"+id+"/stream", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read stream: %v", err)
	}
	if !strings.Contains(string(b), "event: "+runner.EventRunFinished) {
		t.Fatalf("stream ended without run_finished: %.400s", b)
	}
	return b
}

// checkRunSurfaces scans every surface a finished run is visible on.
func checkRunSurfaces(t *testing.T, s *Server, id, base string) {
	t.Helper()
	front := httptest.NewServer(s)
	defer front.Close()
	checkNoLeak(t, "GET /api/runs/{id}", do(t, s, http.MethodGet, "/api/runs/"+id, nil).Body.Bytes(), base)
	checkNoLeak(t, "the run's stream", readStream(t, front.URL, id), base)
	checkNoLeak(t, "GET /api/runs", do(t, s, http.MethodGet, "/api/runs", nil).Body.Bytes(), base)
	checkNoLeak(t, "GET /api/status", do(t, s, http.MethodGet, "/api/status", nil).Body.Bytes(), base)
}

// Every surface a run is visible on is free of the target's address and of
// Go's error text, in both modes, whatever the failure.
func TestRunSurfacesCarryNoTargetAddress(t *testing.T) {
	for _, tc := range failingTargets(t) {
		t.Run("functional "+tc.name, func(t *testing.T) {
			s := newServer(t, tc.base, nil)
			id := startRun(t, s, payload(2, 0))
			waitIdle(t, s)
			if tc.msg != "" {
				rep := decode[report.Report](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
				if got := rep.Functional.Results[0].Error; got != tc.msg {
					t.Errorf("row error = %q, want %q", got, tc.msg)
				}
			}
			checkRunSurfaces(t, s, id, tc.base)
		})
	}
	for _, name := range []string{"refused", "dropped mid-body"} {
		t.Run("performance "+name, func(t *testing.T) {
			var base string
			for _, tc := range failingTargets(t) {
				if tc.name == name {
					base = tc.base
				}
			}
			s := newServer(t, base, nil)
			rr := sandbox.RunRequest{Mode: sandbox.ModePerformance, Sequence: payload(1, 0).Sequence,
				Options: sandbox.Options{Concurrency: 2, DurationSecs: 1}}
			id := startRun(t, s, rr)
			waitIdle(t, s)
			rep := decode[report.Report](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
			if rep.Performance.Overall.Errors == 0 || len(rep.Performance.Overall.ErrorKinds) == 0 {
				t.Errorf("overall = %+v, want counted errors and their kinds", rep.Performance.Overall)
			}
			checkRunSurfaces(t, s, id, base)
		})
	}
	for _, mode := range []string{sandbox.ModeFunctional, sandbox.ModePerformance} {
		t.Run("cancelled "+mode, func(t *testing.T) {
			var hits atomic.Int64
			base := serveTarget(t, func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				hang(w, r)
			})
			s := newServer(t, base, nil)
			rr := payload(2, 0)
			if mode == sandbox.ModePerformance {
				rr = sandbox.RunRequest{Mode: mode, Sequence: rr.Sequence, Options: sandbox.Options{Concurrency: 2, DurationSecs: 30}}
			}
			id := startRun(t, s, rr)
			waitFor(t, "a dispatch to reach the target", func() bool { return hits.Load() > 0 })
			if rec := do(t, s, http.MethodDelete, "/api/runs/"+id, nil); rec.Code != http.StatusNoContent {
				t.Fatalf("cancel = %d %s", rec.Code, rec.Body.String())
			}
			waitIdle(t, s)
			if mode == sandbox.ModeFunctional {
				rep := decode[report.Report](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
				if row := rep.Functional.Results[0]; row.Error != runner.MsgAborted {
					t.Errorf("aborted row error = %q, want %q", row.Error, runner.MsgAborted)
				}
			}
			checkRunSurfaces(t, s, id, base)
		})
	}
}

// A Send that got no response evaluates nothing: every outcome fails as not
// evaluated, and a latency bound no longer passes on a refused connection.
func TestSendEvaluatesNoAssertionWithoutAResponse(t *testing.T) {
	s := newServer(t, closedTarget(t), nil)
	req := sendable()
	req.Assertions = []assert.Assertion{
		{Type: assert.TypeLatency, Op: "lt", Value: 150},
		{Type: assert.TypeStatus, Op: "neq", Value: 500},
		{Type: assert.TypeStatus, Op: "eq", Value: 200},
	}
	got := decode[sendResult](t, do(t, s, http.MethodPost, "/api/send", req))
	if got.Passed {
		t.Error("passed = true for a request that got no response")
	}
	if len(got.Assertions) != 3 {
		t.Fatalf("%d outcomes, want 3", len(got.Assertions))
	}
	for _, o := range got.Assertions {
		if o.Passed || o.Actual != runner.NoResponse || o.Error != runner.NotEvaluated {
			t.Errorf("outcome %+v, want failed, actual %q, error %q", o, runner.NoResponse, runner.NotEvaluated)
		}
	}
}

// A Send that is answered with a redirect shows the redirect; the server it
// points at is never asked.
func TestSendRecordsARedirectWithoutFollowingIt(t *testing.T) {
	var away atomic.Int64
	elsewhere := serveTarget(t, func(w http.ResponseWriter, _ *http.Request) {
		away.Add(1)
		_, _ = io.WriteString(w, `{"total":107}`)
	})
	base := serveTarget(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", elsewhere+"/api/search")
		w.WriteHeader(http.StatusFound)
	})
	got := decode[sendResult](t, do(t, newServer(t, base, nil), http.MethodPost, "/api/send", sendable()))
	if got.Status != http.StatusFound || got.Error != "" {
		t.Errorf("status %d error %q, want the 302 recorded", got.Status, got.Error)
	}
	if n := away.Load(); n != 0 {
		t.Errorf("the second server was asked %d times, want never", n)
	}
}
