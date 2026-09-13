// Package report is Courier's run-report model and the load-test maths behind
// it. It is pure: no HTTP, no goroutines, no clock beyond the durations it is
// handed. The accounting rules it implements are spec-level, not incidental —
// see the Tally documentation.
package report

import (
	"time"

	"github.com/AndresThePerez/courier/internal/assert"
)

// Run statuses. A run's status is report metadata, not a UI flag.
const (
	StatusRunning   = "running"
	StatusCompleted = "completed"
	StatusCancelled = "cancelled"
	StatusExpired   = "expired"
)

// Verdicts. VerdictNA is what a cancelled or expired run renders, or a
// completed run of an uncalibrated sequence: the numbers are real but they do
// not describe what the SLOs measure.
const (
	VerdictPass = "PASS"
	VerdictFail = "FAIL"
	VerdictNA   = "N/A"
)

// Error kinds recorded against a dispatch.
const (
	KindTimeout    = "timeout"
	KindConnection = "connection"
	KindNon2xx     = "non_2xx"
)

// Report is one run, start to finish. It is what the API serves, what history
// stores, and what the PDF renders.
type Report struct {
	ID          string       `json:"id"`
	Mode        string       `json:"mode"`
	Status      string       `json:"status"` // running | completed | cancelled | expired
	StartedAt   time.Time    `json:"started_at"`
	FinishedAt  time.Time    `json:"finished_at,omitempty"`
	DurationMs  int64        `json:"duration_ms"`
	Target      string       `json:"target"`
	Config      Config       `json:"config"`
	Entries     []Entry      `json:"entries"`
	Functional  *Functional  `json:"functional,omitempty"`
	Performance *Performance `json:"performance,omitempty"`
	Note        string       `json:"note"`
}

// Config is the run's knobs as actually honoured, after clamping.
type Config struct {
	StopOnFailure bool `json:"stop_on_failure"`
	DelayMs       int  `json:"delay_ms"`
	Concurrency   int  `json:"concurrency"`
	DurationSecs  int  `json:"duration_secs"`
}

// Entry describes one request in the sequence, resolved to the path and query
// that actually went out. Recording it here is what makes a stored report
// readable without the original payload.
type Entry struct {
	Index    int    `json:"index"`
	Name     string `json:"name"`
	Endpoint string `json:"endpoint"`
	Path     string `json:"path"`
	Query    string `json:"query"`
}

// Functional is the result of a sequential assertion walk.
//
// The four counters carry `json:"-"` per the plan's interface: they are
// derivable from Results, and the wire format keeps a single source of truth.
// Server-side consumers (the PDF renderer) read them from the struct directly.
type Functional struct {
	Total, Passed, Failed, Skipped int             `json:"-"`
	Results                        []RequestResult `json:"results"`
}

// MaxBodyPreview bounds how much of a response body a functional result keeps.
const MaxBodyPreview = 16 << 10

// RequestResult is one request's functional outcome.
type RequestResult struct {
	Index         int              `json:"index"`
	Name          string           `json:"name"`
	Endpoint      string           `json:"endpoint"`
	Query         string           `json:"query"`
	Status        int              `json:"status"`
	LatencyMs     float64          `json:"latency_ms"`
	SizeBytes     int              `json:"size_bytes"`
	Error         string           `json:"error,omitempty"`
	ErrorKind     string           `json:"error_kind,omitempty"`
	Assertions    []assert.Outcome `json:"assertions"`
	Passed        bool             `json:"passed"`
	Skipped       bool             `json:"skipped"`
	BodyPreview   string           `json:"body_preview,omitempty"`
	BodyTruncated bool             `json:"body_truncated"`
}

// SLO is the gate a performance run was judged by, recorded on the report so
// the stored artifact is self-describing. The thresholds are this build's
// constants; the sequence and the date are what they were measured against.
type SLO struct {
	P95Ms               float64   `json:"p95_ms"`
	MaxErrorRate        float64   `json:"max_error_rate"`
	LadderMs            []float64 `json:"ladder_ms"`
	ApdexTMs            float64   `json:"apdex_t_ms"`
	CalibrationSequence string    `json:"calibration_sequence"`
	CalibrationDate     string    `json:"calibration_date"`
}

// Performance is the result of a worker-pool load run.
type Performance struct {
	Verdict        string   `json:"verdict"`
	VerdictReasons []string `json:"verdict_reasons"`
	// SLO is additive on the wire. The acceptance matrix and the PDF renderer
	// both assert against this shape and the polling fallback synthesises
	// envelopes from it, so fields may be added here and never renamed.
	SLO        SLO     `json:"slo"`
	Overall    Stats   `json:"overall"`
	PerRequest []Stats `json:"per_request"`
	OverrunMs  int64   `json:"overrun_ms"`
}

// Stats is one scope's computed numbers — the whole run, or one entry in it.
type Stats struct {
	Index          int            `json:"index"` // -1 for the overall scope
	Name           string         `json:"name"`
	Requests       int            `json:"requests"`
	OK             int            `json:"ok"`
	Errors         int            `json:"errors"`
	Aborted        int            `json:"aborted"`
	SuccessRatio   float64        `json:"success_ratio"`
	RequestsPerSec float64        `json:"requests_per_sec"`
	Bytes          int64          `json:"bytes"`
	Latency        Percentiles    `json:"latency"`
	SLA            SLALadder      `json:"sla"`
	Apdex          ApdexScore     `json:"apdex"`
	Histogram      []Bucket       `json:"histogram"`
	StatusCounts   map[int]int    `json:"status_counts"`
	ErrorKinds     map[string]int `json:"error_kinds"`
}

// Percentiles is the latency distribution over every completed response.
type Percentiles struct {
	Min float64 `json:"min"`
	Avg float64 `json:"avg"`
	P50 float64 `json:"p50"`
	P90 float64 `json:"p90"`
	P95 float64 `json:"p95"`
	P99 float64 `json:"p99"`
	Max float64 `json:"max"`
}

// SLALadder is the share of completed responses under each tier, as a
// percentage.
type SLALadder struct {
	Under50  float64 `json:"under_50"`
	Under150 float64 `json:"under_150"`
	Under300 float64 `json:"under_300"`
}

// ApdexScore is the application performance index and its bands.
type ApdexScore struct {
	Score      float64 `json:"score"`
	Rating     string  `json:"rating"`
	Satisfied  int     `json:"satisfied"`
	Tolerating int     `json:"tolerating"`
	Frustrated int     `json:"frustrated"`
}

// Bucket is one histogram bar. To == 0 means unbounded.
type Bucket struct {
	Label string  `json:"label"`
	From  float64 `json:"from"`
	To    float64 `json:"to"` // 0 = unbounded
	Count int     `json:"count"`
}
