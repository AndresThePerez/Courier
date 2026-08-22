package runner

import (
	"time"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// Event types. This is the whole stream vocabulary; the SSE layer forwards
// these verbatim and the frontend switches on Type.
const (
	EventRunStarted    = "run_started"
	EventRequestResult = "request_result"
	EventProgress      = "progress"
	EventRunFinished   = "run_finished"
)

// Event is one thing that happened during a run.
//
// RunID is stamped by the manager rather than by the modes, which do not know
// their run's identity. Carrying it on the envelope means a spectator attaching
// mid-run can tell a replayed event from a live one without inspecting Data.
type Event struct {
	Type  string `json:"type"`
	RunID string `json:"run_id,omitempty"`
	Data  any    `json:"data"`
}

// Emitter receives a run's events. It is called from the run's own goroutines
// and must not block: the manager's emitter publishes to a non-blocking
// broadcaster, and the run continues even when every subscriber has gone.
type Emitter func(Event)

// RunStarted is the run_started payload: everything the UI needs to draw the
// sequence before the first result lands.
type RunStarted struct {
	Mode      string         `json:"mode"`
	Total     int            `json:"total"`
	StartedAt time.Time      `json:"started_at"`
	Config    report.Config  `json:"config"`
	Entries   []report.Entry `json:"entries"`
}

// Progress is the 250ms performance-mode heartbeat. There are deliberately no
// percentiles here: they are computed once, after the results channel closes,
// over samples the aggregator alone owns.
type Progress struct {
	ElapsedMs    int64   `json:"elapsed_ms"`
	Requests     int     `json:"requests"`
	Errors       int     `json:"errors"`
	Aborted      int     `json:"aborted"`
	RPS          float64 `json:"rps"`
	AvgLatencyMs float64 `json:"avg_latency_ms"`
}

// RunFinished is the run_finished payload. The manager emits it after the
// report is stamped, stored, and charged to the budget, so a client that reacts
// to it by fetching the report never races finalization.
type RunFinished struct {
	Status        string    `json:"status"`
	DurationMs    int64     `json:"duration_ms"`
	Verdict       string    `json:"verdict,omitempty"`
	CooldownUntil time.Time `json:"cooldown_until"`
}

// Result is what a mode returns: its payload plus the status the run finalized
// with. The status has to travel with the payload because only the mode knows
// whether it stopped because it was done, cancelled, or out of wall-clock.
type Result struct {
	Status      string // report.StatusCompleted | StatusCancelled | StatusExpired
	Functional  *report.Functional
	Performance *report.Performance
}

// noopEmitter is used when a caller does not care about the stream.
func noopEmitter(Event) {}

// emitOr returns emit, or a no-op when it is nil, so no mode needs a nil check
// in its hot path.
func emitOr(emit Emitter) Emitter {
	if emit == nil {
		return noopEmitter
	}
	return emit
}

// configOf renders the honoured (post-clamp) knobs for a report.
func configOf(o sandbox.Options) report.Config {
	return report.Config{
		StopOnFailure: o.StopOnFailure,
		DelayMs:       o.DelayMs,
		Concurrency:   o.Concurrency,
		DurationSecs:  o.DurationSecs,
	}
}
