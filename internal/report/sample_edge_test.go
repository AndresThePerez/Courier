package report

import (
	"math"
	"testing"
	"time"
)

func exactPercentile(n int, p float64) float64 {
	// Latencies are 1..n, so the nearest-rank value is the rank itself.
	return math.Ceil(p / 100 * float64(n))
}

// A reservoir that favoured early or late arrivals would shift the percentiles
// of an input that arrives sorted, reversed, or in a slow block at the end.
// Each order of the same 1..n latencies must give the same percentiles to
// within half a percentile point.
func TestPercentilesDoNotDependOnArrivalOrder(t *testing.T) {
	const n = 1_000_000
	orders := map[string]func(i int) float64{
		"ascending":  func(i int) float64 { return float64(i + 1) },
		"descending": func(i int) float64 { return float64(n - i) },
		// Every fast request first, then the slow tail: the pattern of a
		// target that degrades over a run.
		"fast then slow": func(i int) float64 {
			if i < n/2 {
				return float64(2*i + 1)
			}
			return float64(2 * (i - n/2 + 1))
		},
	}
	for name, at := range orders {
		var tal Tally
		for i := range n {
			tal.AddResponse(200, at(i), 10)
		}
		if len(tal.Samples) != MaxSamples {
			t.Fatalf("%s: kept %d samples, want %d", name, len(tal.Samples), MaxSamples)
		}
		s := ComputeStats(-1, "all", tal, time.Second)
		if s.PercentileSamples != MaxSamples {
			t.Errorf("%s: percentile_samples = %d, want %d", name, s.PercentileSamples, MaxSamples)
		}
		for p, got := range map[float64]float64{50: s.Latency.P50, 90: s.Latency.P90, 95: s.Latency.P95, 99: s.Latency.P99} {
			want := exactPercentile(n, p)
			if math.Abs(got-want) > 0.005*n {
				t.Errorf("%s: p%.0f = %.0f, exact %.0f (more than 0.5 points off)", name, p, got, want)
			}
		}
		if s.Latency.Min != 1 || s.Latency.Max != n || s.Requests != n || s.OK != n {
			t.Errorf("%s: exact figures wrong: min %v max %v requests %d ok %d", name, s.Latency.Min, s.Latency.Max, s.Requests, s.OK)
		}
	}
}

// A constant latency has one possible percentile; the sampler must not invent
// another, and exactly at the cap and one past it nothing is lost or doubled.
func TestConstantLatencyAtAndPastTheCap(t *testing.T) {
	for _, n := range []int{MaxSamples - 1, MaxSamples, MaxSamples + 1, 2*MaxSamples + 7} {
		var tal Tally
		for range n {
			tal.AddResponse(200, 42, 1)
		}
		s := ComputeStats(-1, "all", tal, time.Second)
		if want := min(n, MaxSamples); len(tal.Samples) != want || s.PercentileSamples != want {
			t.Errorf("n=%d: kept %d, disclosed %d, want %d", n, len(tal.Samples), s.PercentileSamples, want)
		}
		if s.Requests != n || s.OK != n || s.Latency.P50 != 42 || s.Latency.P99 != 42 || s.Latency.Avg != 42 {
			t.Errorf("n=%d: stats = %+v", n, s)
		}
		var hist int
		for _, b := range s.Histogram {
			hist += b.Count
		}
		if hist != n {
			t.Errorf("n=%d: histogram counts %d responses", n, hist)
		}
	}
}

// The per-dispatch path must stay allocation-free once the reservoir is full,
// or a long run pays garbage-collection time inside the load it is measuring.
func TestAddResponseDoesNotAllocateOnceTheReservoirIsFull(t *testing.T) {
	var tal Tally
	tal.Samples = make([]Sample, 0, MaxSamples)
	tal.StatusCounts = map[int]int{}
	tal.ErrorKinds = map[string]int{}
	for i := range MaxSamples + 10 {
		tal.AddResponse(200, float64(i%500), 10)
	}
	i := 0
	allocs := testing.AllocsPerRun(10_000, func() {
		i++
		tal.AddResponse(200, float64(i%500), 10)
		tal.AddResponse(503, float64(i%500), 10)
	})
	if allocs != 0 {
		t.Errorf("AddResponse allocates %.1f per call once full, want 0", allocs)
	}
}

// Two tallies fed the same stream keep the same samples, and a tally given a
// smaller cap than responses never exceeds it, including a cap of 1.
func TestSampleCapOfOneAndDeterminism(t *testing.T) {
	a, b := Tally{SampleCap: 1}, Tally{SampleCap: 1}
	for i := range 5000 {
		a.AddResponse(200, float64(i), 1)
		b.AddResponse(200, float64(i), 1)
	}
	if len(a.Samples) != 1 || a.Samples[0] != b.Samples[0] {
		t.Fatalf("cap 1 kept %v and %v", a.Samples, b.Samples)
	}
	s := ComputeStats(0, "x", a, time.Second)
	if s.Latency.P50 != a.Samples[0].Ms || s.Latency.Max != 4999 || s.Latency.Min != 0 {
		t.Errorf("stats with a one-sample reservoir: %+v", s.Latency)
	}
}
