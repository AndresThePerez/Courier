package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// rawTarget is a target that speaks raw bytes: each accepted connection has
// its request headers read and is then handed to answer, which may write
// anything and may block until the client gives up. It counts connections.
type rawTarget struct {
	url   string
	conns atomic.Int64
}

func newRawTarget(t *testing.T, answer func(net.Conn)) *rawTarget {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	rt := &rawTarget{url: "http://" + ln.Addr().String()}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var open []net.Conn
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			rt.conns.Add(1)
			mu.Lock()
			open = append(open, c)
			mu.Unlock()
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer c.Close()
				br := bufio.NewReader(c)
				for {
					line, err := br.ReadString('\n')
					if err != nil {
						return
					}
					if line == "\r\n" {
						break
					}
				}
				answer(c)
			}()
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		mu.Lock()
		for _, c := range open {
			c.Close()
		}
		mu.Unlock()
		wg.Wait()
	})
	return rt
}

// writeThenClose answers with s and hangs up.
func writeThenClose(s string) func(net.Conn) {
	return func(c net.Conn) { _, _ = io.WriteString(c, s) }
}

// writeThenStall answers with s and keeps the connection open until the
// client closes it.
func writeThenStall(s string) func(net.Conn) {
	return func(c net.Conn) {
		_, _ = io.WriteString(c, s)
		_, _ = io.Copy(io.Discard, c)
	}
}

// Each way a target can break maps to exactly one public sentence and one
// error kind, and the functional row agrees with the dispatch.
func TestEveryBrokenAnswerReadsAsOneFixedSentence(t *testing.T) {
	const short = 200 * time.Millisecond
	cases := []struct {
		name    string
		answer  func(net.Conn)
		timeout bool // shorten the client ceiling
		abort   bool // abort the run while the dispatch is in flight
		status  int
		kind    string
		msg     string
	}{
		{name: "accepts and closes at once", answer: writeThenClose(""),
			kind: ErrKindConnection, msg: MsgConnection},
		{name: "closes after the status line", answer: writeThenClose("HTTP/1.1 200 OK\r\n"),
			kind: ErrKindConnection, msg: MsgConnection},
		{name: "closes mid-headers", answer: writeThenClose("HTTP/1.1 200 OK\r\nContent-Type: appl"),
			kind: ErrKindConnection, msg: MsgConnection},
		{name: "resets the connection", answer: func(c net.Conn) {
			if tc, ok := c.(*net.TCPConn); ok {
				_ = tc.SetLinger(0)
			}
		}, kind: ErrKindConnection, msg: MsgConnection},
		{name: "answers garbage", answer: writeThenClose("SSH-2.0-not-http\r\n\x00\x01\x02\r\n\r\n"),
			kind: ErrKindConnection, msg: MsgConnection},
		{name: "delivers less than its content length",
			answer: writeThenClose("HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n{\"total\":1}"),
			status: 200, kind: ErrKindConnection, msg: MsgDropped},
		{name: "sends an invalid chunk",
			answer: writeThenClose("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nabc\r\n"),
			status: 200, kind: ErrKindConnection, msg: MsgDropped},
		{name: "stalls before its headers", answer: writeThenStall(""), timeout: true,
			kind: ErrKindTimeout, msg: MsgTimeout},
		{name: "stalls after its headers",
			answer:  writeThenStall("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"to"),
			timeout: true, status: 200, kind: ErrKindTimeout, msg: MsgTimeout},
		{name: "aborted before its headers", answer: writeThenStall(""), abort: true,
			kind: ErrKindAborted, msg: MsgAborted},
		{name: "aborted after its headers",
			answer: writeThenStall("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"to"), abort: true,
			status: 200, kind: ErrKindAborted, msg: MsgAborted},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rt := newRawTarget(t, tc.answer)
			ex := NewExecutor(rt.url)
			if tc.timeout {
				withTimeout(ex, short)
			}
			ctx := context.Background()
			if tc.abort {
				var abort context.CancelCauseFunc
				ctx, abort = context.WithCancelCause(ctx)
				defer abort(nil)
				go func() {
					deadline := time.Now().Add(10 * time.Second)
					for rt.conns.Load() == 0 && time.Now().Before(deadline) {
						time.Sleep(time.Millisecond)
					}
					time.Sleep(50 * time.Millisecond) // let the headers land
					abort(ErrRunAborted)
				}()
			}
			resp := ex.Do(ctx, searchReq(nil), true)
			if resp.Err == nil {
				t.Fatalf("dispatch succeeded with status %d", resp.Status)
			}
			if resp.ErrKind != tc.kind {
				t.Errorf("kind = %q, want %q (raw: %v)", resp.ErrKind, tc.kind, resp.Err)
			}
			if resp.Status != tc.status {
				t.Errorf("status = %d, want %d (raw: %v)", resp.Status, tc.status, resp.Err)
			}
			if got := resp.PublicError(); got != tc.msg {
				t.Errorf("public error = %q, want %q (raw: %v)", got, tc.msg, resp.Err)
			}

			row := functionalResult(0, searchReq(nil), ex, resp)
			if row.Error != tc.msg || row.ErrorKind != tc.kind || row.Passed {
				t.Errorf("row = error %q kind %q passed %v, want %q %q and not passed", row.Error, row.ErrorKind, row.Passed, tc.msg, tc.kind)
			}
			if row.Skipped != (tc.kind == ErrKindAborted) {
				t.Errorf("row skipped = %v for kind %q; only an abort is skipped", row.Skipped, tc.kind)
			}
			if !errors.Is(row.Cause, resp.Err) {
				t.Errorf("row cause = %v, want the raw error for the log", row.Cause)
			}
		})
	}
}

// allOperators is one assertion for every type and operator the validator
// accepts, each of which a 0 status, a near-zero latency or an empty body
// could satisfy if it were evaluated.
func allOperators() []assert.Assertion {
	return []assert.Assertion{
		{Type: assert.TypeStatus, Op: "eq", Value: float64(200)},
		{Type: assert.TypeStatus, Op: "neq", Value: float64(500)},
		{Type: assert.TypeLatency, Op: "lt", Value: float64(10000)},
		{Type: assert.TypeBodyContains, Op: "contains", Value: ""},
		{Type: assert.TypeJSON, Path: "$", Op: "exists"},
		{Type: assert.TypeJSON, Path: "$.total", Op: "neq", Value: float64(1)},
		{Type: assert.TypeJSON, Path: "$.total", Op: "eq", Value: float64(0)},
		{Type: assert.TypeJSON, Path: "$.total", Op: "lt", Value: float64(1)},
		{Type: assert.TypeJSON, Path: "$.total", Op: "gt", Value: float64(-1)},
		{Type: assert.TypeJSON, Path: "$.results", Op: "count", Value: float64(0)},
		{Type: assert.TypeJSON, Path: "$.name", Op: "contains", Value: ""},
	}
}

// With no response, every operator of every type fails as not evaluated,
// whatever the failure took and whatever the failure was.
func TestNoResponseFailsEveryOperator(t *testing.T) {
	for _, a := range allOperators() {
		if err := assert.ValidateAssertion(a); err != nil {
			t.Fatalf("fixture %+v is not a valid assertion: %v", a, err)
		}
	}
	for _, kind := range []string{ErrKindConnection, ErrKindTimeout} {
		resp := Response{LatencyMs: 0.01, Err: errors.New("raw sentinel-host-7f3a.invalid:47913"), ErrKind: kind}
		outcomes, all := EvaluateResponse(allOperators(), resp)
		if all {
			t.Errorf("%s: all passed with no response", kind)
		}
		if len(outcomes) != len(allOperators()) {
			t.Fatalf("%s: %d outcomes, want %d", kind, len(outcomes), len(allOperators()))
		}
		for i, o := range outcomes {
			if o.Passed || o.Actual != NoResponse || o.Error != NotEvaluated {
				t.Errorf("%s: outcome %d %+v, want failed, %q, %q", kind, i, o, NoResponse, NotEvaluated)
			}
			if strings.Contains(o.Error+o.Actual+o.Expected, "sentinel") {
				t.Errorf("%s: outcome %d carries the raw error: %+v", kind, i, o)
			}
		}
	}

	// No assertions and no response: the list is empty but present, and the
	// row it builds is failed, not passed and not skipped.
	outcomes, all := EvaluateResponse(nil, Response{Err: errors.New("x"), ErrKind: ErrKindConnection})
	if outcomes == nil || len(outcomes) != 0 || all {
		t.Errorf("zero assertions: outcomes %#v all %v, want an empty list and false", outcomes, all)
	}
	ex := NewExecutor(closedTarget(t))
	res := RunFunctional(context.Background(), ex, sandbox.RunRequest{Mode: sandbox.ModeFunctional,
		Sequence: []sandbox.Request{{ID: "1", Name: "a", Endpoint: "search"}, {ID: "2", Name: "b", Endpoint: "healthz"}}}, nil)
	f := res.Functional
	if f.Failed != 2 || f.Passed != 0 || f.Skipped != 0 {
		t.Errorf("counts passed %d failed %d skipped %d, want 0/2/0", f.Passed, f.Failed, f.Skipped)
	}
	for _, row := range f.Results {
		if row.Passed || row.Skipped || row.Assertions == nil {
			t.Errorf("row %+v, want failed with an empty assertion list", row)
		}
	}
	if v := report.FunctionalVerdict(res.Status, f); v != report.VerdictFail {
		t.Errorf("verdict = %q, want FAIL", v)
	}
}

// A healthy response is held to its assertions exactly as before.
func TestAHealthyResponseIsEvaluatedAsBefore(t *testing.T) {
	resp := Response{Status: 200, LatencyMs: 5, Body: []byte(`{"total":3,"name":"Charizard","results":[1,2,3]}`)}
	as := []assert.Assertion{
		{Type: assert.TypeStatus, Op: "eq", Value: float64(200)},
		{Type: assert.TypeStatus, Op: "neq", Value: float64(200)},
		{Type: assert.TypeLatency, Op: "lt", Value: float64(150)},
		{Type: assert.TypeBodyContains, Op: "contains", Value: "charizard"},
		{Type: assert.TypeJSON, Path: "$.results", Op: "count", Value: float64(3)},
		{Type: assert.TypeJSON, Path: "$.total", Op: "gt", Value: float64(5)},
	}
	want := []bool{true, false, true, true, true, false}
	outcomes, all := EvaluateResponse(as, resp)
	direct, directAll := assert.EvaluateAll(as, assert.NewTarget(200, 5, resp.Body))
	if all || directAll {
		t.Errorf("all = %v (direct %v), want false: two assertions fail", all, directAll)
	}
	for i, o := range outcomes {
		if o.Passed != want[i] {
			t.Errorf("outcome %d %+v, want passed %v", i, o, want[i])
		}
		if o != direct[i] {
			t.Errorf("outcome %d = %+v, direct evaluation %+v", i, o, direct[i])
		}
		if o.Actual == NoResponse || o.Error == NotEvaluated {
			t.Errorf("outcome %d of a real response reads as not evaluated: %+v", i, o)
		}
	}
}

// redirectAnswers are 3xx answers of every shape a target might give.
func redirectAnswers(elsewhere string) map[string]func(http.ResponseWriter) {
	host := strings.TrimPrefix(elsewhere, "http://")
	loc := func(code int, l string) func(http.ResponseWriter) {
		return func(w http.ResponseWriter) {
			w.Header().Set("Location", l)
			w.WriteHeader(code)
		}
	}
	out := map[string]func(http.ResponseWriter){}
	for _, code := range []int{301, 302, 303, 307, 308} {
		out[fmt.Sprintf("%d scheme-relative", code)] = loc(code, "//"+host+"/api/search")
		out[fmt.Sprintf("%d absolute", code)] = loc(code, elsewhere+"/api/search")
		out[fmt.Sprintf("%d javascript", code)] = loc(code, "javascript:alert(1)")
		out[fmt.Sprintf("%d file", code)] = loc(code, "file:///etc/hosts")
		out[fmt.Sprintf("%d reserved name", code)] = loc(code, "http://target.invalid/api/search")
		out[fmt.Sprintf("%d empty", code)] = loc(code, "")
		out[fmt.Sprintf("%d missing", code)] = func(w http.ResponseWriter) { w.WriteHeader(code) }
		out[fmt.Sprintf("%d with a body and a refresh", code)] = func(w http.ResponseWriter) {
			w.Header().Set("Location", elsewhere+"/api/search")
			w.Header().Set("Refresh", "0; url="+elsewhere+"/api/search")
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(code)
			fmt.Fprintf(w, `<meta http-equiv="refresh" content="0; url=%s/api/search">`, elsewhere)
		}
	}
	out["200 with a refresh"] = func(w http.ResponseWriter) {
		w.Header().Set("Refresh", "0; url="+elsewhere+"/api/search")
		fmt.Fprintf(w, `<meta http-equiv="refresh" content="0; url=%s/api/search">`, elsewhere)
	}
	return out
}

// No redirect of any shape is followed in any mode, and the target is asked
// exactly once per dispatch.
func TestRedirectsOfEveryShapeStayOnTheTarget(t *testing.T) {
	var away atomic.Int64
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		away.Add(1)
		fmt.Fprint(w, `{"total":1}`)
	}))
	defer elsewhere.Close()

	for name, answer := range redirectAnswers(elsewhere.URL) {
		var hits atomic.Int64
		target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hits.Add(1)
			answer(w)
		}))
		code := 200
		fmt.Sscanf(name, "%d", &code)

		resp := NewExecutor(target.URL).Do(context.Background(), searchReq(nil), true)
		if resp.Err != nil || resp.Status != code {
			t.Errorf("%s: status %d err %v, want %d recorded", name, resp.Status, resp.Err, code)
		}
		res := RunFunctional(context.Background(), NewExecutor(target.URL), sandbox.RunRequest{Mode: sandbox.ModeFunctional,
			Sequence: []sandbox.Request{{ID: "1", Name: "a", Endpoint: "search"}}}, nil)
		if row := res.Functional.Results[0]; row.Status != code || row.Error != "" {
			t.Errorf("%s: functional row status %d error %q, want %d", name, row.Status, row.Error, code)
		}
		if n := hits.Load(); n != 2 {
			t.Errorf("%s: the target was asked %d times for 2 dispatches", name, n)
		}
		target.Close()
	}

	// Performance mode: every 3xx is a recorded non-2xx, never a dispatch to
	// another host, and the dead-target pacing does not engage on an answer.
	var hits atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Location", elsewhere.URL+"/api/search")
		w.WriteHeader(http.StatusFound)
	}))
	defer target.Close()
	res := RunPerformance(context.Background(), NewExecutor(target.URL), perfRun(oneRequest(), 2, 1), nil)
	o := res.Performance.Overall
	if o.Requests == 0 || int64(o.Requests) != hits.Load() {
		t.Errorf("performance: %d dispatches recorded, the target saw %d", o.Requests, hits.Load())
	}
	if o.StatusCounts[http.StatusFound] != o.Requests || o.Errors != o.Requests || o.OK != 0 {
		t.Errorf("performance: overall %+v, want every dispatch a recorded 302 counted as non-2xx", o)
	}
	if nextBackoff(BackoffFirst, Response{Status: http.StatusFound}) != 0 {
		t.Error("a 3xx answer paced the next dispatch")
	}
	if nextBackoff(0, Response{Err: errors.New("refused"), ErrKind: ErrKindConnection}) != BackoffFirst {
		t.Error("a refused connection no longer paces the next dispatch")
	}
	if n := away.Load(); n != 0 {
		t.Errorf("the second server was asked %d times, want never", n)
	}
}

// The accounting identity holds over a mix of 2xx, 3xx, refusals and aborts.
func TestAccountingHoldsOverAnswersRedirectsRefusalsAndAborts(t *testing.T) {
	var n atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch n.Add(1) % 4 {
		case 0:
			w.Header().Set("Location", "/x")
			w.WriteHeader(http.StatusMovedPermanently)
		case 1:
			fmt.Fprint(w, `{"total":1}`)
		case 2:
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
		default:
			<-r.Context().Done()
		}
	}))
	defer srv.Close()
	ctx, abort := context.WithCancelCause(context.Background())
	time.AfterFunc(700*time.Millisecond, func() { abort(ErrRunAborted) })
	res := RunPerformance(ctx, NewExecutor(srv.URL), perfRun(oneRequest(), 4, 30), nil)
	o := res.Performance.Overall
	if o.Requests != o.OK+o.Errors+o.Aborted {
		t.Errorf("requests %d != ok %d + errors %d + aborted %d", o.Requests, o.OK, o.Errors, o.Aborted)
	}
	statuses := 0
	for _, c := range o.StatusCounts {
		statuses += c
	}
	if statuses+o.Aborted != o.Requests {
		t.Errorf("status counts %v (sum %d) + aborted %d != requests %d", o.StatusCounts, statuses, o.Aborted, o.Requests)
	}
	if o.StatusCounts[http.StatusMovedPermanently] == 0 || o.StatusCounts[200] == 0 || o.Aborted == 0 {
		t.Errorf("overall %+v, want 301s, 200s and aborts in the mix", o)
	}
	for k := range o.ErrorKinds {
		if k != report.KindNon2xx && k != report.KindConnection && k != report.KindTimeout {
			t.Errorf("unexpected error kind %q in %v", k, o.ErrorKinds)
		}
	}
}

// The proxy environment is ignored and every other limit the executor had is
// unchanged.
func TestTransportLimitsAreUnchangedAndTheProxyEnvironmentIgnored(t *testing.T) {
	for _, k := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"} {
		t.Setenv(k, "http://192.0.2.10:3128")
	}
	t.Setenv("NO_PROXY", "")
	t.Setenv("no_proxy", "")

	ex := NewExecutor("http://target.invalid")
	tr := transportOf(ex)
	if tr.Proxy != nil {
		t.Error("the transport consults a proxy")
	}
	def := http.DefaultTransport.(*http.Transport)
	if tr.MaxIdleConns != 256 || tr.MaxIdleConnsPerHost != 256 || tr.IdleConnTimeout != 90*time.Second {
		t.Errorf("idle pool = %d/%d/%v, want 256/256/90s", tr.MaxIdleConns, tr.MaxIdleConnsPerHost, tr.IdleConnTimeout)
	}
	if tr.TLSHandshakeTimeout != def.TLSHandshakeTimeout || tr.ExpectContinueTimeout != def.ExpectContinueTimeout ||
		tr.ResponseHeaderTimeout != def.ResponseHeaderTimeout || tr.ForceAttemptHTTP2 != def.ForceAttemptHTTP2 ||
		tr.DisableKeepAlives || tr.DisableCompression != def.DisableCompression || tr.MaxConnsPerHost != def.MaxConnsPerHost ||
		tr.DialContext == nil {
		t.Errorf("transport settings drifted from the default clone: %+v", tr)
	}
	if ex.client.Timeout != ClientTimeout || ClientTimeout != 10*time.Second {
		t.Errorf("client timeout = %v (constant %v), want 10s", ex.client.Timeout, ClientTimeout)
	}
	if MaxBodyBytes != 1<<20 {
		t.Errorf("MaxBodyBytes = %d, want 1 MiB", MaxBodyBytes)
	}
	if MsgTimeout != "the target did not respond within "+ClientTimeout.String() {
		t.Errorf("MsgTimeout = %q does not follow ClientTimeout %v", MsgTimeout, ClientTimeout)
	}
	if ex.client.CheckRedirect == nil || !errors.Is(ex.client.CheckRedirect(nil, nil), http.ErrUseLastResponse) {
		t.Error("the client would follow a redirect")
	}
	if ex.client.Jar != nil {
		t.Error("the client keeps cookies")
	}
}

// The raw cause never serializes, and the manager keeps none of it once the
// row has been logged: not in the live report, not in the stored one, not in
// history, and not in what it publishes. Readers race the run under -race.
func TestTheCauseIsNeitherSerializedNorRetained(t *testing.T) {
	const sentinel = "sentinel-host-7f3a.invalid:47913"
	cause := errors.New("Get \"http://" + sentinel + "/api/search\": dial tcp: lookup sentinel-host-7f3a.invalid: no such host")
	row := report.RequestResult{Index: 0, Name: "a", Endpoint: "search", Error: MsgConnection, ErrorKind: ErrKindConnection,
		Assertions: []assert.Outcome{}, Cause: cause}
	rep := report.Report{ID: "run-x", Mode: sandbox.ModeFunctional,
		Functional: &report.Functional{Results: []report.RequestResult{row}}}
	for name, v := range map[string]any{
		"row":    row,
		"rows":   []report.RequestResult{row},
		"report": rep,
		"event":  Event{Type: EventRequestResult, RunID: "run-x", Data: row},
		"ptr":    &row,
	} {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("%s: marshal: %v", name, err)
		}
		if strings.Contains(string(b), "sentinel") || strings.Contains(string(b), "dial") {
			t.Errorf("%s serializes the cause: %s", name, b)
		}
	}

	m, _, pub := newTestManager(t, closedTarget(t))
	rr := sandbox.RunRequest{Mode: sandbox.ModeFunctional, Options: sandbox.Options{DelayMs: 20}}
	for i := range 6 {
		rr.Sequence = append(rr.Sequence, sandbox.Request{ID: fmt.Sprint(i), Name: "a", Endpoint: "search"})
	}
	id, err := m.Start(context.Background(), rr)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	stop := make(chan struct{})
	var readers sync.WaitGroup
	for range 3 {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if r, ok := m.Report(id); ok && r.Functional != nil {
					for _, row := range r.Functional.Results {
						if row.Cause != nil {
							t.Errorf("the live report holds a cause: %v", row.Cause)
							return
						}
					}
				}
				_, _ = json.Marshal(m.History())
				time.Sleep(time.Millisecond)
			}
		}()
	}
	m.Wait()
	close(stop)
	readers.Wait()

	stored, ok := m.Report(id)
	if !ok || len(stored.Functional.Results) != 6 {
		t.Fatalf("stored report = %+v", stored)
	}
	for _, r := range append(stored.Functional.Results, m.History()[0].Functional.Results...) {
		if r.Cause != nil {
			t.Errorf("row %d of the stored report keeps its cause: %v", r.Index, r.Cause)
		}
		if r.Error != MsgConnection {
			t.Errorf("row %d error = %q", r.Index, r.Error)
		}
	}
	for _, e := range pub.Replay() {
		if rr, ok := e.Data.(report.RequestResult); ok && rr.Cause != nil {
			t.Errorf("a published row keeps its cause: %v", rr.Cause)
		}
		if r, ok := e.Data.(*report.Report); ok && r.Functional != nil {
			for _, row := range r.Functional.Results {
				if row.Cause != nil {
					t.Errorf("a published report keeps a cause: %v", row.Cause)
				}
			}
		}
	}
}
