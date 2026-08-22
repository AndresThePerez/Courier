package runner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/AndresThePerez/courier/internal/budget"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// HistorySize is how many finished runs stay in memory. History resets on
// redeploy; this is a demo's recent activity, not a datastore.
const HistorySize = 20

var (
	// ErrBusy is returned when a run is already in progress. One run at a time,
	// globally — the target is a live portfolio service, not a lab.
	ErrBusy = errors.New("a run is already in progress")

	// ErrCoolingDown is what the load budget refuses with. Callers should
	// errors.As for *CooldownError to get the timestamp to count down to.
	ErrCoolingDown = errors.New("cooling down")

	// ErrNotRunning is returned by Cancel for an id that is not the live run.
	ErrNotRunning = errors.New("that run is not in progress")
)

// CooldownError carries the deadline with the refusal, so the API can answer a
// 409 with cooldown_until rather than making the client guess.
type CooldownError struct{ Until time.Time }

func (e *CooldownError) Error() string {
	return fmt.Sprintf("cooling down until %s", e.Until.UTC().Format(time.RFC3339))
}

func (e *CooldownError) Unwrap() error { return ErrCoolingDown }

// Publisher is the slice of the SSE broadcaster the manager needs. It is
// declared here, narrowly, so internal/sse can import internal/runner for the
// Event type without the two packages forming a cycle.
type Publisher interface {
	Publish(Event)
	Reset(runID string)
	Replay() []Event
}

// Status is the lifecycle as /api/status reports it.
//
// CooldownUntil is present whenever it is in the future, so the UI counts down
// a value the server gave it rather than one it inferred. It must be re-read
// from the poll rather than cached: a send can push it later.
type Status struct {
	Running       bool       `json:"running"`
	RunID         string     `json:"run_id,omitempty"`
	Mode          string     `json:"mode,omitempty"`
	StartedAt     *time.Time `json:"started_at,omitempty"`
	CooldownUntil *time.Time `json:"cooldown_until,omitempty"`
	BudgetBalance float64    `json:"budget_balance"`
}

// runFunc is the mode dispatch, behind a field so a test can inject a runner
// that panics without standing up HTTP.
type runFunc func(ctx context.Context, ex *Executor, rr sandbox.RunRequest, emit Emitter) Result

// Manager owns the global run lifecycle: the lock, the load budget, the run
// registry, and the history ring.
//
// The lifecycle is one mutex-guarded state struct with a single transition
// function, not an atomic.Bool plus loose fields. It has three states — idle,
// running, cooling — plus run id, mode, and start time, and splitting that
// across an atomic and separate timestamps invites check-then-act races and
// torn /api/status reads.
type Manager struct {
	ex     *Executor
	target string
	pub    Publisher
	log    *slog.Logger
	bucket *budget.Bucket
	now    func() time.Time
	run    runFunc

	mu      sync.Mutex
	st      Status
	live    *report.Report // the in-progress report, updated from the event stream
	abort   context.CancelCauseFunc
	byID    map[string]*report.Report
	history []*report.Report // newest first

	wg sync.WaitGroup
}

// NewManager builds the manager. The logger is passed explicitly rather than
// taken from a package global: a run's log trail is part of its behaviour, and
// a test that asserts on it should not have to reach through a global to do so.
func NewManager(ex *Executor, targetDisplay string, pub Publisher, log *slog.Logger) *Manager {
	return NewManagerAt(ex, targetDisplay, pub, log, nil)
}

// NewManagerAt is NewManager with the clock passed in; nil means time.Now.
//
// The manager and its budget must always read the same time source — a caller
// that injected one and not the other would prove nothing — so this is the only
// place either is set. It exists because the load budget's 5s cooldown floor is
// real time: a package outside this one that needs to cross it (the API layer's
// handler tests) would otherwise have to sleep through it once per run.
func NewManagerAt(ex *Executor, targetDisplay string, pub Publisher, log *slog.Logger, now func() time.Time) *Manager {
	if now == nil {
		now = time.Now
	}
	if pub == nil {
		pub = nopPublisher{}
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	m := &Manager{
		ex:     ex,
		target: targetDisplay,
		pub:    pub,
		log:    log,
		now:    now,
		byID:   map[string]*report.Report{},
	}
	m.bucket = budget.New(m.clock)
	m.run = dispatchMode
	return m
}

// clock is an indirection so the manager and its budget always read the same
// time source — a test that injects one and not the other would prove nothing.
func (m *Manager) clock() time.Time { return m.now() }

// dispatchMode routes a validated payload to its engine.
func dispatchMode(ctx context.Context, ex *Executor, rr sandbox.RunRequest, emit Emitter) Result {
	if rr.Mode == sandbox.ModePerformance {
		return RunPerformance(ctx, ex, rr, emit)
	}
	return RunFunctional(ctx, ex, rr, emit)
}

// Start validates a payload, admits it against the budget and the lock, and
// launches the run. It returns as soon as the run is registered; the run itself
// proceeds on its own goroutine and survives every subscriber disconnecting.
func (m *Manager) Start(ctx context.Context, rr sandbox.RunRequest) (string, error) {
	clean, err := sandbox.Validate(rr)
	if err != nil {
		return "", err
	}

	m.mu.Lock()
	if m.st.Running {
		m.mu.Unlock()
		m.log.Info("run refused", "event", EventRunRefused, "reason", "busy", "running_run_id", m.st.RunID)
		return "", ErrBusy
	}
	// Admission and the transition to running happen in one critical section.
	// Checking the budget outside the lock would let two requests both pass a
	// check that only one of them can honour.
	nominal := nominalCost(clean)
	d := m.bucket.Admit()
	if !d.Admitted {
		m.mu.Unlock()
		m.log.Info("run refused",
			"event", EventBudgetDenied,
			"reason", "cooling_down",
			"requested_worker_seconds", nominal,
			"balance", d.Balance,
			"cooldown_until", d.CooldownUntil)
		return "", &CooldownError{Until: d.CooldownUntil}
	}

	id := newRunID(m.now())
	start := m.now()
	rep := &report.Report{
		ID:        id,
		Mode:      clean.Mode,
		Status:    report.StatusRunning,
		StartedAt: start,
		Target:    m.target,
		Config:    configOf(clean.Options),
		Entries:   Entries(m.ex, clean.Sequence),
	}
	switch clean.Mode {
	case sandbox.ModeFunctional:
		rep.Functional = &report.Functional{Total: len(clean.Sequence), Results: []report.RequestResult{}}
	default:
		rep.Performance = &report.Performance{Verdict: report.VerdictNA, PerRequest: []report.Stats{}}
	}

	runCtx, abort := context.WithCancelCause(ctx)
	m.abort = abort
	m.live = rep
	m.byID[id] = rep
	m.st = Status{Running: true, RunID: id, Mode: clean.Mode, StartedAt: &start}
	m.wg.Add(1)
	m.mu.Unlock()

	m.pub.Reset(id)
	m.log.Info("budget admitted",
		"event", EventBudgetAdmitted,
		"run_id", id,
		"requested_worker_seconds", nominal,
		"balance", d.Balance)
	m.log.Info("run started",
		"event", EventRunStarted,
		"run_id", id,
		"mode", clean.Mode,
		"sequence", len(clean.Sequence),
		"concurrency", clean.Options.Concurrency,
		"duration_secs", clean.Options.DurationSecs,
		"delay_ms", clean.Options.DelayMs,
		"stop_on_failure", clean.Options.StopOnFailure,
		"target", m.target)

	go func() {
		defer m.wg.Done()
		defer abort(ErrRunAborted) // release the context whatever happens

		res := m.execute(runCtx, id, clean)
		m.finish(id, res)
	}()
	return id, nil
}

// execute runs the mode and turns a panic into a finished, honest report.
//
// A panic must never wedge the lock. Every exit path — normal, cancelled,
// expired, panicking — reaches m.finish, which is what keeps the lock, the
// history ring, and the cooldown from drifting apart.
func (m *Manager) execute(ctx context.Context, id string, clean sandbox.RunRequest) (res Result) {
	defer func() {
		if r := recover(); r != nil {
			m.log.Error("run panicked",
				"event", EventRunPanicked,
				"run_id", id,
				"panic", fmt.Sprint(r))
			// There is no "failed" run status: the vocabulary is running,
			// completed, cancelled, expired. A panicked run did not complete,
			// so it is cancelled — with a note that says who cancelled it.
			res = Result{Status: report.StatusCancelled}
			if clean.Mode == sandbox.ModeFunctional {
				res.Functional = &report.Functional{Total: len(clean.Sequence), Results: []report.RequestResult{}}
			}
		}
	}()
	return m.run(ctx, m.ex, clean, m.emitter(id))
}

// finish is the single exit path for every run. It stamps the report, stores
// it, debits the budget with what the run actually consumed, and releases the
// lock — together, in one critical section, because a lock and a cooldown that
// are updated separately will eventually disagree.
func (m *Manager) finish(id string, res Result) {
	m.mu.Lock()
	rep := m.byID[id]
	end := m.now()
	elapsed := end.Sub(rep.StartedAt)

	rep.FinishedAt = end
	rep.DurationMs = elapsed.Milliseconds()
	rep.Status = res.Status
	if res.Functional != nil {
		rep.Functional = res.Functional
	}
	if res.Performance != nil {
		rep.Performance = res.Performance
	}
	if rep.Note == "" {
		rep.Note = noteFor(rep)
	}

	// Wall-clock worker-seconds, so the in-flight completion tail is paid for.
	charge := m.bucket.Spend(workerSeconds(rep.Mode, rep.Config, elapsed))

	m.history = append([]*report.Report{rep}, m.history...)
	for len(m.history) > HistorySize {
		evicted := m.history[len(m.history)-1]
		m.history = m.history[:len(m.history)-1]
		delete(m.byID, evicted.ID)
	}

	m.st = Status{}
	m.live = nil
	m.abort = nil
	m.mu.Unlock()

	verdict := ""
	if rep.Performance != nil {
		verdict = rep.Performance.Verdict
	}
	m.log.Info("budget charged",
		"event", EventBudgetCharged,
		"run_id", id,
		"worker_seconds", charge.Cost,
		"balance_before", charge.Before,
		"balance_after", charge.After,
		"cooldown_secs", charge.Cooldown.Seconds(),
		"cooldown_until", charge.CooldownUntil)
	m.log.Info("run finished",
		"event", EventRunFinished,
		"run_id", id,
		"mode", rep.Mode,
		"status", rep.Status,
		"duration_ms", rep.DurationMs,
		"verdict", verdict)

	// Published after finalization, so a client that reacts by fetching the
	// report never races the store.
	m.pub.Publish(Event{Type: EventRunFinished, RunID: id, Data: RunFinished{
		Status:        rep.Status,
		DurationMs:    rep.DurationMs,
		Verdict:       verdict,
		CooldownUntil: charge.CooldownUntil,
	}})
}

// Cancel stops the live run. Any visitor may cancel, spectators included:
// cancelling only ever reduces load, the budget charges a cancelled run exactly
// what it consumed, and a spectator watching a stuck run they cannot stop is
// the worse experience.
func (m *Manager) Cancel(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.st.Running || m.st.RunID != id || m.abort == nil {
		return ErrNotRunning
	}
	m.log.Info("run cancelled", "event", EventRunCancelled, "run_id", id)
	m.abort(ErrRunAborted)
	return nil
}

// Status reports the lifecycle plus the budget's view of when a run may next
// start.
func (m *Manager) Status() Status {
	m.mu.Lock()
	st := m.st
	m.mu.Unlock()

	st.BudgetBalance = m.bucket.Balance()
	if until := m.bucket.CooldownUntil(); until.After(m.now()) {
		st.CooldownUntil = &until
	}
	return st
}

// Report returns a run's report. The live run's report is a snapshot: coherent,
// partial, and free of body previews, because it is what the polling fallback
// reads while status is still running.
func (m *Manager) Report(id string) (*report.Report, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rep, ok := m.byID[id]
	if !ok {
		return nil, false
	}
	if rep.Status == report.StatusRunning {
		return snapshot(rep), true
	}
	// A finished report is never mutated again, so it can be shared as-is.
	return rep, true
}

// History returns finished runs, newest first.
func (m *Manager) History() []*report.Report {
	m.mu.Lock()
	defer m.mu.Unlock()
	return slices.Clone(m.history)
}

// Wait blocks until no run is active. Graceful shutdown and tests both need it;
// nothing else should.
func (m *Manager) Wait() { m.wg.Wait() }

// Budget exposes the bucket so /api/send can debit the same ledger. Gating runs
// while leaving an ungated path to the same target would be incoherent.
func (m *Manager) Budget() *budget.Bucket { return m.bucket }

// emitter stamps the run id onto every event, folds it into the live partial
// report, and forwards it to the broadcaster.
func (m *Manager) emitter(id string) Emitter {
	return func(e Event) {
		e.RunID = id
		m.absorb(id, e)
		m.pub.Publish(e)
	}
}

// absorb keeps the live report coherent enough to serve mid-run.
//
// Body previews are deliberately dropped here: the 16KB preview streams live
// and is stored on the finished report, but a partial report fetched by the
// polling fallback every few seconds should not carry a growing pile of them.
func (m *Manager) absorb(id string, e Event) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rep := m.live
	if rep == nil || rep.ID != id {
		return
	}
	switch data := e.Data.(type) {
	case report.RequestResult:
		if rep.Functional == nil {
			return
		}
		data.BodyPreview, data.BodyTruncated = "", false
		rep.Functional.Results = append(rep.Functional.Results, data)
		switch {
		case data.Skipped:
			rep.Functional.Skipped++
		case data.Passed:
			rep.Functional.Passed++
		default:
			rep.Functional.Failed++
		}
	case Progress:
		if rep.Performance == nil {
			return
		}
		// Counters only. No percentiles mid-run: they are computed once, at the
		// end, over samples the aggregator alone owns.
		rep.Performance.Overall = report.Stats{
			Index:          -1,
			Name:           "overall",
			Requests:       data.Requests,
			Errors:         data.Errors,
			Aborted:        data.Aborted,
			RequestsPerSec: data.RPS,
			Latency:        report.Percentiles{Avg: data.AvgLatencyMs},
		}
	}
}

// snapshot copies a live report deeply enough that a reader can range over it
// while the run keeps writing. Must be called under the lock.
func snapshot(rep *report.Report) *report.Report {
	out := *rep
	out.Entries = slices.Clone(rep.Entries)
	if rep.Functional != nil {
		f := *rep.Functional
		f.Results = slices.Clone(rep.Functional.Results)
		out.Functional = &f
	}
	if rep.Performance != nil {
		p := *rep.Performance
		p.PerRequest = slices.Clone(rep.Performance.PerRequest)
		out.Performance = &p
	}
	return &out
}

// nominalCost is what a run would cost if it used its whole budgeted duration.
// It is what the admission log line reports as requested; the debit at the end
// is the actual figure, which for a cancelled or stalled run differs sharply.
func nominalCost(rr sandbox.RunRequest) float64 {
	if rr.Mode == sandbox.ModePerformance {
		return float64(rr.Options.Concurrency) * float64(rr.Options.DurationSecs)
	}
	return float64(len(rr.Sequence)) // one worker, roughly a second per request
}

// workerSeconds prices a finished run. Functional mode is one worker by
// definition — it is a sequential walk.
func workerSeconds(mode string, cfg report.Config, elapsed time.Duration) float64 {
	workers := 1.0
	if mode == sandbox.ModePerformance && cfg.Concurrency > 0 {
		workers = float64(cfg.Concurrency)
	}
	secs := elapsed.Seconds()
	if secs < 0 {
		secs = 0
	}
	return workers * secs
}

// noteFor explains a non-obvious status in the report itself, so a stored run
// is readable a week later without the UI's help.
func noteFor(rep *report.Report) string {
	switch rep.Status {
	case report.StatusCancelled:
		return "Cancelled before completion. Abandoned dispatches are counted as aborted — not as target errors — so the verdict is withheld rather than failed."
	case report.StatusExpired:
		return fmt.Sprintf("Reached the %s wall-clock deadline. The request in flight completed and counts; the remainder was skipped.", FunctionalDeadline)
	default:
		return ""
	}
}

// newRunID is run-YYYYmmdd-HHMMSS-<4 hex>. The timestamp makes history sortable
// by eye; the random suffix keeps two runs in the same second distinct.
func newRunID(now time.Time) string {
	var b [2]byte
	_, _ = rand.Read(b[:])
	return "run-" + now.UTC().Format("20060102-150405") + "-" + hex.EncodeToString(b[:])
}

// nopPublisher lets the manager run without an SSE layer, which is exactly the
// state Phase 3 is in and exactly what a unit test wants.
type nopPublisher struct{}

func (nopPublisher) Publish(Event)   {}
func (nopPublisher) Reset(string)    {}
func (nopPublisher) Replay() []Event { return nil }
