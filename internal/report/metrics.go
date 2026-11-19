package report

import (
	"fmt"
	"maps"
	"math"
	"math/bits"
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
// co-hosted with other services) measured p95 38.6 / 118.8 / 262.2 /
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
//
// Memory is bounded. Every count above, the Apdex bands, the SLA ladder, the
// histogram, and min, max and average latency are counted as each response is
// added, so they are exact at any volume. Only Samples, which the percentiles
// are read from, is capped (see MaxSamples).
type Tally struct {
	Requests     int // dispatches
	Samples      []Sample
	Transport    int // failures with no response
	Aborted      int // killed by Courier's own cancel/shutdown/deadline
	Bytes        int64
	StatusCounts map[int]int    // 0 = transport failure; aborted has no key
	ErrorKinds   map[string]int // timeout | connection | non_2xx

	// SampleCap bounds Samples; 0 means MaxSamples.
	SampleCap int

	responses, ok                     int
	sumMs, minMs, maxMs               float64
	satisfied, tolerating, frustrated int    // responses only; transport adds at compute time
	under                             [3]int // SLATier1Ms, SLATier2Ms, SLATier3Ms
	hist                              [6]int // the buckets below
	rng                               uint64 // the sampler's state; zero is a valid seed
}

// MaxSamples is how many latencies a run's overall Tally keeps for its
// percentiles; a per-entry Tally keeps an equal share of it. At 16 bytes a
// sample that is about 4 MB for the overall scope and as much again across
// the entries, whatever the run's volume: a microsecond target used to grow a
// run's samples without bound (4.1M requests took the process from 15 MB to
// 290 MB). The cap is far above any run against the real target, which
// measured about 18,000 responses at its knee, so those runs keep every
// sample. Past it, Samples is a uniform random sample of every latency
// recorded (Algorithm R), and a percentile read from it is still a latency a
// request really had. Its rank error is about sqrt(p(1-p)/k): 0.02 percentile
// points at p99 for k = 262,144.
const MaxSamples = 1 << 18

// AddResponse records a completed response, 2xx or not.
func (t *Tally) AddResponse(status int, ms float64, size int) {
	ok := status >= 200 && status < 300
	t.Requests++
	t.Bytes += int64(size)
	t.countStatus(status)
	if !ok {
		t.countKind(KindNon2xx)
	}

	t.responses++
	t.sumMs += ms
	if t.responses == 1 || ms < t.minMs {
		t.minMs = ms
	}
	if t.responses == 1 || ms > t.maxMs {
		t.maxMs = ms
	}
	switch {
	case !ok:
		t.frustrated++ // every non-2xx is frustrated, however fast it was
	case ms <= ApdexTMs:
		t.ok++
		t.satisfied++
	case ms <= 4*ApdexTMs:
		t.ok++
		t.tolerating++
	default:
		t.ok++
		t.frustrated++
	}
	if ms <= SLATier3Ms {
		t.under[2]++
		if ms <= SLATier2Ms {
			t.under[1]++
			if ms <= SLATier1Ms {
				t.under[0]++
			}
		}
	}
	t.hist[bucketOf(ms)]++
	t.keep(Sample{Ms: ms, OK: ok})
}

// keep is reservoir sampling (Algorithm R): every sample is kept until the
// cap, and the n-th after that replaces a random kept one with probability
// cap/n, which leaves Samples a uniform sample of everything recorded. The
// generator is splitmix64 held in the Tally: deterministic, so a test can
// reproduce a run's sample, and allocation-free on the per-dispatch path.
func (t *Tally) keep(s Sample) {
	limit := t.SampleCap
	if limit <= 0 {
		limit = MaxSamples
	}
	if len(t.Samples) < limit {
		t.Samples = append(t.Samples, s)
		return
	}
	t.rng += 0x9e3779b97f4a7c15
	z := t.rng
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	z ^= z >> 31
	if j, _ := bits.Mul64(z, uint64(t.responses)); j < uint64(limit) {
		t.Samples[j] = s
	}
}

// bucketOf is the histogram bucket a latency falls in; see buckets.
func bucketOf(ms float64) int {
	for i := range len(buckets) - 1 {
		if ms < buckets[i].To {
			return i
		}
	}
	return len(buckets) - 1
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
	for _, sample := range t.Samples {
		latencies = append(latencies, sample.Ms)
	}
	slices.Sort(latencies)
	s.PercentileSamples = len(latencies)
	s.OK = t.ok

	// Aborts are not errors: Courier killed those dispatches, the target did
	// not fail them.
	s.Errors = (t.responses - t.ok) + t.Transport

	if denom := t.Requests - t.Aborted; denom > 0 {
		s.SuccessRatio = 100 * float64(s.OK) / float64(denom)
	}
	if secs := wall.Seconds(); secs > 0 {
		s.RequestsPerSec = float64(t.Requests) / secs
	}

	if t.responses > 0 {
		s.Latency = Percentiles{
			Min: t.minMs,
			Avg: t.sumMs / float64(t.responses),
			P50: Percentile(latencies, 50),
			P90: Percentile(latencies, 90),
			P95: Percentile(latencies, 95),
			P99: Percentile(latencies, 99),
			Max: t.maxMs,
		}
		n := float64(t.responses)
		s.SLA = SLALadder{
			Under50:  100 * float64(t.under[0]) / n,
			Under150: 100 * float64(t.under[1]) / n,
			Under300: 100 * float64(t.under[2]) / n,
		}
	}
	s.Apdex = apdexOf(t.satisfied, t.tolerating, t.frustrated+t.Transport)
	s.Histogram = slices.Clone(buckets)
	for i := range s.Histogram {
		s.Histogram[i].Count = t.hist[i]
	}
	return s
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

// FunctionalVerdict judges a functional run. A request counts as asserted when
// it was dispatched (not skipped) and carries at least one assertion outcome;
// a request with no assertion that got its answer checks nothing.
//
//	status               results                                          verdict
//	cancelled, expired   anything                                         N/A
//	completed            any dispatched request not passed: an assertion  FAIL
//	                     failed, or no response or a response cut off
//	                     (with or without assertions)
//	completed            none failed, at least one asserted               PASS
//	completed            none failed, none asserted (every request        N/A
//	                     answered with no assertion, or every entry
//	                     skipped, or no entries)
//
// Skipped rows count for nothing: their assertions were never evaluated.
// A run that only checked that its requests were answered is N/A rather than
// PASS: it asserted nothing, and a PASS would claim it had.
//
// It is the one implementation of the rule. The PDF band, the history row,
// the stored report and run_finished all read it, so no two of them can
// disagree about the same run.
func FunctionalVerdict(status string, f *Functional) string {
	if status == StatusCancelled || status == StatusExpired || f == nil {
		return VerdictNA
	}
	asserted := false
	for _, r := range f.Results {
		switch {
		case r.Skipped:
		case !r.Passed:
			return VerdictFail
		case len(r.Assertions) > 0:
			asserted = true
		}
	}
	if asserted {
		return VerdictPass
	}
	return VerdictNA
}
