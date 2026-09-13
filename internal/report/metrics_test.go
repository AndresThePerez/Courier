package report

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func newTally() Tally {
	return Tally{StatusCounts: map[int]int{}, ErrorKinds: map[string]int{}}
}

func okTally(latencies ...float64) Tally {
	t := newTally()
	for _, ms := range latencies {
		t.AddResponse(200, ms, 100)
	}
	return t
}

func TestPercentileNearestRank(t *testing.T) {
	s := make([]float64, 100)
	for i := range s {
		s[i] = float64(i + 1) // 1..100, sorted
	}
	for _, tc := range []struct{ p, want float64 }{{50, 50}, {90, 90}, {95, 95}, {99, 99}, {100, 100}, {0, 1}} {
		if got := Percentile(s, tc.p); got != tc.want {
			t.Errorf("Percentile(%v) = %v, want %v", tc.p, got, tc.want)
		}
	}
	if got := Percentile(nil, 95); got != 0 {
		t.Errorf("Percentile(empty) = %v, want 0", got)
	}
	if got := Percentile([]float64{7}, 99); got != 7 {
		t.Errorf("Percentile(single) = %v, want 7", got)
	}
}

// Buckets are the deploy-calibrated values, sized to the server's measured
// 29-517ms range.
func TestHistogramBucketsAndBoundaries(t *testing.T) {
	s := []float64{1, 24.9, 25, 49, 50, 99, 100, 199, 200, 399, 400, 1200}
	buckets := Histogram(s)
	if len(buckets) != 6 {
		t.Fatalf("len(buckets) = %d, want 6", len(buckets))
	}
	want := []struct {
		label string
		count int
	}{{"0-25ms", 2}, {"25-50ms", 2}, {"50-100ms", 2}, {"100-200ms", 2}, {"200-400ms", 2}, {"400ms+", 2}}
	total := 0
	for i, b := range buckets {
		if b.Label != want[i].label || b.Count != want[i].count {
			t.Errorf("bucket %d = %q/%d, want %q/%d", i, b.Label, b.Count, want[i].label, want[i].count)
		}
		total += b.Count
	}
	if total != len(s) {
		t.Errorf("bucket counts sum to %d, want %d", total, len(s))
	}
	if len(Histogram(nil)) != 6 {
		t.Error("histogram must always have six buckets, even when empty")
	}
}

func TestSLALadderIsMonotonicAtNewTiers(t *testing.T) {
	tal := newTally()
	for i := 0; i < 1000; i++ {
		tal.AddResponse(200, float64(i%400)+0.5, 10)
	}
	st := ComputeStats(-1, "overall", tal, time.Second)
	if !(st.SLA.Under50 <= st.SLA.Under150 && st.SLA.Under150 <= st.SLA.Under300) {
		t.Errorf("ladder not monotonic: %+v", st.SLA)
	}
	if st.SLA.Under300 > 100 || st.SLA.Under50 < 0 {
		t.Errorf("ladder out of range: %+v", st.SLA)
	}
	// The tiers must actually discriminate on this distribution — tiers set
	// far above the observed range would read 100/100/100 here.
	if st.SLA.Under50 == st.SLA.Under300 {
		t.Errorf("tiers do not discriminate: %+v", st.SLA)
	}
}

func TestApdexAtT50(t *testing.T) {
	// 100 satisfied (<=50ms), 100 tolerating (<=200ms), 0 frustrated -> 0.75
	tal := newTally()
	for i := 0; i < 100; i++ {
		tal.AddResponse(200, 30, 10)
	}
	for i := 0; i < 100; i++ {
		tal.AddResponse(200, 160, 10)
	}
	a := ComputeStats(-1, "overall", tal, time.Second).Apdex
	if math.Abs(a.Score-0.75) > 1e-9 {
		t.Errorf("score = %v, want 0.75", a.Score)
	}
	if a.Satisfied != 100 || a.Tolerating != 100 || a.Frustrated != 0 {
		t.Errorf("bands = %+v", a)
	}
	if a.Rating != "Fair" {
		t.Errorf("rating = %q, want Fair", a.Rating)
	}
	// Exact thresholds: T is satisfied, 4T is tolerating.
	edge := ComputeStats(-1, "e", okTally(50, 200), time.Second).Apdex
	if edge.Satisfied != 1 || edge.Tolerating != 1 {
		t.Errorf("threshold handling = %+v", edge)
	}
	if empty := ComputeStats(-1, "e", newTally(), time.Second).Apdex; empty.Score != 0 || empty.Rating != "Unacceptable" {
		t.Errorf("empty Apdex = %+v", empty)
	}
}

// The Revision 2 accounting rule, and the reason this task was rewritten.
func TestNonOKResponseIsCountedExactlyOnce(t *testing.T) {
	tal := newTally()
	for i := 0; i < 90; i++ {
		tal.AddResponse(200, 10, 100)
	}
	for i := 0; i < 10; i++ {
		tal.AddResponse(503, 4, 50) // fast failures, as real 503s are
	}
	st := ComputeStats(-1, "overall", tal, time.Second)

	if st.Requests != 100 {
		t.Errorf("Requests = %d, want 100 (one per dispatch, never samples+errors)", st.Requests)
	}
	if st.OK != 90 || st.Errors != 10 {
		t.Errorf("OK/Errors = %d/%d, want 90/10", st.OK, st.Errors)
	}
	if math.Abs(st.SuccessRatio-90) > 1e-9 {
		t.Errorf("SuccessRatio = %v, want 90", st.SuccessRatio)
	}
	// The 503 latencies ARE in the distribution...
	histTotal := 0
	for _, b := range st.Histogram {
		histTotal += b.Count
	}
	if histTotal != 100 {
		t.Errorf("histogram covers %d responses, want all 100 completed responses", histTotal)
	}
	// ...but they are frustrated for Apdex regardless of being fast.
	if st.Apdex.Frustrated != 10 {
		t.Errorf("Apdex.Frustrated = %d, want 10 (every non-2xx is frustrated)", st.Apdex.Frustrated)
	}
	if st.Apdex.Satisfied != 90 {
		t.Errorf("Apdex.Satisfied = %d, want 90", st.Apdex.Satisfied)
	}
	if st.StatusCounts[503] != 10 || st.ErrorKinds["non_2xx"] != 10 {
		t.Errorf("status/kind bookkeeping = %v / %v", st.StatusCounts, st.ErrorKinds)
	}
	if st.RequestsPerSec != 100 {
		t.Errorf("rps = %v, want 100", st.RequestsPerSec)
	}
}

func TestTransportFailureHasNoSample(t *testing.T) {
	tal := newTally()
	for i := 0; i < 40; i++ {
		tal.AddResponse(200, 10, 100)
	}
	for i := 0; i < 10; i++ {
		tal.AddTransportFailure("connection")
	}
	st := ComputeStats(-1, "overall", tal, 2*time.Second)

	if st.Requests != 50 || st.OK != 40 || st.Errors != 10 {
		t.Errorf("counts = %d/%d/%d, want 50/40/10", st.Requests, st.OK, st.Errors)
	}
	histTotal := 0
	for _, b := range st.Histogram {
		histTotal += b.Count
	}
	if histTotal != 40 {
		t.Errorf("histogram covers %d, want 40 (transport failures have no latency)", histTotal)
	}
	if st.Apdex.Frustrated != 10 {
		t.Errorf("Apdex.Frustrated = %d, want 10", st.Apdex.Frustrated)
	}
	if st.StatusCounts[0] != 10 || st.ErrorKinds["connection"] != 10 {
		t.Errorf("transport failures must land under status 0: %v / %v", st.StatusCounts, st.ErrorKinds)
	}
	if st.RequestsPerSec != 25 {
		t.Errorf("rps = %v, want 25 (errors count as dispatched)", st.RequestsPerSec)
	}
}

// The Revision 2.1 rule: cancelling a run must not manufacture target errors.
func TestAbortedDispatchesAreNotErrors(t *testing.T) {
	tal := newTally()
	for i := 0; i < 950; i++ {
		tal.AddResponse(200, 10, 100)
	}
	for i := 0; i < 50; i++ {
		tal.AddAborted() // the in-flight requests when the visitor pressed Cancel
	}
	st := ComputeStats(-1, "overall", tal, time.Second)

	if st.Requests != 1000 || st.Aborted != 50 {
		t.Fatalf("Requests/Aborted = %d/%d, want 1000/50", st.Requests, st.Aborted)
	}
	if st.Errors != 0 {
		t.Errorf("Errors = %d, want 0 — an abort is Courier's doing, not the target's", st.Errors)
	}
	if st.SuccessRatio != 100 {
		t.Errorf("SuccessRatio = %v, want 100 (aborted dispatches leave the denominator)", st.SuccessRatio)
	}
	if st.Apdex.Frustrated != 0 {
		t.Errorf("Apdex.Frustrated = %d, want 0", st.Apdex.Frustrated)
	}
	if st.StatusCounts[0] != 0 || st.ErrorKinds["connection"] != 0 {
		t.Errorf("aborts must not appear as transport failures: %v / %v", st.StatusCounts, st.ErrorKinds)
	}
	histTotal := 0
	for _, b := range st.Histogram {
		histTotal += b.Count
	}
	if histTotal != 950 {
		t.Errorf("histogram covers %d, want 950 (aborts have no latency)", histTotal)
	}
	// The regression this rule exists for: without it the run above reads as
	// a 5% error rate and the verdict FAILs because someone pressed Cancel.
	if v, _ := Verdict(st, true); v != "PASS" {
		t.Errorf("verdict = %q, want PASS — the cancel itself must not fail the run", v)
	}
}

func TestVerdictAtRecalibratedSLOs(t *testing.T) {
	// Measured on the deploy host: 10 workers -> p95 118.8ms (PASS);
	// 25 workers -> p95 262.2ms (FAIL).
	fast := ComputeStats(-1, "overall", okTally(repeat(118.8, 1000)...), time.Second)
	if v, _ := Verdict(fast, true); v != "PASS" {
		t.Errorf("p95 118.8ms verdict = %q, want PASS", v)
	}
	slow := ComputeStats(-1, "overall", okTally(repeat(262.2, 1000)...), time.Second)
	v, reasons := Verdict(slow, true)
	if v != "FAIL" || len(reasons) == 0 {
		t.Errorf("p95 262.2ms verdict = %q reasons %v, want FAIL with a reason", v, reasons)
	}
	// Error rate alone can fail it.
	tal := newTally()
	for i := 0; i < 95; i++ {
		tal.AddResponse(200, 5, 10)
	}
	for i := 0; i < 5; i++ {
		tal.AddResponse(503, 2, 10)
	}
	if v, _ := Verdict(ComputeStats(-1, "overall", tal, time.Second), true); v != "FAIL" {
		t.Errorf("5%% errors must FAIL, got %q", v)
	}
}

func repeat(v float64, n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = v
	}
	return out
}

func TestComputeStatsEdgeCases(t *testing.T) {
	zero := ComputeStats(-1, "overall", newTally(), time.Second)
	if zero.Requests != 0 || zero.SuccessRatio != 0 || zero.RequestsPerSec != 0 {
		t.Errorf("zero-request stats = %+v", zero)
	}
	one := ComputeStats(-1, "overall", okTally(42), time.Second)
	if one.Latency.Min != 42 || one.Latency.Max != 42 || one.Latency.P99 != 42 || one.Latency.Avg != 42 {
		t.Errorf("single-sample stats = %+v", one.Latency)
	}
	if one.SuccessRatio != 100 {
		t.Errorf("success ratio = %v, want 100", one.SuccessRatio)
	}
	unsorted := ComputeStats(-1, "overall", okTally(300, 10, 200, 20), time.Second)
	if unsorted.Latency.Min != 10 || unsorted.Latency.Max != 300 {
		t.Errorf("unsorted input mishandled: %+v", unsorted.Latency)
	}
}

// ComputeStats is called on a live Tally by the progress ticker as well as at
// the end of a run, so it must leave the Tally exactly as it found it.
func TestComputeStatsDoesNotMutateTheTally(t *testing.T) {
	tal := okTally(300, 10, 200, 20)
	tal.AddTransportFailure("timeout")
	before := append([]Sample(nil), tal.Samples...)

	ComputeStats(-1, "overall", tal, time.Second)

	for i, s := range tal.Samples {
		if s != before[i] {
			t.Fatalf("ComputeStats reordered the tally's samples: %v", tal.Samples)
		}
	}
	st := ComputeStats(-1, "overall", tal, time.Second)
	st.StatusCounts[999] = 1
	st.ErrorKinds["injected"] = 1
	if tal.StatusCounts[999] != 0 || tal.ErrorKinds["injected"] != 0 {
		t.Error("Stats shares its maps with the Tally")
	}
}

// The denominators are the whole point of the accounting rules, so pin them on
// a tally that exercises all four rows at once.
func TestMixedTallyDenominators(t *testing.T) {
	tal := newTally()
	for i := 0; i < 80; i++ {
		tal.AddResponse(200, 10, 100)
	}
	for i := 0; i < 10; i++ {
		tal.AddResponse(503, 4, 50)
	}
	for i := 0; i < 5; i++ {
		tal.AddTransportFailure("timeout")
	}
	for i := 0; i < 5; i++ {
		tal.AddAborted()
	}
	st := ComputeStats(-1, "overall", tal, time.Second)

	if st.Requests != 100 || st.Aborted != 5 {
		t.Fatalf("Requests/Aborted = %d/%d, want 100/5", st.Requests, st.Aborted)
	}
	if st.OK != 80 || st.Errors != 15 {
		t.Errorf("OK/Errors = %d/%d, want 80/15", st.OK, st.Errors)
	}
	// success_ratio = 2xx / (requests - aborted) = 80/95
	if want := 100 * 80.0 / 95.0; math.Abs(st.SuccessRatio-want) > 1e-9 {
		t.Errorf("SuccessRatio = %v, want %v", st.SuccessRatio, want)
	}
	// Apdex bands must account for every non-aborted dispatch, exactly once.
	if n := st.Apdex.Satisfied + st.Apdex.Tolerating + st.Apdex.Frustrated; n != 95 {
		t.Errorf("Apdex bands cover %d dispatches, want 95 (requests - aborted)", n)
	}
	if st.Apdex.Frustrated != 15 {
		t.Errorf("Apdex.Frustrated = %d, want 15 (10 non-2xx + 5 transport)", st.Apdex.Frustrated)
	}
	if st.ErrorKinds["non_2xx"] != 10 || st.ErrorKinds["timeout"] != 5 {
		t.Errorf("error kinds = %v", st.ErrorKinds)
	}
}

func TestApdexRatings(t *testing.T) {
	for _, tc := range []struct {
		score  float64
		rating string
	}{
		{0.94, "Excellent"}, {1.0, "Excellent"},
		{0.85, "Good"}, {0.93, "Good"},
		{0.70, "Fair"}, {0.84, "Fair"},
		{0.50, "Poor"}, {0.69, "Poor"},
		{0.49, "Unacceptable"}, {0, "Unacceptable"},
	} {
		if got := ApdexRating(tc.score); got != tc.rating {
			t.Errorf("ApdexRating(%v) = %q, want %q", tc.score, got, tc.rating)
		}
	}
}

// A judgement with no data behind it is the "permanently green verdict" the
// SLO recalibration exists to prevent.
func TestVerdictWithNoDispatches(t *testing.T) {
	v, reasons := Verdict(ComputeStats(-1, "overall", newTally(), time.Second), true)
	if v != "FAIL" || len(reasons) == 0 {
		t.Errorf("verdict on an empty run = %q %v, want FAIL with a reason", v, reasons)
	}
}

// The invariant README.md and docs/design.md both claim is tested: every
// dispatch lands in exactly one of ok, error or aborted, so the three always
// sum to the dispatch count. It was asserted only inside the build-tagged
// acceptance matrix, which `go test ./...` skips, while this suite pinned the
// components and never the sum.
func TestDispatchAccountingInvariant(t *testing.T) {
	cases := []struct {
		name                              string
		ok2xx, non2xx, transport, aborted int
	}{
		{"all clean", 100, 0, 0, 0},
		{"non-2xx only", 0, 40, 0, 0},
		{"transport only", 0, 0, 25, 0},
		{"aborted only", 0, 0, 0, 12},
		{"all four at once", 80, 10, 5, 5},
		{"nothing dispatched", 0, 0, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tal := newTally()
			for i := 0; i < c.ok2xx; i++ {
				tal.AddResponse(200, 10, 100)
			}
			for i := 0; i < c.non2xx; i++ {
				tal.AddResponse(503, 4, 50)
			}
			for i := 0; i < c.transport; i++ {
				tal.AddTransportFailure("timeout")
			}
			for i := 0; i < c.aborted; i++ {
				tal.AddAborted()
			}
			st := ComputeStats(-1, "overall", tal, time.Second)

			want := c.ok2xx + c.non2xx + c.transport + c.aborted
			if st.Requests != want {
				t.Fatalf("Requests = %d, want %d", st.Requests, want)
			}
			if got := st.OK + st.Errors + st.Aborted; got != st.Requests {
				t.Errorf("ok + errors + aborted = %d (%d + %d + %d), want Requests = %d",
					got, st.OK, st.Errors, st.Aborted, st.Requests)
			}
		})
	}
}

// A stored report has to say which gate judged it, because a future
// recalibrated build would otherwise produce a byte-identical artifact.
func TestDemoSLORecordsTheConstantsAndTheirProvenance(t *testing.T) {
	s := DemoSLO()
	if s.P95Ms != VerdictP95Ms || s.MaxErrorRate != VerdictMaxErrorRate || s.ApdexTMs != ApdexTMs {
		t.Errorf("DemoSLO = %+v, want the package constants", s)
	}
	if len(s.LadderMs) != 3 || s.LadderMs[1] != SLATier2Ms {
		t.Errorf("LadderMs = %v, want the three tier constants", s.LadderMs)
	}
	if s.CalibrationSequence == "" || s.CalibrationDate == "" {
		t.Error("the gate must carry what it was calibrated against")
	}
	if len(CalibrationEntries) != 5 {
		t.Errorf("CalibrationEntries has %d names, want the five of the calibrated collection", len(CalibrationEntries))
	}
}

// The stored report is the artifact and the JSON is how it travels. The
// acceptance matrix, the PDF renderer and the polling fallback all read this
// object, so its field set is a contract: a key may be added and none may be
// renamed or dropped. The slo object is pinned the same way, because the app
// reads these six names to write the verdict note.
func TestPerformanceJSONCarriesTheGate(t *testing.T) {
	b, err := json.Marshal(Performance{SLO: DemoSLO()})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(b, &envelope); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	for _, k := range []string{"verdict", "verdict_reasons", "overall", "per_request", "overrun_ms", "slo"} {
		if _, ok := envelope[k]; !ok {
			t.Errorf("the performance object on the wire is missing %q", k)
		}
	}

	var slo map[string]json.RawMessage
	if err := json.Unmarshal(envelope["slo"], &slo); err != nil {
		t.Fatalf("Unmarshal slo: %v", err)
	}
	want := []string{"p95_ms", "max_error_rate", "ladder_ms", "apdex_t_ms", "calibration_sequence", "calibration_date"}
	for _, k := range want {
		if _, ok := slo[k]; !ok {
			t.Errorf("the slo object on the wire is missing %q", k)
		}
	}
	if len(slo) != len(want) {
		t.Errorf("the slo object has %d keys, want exactly the %d its readers name: %v", len(slo), len(want), want)
	}
}

// The gate was derived from one five-request mix, so a run of anything else
// gets no judgement rather than a judgement nobody calibrated.
func TestVerdictIsWithheldForAnUncalibratedSequence(t *testing.T) {
	fast := okTally(10, 10, 10)
	st := ComputeStats(-1, "overall", fast, time.Second)

	if v, _ := Verdict(st, true); v != VerdictPass {
		t.Fatalf("calibrated verdict = %q, want PASS on a fast run", v)
	}
	v, reasons := Verdict(st, false)
	if v != VerdictNA {
		t.Errorf("uncalibrated verdict = %q, want %q", v, VerdictNA)
	}
	if len(reasons) == 0 {
		t.Error("a withheld verdict must say why")
	}
}

func TestIsCalibratedRecognisesTheSequenceAndRejectsASubset(t *testing.T) {
	full := make([]Entry, 0, len(CalibrationEntries))
	for i, n := range CalibrationEntries {
		full = append(full, Entry{Index: i, Name: n})
	}
	if !IsCalibrated(full) {
		t.Error("the calibration sequence must be recognised")
	}
	if IsCalibrated(full[:1]) {
		t.Error("a one-entry subset is a different workload and must not be recognised")
	}
	if IsCalibrated(append(full[:4:4], Entry{Index: 4, Name: "something else"})) {
		t.Error("a substituted entry is a different workload and must not be recognised")
	}
}
