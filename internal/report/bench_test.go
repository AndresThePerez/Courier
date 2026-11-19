package report

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"testing"
	"time"
)

// sampleCounts bracket a real run: ~2,000 responses at one worker over ten
// seconds, ~18,000 at the measured throughput knee.
var sampleCounts = []int{1_000, 18_000, 100_000}

// latencies builds a plausible right-skewed distribution rather than uniform
// noise: percentile code is only interesting where the tail is.
func latencies(n int) []float64 {
	r := rand.New(rand.NewPCG(1, 2))
	out := make([]float64, n)
	for i := range out {
		ms := 3 + r.Float64()*12 // the 3-15ms body
		if r.IntN(20) == 0 {
			ms += r.Float64() * 90 // the tail
		}
		out[i] = ms
	}
	return out
}

// sortedLatencies pre-sorts outside the timed loop: Percentile takes an
// already-sorted slice, and measuring the sort here would hide it.
func sortedLatencies(n int) []float64 {
	s := latencies(n)
	slices.Sort(s)
	return s
}

func BenchmarkPercentile(b *testing.B) {
	for _, n := range sampleCounts {
		s := sortedLatencies(n)
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				_ = Percentile(s, 95)
			}
		})
	}
}

// ComputeStats is the whole end-of-run computation: copy, sort, percentiles,
// ladder, Apdex, histogram. The aggregator also calls it for live progress, so
// its cost is paid more than once per run.
func BenchmarkComputeStats(b *testing.B) {
	for _, n := range sampleCounts {
		tal := tallyOf(n)
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				_ = ComputeStats(-1, "overall", tal, 10*time.Second)
			}
		})
	}
}

// Recording one response is on the per-dispatch path, so it has to be cheap.
func BenchmarkTallyAddResponse(b *testing.B) {
	t := Tally{StatusCounts: map[int]int{}, ErrorKinds: map[string]int{}}
	b.ReportAllocs()
	for b.Loop() {
		t.AddResponse(200, 9.5, 38_000)
	}
}

// BenchmarkTallyAddResponse spends nearly all its iterations past MaxSamples,
// where a sample replaces another. A real run never gets there (about 18,000
// responses at the knee), so this one starts a fresh Tally before the cap and
// measures the path a real run takes: appending, with the slice's growth
// amortised in. Building the fresh Tally is not timed.
func BenchmarkTallyAddResponseBelowCap(b *testing.B) {
	fresh := func() Tally { return Tally{StatusCounts: map[int]int{}, ErrorKinds: map[string]int{}} }
	t := fresh()
	b.ReportAllocs()
	for b.Loop() {
		if len(t.Samples) == MaxSamples {
			b.StopTimer()
			t = fresh()
			b.StartTimer()
		}
		t.AddResponse(200, 9.5, 38_000)
	}
	if len(t.Samples) != t.Requests {
		b.Fatalf("kept %d of %d samples; the benchmark crossed the cap", len(t.Samples), t.Requests)
	}
}

func tallyOf(n int) Tally {
	t := Tally{StatusCounts: map[int]int{}, ErrorKinds: map[string]int{}}
	for i, ms := range latencies(n) {
		switch {
		case i%1000 == 0:
			t.AddTransportFailure(KindTimeout)
		case i%500 == 0:
			t.AddResponse(503, ms, 120)
		default:
			t.AddResponse(200, ms, 38_000)
		}
	}
	return t
}

func BenchmarkVerdict(b *testing.B) {
	s := ComputeStats(-1, "overall", tallyOf(18_000), 10*time.Second)
	b.ReportAllocs()
	for b.Loop() {
		_, _ = Verdict(s, true)
	}
}
