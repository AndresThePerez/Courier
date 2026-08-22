package runner

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/budget"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// testClock is hand-advanced so the cooldown tests do not sleep out the budget.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func newTestClock() *testClock {
	return &testClock{t: time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)}
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// capturingPublisher records what the SSE layer would have been handed.
type capturingPublisher struct {
	mu     sync.Mutex
	resets []string
	events []Event
}

func (p *capturingPublisher) Publish(e Event) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, e)
}

func (p *capturingPublisher) Reset(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resets = append(p.resets, id)
}

func (p *capturingPublisher) Replay() []Event {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Event(nil), p.events...)
}

func (p *capturingPublisher) countOf(typ string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, e := range p.events {
		if e.Type == typ {
			n++
		}
	}
	return n
}

// okServer answers everything instantly, so a manager test measures the
// manager rather than a target.
func okServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"total":1}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// newTestManager wires a manager onto an injected clock so the budget can be
// wound forward instead of waited out.
func newTestManager(t *testing.T, url string) (*Manager, *testClock, *capturingPublisher) {
	t.Helper()
	c := newTestClock()
	pub := &capturingPublisher{}
	m := NewManager(NewExecutor(url), "test-target", pub, nil)
	m.now = c.Now
	m.bucket = budget.New(m.clock)
	return m, c, pub
}

func functionalRun() sandbox.RunRequest {
	return sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: []sandbox.Request{
		{ID: "1", Name: "a", Endpoint: "search", Params: map[string]string{"q": "charizard"}},
	}}
}

func longPerfRun() sandbox.RunRequest {
	return perfRun(oneRequest(), 4, 30)
}

func TestStartRejectsAnInvalidPayloadBeforeTakingTheLock(t *testing.T) {
	m, _, _ := newTestManager(t, "http://target.invalid")

	if _, err := m.Start(context.Background(), sandbox.RunRequest{Mode: "sideways"}); err == nil {
		t.Fatal("an invalid payload must not start a run")
	}
	var ve sandbox.ValidationError
	if _, err := m.Start(context.Background(), sandbox.RunRequest{Mode: sandbox.ModeFunctional}); !errors.As(err, &ve) {
		t.Errorf("err = %v, want a ValidationError the API can turn into a 400", err)
	}
	if m.Status().Running {
		t.Error("a rejected payload must leave the manager idle")
	}
}

func TestSecondStartWhileRunningIsBusy(t *testing.T) {
	srv := okServer(t)
	m, _, _ := newTestManager(t, srv.URL)

	first, err := m.Start(context.Background(), longPerfRun())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() {
		_ = m.Cancel(first)
		m.Wait()
	}()

	if _, err := m.Start(context.Background(), functionalRun()); !errors.Is(err, ErrBusy) {
		t.Errorf("second Start = %v, want ErrBusy", err)
	}
	st := m.Status()
	if !st.Running || st.RunID != first || st.Mode != sandbox.ModePerformance || st.StartedAt == nil {
		t.Errorf("status = %+v, want the first run's identity", st)
	}
}

func TestCancelStopsTheRunAndFreesTheLockImmediately(t *testing.T) {
	srv := okServer(t)
	m, c, _ := newTestManager(t, srv.URL)

	id, err := m.Start(context.Background(), longPerfRun())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Let some load actually land before pulling the plug.
	time.Sleep(150 * time.Millisecond)

	start := time.Now()
	if err := m.Cancel(id); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	m.Wait()
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("cancel took %v to unwind", elapsed)
	}

	if m.Status().Running {
		t.Error("the lock must be free the moment a cancelled run finalizes")
	}
	rep, ok := m.Report(id)
	if !ok {
		t.Fatal("a cancelled run must still be stored")
	}
	if rep.Status != report.StatusCancelled {
		t.Errorf("status = %q, want cancelled", rep.Status)
	}
	if rep.Performance == nil || rep.Performance.Overall.Requests == 0 {
		t.Errorf("a cancelled run must keep its partial data: %+v", rep.Performance)
	}
	if rep.Performance.Verdict != report.VerdictNA {
		t.Errorf("verdict = %q, want N/A — a cancel must never manufacture a FAIL", rep.Performance.Verdict)
	}
	if rep.Note == "" {
		t.Error("a cancelled run should explain itself in the stored report")
	}

	// The cooldown is charged from what the run actually consumed, so it is
	// short — but it exists, floor included.
	if err := m.Cancel(id); !errors.Is(err, ErrNotRunning) {
		t.Errorf("cancelling a finished run = %v, want ErrNotRunning", err)
	}
	c.Advance(budget.MinCooldown)
	if _, err := m.Start(context.Background(), functionalRun()); err != nil {
		t.Errorf("manager unusable after a cancel: %v", err)
	}
	m.Wait()
}

func TestLockReleasedAfterPanic(t *testing.T) {
	srv := okServer(t)
	m, c, _ := newTestManager(t, srv.URL)
	m.run = func(context.Context, *Executor, sandbox.RunRequest, Emitter) Result {
		panic("engine exploded")
	}

	id, err := m.Start(context.Background(), functionalRun())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	m.Wait()

	if m.Status().Running {
		t.Fatal("lock wedged after a panicking run")
	}
	rep, ok := m.Report(id)
	if !ok || rep.Status == report.StatusRunning {
		t.Errorf("a panicking run must still finalize: %+v", rep)
	}
	// A panic still costs the budget what it consumed, so the cooldown is set.
	if until := m.bucket.CooldownUntil(); !until.After(c.Now()) {
		t.Error("a panicking run must still set the cooldown")
	}

	c.Advance(budget.MinCooldown)
	if _, err := m.Start(context.Background(), functionalRun()); err != nil {
		t.Fatalf("manager unusable after panic: %v", err)
	}
	m.Wait()
}

func TestCooldownRefusesThenAdmits(t *testing.T) {
	srv := okServer(t)
	m, c, _ := newTestManager(t, srv.URL)

	if _, err := m.Start(context.Background(), functionalRun()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	m.Wait()

	_, err := m.Start(context.Background(), functionalRun())
	if !errors.Is(err, ErrCoolingDown) {
		t.Fatalf("second Start = %v, want ErrCoolingDown", err)
	}
	var ce *CooldownError
	if !errors.As(err, &ce) || !ce.Until.After(c.Now()) {
		t.Fatalf("the refusal must carry the deadline to count down to: %v", err)
	}
	if st := m.Status(); st.CooldownUntil == nil || !st.CooldownUntil.Equal(ce.Until) {
		t.Errorf("status must report the same cooldown_until the refusal did: %+v", st)
	}

	// Wind past it rather than sleeping ten real seconds.
	c.Advance(budget.MinCooldown)
	if _, err := m.Start(context.Background(), functionalRun()); err != nil {
		t.Errorf("Start after the cooldown = %v, want success", err)
	}
	m.Wait()
}

// The budget prices load, so the happy path — a stroll through curated
// functional collections — never leaves the floor.
func TestCuratedFunctionalStrollStaysAtTheFloor(t *testing.T) {
	srv := okServer(t)
	m, c, _ := newTestManager(t, srv.URL)

	for i := range 6 {
		if _, err := m.Start(context.Background(), functionalRun()); err != nil {
			t.Fatalf("collection %d refused: %v", i, err)
		}
		m.Wait()
		st := m.Status()
		if st.CooldownUntil == nil {
			t.Fatalf("collection %d: no cooldown reported", i)
		}
		if wait := st.CooldownUntil.Sub(c.Now()); wait > budget.MinCooldown {
			t.Fatalf("collection %d cooled %v, want no more than the %v floor", i, wait, budget.MinCooldown)
		}
		c.Advance(budget.MinCooldown)
	}
}

func TestHistoryIsNewestFirstAndCapped(t *testing.T) {
	srv := okServer(t)
	m, c, _ := newTestManager(t, srv.URL)

	var ids []string
	for range HistorySize + 3 {
		id, err := m.Start(context.Background(), functionalRun())
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
		m.Wait()
		ids = append(ids, id)
		c.Advance(budget.MinCooldown)
	}

	h := m.History()
	if len(h) != HistorySize {
		t.Fatalf("history = %d runs, want the %d cap", len(h), HistorySize)
	}
	if h[0].ID != ids[len(ids)-1] {
		t.Errorf("history[0] = %s, want the newest run %s", h[0].ID, ids[len(ids)-1])
	}
	for _, gone := range ids[:3] {
		if _, ok := m.Report(gone); ok {
			t.Errorf("evicted run %s is still in the registry; the ring is not bounding memory", gone)
		}
	}
	if _, ok := m.Report(ids[len(ids)-1]); !ok {
		t.Error("the newest run must still be retrievable")
	}
}

func TestReportLookup(t *testing.T) {
	srv := okServer(t)
	m, _, _ := newTestManager(t, srv.URL)

	if _, ok := m.Report("nope"); ok {
		t.Error("Report must not invent a run")
	}

	id, err := m.Start(context.Background(), longPerfRun())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	time.Sleep(400 * time.Millisecond)

	live, ok := m.Report(id)
	if !ok {
		t.Fatal("the in-progress run must be retrievable — the polling fallback depends on it")
	}
	if live.Status != report.StatusRunning {
		t.Errorf("live status = %q, want running", live.Status)
	}
	if live.Performance == nil || live.Performance.Overall.Requests == 0 {
		t.Errorf("a partial report must carry partial results: %+v", live.Performance)
	}
	if len(live.Entries) == 0 || live.Target != "test-target" {
		t.Errorf("a partial report must be self-describing: %+v", live)
	}

	_ = m.Cancel(id)
	m.Wait()
	done, _ := m.Report(id)
	if done.Status == report.StatusRunning || done.FinishedAt.IsZero() {
		t.Errorf("finished report = %+v", done)
	}
}

// A partial functional report is served to the polling fallback repeatedly; it
// must not carry a growing pile of 16KB body previews.
func TestPartialFunctionalReportCarriesNoBodyPreviews(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(60 * time.Millisecond)
		fmt.Fprint(w, `{"total":1,"body":"`+strings.Repeat("x", 2000)+`"}`)
	}))
	defer srv.Close()

	m, _, _ := newTestManager(t, srv.URL)
	seq := make([]sandbox.Request, 12)
	for i := range seq {
		seq[i] = sandbox.Request{ID: fmt.Sprint(i), Name: fmt.Sprint(i), Endpoint: "search"}
	}
	id, err := m.Start(context.Background(), sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: seq})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	time.Sleep(200 * time.Millisecond)

	live, _ := m.Report(id)
	if live.Functional == nil || len(live.Functional.Results) == 0 {
		t.Fatalf("no partial results yet: %+v", live.Functional)
	}
	for _, r := range live.Functional.Results {
		if r.BodyPreview != "" {
			t.Fatalf("partial report leaked a body preview on result %d", r.Index)
		}
	}

	m.Wait()
	done, _ := m.Report(id)
	if done.Functional.Results[0].BodyPreview == "" {
		t.Error("the finished report must keep the preview — it is only the partial that drops it")
	}
}

func TestStatusFlips(t *testing.T) {
	srv := okServer(t)
	m, _, pub := newTestManager(t, srv.URL)

	if st := m.Status(); st.Running || st.StartedAt != nil {
		t.Fatalf("idle status = %+v", st)
	}

	id, err := m.Start(context.Background(), longPerfRun())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if st := m.Status(); !st.Running || st.StartedAt == nil || st.RunID != id {
		t.Errorf("running status = %+v", st)
	}

	_ = m.Cancel(id)
	m.Wait()

	st := m.Status()
	if st.Running || st.StartedAt != nil || st.RunID != "" {
		t.Errorf("finished status = %+v", st)
	}
	if st.CooldownUntil == nil {
		t.Error("status must report the cooldown so the UI can count it down")
	}

	if len(pub.resets) != 1 || pub.resets[0] != id {
		t.Errorf("broadcaster resets = %v, want one for %s", pub.resets, id)
	}
	if pub.countOf(EventRunFinished) != 1 {
		t.Errorf("want exactly one run_finished published after finalization, got %d", pub.countOf(EventRunFinished))
	}
}

// The run_finished event is published after the report is stored, so a client
// that reacts to it by fetching the report never races finalization.
func TestRunFinishedIsPublishedAfterTheReportIsStored(t *testing.T) {
	srv := okServer(t)
	m, _, _ := newTestManager(t, srv.URL)

	seen := make(chan string, 1)
	m.pub = &finishHook{m: m, seen: seen}

	id, err := m.Start(context.Background(), functionalRun())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	m.Wait()

	select {
	case status := <-seen:
		if status == report.StatusRunning {
			t.Errorf("report still %q when run_finished was published for %s", status, id)
		}
	case <-time.After(time.Second):
		t.Fatal("no run_finished published")
	}
}

// finishHook reads the stored report at the instant run_finished is published.
type finishHook struct {
	m    *Manager
	seen chan string
}

func (h *finishHook) Publish(e Event) {
	if e.Type != EventRunFinished {
		return
	}
	if rep, ok := h.m.Report(e.RunID); ok {
		select {
		case h.seen <- rep.Status:
		default:
		}
	}
}

func (h *finishHook) Reset(string)    {}
func (h *finishHook) Replay() []Event { return nil }

func TestWorkerSecondsPricesTheMode(t *testing.T) {
	if got := workerSeconds(sandbox.ModePerformance, report.Config{Concurrency: 50}, 30*time.Second); got != 1500 {
		t.Errorf("max run = %v worker-seconds, want 1500", got)
	}
	if got := workerSeconds(sandbox.ModeFunctional, report.Config{}, 3*time.Second); got != 3 {
		t.Errorf("functional run = %v worker-seconds, want 3 (one worker)", got)
	}
	// The in-flight completion tail is paid for: elapsed is wall clock.
	if got := workerSeconds(sandbox.ModePerformance, report.Config{Concurrency: 50}, 40*time.Second); got != 2000 {
		t.Errorf("stalled run = %v worker-seconds, want 2000", got)
	}
}

func TestRunIDShape(t *testing.T) {
	id := newRunID(time.Date(2026, 8, 22, 14, 12, 33, 0, time.UTC))
	if !strings.HasPrefix(id, "run-20260822-141233-") || len(id) != len("run-20260822-141233-")+4 {
		t.Errorf("run id = %q, want run-20060102-150405-<4 hex>", id)
	}
	if newRunID(time.Now()) == newRunID(time.Now()) {
		t.Error("two run ids in the same second must still differ")
	}
}
