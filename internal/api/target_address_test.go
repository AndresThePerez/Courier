package api

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// A made-up target name and port that nothing else in a response could carry.
const (
	sentinelHost = "sentinel-host-7f3a.invalid"
	sentinelPort = "47913"
)

// transportWords is the vocabulary of Go's dialler and HTTP client. None of
// it belongs in anything a visitor can fetch.
var transportWords = []string{
	"dial", "lookup", "connection refused", "timeout exceeded", "deadline", "EOF", "x509", "tls",
	`Get "`, "http:", "read tcp", "write tcp", "reset by peer", "broken pipe", "no such host",
	"server misbehaving", "unsupported protocol", "malformed HTTP", "Client.Timeout",
	"run aborted", "127.0.0.1", "chunk", "Content-Length", "SSH-2.0",
}

// leakScan fails when b carries the target's host, its port as a token, or
// any transport word. ("refused" alone is a metric name, sends_refused.)
func leakScan(t *testing.T, where string, b []byte, base string) {
	t.Helper()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse %q: %v", base, err)
	}
	s := string(b)
	if h := u.Hostname(); strings.Contains(s, h) {
		t.Errorf("%s carries the target host %q: %.300s", where, h, around(s, h))
	}
	if p := u.Port(); p != "" && regexp.MustCompile(`(^|[^0-9.])`+p+`([^0-9.]|$)`).MatchString(s) {
		t.Errorf("%s carries the target port %s: %.300s", where, p, around(s, p))
	}
	for _, w := range transportWords {
		if strings.Contains(s, w) {
			t.Errorf("%s carries %q: %.300s", where, w, around(s, w))
		}
	}
}

func around(s, sub string) string {
	i := strings.Index(s, sub)
	if i < 0 {
		return ""
	}
	return s[max(0, i-120):min(len(s), i+len(sub)+120)]
}

// pdfText is a PDF with every Flate stream inflated in place, so text drawn on
// the page is searchable.
func pdfText(t *testing.T, b []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	re := regexp.MustCompile(`(?s)stream\r?\n(.*?)\r?\nendstream`)
	last := 0
	for _, m := range re.FindAllSubmatchIndex(b, -1) {
		out.Write(b[last:m[2]])
		raw := b[m[2]:m[3]]
		if zr, err := zlib.NewReader(bytes.NewReader(raw)); err == nil {
			inflated, _ := io.ReadAll(zr)
			out.Write(inflated)
		} else {
			out.Write(raw)
		}
		last = m[3]
	}
	out.Write(b[last:])
	// The trailer marker is the format's, not an error's.
	return bytes.ReplaceAll(out.Bytes(), []byte("%%EOF"), nil)
}

// rawAnswer is a target speaking raw bytes after reading the request headers.
// answer may block; it is released when the client hangs up or the test ends.
func rawAnswer(t *testing.T, hits *atomic.Int64, answer func(net.Conn)) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	var wg sync.WaitGroup
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
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
				if hits != nil {
					hits.Add(1)
				}
				answer(c)
			}()
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		mu.Lock()
		for _, c := range conns {
			c.Close()
		}
		mu.Unlock()
		wg.Wait()
	})
	return "http://" + ln.Addr().String()
}

func sayThenClose(s string) func(net.Conn) {
	return func(c net.Conn) { _, _ = io.WriteString(c, s) }
}

func sayThenStall(s string) func(net.Conn) {
	return func(c net.Conn) {
		_, _ = io.WriteString(c, s)
		_, _ = io.Copy(io.Discard, c)
	}
}

// fetch performs a request against a live front server and returns the body.
func fetch(t *testing.T, method, u string, header http.Header) (int, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, method, u, nil)
	for k, v := range header {
		req.Header[k] = v
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, u, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil && ctx.Err() != nil {
		t.Fatalf("%s %s did not end: %v", method, u, err)
	}
	return resp.StatusCode, b
}

// scanEverySurface fetches every route a visitor can reach for run id and
// scans each body.
func scanEverySurface(t *testing.T, s *Server, id, base string) {
	t.Helper()
	front := httptest.NewServer(s)
	defer front.Close()
	for _, path := range []string{"/api/status", "/api/runs", "/api/runs/" + id, "/metrics", "/api/runs/missing-run"} {
		_, b := fetch(t, http.MethodGet, front.URL+path, nil)
		leakScan(t, "GET "+path, b, base)
	}
	_, b := fetch(t, http.MethodGet, front.URL+"/api/runs/"+id+"/stream", nil)
	leakScan(t, "the stream", b, base)
	_, b = fetch(t, http.MethodGet, front.URL+"/api/runs/"+id+"/stream", http.Header{"Last-Event-Id": {"1"}})
	leakScan(t, "the resumed stream", b, base)
	code, b := fetch(t, http.MethodGet, front.URL+"/api/runs/"+id+"/report.pdf", nil)
	if code == http.StatusOK {
		leakScan(t, "the PDF", pdfText(t, b), base)
	}
	_, b = fetch(t, http.MethodDelete, front.URL+"/api/runs/"+id, nil)
	leakScan(t, "DELETE", b, base)
}

// brokenTargets are the ways a target can fail, each served so its address is
// known, with the sentence its row must read as ("" when it is an answer).
func brokenTargets(t *testing.T) []struct{ name, base, msg string } {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	refused := "http://" + ln.Addr().String()
	ln.Close()
	plainSrv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(plainSrv.Close)
	plain := plainSrv.URL
	return []struct{ name, base, msg string }{
		{"refused", refused, runner.MsgConnection},
		{"unresolvable sentinel host", "http://" + sentinelHost + ":" + sentinelPort, runner.MsgConnection},
		{"tls to a plain target", strings.Replace(plain, "http://", "https://", 1), runner.MsgConnection},
		{"accepts and closes", rawAnswer(t, nil, sayThenClose("")), runner.MsgConnection},
		{"closes after the status line", rawAnswer(t, nil, sayThenClose("HTTP/1.1 200 OK\r\n")), runner.MsgConnection},
		{"closes mid-headers", rawAnswer(t, nil, sayThenClose("HTTP/1.1 200 OK\r\nContent-Ty")), runner.MsgConnection},
		{"short content length", rawAnswer(t, nil, sayThenClose("HTTP/1.1 200 OK\r\nContent-Length: 900\r\n\r\n{\"total\":")), runner.MsgDropped},
		{"invalid chunk", rawAnswer(t, nil, sayThenClose("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nabc\r\n")), runner.MsgDropped},
		{"garbage", rawAnswer(t, nil, sayThenClose("SSH-2.0-not-http\r\n\x00\x01\r\n\r\n")), runner.MsgConnection},
		{"redirect to the sentinel", rawAnswer(t, nil, sayThenClose("HTTP/1.1 302 Found\r\nLocation: http://"+sentinelHost+":"+sentinelPort+"/x\r\nContent-Length: 0\r\n\r\n")), ""},
	}
}

// No byte a visitor can fetch, on any route, while or after a run, names the
// target or speaks the transport's vocabulary, whatever way the target broke.
func TestNoVisitorByteNamesTheTargetFunctional(t *testing.T) {
	for _, tc := range brokenTargets(t) {
		t.Run(tc.name, func(t *testing.T) {
			s := newServer(t, tc.base, nil)
			rec := do(t, s, http.MethodPost, "/api/send", sendable())
			leakScan(t, "the Send response", rec.Body.Bytes(), tc.base)
			if got := decode[sendResult](t, rec); got.Error != tc.msg {
				t.Errorf("send error = %q, want %q", got.Error, tc.msg)
			}

			id := startRun(t, s, payload(1, 0))
			waitIdle(t, s)
			rep := decode[report.Report](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
			if row := rep.Functional.Results[0]; row.Error != tc.msg {
				t.Errorf("row error = %q, want %q", row.Error, tc.msg)
			}
			if tc.msg != "" && rep.Functional.Verdict != report.VerdictFail {
				t.Errorf("verdict = %q, want FAIL", rep.Functional.Verdict)
			}
			scanEverySurface(t, s, id, tc.base)
		})
	}
}

// The same holds for a run stopped mid-request by Cancel and by the server
// shutting down, before and after the target's headers arrived, and for the
// 409 a second visitor reads while the run is live.
func TestNoVisitorByteNamesTheTargetWhenStoppedMidRequest(t *testing.T) {
	stalls := map[string]func(net.Conn){
		"before headers": sayThenStall(""),
		"after headers":  sayThenStall("HTTP/1.1 200 OK\r\nContent-Length: 900\r\n\r\n{\"total\":"),
	}
	for name, answer := range stalls {
		for _, how := range []string{"cancel", "shutdown"} {
			t.Run(how+" "+name, func(t *testing.T) {
				var hits atomic.Int64
				base := rawAnswer(t, &hits, answer)
				s := newServer(t, base, nil)
				id := startRun(t, s, payload(2, 0))
				waitFor(t, "a dispatch to reach the target", func() bool { return hits.Load() > 0 })
				busy := do(t, s, http.MethodPost, "/api/runs", payload(1, 0))
				if busy.Code != http.StatusConflict {
					t.Errorf("second start = %d, want 409", busy.Code)
				}
				leakScan(t, "the 409", busy.Body.Bytes(), base)
				leakScan(t, "the live report", do(t, s, http.MethodGet, "/api/runs/"+id, nil).Body.Bytes(), base)
				switch how {
				case "cancel":
					if rec := do(t, s, http.MethodDelete, "/api/runs/"+id, nil); rec.Code != http.StatusNoContent {
						t.Fatalf("cancel = %d", rec.Code)
					}
				default:
					ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
					defer cancel()
					if err := s.Close(ctx); err != nil {
						t.Fatalf("close: %v", err)
					}
				}
				waitIdle(t, s)
				rep := decode[report.Report](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
				row := rep.Functional.Results[0]
				if row.Error != runner.MsgAborted || !row.Skipped {
					t.Errorf("row = error %q skipped %v, want %q and skipped", row.Error, row.Skipped, runner.MsgAborted)
				}
				scanEverySurface(t, s, id, base)
			})
		}
	}
}

// Performance mode: the live partial report, the progress frames, the error
// breakdown and the PDF carry kinds and counts, never the target.
func TestNoVisitorByteNamesTheTargetPerformance(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	refused := "http://" + ln.Addr().String()
	ln.Close()
	dropping := rawAnswer(t, nil, sayThenClose("HTTP/1.1 200 OK\r\nContent-Length: 900\r\n\r\n{\"total\":"))
	for name, base := range map[string]string{"refused": refused, "dropping": dropping} {
		t.Run(name, func(t *testing.T) {
			s := newServer(t, base, nil)
			front := httptest.NewServer(s)
			defer front.Close()
			id := startRun(t, s, sandbox.RunRequest{Mode: sandbox.ModePerformance, Sequence: payload(1, 0).Sequence,
				Options: sandbox.Options{Concurrency: 2, DurationSecs: 1}})
			// The stream is opened while the run is live, so progress frames
			// are read as they are sent.
			streamed := make(chan []byte, 1)
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				req, _ := http.NewRequestWithContext(ctx, http.MethodGet, front.URL+"/api/runs/"+id+"/stream", nil)
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					streamed <- nil
					return
				}
				defer resp.Body.Close()
				b, _ := io.ReadAll(resp.Body)
				streamed <- b
			}()
			for s.mgr.Status().Running {
				leakScan(t, "the live report", do(t, s, http.MethodGet, "/api/runs/"+id, nil).Body.Bytes(), base)
				leakScan(t, "the live status", do(t, s, http.MethodGet, "/api/status", nil).Body.Bytes(), base)
				time.Sleep(100 * time.Millisecond)
			}
			waitIdle(t, s)
			live := <-streamed
			if !bytes.Contains(live, []byte("event: progress")) {
				t.Errorf("the live stream carried no progress frame: %.300s", live)
			}
			leakScan(t, "the live stream", live, base)
			rep := decode[report.Report](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
			if rep.Performance.Overall.Errors == 0 {
				t.Errorf("overall = %+v, want counted failures", rep.Performance.Overall)
			}
			scanEverySurface(t, s, id, base)
		})
	}
}

// The log keeps every failed dispatch's raw cause exactly once: one
// dispatch_failed per failed row of a functional run with its run id and
// index, one per failed Send with its endpoint, none for an answered dispatch,
// and none per dispatch in performance mode. No other line repeats the cause.
func TestEachFailedDispatchIsLoggedExactlyOnce(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	refused := "http://" + ln.Addr().String()
	addr := ln.Addr().String()
	ln.Close()

	s, logs := newLoggedServer(t, refused)
	id := startRun(t, s, payload(3, 0))
	waitIdle(t, s)
	failed := logs.lines(t, runner.EventDispatchFailed)
	if len(failed) != 3 {
		t.Fatalf("%d %s lines for 3 failed dispatches, want 3", len(failed), runner.EventDispatchFailed)
	}
	for i, l := range failed {
		errText, _ := l["err"].(string)
		if l["run_id"] != id || l["index"] != float64(i) || l["error_kind"] != report.KindConnection ||
			!strings.Contains(errText, addr) || l["level"] != "WARN" {
			t.Errorf("line %d = %v, want run %s index %d kind connection and the raw error naming %s", i, l, id, i, addr)
		}
	}
	if n := linesWith(logs, addr); n != 3 {
		t.Errorf("%d log lines carry the target address, want 3 (one per failed dispatch)", n)
	}

	rec := do(t, s, http.MethodPost, "/api/send", sendable())
	if rec.Code != http.StatusOK {
		t.Fatalf("send = %d", rec.Code)
	}
	failed = logs.lines(t, runner.EventDispatchFailed)
	if len(failed) != 4 || failed[3]["endpoint"] != "search" || failed[3]["run_id"] != nil {
		t.Errorf("after one failed Send: %v, want a 4th line with endpoint search and no run id", failed)
	}
	if n := linesWith(logs, addr); n != 4 {
		t.Errorf("%d log lines carry the target address after a Send, want 4", n)
	}

	// Performance: thousands of possible failures, no per-dispatch line.
	ps, plogs := newLoggedServer(t, refused)
	pid := startRun(t, ps, sandbox.RunRequest{Mode: sandbox.ModePerformance, Sequence: payload(1, 0).Sequence,
		Options: sandbox.Options{Concurrency: 4, DurationSecs: 1}})
	waitIdle(t, ps)
	rep := decode[report.Report](t, do(t, ps, http.MethodGet, "/api/runs/"+pid, nil))
	if rep.Performance.Overall.Errors == 0 {
		t.Fatalf("the performance run failed nothing: %+v", rep.Performance.Overall)
	}
	if n := len(plogs.lines(t, runner.EventDispatchFailed)); n != 0 {
		t.Errorf("%d %s lines in performance mode, want 0", n, runner.EventDispatchFailed)
	}
	if strings.Contains(plogs.String(), addr) {
		t.Error("a performance run logged the target address")
	}

	// A healthy dispatch logs no failure.
	hs, hlogs := newLoggedServer(t, newTarget(t, 0))
	do(t, hs, http.MethodPost, "/api/send", sendable())
	startRun(t, hs, payload(2, 0))
	waitIdle(t, hs)
	if n := len(hlogs.lines(t, runner.EventDispatchFailed)); n != 0 {
		t.Errorf("%d %s lines for answered dispatches, want 0", n, runner.EventDispatchFailed)
	}
}

func linesWith(logs *syncBuffer, s string) int {
	n := 0
	for _, line := range strings.Split(logs.String(), "\n") {
		if strings.Contains(line, s) {
			n++
		}
	}
	return n
}

// An aborted dispatch is logged at most once, and the log agrees with the
// report: one line per row that carries an error, none for a row that was
// never dispatched.
func TestAnAbortedDispatchIsLoggedConsistently(t *testing.T) {
	var hits atomic.Int64
	base := rawAnswer(t, &hits, sayThenStall(""))
	s, logs := newLoggedServer(t, base)
	id := startRun(t, s, payload(3, 0))
	waitFor(t, "a dispatch to reach the target", func() bool { return hits.Load() > 0 })
	if rec := do(t, s, http.MethodDelete, "/api/runs/"+id, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("cancel = %d", rec.Code)
	}
	waitIdle(t, s)
	rep := decode[report.Report](t, do(t, s, http.MethodGet, "/api/runs/"+id, nil))
	withError := map[float64]bool{}
	for _, r := range rep.Functional.Results {
		if !r.Skipped {
			t.Errorf("row %d not skipped after a cancel: %+v", r.Index, r)
		}
		if r.Error != "" {
			withError[float64(r.Index)] = true
		}
	}
	failed := logs.lines(t, runner.EventDispatchFailed)
	if len(failed) != len(withError) {
		t.Errorf("%d %s lines, %d rows carrying an error", len(failed), runner.EventDispatchFailed, len(withError))
	}
	for _, l := range failed {
		if !withError[l["index"].(float64)] || l["error_kind"] != runner.ErrKindAborted {
			t.Errorf("line %v does not match an aborted row", l)
		}
	}
}

// A huge run id is quoted clipped on a rune boundary on every route that
// names it; DELETE does not quote it at all.
func TestAHugeMultibyteRunIDIsClippedOnARuneBoundary(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	id := strings.Repeat("é", 450_000) // 900 KB
	esc := url.PathEscape(id)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/runs/" + esc},
		{http.MethodGet, "/api/runs/" + esc + "/stream"},
		{http.MethodGet, "/api/runs/" + esc + "/report.pdf"},
		{http.MethodDelete, "/api/runs/" + esc},
	} {
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
		if rec.Code != http.StatusNotFound || rec.Body.Len() >= 1024 {
			t.Errorf("%s %.40s: %d with %d bytes, want 404 under 1 KB", tc.method, tc.path, rec.Code, rec.Body.Len())
			continue
		}
		eb := decode[errorBody](t, rec)
		if !utf8.ValidString(eb.Error) || strings.ContainsRune(eb.Error, utf8.RuneError) {
			t.Errorf("%s: error %q splits a character", tc.method, eb.Error)
		}
		if tc.method == http.MethodGet && !strings.HasPrefix(eb.Error, `no run "éé`) {
			t.Errorf("%s: error %q, want the clipped id quoted", tc.method, eb.Error)
		}
	}
	if eb := decode[errorBody](t, do(t, s, http.MethodGet, "/api/runs/abc", nil)); eb.Error != `no run "abc"` {
		t.Errorf("short id: %q", eb.Error)
	}
}

// Sends racing a functional run against a dead target each log their own
// cause once, and the rows and responses stay clean.
func TestConcurrentSendsAndARunLogEachFailureOnce(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + ln.Addr().String()
	ln.Close()
	s, logs := newLoggedServer(t, base)
	id := startRun(t, s, payload(5, 5))

	var answered atomic.Int64
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 5 {
				rec := do(t, s, http.MethodPost, "/api/send", sendable())
				switch rec.Code {
				case http.StatusOK:
					answered.Add(1)
					leakScan(t, "a racing Send", rec.Body.Bytes(), base)
				case http.StatusTooManyRequests:
				default:
					t.Errorf("send = %d %s", rec.Code, rec.Body.String())
				}
			}
		}()
	}
	wg.Wait()
	waitIdle(t, s)

	var sends, rows int
	for _, l := range logs.lines(t, runner.EventDispatchFailed) {
		switch {
		case l["run_id"] == id:
			rows++
		case l["endpoint"] == "search" && l["run_id"] == nil:
			sends++
		default:
			t.Errorf("unexpected %s line %v", runner.EventDispatchFailed, l)
		}
	}
	if rows != 5 || int64(sends) != answered.Load() {
		t.Errorf("%d row lines and %d send lines, want 5 and %d", rows, sends, answered.Load())
	}
	leakScan(t, "the report", do(t, s, http.MethodGet, "/api/runs/"+id, nil).Body.Bytes(), base)
}

// Bodies built to trip a hand-written JSON reader are refused through the
// handler with a small 400 in the one error shape, on both payload routes.
func TestAdversarialBodiesGetTheOneErrorShape(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	bodies := map[string]string{
		"lone quote":            `"`,
		"open string":           `{"endpoint":"search`,
		"backslash at the end":  `{"endpoint":"search\`,
		"escaped closing quote": `{"endpoint":"search\"}`,
		"huge number":           `{"endpoint":"search","assertions":[{"type":"status","op":"eq","value":1e400}]}`,
		"long number":           `{"endpoint":"search","assertions":[{"type":"status","op":"eq","value":` + strings.Repeat("9", 5000) + `}]}`,
		"nul in a key":          "{\"end\x00point\":\"search\"}",
		"nul outside a string":  "{\"endpoint\":\"search\"\x00}",
		"invalid utf-8 key":     "{\"\xff\xfe\":1}",
		"deep without closers":  strings.Repeat(`{"a":[`, 20000),
		"deep closed":           `{"assertions":[{"value":` + strings.Repeat("[", 5000) + strings.Repeat("]", 5000) + `}]}`,
		"trailing comma":        `{"endpoint":"search",}`,
		"bare minus":            `{"options":{"delay_ms":-}}`,
		"unknown key":           `{"endpoint":"search","proxy":"http://192.0.2.10"}`,
		"unknown nested key":    `{"endpoint":"search","assertions":[{"type":"status","op":"eq","value":200,"follow":true}]}`,
	}
	for name, body := range bodies {
		for _, path := range []string{"/api/send", "/api/runs"} {
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				defer func() {
					if p := recover(); p != nil {
						t.Errorf("%s %s: handler panicked: %v", name, path, p)
						done <- nil
					}
				}()
				done <- postRaw(t, s, path, strings.NewReader(body), "application/json")
			}()
			var rec *httptest.ResponseRecorder
			select {
			case rec = <-done:
			case <-time.After(10 * time.Second):
				t.Fatalf("%s %s: the handler did not return", name, path)
			}
			if rec == nil {
				continue
			}
			if rec.Code != http.StatusBadRequest || rec.Header().Get("Content-Type") != "application/json" || rec.Body.Len() >= 1024 {
				t.Errorf("%s %s: %d %q %d bytes, want a small JSON 400", name, path, rec.Code, rec.Header().Get("Content-Type"), rec.Body.Len())
				continue
			}
			if eb := decode[errorBody](t, rec); eb.Error == "" {
				t.Errorf("%s %s: empty error", name, path)
			}
		}
	}
}
