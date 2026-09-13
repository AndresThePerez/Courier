package report

import (
	"fmt"
	"maps"
	"math"
	"slices"
	"time"
)

// SLO constants — calibrated 2026-08-22 against the DEPLOY host (spec
// Deployment step 5), superseding the workstation dev values.
//
// This block is the only place they are defined. The values matter: a verdict
// that can never fail — or never pass — is decoration, not a load test. The
// dev-calibrated gate (p95 ≤ 50ms, tiers 25/50/100, T=25) was measured on a
// Ryzen 5800X where the internal-network series read p95 20→128ms across
// 1→50 workers; the deploy host (4-core Ryzen 3 2200G, ES capped at 1g,
// co-hosted with the portfolio site) measured p95 38.6 / 118.8 / 262.2 /
// 407.9ms at 1/10/25/50 workers. These constants reproduce the same
// falsifiable shape there: PASS at 1 and 10 workers, FAIL at 25 and 50.
const (
	VerdictP95Ms        = 150.0 // PASS iff p95 <= this AND error rate < VerdictMaxErrorRate
	VerdictMaxErrorRate = 0.01

	SLATier1Ms = 50.0
	SLATier2Ms = 150.0
	SLATier3Ms = 300.0

	ApdexTMs = 50.0 // tolerating <= 4T = 200ms
)

// What the constants above were measured against. They live here rather than
// only in the comment so a stored report can carry them: the provenance of a
// judgement is part of the judgement, and a report that cannot say which gate
// applied is a report a future recalibrated build would produce identically.
const (
	CalibrationDate     = "2026-08-22"
	CalibrationSequence = "search-basics"
)

// CalibrationEntries is that sequence by the names the curated collection
// gives its requests, which is what a stored report records. The sequence
// check reads this; nothing else should hard-code the list.
var CalibrationEntries = []string{
	"01 - Basic Text Search",
	"02 - Exact Card By ID",
	"03 - Browse (No Query)",
	"04 - Fuzzy Match On A Typo",
	"05 - Facets Scope To The Query",
}

// DemoSLO is the gate this build judges with, as data rather than as six
// package constants a caller has to know about. The name matches the one the
// standalone-app plan reserves for the same value, so that work inherits this
// shape rather than inventing a second one.
func DemoSLO() SLO {
	return SLO{
		P95Ms:               VerdictP95Ms,
		MaxErrorRate:        VerdictMaxErrorRate,
		LadderMs:            []float64{SLATier1Ms, SLATier2Ms, SLATier3Ms},
		ApdexTMs:            ApdexTMs,
		CalibrationSequence: CalibrationSequence,
		CalibrationDate:     CalibrationDate,
	}
}

// Sample is one completed HTTP response. Transport failures produce none.
type Sample struct {
	Ms float64
	OK bool // 2xx
}

// Tally is what the aggregator fills, one per scope (overall + per entry).
//
// The accounting rules below are spec-level and are the reason this type has
// three distinct Add methods rather than one:
//
//	outcome              Requests  sample  OK  Error  Apdex band  StatusCounts
//	2xx response         +1        yes     +1  -      by latency  the status
//	non-2xx response     +1        yes     -   +1     frustrated  the status
//	transport failure    +1        no      -   +1     frustrated  0
//	aborted by Courier   +1        no      -   no     none        none
//
// Requests counts dispatches and is never derived from sample counts. A non-2xx
// contributes exactly one of everything, never two.
//
// The aborted row is the one that keeps being rediscovered the hard way. Cancel,
// SIGTERM, and the functional deadline all abandon in-flight requests, and their
// http.Client calls return context.Canceled — indistinguishable from a transport
// failure unless it is classified deliberately. Left unhandled, cancelling a
// 50-worker run lands up to 50 phantom connection errors, pushes the error rate
// past the 1% gate, and stores a report that blames the target for the visitor
// pressing Cancel. Detection is errors.Is(err, context.Canceled) *with the run's
// own abort as the cause*; a target-side reset is still a transport failure.
type Tally struct {
	Requests     int // dispatches
	Samples      []Sample
	Transport    int // failures with no response
	Aborted      int // killed by Courier's own cancel/shutdown/deadline
	Bytes        int64
	StatusCounts map[int]int    // 0 = transport failure; aborted has no key
	ErrorKinds   map[string]int // timeout | connection | non_2xx
}

// AddResponse records a completed response, 2xx or not.
func (t *Tally) AddResponse(status int, ms float64, size int) {
	ok := status >= 200 && status < 300
	t.Requests++
	t.Samples = append(t.Samples, Sample{Ms: ms, OK: ok})
	t.Bytes += int64(size)
	t.countStatus(status)
	if !ok {
		t.countKind(KindNon2xx)
	}
}

// AddTransportFailure records a dispatch that never produced a response.
// kind is timeout or connection.
func (t *Tally) AddTransportFailure(kind string) {
	t.Requests++
	t.Transport++
	t.countStatus(0)
	t.countKind(kind)
}

// AddAborted records a dispatch Courier itself killed. It is a dispatch and
// nothing else: no sample, no error, no Apdex band, and out of the success
// denominator.
func (t *Tally) AddAborted() {
	t.Requests++
	t.Aborted++
}

// countStatus and countKind lazily create their maps so a zero Tally is usable
// without a constructor — the aggregator makes one per entry.
func (t *Tally) countStatus(status int) {
	if t.StatusCounts == nil {
		t.StatusCounts = map[int]int{}
	}
	t.StatusCounts[status]++
}

func (t *Tally) countKind(kind string) {
	if t.ErrorKinds == nil {
		t.ErrorKinds = map[string]int{}
	}
	t.ErrorKinds[kind]++
}

// ComputeStats turns a Tally into the numbers a report shows. It is called both
// by the progress ticker mid-run and once at the end, so it never mutates the
// Tally: the latencies are extracted into a fresh slice and that copy is sorted.
//
// index is -1 for the overall scope. wall is the elapsed time the throughput is
// measured against.
func ComputeStats(index int, name string, t Tally, wall time.Duration) Stats {
	s := Stats{
		Index:        index,
		Name:         name,
		Requests:     t.Requests,
		Aborted:      t.Aborted,
		Bytes:        t.Bytes,
		StatusCounts: maps.Clone(t.StatusCounts),
		ErrorKinds:   maps.Clone(t.ErrorKinds),
	}
	if s.StatusCounts == nil {
		s.StatusCounts = map[int]int{}
	}
	if s.ErrorKinds == nil {
		s.ErrorKinds = map[string]int{}
	}

	latencies := make([]float64, 0, len(t.Samples))
	var sum float64
	satisfied, tolerating, frustrated := 0, 0, 0
	for _, sample := range t.Samples {
		latencies = append(latencies, sample.Ms)
		sum += sample.Ms
		switch {
		case !sample.OK:
			frustrated++ // every non-2xx is frustrated, however fast it was
		case sample.Ms <= ApdexTMs:
			satisfied++
		case sample.Ms <= 4*ApdexTMs:
			tolerating++
		default:
			frustrated++
		}
		if sample.OK {
			s.OK++
		}
	}
	frustrated += t.Transport
	slices.Sort(latencies)

	// Aborts are not errors: Courier killed those dispatches, the target did
	// not fail them.
	s.Errors = (len(t.Samples) - s.OK) + t.Transport

	if denom := t.Requests - t.Aborted; denom > 0 {
		s.SuccessRatio = 100 * float64(s.OK) / float64(denom)
	}
	if secs := wall.Seconds(); secs > 0 {
		s.RequestsPerSec = float64(t.Requests) / secs
	}

	s.Latency = percentilesOf(latencies, sum)
	s.SLA = ladderOf(latencies)
	s.Apdex = apdexOf(satisfied, tolerating, frustrated)
	s.Histogram = Histogram(latencies)
	return s
}

func percentilesOf(sorted []float64, sum float64) Percentiles {
	if len(sorted) == 0 {
		return Percentiles{}
	}
	return Percentiles{
		Min: sorted[0],
		Avg: sum / float64(len(sorted)),
		P50: Percentile(sorted, 50),
		P90: Percentile(sorted, 90),
		P95: Percentile(sorted, 95),
		P99: Percentile(sorted, 99),
		Max: sorted[len(sorted)-1],
	}
}

// Percentile is nearest-rank: the smallest value at or below which at least p
// percent of the samples fall. No interpolation — an interpolated p99 is a
// number that no request actually experienced.
func Percentile(sorted []float64, p float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	// Multiply before dividing: p/100*n rounds badly at exactly 95, and a p95
	// that silently reads the p96 sample is the kind of bug nobody finds.
	rank := int(math.Ceil(p * float64(n) / 100))
	return sorted[min(max(rank-1, 0), n-1)]
}

func ladderOf(sorted []float64) SLALadder {
	n := len(sorted)
	if n == 0 {
		return SLALadder{}
	}
	share := func(tier float64) float64 {
		count := 0
		for _, ms := range sorted {
			if ms <= tier {
				count++
			}
		}
		return 100 * float64(count) / float64(n)
	}
	return SLALadder{Under50: share(SLATier1Ms), Under150: share(SLATier2Ms), Under300: share(SLATier3Ms)}
}

func apdexOf(satisfied, tolerating, frustrated int) ApdexScore {
	a := ApdexScore{Satisfied: satisfied, Tolerating: tolerating, Frustrated: frustrated}
	if n := satisfied + tolerating + frustrated; n > 0 {
		a.Score = (float64(satisfied) + float64(tolerating)/2) / float64(n)
	}
	a.Rating = ApdexRating(a.Score)
	return a
}

// ApdexRating names a score using the standard bands.
func ApdexRating(score float64) string {
	switch {
	case score >= 0.94:
		return "Excellent"
	case score >= 0.85:
		return "Good"
	case score >= 0.70:
		return "Fair"
	case score >= 0.50:
		return "Poor"
	default:
		return "Unacceptable"
	}
}

// buckets are the histogram bounds, sized to the deploy host's measured
// 29-517ms range (see the SLO block above). Half-open [From, To); To == 0 is
// unbounded.
var buckets = []Bucket{
	{Label: "0-25ms", From: 0, To: 25},
	{Label: "25-50ms", From: 25, To: 50},
	{Label: "50-100ms", From: 50, To: 100},
	{Label: "100-200ms", From: 100, To: 200},
	{Label: "200-400ms", From: 200, To: 400},
	{Label: "400ms+", From: 400, To: 0},
}

// Histogram buckets a latency distribution. It always returns all six buckets,
// empty ones included, so a chart keeps a stable shape as a run progresses.
func Histogram(sorted []float64) []Bucket {
	out := slices.Clone(buckets)
	for _, ms := range sorted {
		for i := range out {
			if out[i].To == 0 || ms < out[i].To {
				out[i].Count++
				break
			}
		}
	}
	return out
}

// IsCalibrated reports whether a run dispatched the sequence the SLO constants
// were measured against. Order does not matter and a subset is not enough: the
// gate was derived from the whole five-request mix, and a subset of it measures
// a different workload, which is exactly how a PASS and a FAIL came to sit
// side by side on one host at one concurrency.
func IsCalibrated(entries []Entry) bool {
	if len(entries) != len(CalibrationEntries) {
		return false
	}
	want := make(map[string]int, len(CalibrationEntries))
	for _, n := range CalibrationEntries {
		want[n]++
	}
	for _, e := range entries {
		want[e.Name]--
		if want[e.Name] < 0 {
			return false
		}
	}
	return true
}

// Verdict judges the calibrated workload and withholds otherwise: PASS when p95
// is within budget AND the error rate is under the gate, FAIL when it is not,
// and VerdictNA when the run dispatched a sequence the gate was never measured
// against.
//
// It deliberately knows nothing about run status. A cancelled or expired run's
// report is overridden to VerdictNA by the assembler, because a run stopped two
// seconds into thirty has not measured what these SLOs describe — the
// percentiles, histogram, and throughput still render, only the judgement is
// withheld.
//
// The constants describe one specific sequence, so a run that dispatched a
// different one is not judged at all: the caller passes the sequence fact in
// and an uncalibrated run renders VerdictNA with a reason naming the workload
// the gate was measured against.
func Verdict(s Stats, calibrated bool) (string, []string) {
	var reasons []string

	judged := s.Requests - s.Aborted
	if judged <= 0 {
		return VerdictFail, []string{"no dispatches completed — there is nothing to judge"}
	}

	if !calibrated {
		// The honest answer to a question nobody calibrated. The percentiles,
		// the ladder, the histogram and the throughput all still render and are
		// all still true: only the pass-or-fail judgement is withheld, the same
		// way a cancelled run's is, because the gate was derived from one
		// specific five-request mix and this run dispatched something else.
		return VerdictNA, []string{
			fmt.Sprintf("no verdict: the gate was calibrated on %s against the %s sequence, and this run dispatched a different one",
				CalibrationDate, CalibrationSequence),
		}
	}

	if s.Latency.P95 > VerdictP95Ms {
		reasons = append(reasons, fmt.Sprintf("p95 %.1fms exceeds the %.0fms budget", s.Latency.P95, VerdictP95Ms))
	}
	errorRate := float64(s.Errors) / float64(judged)
	if errorRate >= VerdictMaxErrorRate {
		reasons = append(reasons, fmt.Sprintf("error rate %.2f%% is at or above the %.2f%% gate",
			100*errorRate, 100*VerdictMaxErrorRate))
	}
	if len(reasons) > 0 {
		return VerdictFail, reasons
	}
	return VerdictPass, []string{
		fmt.Sprintf("p95 %.1fms within the %.0fms budget", s.Latency.P95, VerdictP95Ms),
		fmt.Sprintf("error rate %.2f%% below the %.2f%% gate", 100*errorRate, 100*VerdictMaxErrorRate),
	}
}
