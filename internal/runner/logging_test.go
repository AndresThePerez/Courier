package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/AndresThePerez/courier/internal/budget"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// logSink is a race-safe io.Writer for a slog handler. slog serialises its own
// writes, but the test goroutine reads the buffer while a run goroutine may
// still be finishing, so the lock is not decoration.
type logSink struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *logSink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

// lines decodes the captured JSON, one object per line. Decoding rather than
// substring-matching is the point: a log line that is not machine-readable is
// not a structured log line.
func (s *logSink) lines(t *testing.T) []map[string]any {
	t.Helper()
	s.mu.Lock()
	raw := s.buf.String()
	s.mu.Unlock()

	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line is not JSON: %q (%v)", line, err)
		}
		out = append(out, m)
	}
	return out
}

// eventsFor returns the "event" values carried by lines for one run, in order.
func eventsFor(lines []map[string]any, runID string) []string {
	var out []string
	for _, l := range lines {
		if l["run_id"] == runID {
			if ev, ok := l["event"].(string); ok {
				out = append(out, ev)
			}
		}
	}
	return out
}

func findEvent(lines []map[string]any, event string) map[string]any {
	for _, l := range lines {
		if l["event"] == event {
			return l
		}
	}
	return nil
}

// newLoggedManager wires a manager onto a captured JSON logger.
//
// It deliberately keeps the real clock, unlike the lifecycle tests: the budget
// arithmetic asserted below is about a run's actual elapsed cost, and a frozen
// clock would make every run free and every assertion about the charge vacuous.
func newLoggedManager(t *testing.T, url string) (*Manager, *logSink) {
	t.Helper()
	sink := &logSink{}
	log := slog.New(slog.NewJSONHandler(sink, &slog.HandlerOptions{Level: slog.LevelInfo}))
	return NewManager(NewExecutor(url), "test-target", nil, log), sink
}

// A full run must produce a coherent, greppable trail: one run_id, the
// admission decision, the lifecycle, and the budget arithmetic that set the
// next cooldown.
func TestRunLifecycleProducesACoherentEventTrail(t *testing.T) {
	srv := okServer(t)
	m, sink := newLoggedManager(t, srv.URL)

	id, err := m.Start(context.Background(), functionalRun())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	m.Wait()

	lines := sink.lines(t)
	got := eventsFor(lines, id)
	want := []string{EventBudgetAdmitted, EventRunStarted, EventBudgetCharged, EventRunFinished}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("event trail for %s = %v, want %v", id, got, want)
	}

	started := findEvent(lines, EventRunStarted)
	if started["mode"] != sandbox.ModeFunctional || started["target"] != "test-target" {
		t.Errorf("run_started is missing its config: %v", started)
	}
	if started["sequence"].(float64) != 1 {
		t.Errorf("run_started must record the sequence length: %v", started)
	}

	finished := findEvent(lines, EventRunFinished)
	if finished["status"] != report.StatusCompleted {
		t.Errorf("run_finished status = %v, want completed", finished["status"])
	}
	if _, ok := finished["duration_ms"]; !ok {
		t.Errorf("run_finished must record the duration: %v", finished)
	}

	// Every line in the trail must be greppable by run id — that is the whole
	// contract: one jq filter, one run's complete story.
	for _, l := range lines {
		if l["run_id"] != id {
			t.Errorf("stray log line not attributable to a run: %v", l)
		}
		if l["level"] != "INFO" {
			t.Errorf("unexpected level on a healthy run: %v", l)
		}
	}
}

// The budget's decisions are logged on both sides, with the numbers that
// justify them.
func TestBudgetDecisionsAreLoggedWithTheirArithmetic(t *testing.T) {
	srv := okServer(t)
	m, sink := newLoggedManager(t, srv.URL)

	if _, err := m.Start(context.Background(), perfRun(oneRequest(), 4, 1)); err != nil {
		t.Fatalf("Start: %v", err)
	}
	m.Wait()

	// The second start is inside the cooldown the first one bought.
	if _, err := m.Start(context.Background(), functionalRun()); err == nil {
		t.Fatal("want a cooldown refusal")
	}

	lines := sink.lines(t)

	admit := findEvent(lines, EventBudgetAdmitted)
	if admit == nil {
		t.Fatal("no admission decision logged")
	}
	// A 4-worker 1-second run is a nominal 4 worker-seconds against a full
	// bucket.
	if admit["requested_worker_seconds"].(float64) != 4 {
		t.Errorf("admission must log the requested cost: %v", admit)
	}
	if admit["balance"].(float64) != budget.Burst {
		t.Errorf("admission must log the balance it decided on: %v", admit)
	}

	charge := findEvent(lines, EventBudgetCharged)
	if charge == nil {
		t.Fatal("no charge logged")
	}
	before, after := charge["balance_before"].(float64), charge["balance_after"].(float64)
	if before <= after {
		t.Errorf("a charge must move the balance down: before %v after %v", before, after)
	}
	if charge["worker_seconds"].(float64) <= 0 {
		t.Errorf("a charge must log what it cost: %v", charge)
	}
	if _, ok := charge["cooldown_until"]; !ok {
		t.Errorf("a charge must log the cooldown it bought: %v", charge)
	}

	deny := findEvent(lines, EventBudgetDenied)
	if deny == nil {
		t.Fatal("no denial logged")
	}
	if deny["reason"] != "cooling_down" {
		t.Errorf("denial must say why: %v", deny)
	}
	if _, ok := deny["cooldown_until"]; !ok {
		t.Errorf("denial must log the deadline it refused on: %v", deny)
	}
}

func TestBusyRefusalIsLogged(t *testing.T) {
	srv := okServer(t)
	m, sink := newLoggedManager(t, srv.URL)

	first, err := m.Start(context.Background(), longPerfRun())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	_, _ = m.Start(context.Background(), functionalRun())
	_ = m.Cancel(first)
	m.Wait()

	refused := findEvent(sink.lines(t), EventRunRefused)
	if refused == nil {
		t.Fatal("a busy refusal must be logged")
	}
	if refused["reason"] != "busy" || refused["running_run_id"] != first {
		t.Errorf("refusal must name the run holding the lock: %v", refused)
	}

	if findEvent(sink.lines(t), EventRunCancelled) == nil {
		t.Error("a cancellation must be logged")
	}
}

func TestPanicIsLoggedAtErrorAndTheRunStillFinalizes(t *testing.T) {
	srv := okServer(t)
	m, sink := newLoggedManager(t, srv.URL)
	m.run = func(context.Context, *Executor, sandbox.RunRequest, Emitter) Result {
		panic("engine exploded")
	}

	id, err := m.Start(context.Background(), functionalRun())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	m.Wait()

	lines := sink.lines(t)
	panicked := findEvent(lines, EventRunPanicked)
	if panicked == nil {
		t.Fatal("a panic must be logged")
	}
	if panicked["level"] != "ERROR" {
		t.Errorf("a panic must log at ERROR: %v", panicked)
	}
	if !strings.Contains(panicked["panic"].(string), "engine exploded") {
		t.Errorf("the panic value must be captured: %v", panicked)
	}
	// The trail must still close out, or a panic would be invisible to anyone
	// grepping for how the run ended.
	if got := eventsFor(lines, id); got[len(got)-1] != EventRunFinished {
		t.Errorf("trail = %v, want it to end with run_finished", got)
	}
}

// "No fmt.Printf debugging anywhere" is an acceptance criterion, so it is
// checked rather than remembered. Production code logs through the injected
// slog logger; tests are free to use fmt for their own fixtures.
func TestNoUnstructuredLoggingInProductionCode(t *testing.T) {
	banned := []string{"fmt.Print", "println(", "log.Print", "log.Fatal"}

	root := filepath.Join("..", "..")
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == ".git" || name == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, b := range banned {
			if bytes.Contains(src, []byte(b)) {
				t.Errorf("%s uses %s; production code logs through the injected slog logger", path, b)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

// linesContaining counts captured lines that carry s anywhere.
func linesContaining(sink *logSink, s string) int {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	n := 0
	for _, line := range strings.Split(sink.buf.String(), "\n") {
		if strings.Contains(line, s) {
			n++
		}
	}
	return n
}

// The raw transport error is the operator's, not the visitor's: it is logged
// once per failed dispatch, under its own event and the run's id, and nowhere
// a visitor can read it.
func TestDispatchFailedIsLoggedOncePerFailedDispatch(t *testing.T) {
	base := closedTarget(t)
	m, sink := newLoggedManager(t, base)
	rr := sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: []sandbox.Request{
		{ID: "1", Name: "a", Endpoint: "search"},
		{ID: "2", Name: "b", Endpoint: "suggest", Params: map[string]string{"q": "a"}},
		{ID: "3", Name: "c", Endpoint: "healthz"},
	}}
	id, err := m.Start(context.Background(), rr)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	m.Wait()

	var failed []map[string]any
	for _, l := range sink.lines(t) {
		if l["event"] == EventDispatchFailed {
			failed = append(failed, l)
		}
	}
	if len(failed) != 3 {
		t.Fatalf("%d %s lines, want one per failed dispatch (3)", len(failed), EventDispatchFailed)
	}
	for _, l := range failed {
		errText, _ := l["err"].(string)
		if l["run_id"] != id || !strings.Contains(errText, "connection refused") {
			t.Errorf("%s line = %v, want run_id %s and the raw error", EventDispatchFailed, l, id)
		}
	}
	host := strings.TrimPrefix(base, "http://")
	if n := linesContaining(sink, host); n != 3 {
		t.Errorf("%d log lines carry the target address, want exactly the 3 %s lines", n, EventDispatchFailed)
	}

	rep, _ := m.Report(id)
	b, _ := json.Marshal(rep)
	checkNoLeak(t, "the stored report", b, base)
}

// A performance run against a dead target dials hundreds of times a second; it
// logs no line per dispatch.
func TestPerformanceRunsLogNoPerDispatchLines(t *testing.T) {
	base := closedTarget(t)
	m, sink := newLoggedManager(t, base)
	id, err := m.Start(context.Background(), perfRun(oneRequest(), 2, 1))
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	m.Wait()
	if findEvent(sink.lines(t), EventDispatchFailed) != nil {
		t.Errorf("a performance run logged %s", EventDispatchFailed)
	}
	if n := linesContaining(sink, strings.TrimPrefix(base, "http://")); n != 0 {
		t.Errorf("%d log lines carry the target address", n)
	}
	rep, _ := m.Report(id)
	if rep.Performance.Overall.Requests == 0 {
		t.Fatal("the run dispatched nothing")
	}
	b, _ := json.Marshal(rep)
	checkNoLeak(t, "the performance report", b, base)
}
