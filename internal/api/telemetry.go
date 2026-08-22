package api

import (
	"expvar"
	"io"
	"math"
	"net/http"
	"runtime"
	"sync"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sse"
)

// metrics is Courier watching itself: ten numbers, JSON, no dependency.
//
// It is an expvar.Map that is deliberately NOT published to expvar's package
// global. Two reasons, and the second is the important one: a process can build
// more than one Server (every handler test does), and expvar.Publish panics on
// a duplicate name; and the default expvar handler also exposes cmdline and
// memstats, which means os.Args — a demo that hands the internet its own
// command line is not a demo, it is a disclosure. Scoping the map to the server
// gives the same wire format with none of that.
type metrics struct {
	m *expvar.Map

	// gauges are attached on the first render rather than at construction,
	// because they read the server and the server is not finished being built
	// when its metrics are created — the run manager it reads is constructed
	// with the metrics tap this type provides.
	gauges sync.Once

	runsStarted   *expvar.Int
	runsCancelled *expvar.Int
	runsAborted   *expvar.Int
	sends         *expvar.Int
	sendsRefused  *expvar.Int
}

func newMetrics() *metrics {
	mt := &metrics{
		m:             new(expvar.Map).Init(),
		runsStarted:   new(expvar.Int),
		runsCancelled: new(expvar.Int),
		runsAborted:   new(expvar.Int),
		sends:         new(expvar.Int),
		sendsRefused:  new(expvar.Int),
	}

	// Counters: what has happened.
	mt.m.Set("runs_started", mt.runsStarted)
	mt.m.Set("runs_cancelled", mt.runsCancelled)
	mt.m.Set("runs_aborted", mt.runsAborted)
	mt.m.Set("sends_completed", mt.sends)
	mt.m.Set("sends_refused", mt.sendsRefused)

	return mt
}

// attach registers the gauges: what is true right now, as opposed to what has
// happened. expvar.Func is evaluated at render time, so a gauge is never a
// stale copy of state that lives somewhere else.
func (m *metrics) attach(s *Server) {
	m.m.Set("budget_balance", expvar.Func(func() any { return round(s.mgr.Budget().Balance()) }))
	m.m.Set("sse_subscribers", expvar.Func(func() any { return s.bus.Subscribers() }))
	m.m.Set("sse_subscriber_cap", expvar.Func(func() any { return sse.MaxSubscribers }))
	m.m.Set("goroutines", expvar.Func(func() any { return runtime.NumGoroutine() }))
	m.m.Set("uptime_secs", expvar.Func(func() any { return round(s.now().Sub(s.started).Seconds()) }))
	m.m.Set("run_in_progress", expvar.Func(func() any { return s.mgr.Status().Running }))
}

func (m *metrics) runStarted()    { m.runsStarted.Add(1) }
func (m *metrics) runCancelled()  { m.runsCancelled.Add(1) }
func (m *metrics) sendCompleted() { m.sends.Add(1) }
func (m *metrics) sendRefused()   { m.sendsRefused.Add(1) }

// observe taps the event stream on its way to the broadcaster.
//
// runs_aborted counts runs that finished without completing — cancelled by a
// visitor, expired on the functional deadline, or stopped by shutdown. Counting
// that in the cancel handler instead would miss every one of those cases except
// the first.
func (m *metrics) observe(e runner.Event) {
	if e.Type != runner.EventRunFinished {
		return
	}
	if fin, ok := e.Data.(runner.RunFinished); ok && fin.Status != report.StatusCompleted {
		m.runsAborted.Add(1)
	}
}

// meteredBus is the broadcaster with the metrics tap on the way past.
//
// Counting terminal events here rather than adding a hook to the run manager
// keeps telemetry out of the engine: the manager already publishes exactly one
// run_finished per run, after finalization, so the stream is where "how did
// runs end" can be observed without the engine knowing anything about it.
type meteredBus struct {
	*sse.Broadcaster
	m *metrics
}

func (b meteredBus) Publish(e runner.Event) {
	b.m.observe(e)
	b.Broadcaster.Publish(e)
}

// handleMetrics renders the map. expvar.Map.String is already JSON with its
// keys in sorted order, so there is nothing to marshal and nothing to keep in
// sync with a struct.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	s.metrics.gauges.Do(func() { s.metrics.attach(s) })
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, s.metrics.m.String())
}

// round keeps a float readable in a metrics dump. Three decimals is plenty for
// worker-seconds and uptime, and it stops a balance rendering as
// 1499.9999999999998.
func round(f float64) float64 { return math.Round(f*1000) / 1000 }
