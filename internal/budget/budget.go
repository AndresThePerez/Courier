// Package budget is Courier's aggregate-load ceiling: a token bucket measured
// in worker-seconds that decides how long the cooldown after a run lasts.
//
// It replaces the cooldown Courier originally specified. A flat cooldown bounds
// concurrent load but not sustained load — a script could hold the target at a
// ~75% duty cycle forever. The tiered cooldown that replaced it was simulated
// and failed three ways: its claimed bound was false (each long cooldown ages
// runs out of the rolling window, so the top tier undercuts itself and the
// system oscillates near 24% rather than the 9% claimed), it priced a
// one-second cancel identically to a thirty-second fifty-worker blast — making
// start-cancel spam a ~99.9% lockout lever at under 1% of the load — and it
// escalated an honest visitor walking the curated collections to a 300-second
// wall.
//
// Pricing load instead of counting events fixes all three at once. The bound is
// exact and sustained: consumption can never exceed Refill worker-seconds per
// second, which at the fifty-worker cap is a 10% duty cycle, forever. A cancel
// costs precisely what it consumed. And the curated stroll is free — six
// functional collections cost ~18 worker-seconds against a bucket that refills
// five every second, so a genuine visitor never leaves the floor.
//
// internal/budget/budget_sim_test.go proves the bound against adversarial
// traffic shapes over a simulated 24-hour horizon rather than asserting it in
// prose.
package budget

import (
	"math"
	"sync"
	"time"
)

// The calibrated constants. They are re-measured against the deployment host
// before the URL is announced; keep Burst == max_workers x max_duration so the
// burst stays exactly one nominal maximum run, and set Refill from the load the
// host can carry beside whatever else it serves.
//
// The duty-cycle identity is Refill / max_workers, which makes that one
// division rather than a re-derivation.
const (
	// Refill is R: worker-seconds granted per second. This is the sustained
	// load ceiling, and nothing can beat it — the only way to acquire budget is
	// to wait for it.
	Refill = 5.0

	// Burst is B: the bucket's capacity, exactly one nominal maximum run
	// (50 workers x 30s), so a visitor arriving after a quiet period never
	// waits. The clamp at B is load-bearing: letting the balance accumulate
	// over a quiet weekend would grant unlimited back-to-back runs on Monday
	// and silently void the whole mechanism.
	Burst = 1500.0

	// MinCooldown is the floor, so the UI always has a beat to count down even
	// when a run cost almost nothing.
	MinCooldown = 5 * time.Second
)

// Decision is the answer to "may a run start now", shaped for the 409 response
// and for a log line: it carries the balance it was made on and the timestamp
// the client should count down to.
type Decision struct {
	Admitted      bool
	Balance       float64
	CooldownUntil time.Time
}

// Charge is the record of a debit: what it cost, what it did to the balance,
// and the cooldown that fell out. Every field exists because the structured log
// line for a budget decision names it.
type Charge struct {
	Cost          float64
	Before        float64
	After         float64
	Cooldown      time.Duration
	CooldownUntil time.Time
}

// Bucket is the token bucket. It is safe for concurrent use; the API layer
// reads the balance from a status poll while a run finishes against it.
type Bucket struct {
	refill float64
	burst  float64
	floor  time.Duration
	now    func() time.Time

	mu            sync.Mutex
	balance       float64
	last          time.Time
	cooldownUntil time.Time
}

// New builds a bucket with the calibrated constants, full, reading time from
// now. Passing the clock in is what lets the simulator compress a 24-hour
// adversarial horizon into milliseconds of CI time.
func New(now func() time.Time) *Bucket {
	return NewBucket(Refill, Burst, MinCooldown, now)
}

// NewBucket builds a bucket with explicit parameters. It starts full: an
// arriving visitor should not be made to pay for a quiet period they had
// nothing to do with.
func NewBucket(refill, burst float64, floor time.Duration, now func() time.Time) *Bucket {
	if now == nil {
		now = time.Now
	}
	return &Bucket{
		refill:  refill,
		burst:   burst,
		floor:   floor,
		now:     now,
		balance: burst,
		last:    now(),
	}
}

// Admit reports whether a run may start.
//
// Two conditions, and they agree except at the floor: the balance must be
// non-negative, and the cooldown window from the previous run must have passed.
// The floor is the only reason the second can fail while the first holds.
func (b *Bucket) Admit() Decision {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	b.accrue(now)
	return Decision{
		Admitted:      b.balance >= 0 && !now.Before(b.cooldownUntil),
		Balance:       b.balance,
		CooldownUntil: b.cooldownUntil,
	}
}

// Spend debits a run's actual consumption and returns the cooldown it bought.
//
// The debit happens on finish, not on start, and it is measured in wall-clock
// worker-seconds — so a run's cost includes its in-flight completion tail. That
// matters at the edge: fifty workers against a degraded target, each sitting in
// a ten-second timeout at the deadline, costs ~2,000 worker-seconds and cools
// for ~400 seconds. That is the desirable behaviour — the run that hurt the
// target most cools the longest — and it is why Burst is one *nominal* maximum
// run rather than a ceiling on any single run's cost.
//
// Sends debit through here too. They are never gated on the balance (that would
// take the request editor offline for five minutes after every maximum run, for
// no host-protective reason), because the invariant self-compensates: a send's
// debit simply lengthens the next run's cooldown, and total load still
// converges on Refill.
func (b *Bucket) Spend(workerSeconds float64) Charge {
	b.mu.Lock()
	defer b.mu.Unlock()
	before, after := b.debit(workerSeconds)

	cooldown := b.floor
	if deficit := -math.Min(after, 0); deficit > 0 {
		if d := time.Duration(deficit / b.refill * float64(time.Second)); d > cooldown {
			cooldown = d
		}
	}
	b.cooldownUntil = b.last.Add(cooldown)

	return Charge{
		Cost:          workerSeconds,
		Before:        before,
		After:         after,
		Cooldown:      cooldown,
		CooldownUntil: b.cooldownUntil,
	}
}

// Debit charges worker-seconds without opening a cooldown window.
//
// It is what a single /api/send costs the ledger. Spend's floor exists so the
// UI always has a beat to count down after a *run*; applying it to one editor
// request would put the Start button into a five-second cooldown every time a
// visitor pressed Send, which is a rate limit the design does not ask for — the
// one-in-flight rule already caps that path at one worker-second per second.
//
// The load bound is unaffected, and this is the spec's own reading of it: the
// send's debit lowers the balance, so the *next run's* Spend computes a longer
// cooldown from it. Total load still converges on Refill.
func (b *Bucket) Debit(workerSeconds float64) Charge {
	b.mu.Lock()
	defer b.mu.Unlock()
	before, after := b.debit(workerSeconds)
	return Charge{
		Cost:          workerSeconds,
		Before:        before,
		After:         after,
		CooldownUntil: b.cooldownUntil,
	}
}

// debit refills to now and subtracts. It must be called under the lock, and it
// leaves b.last at the instant the debit was applied so a caller that also sets
// a cooldown measures it from the same moment.
func (b *Bucket) debit(workerSeconds float64) (before, after float64) {
	b.accrue(b.now())
	before = b.balance
	b.balance -= workerSeconds
	return before, b.balance
}

// Balance is the current worker-second balance, refilled to now.
func (b *Bucket) Balance() float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.accrue(b.now())
	return b.balance
}

// CooldownUntil is when the next run may start. It is in the past when nothing
// is owed.
func (b *Bucket) CooldownUntil() time.Time {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.cooldownUntil
}

// accrue applies refill up to now, clamped at the burst cap. It must be called
// under the lock.
func (b *Bucket) accrue(now time.Time) {
	elapsed := now.Sub(b.last)
	if elapsed <= 0 {
		return
	}
	b.last = now
	b.balance = math.Min(b.burst, b.balance+b.refill*elapsed.Seconds())
}
