package budget

import (
	"fmt"
	"testing"
	"time"
)

// The budget simulator.
//
// The design this bucket replaced claimed a 9% duty-cycle bound and delivered
// 24% — nobody noticed until it was simulated. The lesson taken from that is
// that a load bound stated in prose is a guess, so the bound is asserted here
// instead, against the real implementation (not a model of it), over a
// simulated 24-hour horizon, by adversaries that are trying to beat it.
//
// Run with: go test ./internal/budget/ -run Sim -v
//
// The claim under test: sustained consumption can never exceed Refill
// worker-seconds per second, which at the fifty-worker cap is a 10.0% duty
// cycle. Formally, any window may grant at most
//
//	Burst + one run's cost + Refill x elapsed
//
// — the burst, plus the single in-flight run that is not debited until it
// finishes, plus refill — which decays to a sustained rate of exactly Refill.
// Both the envelope and the duty cycle are asserted below.

const (
	// The deployed caps. The duty-cycle bound is Refill / simMaxWorkers by
	// construction, which is why recalibrating the budget at deploy time is one
	// division rather than a re-derivation.
	simMaxWorkers  = 50
	simMaxDuration = 30 * time.Second

	simHorizon = 24 * time.Hour

	// dutyBound is the claim: 5 worker-seconds/sec over 50 workers = 10.0%.
	dutyBound = Refill / simMaxWorkers

	// dutyTolerance absorbs the burst head start. Over 24 hours the burst plus
	// one undebited run is (1500 + 1500) / (50 x 86400) = 0.07 percentage
	// points, so half a point is generous without being meaningless.
	dutyTolerance = 0.005

	// simMaxSteps stops a regression that stopped advancing the clock from
	// hanging CI instead of failing it.
	simMaxSteps = 4_000_000
)

// attempt is one thing an adversary tries to do.
type attempt struct {
	workers int
	dur     time.Duration

	// gated is false for /api/send, which is admitted regardless of balance —
	// only the one-in-flight rule limits it. It still debits, which is the
	// property that keeps the ungated path from voiding the bound.
	gated bool
}

type simResult struct {
	consumed float64 // worker-seconds actually spent
	elapsed  time.Duration
	admitted int
	denied   int
	maxWait  time.Duration
}

// duty is consumption as a fraction of what the host would have carried had the
// worker cap been saturated for the whole window.
func (r simResult) duty() float64 {
	return r.consumed / (simMaxWorkers * r.elapsed.Seconds())
}

// rate is sustained worker-seconds per second — the number the bound is
// actually about.
func (r simResult) rate() float64 { return r.consumed / r.elapsed.Seconds() }

func (r simResult) String() string {
	return fmt.Sprintf("%.1f worker-seconds over %v: %.4f w-s/s, duty %.3f%%, %d admitted, %d denied, longest wait %v",
		r.consumed, r.elapsed, r.rate(), 100*r.duty(), r.admitted, r.denied, r.maxWait)
}

// drive runs an adversary against a real bucket for the horizon. The adversary
// is optimal: when refused, it waits exactly as long as it is told to and not a
// millisecond more, which is the worst case for the bound.
func drive(t *testing.T, b *Bucket, c *clock, horizon time.Duration, next func(i int) attempt) simResult {
	t.Helper()
	start := c.t
	end := start.Add(horizon)
	var res simResult

	// step advances only when an attempt actually executes. A refusal is a
	// retry of the same intent, not the next one: incrementing here would let a
	// denial reshuffle an alternating adversary into a different, weaker shape.
	step := 0
	for iter := 0; c.t.Before(end); iter++ {
		if iter > simMaxSteps {
			t.Fatalf("simulation did not converge in %d steps — the clock is not advancing", simMaxSteps)
		}
		a := next(step)

		if a.gated {
			d := b.Admit()
			if !d.Admitted {
				res.denied++
				wait := d.CooldownUntil.Sub(c.t)
				if wait <= 0 {
					// Unreachable: the cooldown is derived from the deficit, so
					// a past deadline implies a non-negative balance. Advancing
					// anyway keeps a regression from spinning forever.
					wait = time.Second
				}
				if wait > res.maxWait {
					res.maxWait = wait
				}
				c.Advance(wait)
				continue
			}
			res.admitted++
		}

		step++
		c.Advance(a.dur)
		cost := float64(a.workers) * a.dur.Seconds()
		res.consumed += cost
		// A gated attempt is a run and charges Spend, which opens the cooldown.
		// An ungated attempt is an /api/send and charges Debit, which does not.
		// Charging Spend for both proved the bound against a method the server
		// never calls on that path.
		if a.gated {
			b.Spend(cost)
		} else {
			b.Debit(cost)
		}
	}

	res.elapsed = c.t.Sub(start)
	return res
}

// assertWithinBound checks both forms of the claim: the exact grant envelope,
// and the duty cycle it decays to.
func assertWithinBound(t *testing.T, name string, res simResult) {
	t.Helper()
	t.Logf("%s: %s", name, res)

	// The envelope is exact and has no fudge factor in it.
	envelope := Burst + simMaxWorkers*simMaxDuration.Seconds() + Refill*res.elapsed.Seconds()
	if res.consumed > envelope {
		t.Errorf("%s consumed %.1f worker-seconds, exceeding the B + one run + R*t envelope of %.1f",
			name, res.consumed, envelope)
	}
	if duty := res.duty(); duty > dutyBound+dutyTolerance {
		t.Errorf("%s held a %.3f%% duty cycle, above the %.1f%% bound", name, 100*duty, 100*dutyBound)
	}
}

// assertBoundIsTight checks the other direction for the shapes that are trying
// their hardest. A mechanism that refused everything would satisfy the bound
// and be useless; these shapes should get their full 10% and no more.
func assertBoundIsTight(t *testing.T, name string, res simResult) {
	t.Helper()
	if duty := res.duty(); duty < dutyBound-0.005 {
		t.Errorf("%s only reached a %.3f%% duty cycle; the bound should be tight at %.1f%%, not merely satisfied",
			name, 100*duty, 100*dutyBound)
	}
}

// Shape (a): maximum runs, back to back, forever. The headline case — a script
// asking for 50 workers for 30 seconds as fast as it is allowed to.
func TestSimMaxRunsBackToBack(t *testing.T) {
	c := newClock()
	b := New(c.Now)

	res := drive(t, b, c, simHorizon, func(int) attempt {
		return attempt{workers: simMaxWorkers, dur: simMaxDuration, gated: true}
	})

	assertWithinBound(t, "max runs back-to-back", res)
	assertBoundIsTight(t, "max runs back-to-back", res)

	// Steady state is one maximum run per 300 seconds: 1500 worker-seconds
	// debited, refilled at 5/s.
	if got, want := res.elapsed.Seconds()/float64(res.admitted), 300.0; got < want*0.98 || got > want*1.02 {
		t.Errorf("one run every %.1fs, want ~%.0fs", got, want)
	}
}

// Shape (b): start-and-immediately-cancel spam. This is the lever that killed
// the tiered design, where six cycles held the global cooldown active ~99.9% of
// the time at under 1% of the load. Here a cancel costs exactly what it
// consumed, so the lockout is paid for in full: the griefer's own load lands at
// the same 10% ceiling as anyone else's, and there is no cheap lever left.
func TestSimStartCancelSpam(t *testing.T) {
	c := newClock()
	b := New(c.Now)

	res := drive(t, b, c, simHorizon, func(int) attempt {
		return attempt{workers: simMaxWorkers, dur: time.Second, gated: true}
	})

	assertWithinBound(t, "start-cancel spam", res)
	assertBoundIsTight(t, "start-cancel spam", res)

	// The lockout is proportional, not free: 50 worker-seconds per cycle buys a
	// 9-second cooldown, so the attacker holds the lock 1 second in 10 — the
	// exact fraction of the host's capacity it actually paid for.
	if got := res.elapsed.Seconds() / float64(res.admitted); got < 9.8 || got > 10.2 {
		t.Errorf("one cancel cycle every %.2fs, want ~10s", got)
	}
}

// Shape (c): sends interleaved with runs. Sends bypass admission entirely, so
// this is the shape that would expose an ungated path voiding the mechanism.
// It does not, because a send still debits: its cost simply lengthens the next
// run's cooldown and total load still converges on Refill.
func TestSimInterleavedSendAndRun(t *testing.T) {
	c := newClock()
	b := New(c.Now)

	res := drive(t, b, c, simHorizon, func(i int) attempt {
		if i%2 == 1 {
			// A send is one worker for its duration and is never refused.
			return attempt{workers: 1, dur: 2 * time.Second, gated: false}
		}
		return attempt{workers: simMaxWorkers, dur: simMaxDuration, gated: true}
	})

	assertWithinBound(t, "interleaved send + run", res)
	assertBoundIsTight(t, "interleaved send + run", res)
}

// Shape (c'): nothing but sends, as fast as the one-in-flight rule allows.
// Bounded by that rule at one worker-second per second — a fifth of Refill — so
// honest use of the request editor never competes with the run budget.
func TestSimSendFloodStaysUnderTheRefillRate(t *testing.T) {
	c := newClock()
	b := New(c.Now)

	res := drive(t, b, c, simHorizon, func(int) attempt {
		return attempt{workers: 1, dur: time.Second, gated: false}
	})

	t.Logf("send flood: %s", res)
	if rate := res.rate(); rate > 1.01 {
		t.Errorf("send flood sustained %.3f worker-seconds/s; the one-in-flight rule caps it at 1", rate)
	}
	if rate := res.rate(); rate > Refill {
		t.Errorf("the ungated path beat the refill rate: %.3f > %.1f", rate, Refill)
	}
}

// Shape (d): many small runs — the demo's actual happy path, a visitor walking
// curated functional collections. It should sit far below the ceiling and never
// leave the five-second floor.
func TestSimManySmallRuns(t *testing.T) {
	c := newClock()
	b := New(c.Now)

	res := drive(t, b, c, simHorizon, func(int) attempt {
		return attempt{workers: 1, dur: 3 * time.Second, gated: true}
	})

	assertWithinBound(t, "many small runs", res)
	if duty := res.duty(); duty > 0.01 {
		t.Errorf("the happy path reached a %.3f%% duty cycle; small runs should barely register", 100*duty)
	}
	if res.maxWait > MinCooldown {
		t.Errorf("a small-run visitor waited %v, longer than the %v floor", res.maxWait, MinCooldown)
	}
}

// No choice of run size beats the bound. This is the "no scheduling of runs can
// beat it" claim, checked by exhaustion rather than by argument: the only way
// to acquire budget is to wait for refill, so every shape converges on the same
// ceiling regardless of how the attacker slices it.
func TestSimNoRunSizingBeatsTheBound(t *testing.T) {
	durations := []time.Duration{
		100 * time.Millisecond, 500 * time.Millisecond, time.Second,
		3 * time.Second, 10 * time.Second, simMaxDuration,
	}
	for _, workers := range []int{1, 5, 10, 25, simMaxWorkers} {
		for _, dur := range durations {
			name := fmt.Sprintf("%dw x %v", workers, dur)
			t.Run(name, func(t *testing.T) {
				c := newClock()
				b := New(c.Now)
				res := drive(t, b, c, simHorizon, func(int) attempt {
					return attempt{workers: workers, dur: dur, gated: true}
				})
				assertWithinBound(t, name, res)
			})
		}
	}
}

// A griefer who hammers Start on a fixed interval rather than waiting exactly
// as told gets no more than the patient adversary — polling is not a lever.
func TestSimImpatientPollingGainsNothing(t *testing.T) {
	c := newClock()
	b := New(c.Now)

	start := c.t
	end := start.Add(simHorizon)
	var consumed float64
	var admitted int
	for c.t.Before(end) {
		if d := b.Admit(); !d.Admitted {
			c.Advance(250 * time.Millisecond) // poll again, impatiently
			continue
		}
		admitted++
		c.Advance(simMaxDuration)
		cost := float64(simMaxWorkers) * simMaxDuration.Seconds()
		consumed += cost
		b.Spend(cost)
	}

	res := simResult{consumed: consumed, elapsed: c.t.Sub(start), admitted: admitted}
	assertWithinBound(t, "impatient polling", res)
}

// However long the system idles first, the burst is one nominal run and no
// more. Without the clamp at Burst, a quiet weekend would bank enough budget to
// grant unlimited back-to-back maximum runs on Monday, and the whole mechanism
// would be void exactly when someone finally showed up to abuse it.
func TestSimQuietWeekendDoesNotBankUnlimitedRuns(t *testing.T) {
	c := newClock()
	b := New(c.Now)
	c.Advance(72 * time.Hour) // an idle long weekend

	// Count how many maximum runs are admitted in the first five minutes.
	burstRuns := 0
	end := c.t.Add(5 * time.Minute)
	for c.t.Before(end) {
		if d := b.Admit(); !d.Admitted {
			c.Advance(d.CooldownUntil.Sub(c.t))
			continue
		}
		burstRuns++
		c.Advance(simMaxDuration)
		b.Spend(simMaxWorkers * simMaxDuration.Seconds())
	}

	// One from the burst, one more as refill catches up over the window.
	if burstRuns > 2 {
		t.Errorf("a 72-hour idle banked %d maximum runs in five minutes; the balance clamp is not holding", burstRuns)
	}
}
