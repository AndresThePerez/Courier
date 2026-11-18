package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// ---- harness: streams opened while a run is registered but not announced ----

// gapFrame is one SSE frame as a viewer received it.
type gapFrame struct {
	id     uint64
	name   string
	runID  string
	status string
}

// viewer is one open stream, read to its end on its own goroutine.
type viewer struct {
	code   int
	body   string
	events atomic.Int64 // event: lines seen so far

	mu     sync.Mutex
	frames []gapFrame
	tail   []string // fields after the last run_finished
	done   chan struct{}
	cancel context.CancelFunc
}

// openViewer connects to a run's stream and returns once the response headers
// are in, which the handler writes only after it holds its subscriber slot.
func openViewer(t *testing.T, base, runID, lastEventID string) *viewer {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/runs/"+runID+"/stream", nil)
	if err != nil {
		cancel()
		t.Fatalf("request: %v", err)
	}
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	resp, err := client.Do(req)
	if err != nil {
		cancel()
		t.Fatalf("open stream: %v", err)
	}
	v := &viewer{code: resp.StatusCode, done: make(chan struct{}), cancel: cancel}
	t.Cleanup(func() {
		cancel()
		resp.Body.Close()
	})
	go func() {
		defer close(v.done)
		var raw bytes.Buffer
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
		cur := gapFrame{}
		finished := false
		for sc.Scan() {
			line := sc.Text()
			raw.WriteString(line + "\n")
			if finished {
				if line != "" {
					v.mu.Lock()
					v.tail = append(v.tail, line)
					v.mu.Unlock()
				}
				continue
			}
			switch {
			case strings.HasPrefix(line, "id: "):
				cur.id, _ = strconv.ParseUint(strings.TrimPrefix(line, "id: "), 10, 64)
			case strings.HasPrefix(line, "event: "):
				v.events.Add(1)
				cur.name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				var env struct {
					RunID string `json:"run_id"`
					Data  struct {
						Status string `json:"status"`
					} `json:"data"`
				}
				_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &env)
				cur.runID, cur.status = env.RunID, env.Data.Status
			case line == "" && cur.name != "":
				v.mu.Lock()
				v.frames = append(v.frames, cur)
				v.mu.Unlock()
				finished = cur.name == runner.EventRunFinished
				cur = gapFrame{}
			}
		}
		v.mu.Lock()
		v.body = raw.String()
		v.mu.Unlock()
	}()
	return v
}

// wait blocks until the server ended the stream, failing instead of hanging.
func (v *viewer) wait(t *testing.T, what string) {
	t.Helper()
	select {
	case <-v.done:
	case <-time.After(15 * time.Second):
		v.mu.Lock()
		defer v.mu.Unlock()
		t.Fatalf("%s: the stream did not end; frames so far %+v", what, v.frames)
	}
}

func (v *viewer) snapshot() ([]gapFrame, []string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	return slices.Clone(v.frames), slices.Clone(v.tail)
}

// checkWholeRun holds a finished stream to the contract for one run: only that
// run's events, ids strictly rising, run_started first when present, exactly
// one run_finished and it is last, never "running", then one retry: line.
func (v *viewer) checkWholeRun(t *testing.T, what, runID, wantStatus string) []gapFrame {
	t.Helper()
	return v.checkRun(t, what, runID, wantStatus, true)
}

// checkRun is checkWholeRun with the id rule optional: ids must rise, or, when
// strict is false, merely never go backwards.
func (v *viewer) checkRun(t *testing.T, what, runID, wantStatus string, strict bool) []gapFrame {
	t.Helper()
	frames, tail := v.snapshot()
	if v.code != http.StatusOK {
		t.Fatalf("%s: status %d, want 200", what, v.code)
	}
	if len(frames) == 0 {
		t.Fatalf("%s: no frames", what)
	}
	finishes := 0
	for i, f := range frames {
		if f.runID != runID {
			t.Errorf("%s: frame %d (%s) belongs to run %q, want %q", what, i, f.name, f.runID, runID)
		}
		if i > 0 && (f.id < frames[i-1].id || (strict && f.id == frames[i-1].id)) {
			t.Errorf("%s: frame %d id %d does not rise from %d", what, i, f.id, frames[i-1].id)
		}
		if f.name == runner.EventRunStarted && i != 0 {
			t.Errorf("%s: run_started at position %d", what, i)
		}
		if f.name == runner.EventRunFinished {
			finishes++
			if f.status == report.StatusRunning {
				t.Errorf("%s: run_finished with status running", what)
			}
			if wantStatus != "" && f.status != wantStatus {
				t.Errorf("%s: run_finished status %q, want %q", what, f.status, wantStatus)
			}
		}
	}
	if finishes != 1 || frames[len(frames)-1].name != runner.EventRunFinished {
		t.Errorf("%s: %d run_finished, last frame %q; want exactly one, last", what, finishes, frames[len(frames)-1].name)
	}
	if len(tail) != 1 || !strings.HasPrefix(tail[0], "retry: ") {
		t.Errorf("%s: after run_finished the stream sent %q, want one retry: line", what, tail)
	}
	return frames
}

// gapHarness is a server whose broadcaster Reset can be held, so a run can be
// kept registered (named on /api/status, readable at /api/runs/{id}) while the
// broadcaster does not yet describe it.
type gapHarness struct {
	s   *Server
	bus *heldBus
	c   *clock
	url string
}

func newGapHarness(t *testing.T, targetDelay time.Duration) *gapHarness {
	t.Helper()
	c := &clock{}
	s := newServer(t, newTarget(t, targetDelay), c)
	bus := &heldBus{Broadcaster: s.bus}
	s.mgr = runner.NewManagerAt(s.ex, "test-target", bus, nil, c.now)
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return &gapHarness{s: s, bus: bus, c: c, url: srv.URL}
}

// runToEnd runs one functional run and returns its id, then steps the clock
// over the budget's cooldown floor so the next run is admitted.
func (g *gapHarness) runToEnd(t *testing.T, requests int) string {
	t.Helper()
	id, err := g.s.mgr.Start(g.s.runCtx, payload(requests, 0))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	waitIdle(t, g.s)
	g.c.advance(10 * time.Second)
	return id
}

// holdStart registers a run and parks it inside the broadcaster's Reset. The
// returned release is safe to call more than once and runs at cleanup.
func (g *gapHarness) holdStart(t *testing.T, rr sandbox.RunRequest) (id string, release func()) {
	t.Helper()
	entered, rel := g.bus.arm()
	var once sync.Once
	release = func() { once.Do(func() { close(rel) }) }
	t.Cleanup(release)
	started := make(chan error, 1)
	go func() {
		_, err := g.s.mgr.Start(g.s.runCtx, rr)
		started <- err
	}()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the manager never reached Reset")
	}
	t.Cleanup(func() {
		release()
		select {
		case err := <-started:
			if err != nil {
				t.Errorf("start: %v", err)
			}
		case <-time.After(10 * time.Second):
			t.Error("Start did not return after release")
		}
	})
	id = g.s.mgr.Status().RunID
	if id == "" {
		t.Fatal("no run registered in the window")
	}
	return id, release
}

// settle gives a stream that should stay silent a bounded chance to speak, and
// fails if it did. A negative check: a defect shows as a failure, never as a
// flake.
func (v *viewer) staysSilent(t *testing.T, what string) {
	t.Helper()
	deadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(deadline) {
		if n := v.events.Load(); n != 0 {
			frames, _ := v.snapshot()
			t.Fatalf("%s: wrote %d event(s) before its run was announced: %+v", what, n, frames)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitSubscribers(t *testing.T, g *gapHarness, want int, what string) {
	t.Helper()
	waitFor(t, what, func() bool { return g.s.bus.Subscribers() == want })
}

// ---- never a terminal event for a running run ----------------------------

// Whatever Last-Event-ID a viewer carries, a stream opened while its run is
// registered but not announced writes nothing until the run is announced, and
// then the run's own events from run_started to its real run_finished.
func TestGapStreamNeverCarriesATerminalEventForTheRunningRun(t *testing.T) {
	for _, tc := range []struct {
		name   string
		resume func(prev string, last uint64) string
	}{
		{"no header", func(string, uint64) string { return "" }},
		{"zero", func(string, uint64) string { return "0" }},
		{"the previous runs last id", func(_ string, last uint64) string { return strconv.FormatUint(last, 10) }},
		{"a huge id", func(string, uint64) string { return "18446744073709551615" }},
		{"an id past the previous run", func(_ string, last uint64) string { return strconv.FormatUint(last+1000, 10) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := newGapHarness(t, 0)
			prev := g.runToEnd(t, 2)
			last, ok := g.s.bus.LastID(prev)
			if !ok {
				t.Fatal("the previous run has no last id")
			}
			id, release := g.holdStart(t, payload(3, 0))

			v := openViewer(t, g.url, id, tc.resume(prev, last))
			if v.code != http.StatusOK {
				t.Fatalf("status %d, want 200", v.code)
			}
			waitSubscribers(t, g, 1, "the viewer to hold a slot")
			v.staysSilent(t, "a stream in the gap")

			release()
			v.wait(t, "gap stream")
			frames := v.checkWholeRun(t, "gap stream", id, report.StatusCompleted)
			if frames[0].name != runner.EventRunStarted || frames[0].id != 1 {
				t.Errorf("first frame = %+v, want run_started with id 1", frames[0])
			}
			waitSubscribers(t, g, 0, "the slot to be released")
		})
	}
}

// The run before the gap is over and the broadcaster still holds it: a stream
// for that run gets its own real terminal event and ends, whatever
// Last-Event-ID it sends, while the new run sits in the gap undisturbed.
func TestGapStreamOfThePreviousRunGetsItsOwnTerminalEvent(t *testing.T) {
	g := newGapHarness(t, 0)
	prev := g.runToEnd(t, 2)
	last, _ := g.s.bus.LastID(prev)
	id, release := g.holdStart(t, payload(2, 0))

	newViewer := openViewer(t, g.url, id, "")
	waitSubscribers(t, g, 1, "the new run's viewer")

	for _, resume := range []string{"", "0", "1", strconv.FormatUint(last, 10), strconv.FormatUint(last+1, 10), "18446744073709551615"} {
		v := openViewer(t, g.url, prev, resume)
		v.wait(t, "previous run with Last-Event-ID "+resume)
		frames, _ := v.snapshot()
		if len(frames) == 0 || frames[len(frames)-1].name != runner.EventRunFinished {
			t.Fatalf("Last-Event-ID %q: frames %+v do not end with run_finished", resume, frames)
		}
		v.checkWholeRun(t, "previous run, Last-Event-ID "+resume, prev, report.StatusCompleted)
	}
	// Only the new run's viewer still holds a slot.
	waitSubscribers(t, g, 1, "the finished viewers to give their slots back")
	if n := newViewer.events.Load(); n != 0 {
		t.Errorf("the new run's viewer was written %d event(s) in the gap", n)
	}

	release()
	newViewer.wait(t, "new run viewer")
	newViewer.checkWholeRun(t, "new run viewer", id, report.StatusCompleted)
	waitSubscribers(t, g, 0, "every slot back")

	// And once the broadcaster has moved on, the previous run is rebuilt from
	// its report: still its own terminal event.
	v := openViewer(t, g.url, prev, "")
	v.wait(t, "previous run after the gap")
	v.checkWholeRun(t, "previous run after the gap", prev, report.StatusCompleted)
}

// ---- the gap resolving in different ways ---------------------------------

// A run cancelled while it waits to be announced still ends its viewer with
// its own run_finished (cancelled), once, and the viewer gives its slot back.
func TestGapRunCancelledBeforeAnnouncementEndsItsViewerOnce(t *testing.T) {
	g := newGapHarness(t, 0)
	id, release := g.holdStart(t, payload(3, 0))
	v := openViewer(t, g.url, id, "")
	waitSubscribers(t, g, 1, "the viewer to hold a slot")

	if err := g.s.mgr.Cancel(id); err != nil {
		t.Fatalf("cancel in the gap: %v", err)
	}
	v.staysSilent(t, "a stream whose run was cancelled in the gap")
	release()
	v.wait(t, "cancelled run")
	v.checkWholeRun(t, "cancelled run", id, report.StatusCancelled)
	waitSubscribers(t, g, 0, "the slot to be released")
	waitIdle(t, g.s)
}

// Twenty viewers attach in the gap and the run, with no delay at all, finishes
// as soon as it is announced: every viewer sees run_started and run_finished
// once, the same ids the broadcaster numbered, and every slot comes back.
func TestGapManyViewersOfAnInstantRunAllGetTheWholeRun(t *testing.T) {
	g := newGapHarness(t, 0)
	id, release := g.holdStart(t, payload(1, 0))

	const n = 20
	viewers := make([]*viewer, n)
	for i := range viewers {
		viewers[i] = openViewer(t, g.url, id, "")
	}
	waitSubscribers(t, g, n, "all viewers to hold a slot")

	release()
	var want []uint64
	for i, v := range viewers {
		v.wait(t, "viewer "+strconv.Itoa(i))
		frames := v.checkWholeRun(t, "viewer "+strconv.Itoa(i), id, report.StatusCompleted)
		if frames[0].name != runner.EventRunStarted {
			t.Errorf("viewer %d: first frame %q, want run_started", i, frames[0].name)
		}
		ids := make([]uint64, len(frames))
		for j, f := range frames {
			ids[j] = f.id
		}
		if want == nil {
			want = ids
		} else if !slices.Equal(ids, want) {
			t.Errorf("viewer %d saw ids %v, viewer 0 saw %v", i, ids, want)
		}
	}
	var logged []uint64
	for _, e := range g.s.bus.Replay() {
		if e.RunID == id {
			logged = append(logged, e.ID)
		}
	}
	if !slices.Equal(want, logged) {
		t.Errorf("viewers saw ids %v, the run published %v", want, logged)
	}
	waitSubscribers(t, g, 0, "every slot back")
}

// The cap is reached during the gap: the next viewer gets the documented 503
// with {"poll":true}, no slot leaks, and once the run ends every slot is free.
func TestGapSubscriberCapRefusesTheNextViewerAndLeaksNothing(t *testing.T) {
	g := newGapHarness(t, 0)
	id, release := g.holdStart(t, payload(1, 0))

	const cap = 100
	viewers := make([]*viewer, cap)
	for i := range viewers {
		viewers[i] = openViewer(t, g.url, id, "")
		if viewers[i].code != http.StatusOK {
			t.Fatalf("viewer %d: status %d, want 200", i, viewers[i].code)
		}
	}
	waitSubscribers(t, g, cap, "the cap to be reached")

	over := openViewer(t, g.url, id, "")
	over.wait(t, "the refused viewer")
	if over.code != http.StatusServiceUnavailable {
		t.Fatalf("viewer past the cap: status %d, want 503", over.code)
	}
	var body struct {
		Poll bool `json:"poll"`
	}
	over.mu.Lock()
	err := json.Unmarshal([]byte(over.body), &body)
	over.mu.Unlock()
	if err != nil || !body.Poll {
		t.Errorf("refusal body %q (err %v), want {\"poll\":true}", over.body, err)
	}
	if n := g.s.bus.Subscribers(); n != cap {
		t.Errorf("subscribers after a refusal = %d, want %d", n, cap)
	}

	release()
	for i, v := range viewers {
		v.wait(t, "viewer "+strconv.Itoa(i))
		v.checkWholeRun(t, "viewer "+strconv.Itoa(i), id, report.StatusCompleted)
	}
	waitSubscribers(t, g, 0, "every slot back")

	// A fresh viewer is admitted again.
	again := openViewer(t, g.url, id, "")
	again.wait(t, "a viewer after the run")
	again.checkWholeRun(t, "a viewer after the run", id, report.StatusCompleted)
}

// ---- the viewer of an old run when a new run starts ----------------------

// stallWriter is a response writer whose first Write waits for the test: a
// viewer that is slow to read, observed without depending on socket buffers.
type stallWriter struct {
	hdr   http.Header
	gate  chan struct{}
	first chan struct{}
	once  sync.Once

	mu  sync.Mutex
	buf bytes.Buffer
}

func newStallWriter() *stallWriter {
	return &stallWriter{hdr: http.Header{}, gate: make(chan struct{}), first: make(chan struct{})}
}

func (w *stallWriter) Header() http.Header { return w.hdr }
func (w *stallWriter) WriteHeader(int)     {}
func (w *stallWriter) Flush()              {}
func (w *stallWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.first) })
	<-w.gate
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}
func (w *stallWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// A viewer too slow to read A's run_finished while B resets the log still ends
// with A's own terminal event, reads none of B's events, and gives its slot
// back while B carries on.
func TestSlowViewerOfAnOldRunEndsWithItsOwnTerminalWhenTheNextRunStarts(t *testing.T) {
	g := newGapHarness(t, 0)
	a, releaseA := g.holdStart(t, payload(2, 0))

	w := newStallWriter()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/runs/"+a+"/stream", nil)
	handled := make(chan struct{})
	go func() {
		defer close(handled)
		g.s.ServeHTTP(w, req)
	}()
	waitSubscribers(t, g, 1, "the slow viewer to subscribe")

	releaseA()
	select {
	case <-w.first:
	case <-time.After(10 * time.Second):
		t.Fatal("the viewer was never written to")
	}
	waitIdle(t, g.s)
	g.c.advance(10 * time.Second)
	b, err := g.s.mgr.Start(g.s.runCtx, payload(3, 0))
	if err != nil {
		t.Fatalf("start B: %v", err)
	}
	waitIdle(t, g.s)

	close(w.gate)
	select {
	case <-handled:
	case <-time.After(15 * time.Second):
		t.Fatalf("the slow viewer's stream never ended: %q", w.String())
	}
	out := w.String()
	if strings.Contains(out, b) {
		t.Errorf("the viewer of run %s was written run %s's events:\n%s", a, b, out)
	}
	if got := strings.Count(out, "event: "+runner.EventRunFinished+"\n"); got != 1 {
		t.Errorf("run_finished written %d times, want once:\n%s", got, out)
	}
	if !strings.Contains(out, "retry: ") {
		t.Errorf("no retry: line after run_finished:\n%s", out)
	}
	waitSubscribers(t, g, 0, "the slot to be released")
}

// ---- the window in Manager.finish ----------------------------------------

// holdFinish is a publisher that parks the first run's run_finished inside
// Publish until the test releases it, holding Manager.finish between "the lock
// is released" and "the run's last event is published".
type holdFinish struct {
	*heldBus
	mu      sync.Mutex
	runID   string // the run whose run_finished is held; "" holds the next one
	entered chan struct{}
	hold    chan struct{}
	armed   bool
}

func (h *holdFinish) Publish(e runner.Event) {
	if e.Type == runner.EventRunFinished {
		h.mu.Lock()
		hold := h.armed && (h.runID == "" || h.runID == e.RunID)
		if hold {
			h.armed = false
			h.runID = e.RunID
		}
		h.mu.Unlock()
		if hold {
			close(h.entered)
			<-h.hold
		}
	}
	h.heldBus.Publish(e)
}

func newHoldFinish(t *testing.T, g *gapHarness) (h *holdFinish, release func()) {
	t.Helper()
	h = &holdFinish{heldBus: g.bus, entered: make(chan struct{}), hold: make(chan struct{}), armed: true}
	g.s.mgr = runner.NewManagerAt(g.s.ex, "test-target", h, nil, g.c.now)
	var once sync.Once
	release = func() { once.Do(func() { close(h.hold) }) }
	t.Cleanup(release)
	return h, release
}

// A new run cannot be admitted while the old run's run_finished is still
// unpublished: Manager.finish debits the budget, and so opens the cooldown
// floor, before it releases the lock. The window the new run's Reset could
// slip into is closed by that, so a viewer of the old run can never see its
// run_finished land in the new run's log.
func TestNewRunIsRefusedWhileTheOldRunsTerminalEventIsUnpublished(t *testing.T) {
	g := newGapHarness(t, 0)
	h, release := newHoldFinish(t, g)

	a, err := g.s.mgr.Start(g.s.runCtx, payload(1, 0))
	if err != nil {
		t.Fatalf("start A: %v", err)
	}
	select {
	case <-h.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("run A never reached its run_finished")
	}
	if st := g.s.mgr.Status(); st.Running || st.CooldownUntil == nil {
		t.Fatalf("status in the window = %+v, want idle with a cooldown", st)
	}

	_, err = g.s.mgr.Start(g.s.runCtx, payload(1, 0))
	var cool *runner.CooldownError
	if !errors.As(err, &cool) || !errors.Is(err, runner.ErrCoolingDown) {
		t.Fatalf("start in the window = %v, want a cooldown refusal", err)
	}
	if got := g.s.bus.RunID(); got != a {
		t.Errorf("a refused start reset the broadcaster to %q, want %q", got, a)
	}

	// A viewer of A attached in the window still gets A's own terminal event
	// once it is published.
	v := openViewer(t, g.url, a, "")
	waitSubscribers(t, g, 1, "the viewer in the window")
	release()
	v.wait(t, "viewer of the held run")
	v.checkWholeRun(t, "viewer of the held run", a, report.StatusCompleted)
	waitSubscribers(t, g, 0, "the slot to be released")
}

// Even if the guard were stepped over (the clock moves past the floor while the
// old run's run_finished is unpublished, as a stalled publisher would allow),
// no viewer gets a foreign, missing or repeated event: the old run's viewers
// end with the old run's terminal event, the new run's viewer skips the old
// run's late run_finished and ends with its own.
func TestStalledRunFinishedNeverReachesTheWrongViewer(t *testing.T) {
	g := newGapHarness(t, 0)
	h, release := newHoldFinish(t, g)

	a, err := g.s.mgr.Start(g.s.runCtx, payload(1, 0))
	if err != nil {
		t.Fatalf("start A: %v", err)
	}
	select {
	case <-h.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("run A never reached its run_finished")
	}
	// Attached to the broadcaster while it still describes A, before A's
	// run_finished is published.
	early := openViewer(t, g.url, a, "")
	waitSubscribers(t, g, 1, "the early viewer")

	g.c.advance(10 * time.Second)
	b, err := g.s.mgr.Start(g.s.runCtx, payload(3, 700))
	if err != nil {
		t.Fatalf("start B: %v", err)
	}
	// The early viewer meets B's first event while A's own is still held: A is
	// over, so it is ended with A's rebuilt terminal event, not with B's.
	early.wait(t, "the viewer of A")
	// A rebuilt terminal event carries the last id the broadcaster numbered for
	// the run. Here the run's own run_finished was never numbered, so that is
	// the previous event's id: the order is checked, not strict increase.
	early.checkRun(t, "the viewer of A", a, report.StatusCompleted, false)

	// A viewer of A that attaches now finds the broadcaster on B.
	late := openViewer(t, g.url, a, "")
	late.wait(t, "a late viewer of A")
	late.checkWholeRun(t, "a late viewer of A", a, report.StatusCompleted)

	vb := openViewer(t, g.url, b, "")
	waitFor(t, "B's first event", func() bool { return vb.events.Load() > 0 })
	release() // A's run_finished now lands in B's log while B is running
	vb.wait(t, "the viewer of B")
	frames := vb.checkWholeRun(t, "the viewer of B", b, report.StatusCompleted)
	if frames[0].name != runner.EventRunStarted {
		t.Errorf("B's first frame = %q, want run_started", frames[0].name)
	}
	waitSubscribers(t, g, 0, "every slot back")
}

// ---- shutdown and disconnect during the gap ------------------------------

// A viewer that hangs up while it waits for its run to be announced gives its
// slot back at once, while the run is still unannounced, and was written no
// event.
func TestGapViewerThatHangsUpReleasesItsSlot(t *testing.T) {
	g := newGapHarness(t, 0)
	id, _ := g.holdStart(t, payload(2, 0))

	vs := make([]*viewer, 3)
	for i := range vs {
		vs[i] = openViewer(t, g.url, id, "")
	}
	waitSubscribers(t, g, 3, "the viewers to hold slots")

	vs[0].cancel()
	waitSubscribers(t, g, 2, "the departed viewer's slot")
	vs[1].cancel()
	vs[2].cancel()
	waitSubscribers(t, g, 0, "every slot")
	for i, v := range vs {
		if n := v.events.Load(); n != 0 {
			t.Errorf("viewer %d was written %d event(s) while its run was unannounced", i, n)
		}
	}
}

// Shutdown while Reset is held ends every waiting stream, writes no event:
// line to any of them, and releases every slot before the run is announced.
func TestGapShutdownEndsEveryWaitingStreamWithoutAnEvent(t *testing.T) {
	g := newGapHarness(t, 0)
	id, release := g.holdStart(t, payload(2, 0))

	vs := make([]*viewer, 5)
	for i := range vs {
		vs[i] = openViewer(t, g.url, id, "")
	}
	waitSubscribers(t, g, len(vs), "the viewers to hold slots")

	closed := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		closed <- g.s.Close(ctx)
	}()
	for i, v := range vs {
		v.wait(t, "viewer "+strconv.Itoa(i)+" at shutdown")
		v.mu.Lock()
		body := v.body
		v.mu.Unlock()
		if strings.Contains(body, "event: ") || strings.Contains(body, "retry: ") {
			t.Errorf("viewer %d at shutdown was written %q", i, body)
		}
	}
	waitSubscribers(t, g, 0, "every slot at shutdown")

	release()
	select {
	case err := <-closed:
		if err != nil {
			t.Errorf("close: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("Close did not return once the run was announced")
	}
}
