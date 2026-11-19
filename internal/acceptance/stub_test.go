//go:build acceptance

// The self-contained mode: ACCEPTANCE_SELF_CONTAINED=1 runs the matrix with no
// target and no Courier already running. TestMain stands up an in-process stub
// target, builds the server binary, starts the Courier processes the matrix
// needs against the stub, and tears all of it down when the run ends.
//
// The stub is not PokéSearch and does not pretend to be: it answers in
// PokéSearch's response shapes with a handful of cards, which is enough for
// every item that judges Courier rather than the index. The items that judge
// the index itself (the curated fixtures, the strict-parameter 400) need the
// real target and are skipped where this mode runs.

package acceptance

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// selfContained reports whether TestMain should build its own world.
func selfContained() bool { return os.Getenv("ACCEPTANCE_SELF_CONTAINED") == "1" }

// stubLatency is how long the stub takes to answer a catalog request in the ok
// and failing modes: PokéSearch answers in milliseconds, not in the
// microseconds of a loopback stub. An instant answer would make the matrix measure Courier's own loop instead of a target:
// the closed-loop identity in TestPerformanceSanity (requests ~ C*D/L) only
// holds when L dominates the per-request cost, and a run's overrun is only
// non-zero when a request is still in flight at the deadline.
const stubLatency = 10 * time.Millisecond

// defaultStall is how long a request is held in the stalling mode when the
// control call names no stall_ms: longer than the executor's 10s timeout, so
// every dispatch burns its whole timeout.
const defaultStall = 20 * time.Second

// Stub modes, switched with GET /__mode?m=<mode>[&stall_ms=<n>].
const (
	modeOK    = "ok"
	modeFail  = "fail"  // the 503 es_unavailable body PokéSearch answers when its index is down
	modeStall = "stall" // hold every catalog request, then answer as ok
)

// stubCard is one card in the stub's tiny index.
type stubCard struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	SetID  string   `json:"set_id"`
	HP     int      `json:"hp"`
	Types  []string `json:"types"`
	Rarity string   `json:"rarity"`
}

var stubCards = []stubCard{
	{"base1-1", "Alakazam", "base1", 80, []string{"Psychic"}, "Rare Holo"},
	{"base1-4", "Charizard", "base1", 120, []string{"Fire"}, "Rare Holo"},
	{"base1-58", "Pikachu", "base1", 40, []string{"Lightning"}, "Common"},
	{"sv3pt5-6", "Charizard ex", "sv3pt5", 330, []string{"Fire"}, "Double Rare"},
}

// stubTarget is the controllable target.
type stubTarget struct {
	mu    sync.Mutex
	mode  string
	stall time.Duration
	reqs  atomic.Int64 // numbers request_id, as PokéSearch does on every answer
}

func newStubTarget() *stubTarget { return &stubTarget{mode: modeOK, stall: defaultStall} }

func (s *stubTarget) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/__mode" {
		s.setMode(w, r)
		return
	}
	s.mu.Lock()
	mode, stall := s.mode, s.stall
	s.mu.Unlock()

	wait := stubLatency
	if mode == modeStall {
		wait = stall
	}
	// A request whose client gave up is dropped at once: a stalled handler
	// must never be what holds the stub's shutdown open.
	select {
	case <-time.After(wait):
	case <-r.Context().Done():
		return
	}

	reqID := "stub-" + strconv.FormatInt(s.reqs.Add(1), 10)
	if mode == modeFail {
		stubJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":      map[string]any{"code": "es_unavailable", "message": "the search index is unavailable"},
			"request_id": reqID,
		})
		return
	}
	switch r.URL.Path {
	case "/healthz":
		stubJSON(w, http.StatusOK, map[string]any{"status": "ok", "docs": len(stubCards)})
	case "/api/suggest":
		stubJSON(w, http.StatusOK, map[string]any{"suggestions": stubSuggest(r.URL.Query().Get("q"))})
	case "/api/search":
		stubJSON(w, http.StatusOK, stubSearch(r.URL.Query(), reqID))
	default:
		stubJSON(w, http.StatusNotFound, map[string]any{
			"error":      map[string]any{"code": "not_found", "message": "no such endpoint"},
			"request_id": reqID,
		})
	}
}

func (s *stubTarget) setMode(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	mode := q.Get("m")
	if mode != modeOK && mode != modeFail && mode != modeStall {
		http.Error(w, "unknown mode "+strconv.Quote(mode), http.StatusBadRequest)
		return
	}
	stall := defaultStall
	if raw := q.Get("stall_ms"); raw != "" {
		ms, err := strconv.Atoi(raw)
		if err != nil || ms < 0 {
			http.Error(w, "stall_ms must be a whole number of milliseconds", http.StatusBadRequest)
			return
		}
		stall = time.Duration(ms) * time.Millisecond
	}
	s.mu.Lock()
	s.mode, s.stall = mode, stall
	s.mu.Unlock()
	_, _ = fmt.Fprintf(w, "mode=%s stall_ms=%d\n", mode, stall.Milliseconds())
}

func stubJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// stubSearch matches q as a case-insensitive substring of the name and id as
// an exact id, and answers with the search response's fields and facets.
func stubSearch(q map[string][]string, reqID string) map[string]any {
	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	results := []stubCard{}
	for _, c := range stubCards {
		if id := get("id"); id != "" && c.ID != id {
			continue
		}
		if text := get("q"); text != "" && !strings.Contains(strings.ToLower(c.Name), strings.ToLower(text)) {
			continue
		}
		results = append(results, c)
	}
	types, rarity, sets := map[string]int{}, map[string]int{}, map[string]int{}
	for _, c := range results {
		for _, ty := range c.Types {
			types[ty]++
		}
		rarity[c.Rarity]++
		sets[c.SetID]++
	}
	return map[string]any{
		"total":        len(results),
		"matched":      len(results),
		"page":         1,
		"page_size":    24,
		"pages":        1,
		"took_ms":      1,
		"results":      results,
		"facets":       map[string]any{"types": facet(types), "rarity": facet(rarity), "sets": facet(sets)},
		"did_you_mean": nil,
		"request_id":   reqID,
	}
}

func facet(counts map[string]int) []map[string]any {
	out := []map[string]any{}
	for k, n := range counts {
		out = append(out, map[string]any{"value": k, "count": n})
	}
	return out
}

func stubSuggest(q string) []string {
	out := []string{}
	for _, c := range stubCards {
		if q != "" && strings.HasPrefix(strings.ToLower(c.Name), strings.ToLower(q)) && len(out) < 8 {
			out = append(out, c.Name)
		}
	}
	return out
}

// ------------------------------------------------------ the Courier processes

// freePort asks the OS for a free loopback port. The listener is closed before
// the port is used, so a caller that loses the race for it retries.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port, nil
}

// courierProc is one Courier process started by the self-contained mode.
type courierProc struct {
	url    string
	cmd    *exec.Cmd
	exited chan error
	log    string
}

// diesWithParent asks the kernel, where it can (Linux), to kill a child when
// the process that started it dies. A test binary that panics or hits -timeout
// never runs TestMain's teardown, and a Courier left behind would hold its port
// and its target until someone noticed.
func diesWithParent() *syscall.SysProcAttr {
	attr := &syscall.SysProcAttr{}
	if f := reflect.ValueOf(attr).Elem().FieldByName("Pdeathsig"); f.IsValid() && f.CanSet() {
		f.Set(reflect.ValueOf(syscall.SIGKILL))
	}
	return attr
}

// startCourier starts bin against target on a free port and waits until it
// answers as itself: the display name is unique per process, so another
// server that happens to hold the port is never mistaken for this one.
func startCourier(bin, dir, target, display string) (*courierProc, error) {
	var lastErr error
	for attempt := range 3 {
		port, err := freePort()
		if err != nil {
			return nil, err
		}
		logPath := filepath.Join(dir, fmt.Sprintf("%s-%d.log", display, attempt))
		logFile, err := os.Create(logPath)
		if err != nil {
			return nil, err
		}
		cmd := exec.Command(bin)
		cmd.Env = append(os.Environ(),
			"PORT="+strconv.Itoa(port),
			"TARGET_URL="+target,
			"TARGET_DISPLAY="+display,
			"PPROF_ADDR=off",
		)
		cmd.Stdout, cmd.Stderr = logFile, logFile
		cmd.SysProcAttr = diesWithParent()
		if err := cmd.Start(); err != nil {
			logFile.Close()
			return nil, err
		}
		p := &courierProc{
			url:    "http://127.0.0.1:" + strconv.Itoa(port),
			cmd:    cmd,
			exited: make(chan error, 1),
			log:    logPath,
		}
		go func() {
			p.exited <- cmd.Wait()
			logFile.Close()
		}()
		if lastErr = p.awaitReady(display, 60*time.Second); lastErr == nil {
			return p, nil
		}
		p.stop()
		fmt.Fprintf(os.Stderr, "acceptance: %s attempt %d: %v\n%s\n", display, attempt+1, lastErr, tail(logPath))
	}
	return nil, lastErr
}

// awaitReady polls until the process answers /api/collections naming display,
// it exits, or the deadline passes.
func (p *courierProc) awaitReady(display string, within time.Duration) error {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		select {
		case err := <-p.exited:
			p.exited <- err
			return fmt.Errorf("exited before it was ready: %v", err)
		default:
		}
		if answersAs(p.url, display) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("not ready after %s", within)
}

func answersAs(base, display string) bool {
	resp, err := hc.Get(base + "/api/collections")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var body struct {
		Target string `json:"target"`
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != http.StatusOK || json.Unmarshal(raw, &body) != nil {
		return false
	}
	return body.Target == display
}

// stop kills the process and waits for it to be reaped.
func (p *courierProc) stop() {
	_ = p.cmd.Process.Kill()
	select {
	case err := <-p.exited:
		p.exited <- err
	case <-time.After(30 * time.Second):
		fmt.Fprintf(os.Stderr, "acceptance: pid %d was not reaped after kill\n", p.cmd.Process.Pid)
	}
}

func tail(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	if len(raw) > 2000 {
		raw = raw[len(raw)-2000:]
	}
	return string(raw)
}

// runSelfContained builds the world, points the matrix at it, runs the matrix
// and takes the world down again, whatever the tests did.
func runSelfContained(m *testing.M) int {
	// The kernel's parent-death signal follows the thread that started the
	// child. Pinning this goroutine to the main thread for the whole run keeps
	// that thread alive exactly as long as the test binary.
	runtime.LockOSThread()

	stub := httptest.NewServer(newStubTarget())
	defer stub.Close()

	dir, err := os.MkdirTemp("", "courier-acceptance-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "acceptance: temp dir: %v\n", err)
		return 1
	}
	defer os.RemoveAll(dir)

	bin := filepath.Join(dir, "courier")
	if out, err := exec.Command("go", "build", "-o", bin, "../../cmd/server").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "acceptance: go build: %v\n%s\n", err, out)
		return 1
	}

	// Deferred after stub.Close, so it runs before it: a Courier holding a
	// stalled request open would otherwise keep the stub's Close waiting.
	var procs []*courierProc
	defer func() {
		for _, p := range procs {
			p.stop()
		}
	}()
	for _, display := range []string{"acceptance-stub-main", "acceptance-stub-control"} {
		p, err := startCourier(bin, dir, stub.URL, display)
		if err != nil {
			fmt.Fprintf(os.Stderr, "acceptance: starting %s: %v\n", display, err)
			return 1
		}
		procs = append(procs, p)
	}

	courierURL, stubURL, stubTargetURL = procs[0].url, procs[1].url, stub.URL
	fmt.Fprintf(os.Stderr, "acceptance: self-contained: COURIER_URL=%s STUB_URL=%s STUB_TARGET_URL=%s\n",
		courierURL, stubURL, stubTargetURL)
	return m.Run()
}
