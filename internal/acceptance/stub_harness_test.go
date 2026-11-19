//go:build acceptance

// Tests of the self-contained mode's own machinery: the stub target, the port
// helper, the readiness poll and the teardown. They stand up nothing of their
// own beyond loopback listeners and short-lived child processes, so they can
// be run alone, for example
//
//	ACCEPTANCE_SELF_CONTAINED=1 go test -race -tags acceptance ./internal/acceptance/ -run '^TestHarness'
//
// (TestMain still builds the world first; the matrix is simply not selected.)

package acceptance

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

func stubGet(t *testing.T, base, path string) (int, string) {
	t.Helper()
	resp, err := http.Get(base + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return resp.StatusCode, string(raw)
}

// The stub answers in each of its three modes as that mode promises, and a
// mode it does not know, or a stall it cannot parse, is refused without
// changing the mode.
func TestHarnessStubAnswersInEachModeAndRefusesBadSwitches(t *testing.T) {
	srv := httptest.NewServer(newStubTarget())
	defer srv.Close()

	code, body := stubGet(t, srv.URL, "/api/search?q=charizard")
	if code != http.StatusOK {
		t.Fatalf("ok mode: search = %d %s", code, body)
	}
	var search struct {
		Total   int `json:"total"`
		Results []struct {
			Name string `json:"name"`
		} `json:"results"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal([]byte(body), &search); err != nil {
		t.Fatalf("search body is not JSON: %v\n%s", err, body)
	}
	if search.Total != 2 || len(search.Results) != 2 || search.RequestID == "" {
		t.Errorf("search for charizard = %+v, want the two Charizard cards and a request_id", search)
	}
	if code, _ := stubGet(t, srv.URL, "/api/search?q=no-such-card-anywhere"); code != http.StatusOK {
		t.Errorf("a search with no match = %d, want 200 with no results", code)
	}
	if code, _ := stubGet(t, srv.URL, "/healthz"); code != http.StatusOK {
		t.Errorf("healthz = %d", code)
	}
	if code, _ := stubGet(t, srv.URL, "/nope"); code != http.StatusNotFound {
		t.Errorf("unknown path = %d, want 404", code)
	}

	for _, bad := range []string{"/__mode?m=explode", "/__mode", "/__mode?m=stall&stall_ms=abc", "/__mode?m=stall&stall_ms=-5"} {
		if code, _ := stubGet(t, srv.URL, bad); code != http.StatusBadRequest {
			t.Errorf("GET %s = %d, want 400", bad, code)
		}
	}
	if code, _ := stubGet(t, srv.URL, "/api/search?q=pikachu"); code != http.StatusOK {
		t.Errorf("a refused switch changed the mode: search = %d", code)
	}

	stubGet(t, srv.URL, "/__mode?m=fail")
	code, body = stubGet(t, srv.URL, "/api/search?q=pikachu")
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
		RequestID string `json:"request_id"`
	}
	if code != http.StatusServiceUnavailable || json.Unmarshal([]byte(body), &failure) != nil ||
		failure.Error.Code != "es_unavailable" || failure.RequestID == "" {
		t.Errorf("fail mode answered %d %s, want 503 es_unavailable with a request_id", code, body)
	}
	// The failing mode fails every catalog path, healthz included.
	if code, _ := stubGet(t, srv.URL, "/healthz"); code != http.StatusServiceUnavailable {
		t.Errorf("fail mode healthz = %d, want 503", code)
	}

	stubGet(t, srv.URL, "/__mode?m=stall&stall_ms=300")
	started := time.Now()
	code, _ = stubGet(t, srv.URL, "/api/search?q=pikachu")
	if code != http.StatusOK || time.Since(started) < 250*time.Millisecond {
		t.Errorf("stall mode answered %d after %s, want 200 after about 300ms", code, time.Since(started))
	}

	stubGet(t, srv.URL, "/__mode?m=ok")
	started = time.Now()
	if code, _ := stubGet(t, srv.URL, "/api/search?q=pikachu"); code != http.StatusOK || time.Since(started) > 5*time.Second {
		t.Errorf("ok mode after a stall: %d in %s", code, time.Since(started))
	}
}

// Switching modes while requests are in flight is safe (run with -race) and
// every answer is one of the two shapes a mode can give: never a torn mix.
func TestHarnessStubModeSwitchIsSafeUnderConcurrentRequests(t *testing.T) {
	srv := httptest.NewServer(newStubTarget())
	defer srv.Close()

	var wg sync.WaitGroup
	var mu sync.Mutex
	var bad []string
	record := func(s string) { mu.Lock(); bad = append(bad, s); mu.Unlock() }

	for g := range 6 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for i := range 25 {
				mode := []string{"ok", "fail", "stall&stall_ms=20"}[(g+i)%3]
				resp, err := http.Get(srv.URL + "/__mode?m=" + mode)
				if err != nil {
					record("switch: " + err.Error())
					return
				}
				resp.Body.Close()
			}
		}()
		go func() {
			defer wg.Done()
			for range 25 {
				resp, err := http.Get(srv.URL + "/api/search?q=char")
				if err != nil {
					record("request: " + err.Error())
					return
				}
				raw, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				switch resp.StatusCode {
				case http.StatusOK:
					if !strings.Contains(string(raw), `"results"`) {
						record("200 without results: " + string(raw))
					}
				case http.StatusServiceUnavailable:
					if !strings.Contains(string(raw), "es_unavailable") {
						record("503 without es_unavailable: " + string(raw))
					}
				default:
					record("status " + strconv.Itoa(resp.StatusCode))
				}
			}
		}()
	}
	wg.Wait()
	if len(bad) > 0 {
		t.Fatalf("%d torn or failed answers, first: %s", len(bad), bad[0])
	}
}

// A client that gives up on a stalled request does not hold the stub open:
// the stalled handler returns, so closing the stub is prompt however long the
// stall was asked to be.
func TestHarnessStalledRequestDoesNotHoldTheStubOpenAfterTheClientLeaves(t *testing.T) {
	srv := httptest.NewServer(newStubTarget())
	stubGet(t, srv.URL, "/__mode?m=stall&stall_ms=600000")

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/search?q=x", nil)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
		t.Fatal("a stalled request was answered")
	}

	closed := make(chan struct{})
	go func() { srv.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("the stub did not close: a handler for an abandoned request is still stalled")
	}
}

// freePort hands back a port the OS just had free, so one a listener can bind.
func TestHarnessFreePortIsBindable(t *testing.T) {
	seen := map[int]bool{}
	for range 200 {
		port, err := freePort()
		if err != nil {
			t.Fatalf("freePort: %v", err)
		}
		if port < 1 || port > 65535 {
			t.Fatalf("freePort returned %d", port)
		}
		l, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
		if err != nil {
			t.Fatalf("port %d was not bindable: %v", port, err)
		}
		l.Close()
		seen[port] = true
	}
	if len(seen) < 2 {
		t.Errorf("200 calls returned %d distinct ports; the helper looks constant", len(seen))
	}
}

// The readiness poll gives up at its deadline with an error that says so, when
// nothing answers, when something else holds the port, and when the process
// has exited; and it never takes another server's answer for its own.
func TestHarnessAwaitReadyGivesUpWithAClearError(t *testing.T) {
	closedPort, err := freePort()
	if err != nil {
		t.Fatal(err)
	}
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"target":"some-other-server","collections":[]}`)
	}))
	defer other.Close()

	for _, c := range []struct{ name, url string }{
		{"nothing listening", "http://127.0.0.1:" + strconv.Itoa(closedPort)},
		{"another server holds the port", other.URL},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := &courierProc{url: c.url, exited: make(chan error, 1)}
			started := time.Now()
			err := p.awaitReady("acceptance-stub-main", 400*time.Millisecond)
			if err == nil {
				t.Fatal("readiness was reported for a server that is not this process")
			}
			if !strings.Contains(err.Error(), "not ready after") {
				t.Errorf("error = %q, want it to say it was not ready", err)
			}
			if took := time.Since(started); took > 5*time.Second {
				t.Errorf("the poll took %s past a 400ms deadline", took)
			}
		})
	}

	t.Run("process exited", func(t *testing.T) {
		p := &courierProc{url: "http://127.0.0.1:" + strconv.Itoa(closedPort), exited: make(chan error, 1)}
		p.exited <- errors.New("exit status 1")
		started := time.Now()
		err := p.awaitReady("acceptance-stub-main", time.Minute)
		if err == nil || !strings.Contains(err.Error(), "exited before it was ready") {
			t.Fatalf("error = %v, want it to say the process exited", err)
		}
		if time.Since(started) > 5*time.Second {
			t.Error("an exited process was polled until the deadline instead of reported at once")
		}
		select {
		case <-p.exited:
		default:
			t.Error("the exit status was consumed: a later stop() would wait for a reap that already happened")
		}
	})
}

func TestHarnessAnswersAsAcceptsOnlyTheNamedServer(t *testing.T) {
	named := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"target":"acceptance-stub-main"}`)
	}))
	defer named.Close()
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"target":"acceptance-stub-main"}`)
	}))
	defer failing.Close()
	garbage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "<html>") }))
	defer garbage.Close()

	if !answersAs(named.URL, "acceptance-stub-main") {
		t.Error("the named server was not recognised")
	}
	if answersAs(named.URL, "acceptance-stub-control") {
		t.Error("a server was recognised under another process's name")
	}
	if answersAs(failing.URL, "acceptance-stub-main") {
		t.Error("a 503 was taken for readiness")
	}
	if answersAs(garbage.URL, "acceptance-stub-main") {
		t.Error("a non-JSON answer was taken for readiness")
	}
}

// startSleeper starts a child that ignores SIGTERM, wrapped the way
// startCourier wraps its own.
func startSleeper(t *testing.T) *courierProc {
	t.Helper()
	cmd := exec.Command("sh", "-c", `trap '' TERM; while :; do sleep 1; done`)
	cmd.SysProcAttr = diesWithParent()
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	p := &courierProc{cmd: cmd, exited: make(chan error, 1)}
	go func() { p.exited <- cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	return p
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

// stop kills a child that ignores SIGTERM, reaps it, and may be called again.
func TestHarnessStopKillsAChildThatIgnoresSIGTERMAndIsIdempotent(t *testing.T) {
	p := startSleeper(t)
	pid := p.cmd.Process.Pid

	// Give the shell time to install its trap before the signal arrives.
	time.Sleep(300 * time.Millisecond)
	_ = p.cmd.Process.Signal(syscall.SIGTERM)
	time.Sleep(300 * time.Millisecond)
	if !alive(pid) {
		t.Fatal("the fixture died of SIGTERM, so the test proves nothing about a child that ignores it")
	}

	done := make(chan struct{})
	go func() { p.stop(); p.stop(); p.stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("stop() did not return")
	}
	if alive(pid) {
		t.Errorf("pid %d is still alive after stop()", pid)
	}
}

// The child is tied to the test binary's life, where the kernel can do that.
func TestHarnessChildrenAreSetToDieWithTheirParentOnLinux(t *testing.T) {
	attr := diesWithParent()
	f := reflect.ValueOf(attr).Elem().FieldByName("Pdeathsig")
	if !f.IsValid() {
		t.Skip("this platform has no parent-death signal")
	}
	if got := syscall.Signal(f.Int()); got != syscall.SIGKILL {
		t.Errorf("Pdeathsig = %v, want SIGKILL", got)
	}
}

// A child that exits at once (as one does on a busy port) is retried on a new
// port the documented three times and then reported, naming the exit; nothing
// it started is left running, and it never reports success.
func TestHarnessStartCourierRetriesAnImmediateExitThenReportsIt(t *testing.T) {
	dir := t.TempDir()
	bin, err := exec.LookPath("false")
	if err != nil {
		t.Skip("no false(1) on this machine")
	}
	started := time.Now()
	p, err := startCourier(bin, dir, "http://127.0.0.1:1", "acceptance-stub-retry")
	if err == nil || p != nil {
		t.Fatalf("startCourier = %v, %v for a child that exits at once; want an error", p, err)
	}
	if !strings.Contains(err.Error(), "exited before it was ready") {
		t.Errorf("error = %q, want it to name the early exit", err)
	}
	logs, _ := filepath.Glob(filepath.Join(dir, "acceptance-stub-retry-*.log"))
	if len(logs) != 3 {
		t.Errorf("%d attempts were made (%v), want 3", len(logs), logs)
	}
	if took := time.Since(started); took > 30*time.Second {
		t.Errorf("giving up took %s", took)
	}
}

// A binary that cannot be started at all is reported at once rather than
// retried or mistaken for a slow start.
func TestHarnessStartCourierReportsABinaryThatCannotStart(t *testing.T) {
	dir := t.TempDir()
	started := time.Now()
	p, err := startCourier(filepath.Join(dir, "no-such-binary"), dir, "http://127.0.0.1:1", "acceptance-stub-missing")
	if err == nil || p != nil {
		t.Fatalf("startCourier = %v, %v for a missing binary; want an error", p, err)
	}
	if time.Since(started) > 10*time.Second {
		t.Error("a missing binary was waited on")
	}
	if _, serr := os.Stat(dir); serr != nil {
		t.Fatal(serr)
	}
}

// The functional report renders to a PDF. The curated run that normally leaves
// a functional run behind for the PDF item is skipped where the stub is the
// target, so this takes a functional run of its own: without it the
// functional half of the PDF item is skipped silently in that mode.
func TestHarnessFunctionalReportRendersToAPDFAgainstTheStub(t *testing.T) {
	if !selfContained() {
		t.Skip("self-contained mode only: the curated run covers this against a real target")
	}
	id := startRun(t, courierURL, sandbox.RunRequest{
		Mode:     sandbox.ModeFunctional,
		Sequence: searchSequence(t)[:2],
	})
	rep := awaitRun(t, courierURL, id, 60*time.Second)
	if rep.Functional == nil || len(rep.Functional.Results) != 2 {
		t.Fatalf("functional run = %+v, want two results", rep.Functional)
	}
	resp, err := hc.Get(courierURL + "/api/runs/" + id + "/report.pdf")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(string(raw), "%PDF-") {
		t.Fatalf("report.pdf = %d, % x", resp.StatusCode, raw[:min(8, len(raw))])
	}
}
