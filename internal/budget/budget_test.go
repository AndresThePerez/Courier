package budget

import (
	"math"
	"testing"
	"time"
)

// clock is a hand-advanced clock. Every budget assertion below states its
// starting balance and moves time explicitly — a budget test that sleeps is
// both slow and untrustworthy about what it actually proved.
type clock struct{ t time.Time }

func newClock() *clock {
	return &clock{t: time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)}
}

func (c *clock) Now() time.Time          { return c.t }
func (c *clock) Advance(d time.Duration) { c.t = c.t.Add(d) }

// drain empties a bucket to exactly zero, so a test can state "from an empty
// bucket" and mean it.
func drain(b *Bucket) {
	b.mu.Lock()
	b.balance = 0
	b.cooldownUntil = time.Time{}
	b.mu.Unlock()
}

func nearly(got, want, tol float64) bool { return math.Abs(got-want) <= tol }

func TestBucketStartsFull(t *testing.T) {
	c := newClock()
	b := New(c.Now)
	if got := b.Balance(); got != Burst {
		t.Errorf("starting balance = %v, want %v — an arriving visitor should not pay for a quiet period", got, Burst)
	}
	if d := b.Admit(); !d.Admitted {
		t.Error("a full bucket must admit")
	}
}

// From a FULL bucket, the maximum run yields the floor: it spent exactly the
// burst it was given.
func TestMaxRunFromFullBucketYieldsTheFloor(t *testing.T) {
	c := newClock()
	b := New(c.Now)

	c.Advance(30 * time.Second) // the run
	ch := b.Spend(50 * 30)

	if ch.Cooldown != MinCooldown {
		t.Errorf("cooldown = %v, want the %v floor (started full, spent the burst)", ch.Cooldown, MinCooldown)
	}
	if !nearly(ch.After, 0, 0.001) {
		t.Errorf("balance after = %v, want 0", ch.After)
	}
}

// From an EMPTY bucket the same run cools for as long as the debit takes to
// refill, less the refill already accrued while it ran.
func TestMaxRunFromEmptyBucketCoolsForTheDebit(t *testing.T) {
	c := newClock()
	b := New(c.Now)
	drain(b)

	c.Advance(30 * time.Second)
	ch := b.Spend(50 * 30)

	// 1500 debited, 150 refilled during the run: 1350 owed at 5/s = 270s.
	want := 270 * time.Second
	if ch.Cooldown != want {
		t.Errorf("cooldown = %v, want %v", ch.Cooldown, want)
	}
	if d := b.Admit(); d.Admitted {
		t.Error("must not admit while owing")
	}
	c.Advance(want)
	if d := b.Admit(); !d.Admitted {
		t.Errorf("must admit once the debt has refilled: balance %v", d.Balance)
	}
}

// A cancel costs precisely what it consumed, which is the whole reason the
// tiered design was thrown away: there is no cheap lockout lever here.
func TestCancelledRunCostsOnlyWhatItConsumed(t *testing.T) {
	c := newClock()
	b := New(c.Now)
	drain(b)

	c.Advance(time.Second)
	ch := b.Spend(50 * 1) // 50 workers, cancelled after one second

	if ch.Cost != 50 {
		t.Errorf("cost = %v, want 50 worker-seconds", ch.Cost)
	}
	// 50 debited, 5 refilled during the second: 45 owed at 5/s = 9s.
	if want := 9 * time.Second; ch.Cooldown != want {
		t.Errorf("cooldown = %v, want %v — a one-second cancel must not price like a full run", ch.Cooldown, want)
	}
}

// The demo's happy path. Six curated functional collections cost ~18
// worker-seconds in total; a visitor must never leave the floor.
func TestCuratedStrollNeverLeavesTheFloor(t *testing.T) {
	c := newClock()
	b := New(c.Now)

	for i := range 6 {
		if d := b.Admit(); !d.Admitted {
			t.Fatalf("collection %d was refused: balance %v", i, d.Balance)
		}
		c.Advance(3 * time.Second) // a functional collection
		ch := b.Spend(1 * 3)       // functional mode is one worker
		if ch.Cooldown != MinCooldown {
			t.Fatalf("collection %d cooled %v, want the %v floor", i, ch.Cooldown, MinCooldown)
		}
		c.Advance(MinCooldown)
	}
}

// Proportionality the tiers could not express: a small experiment gets a small
// wait.
func TestSmallExperimentGetsASmallWait(t *testing.T) {
	c := newClock()
	b := New(c.Now)
	drain(b)

	c.Advance(10 * time.Second)
	ch := b.Spend(10 * 10) // 10 workers for 10s = 100 worker-seconds

	// 100 debited, 50 refilled while running: 50 owed at 5/s = 10s.
	if want := 10 * time.Second; ch.Cooldown != want {
		t.Errorf("cooldown = %v, want %v", ch.Cooldown, want)
	}
}

// A stalled target makes a run cost far more than a nominal maximum run, and it
// should: the run that hurt the target most cools the longest.
func TestStalledTargetCostsMoreThanOneNominalRun(t *testing.T) {
	c := newClock()
	b := New(c.Now)
	drain(b)

	c.Advance(40 * time.Second) // 30s of dispatch plus a 10s timeout tail
	ch := b.Spend(50 * 40)      // ~2,000 worker-seconds

	if ch.Cost <= Burst {
		t.Fatalf("cost = %v, want more than the %v burst", ch.Cost, Burst)
	}
	// 2000 debited, 200 refilled while running: 1800 owed at 5/s = 360s.
	if want := 360 * time.Second; ch.Cooldown != want {
		t.Errorf("cooldown = %v, want %v", ch.Cooldown, want)
	}
}

// The clamp is load-bearing. Without it a quiet weekend would bank enough
// budget to grant unlimited back-to-back maximum runs on Monday.
func TestBalanceNeverExceedsTheBurstHoweverLongItIdles(t *testing.T) {
	c := newClock()
	b := New(c.Now)
	drain(b)

	c.Advance(72 * time.Hour)
	if got := b.Balance(); got != Burst {
		t.Errorf("balance after three idle days = %v, want the %v cap", got, Burst)
	}
}

// Sends are admitted regardless of the balance — only the one-in-flight rule
// gates them — but they still debit, so they lengthen the next run's cooldown.
func TestSendDebitsWithoutBeingGated(t *testing.T) {
	c := newClock()
	b := New(c.Now)
	drain(b)
	c.Advance(30 * time.Second)
	b.Spend(50 * 30) // a maximum run leaves the bucket deep in debt

	deep := b.Balance()
	if deep >= 0 {
		t.Fatalf("balance = %v, want a debt to send against", deep)
	}

	before := b.CooldownUntil()
	ch := b.Spend(1 * 2) // a two-second send, admitted regardless
	if ch.After >= deep {
		t.Error("a send must still debit the bucket")
	}
	if !ch.CooldownUntil.After(before) {
		t.Error("a send's debit must push the cooldown later, which is why the UI re-reads it")
	}
}

func TestAdmitReportsTheCooldownItRefusedOn(t *testing.T) {
	c := newClock()
	b := New(c.Now)
	c.Advance(time.Second)
	ch := b.Spend(5)

	d := b.Admit()
	if d.Admitted {
		t.Fatal("must refuse inside the floor window")
	}
	if !d.CooldownUntil.Equal(ch.CooldownUntil) {
		t.Errorf("Admit reported %v, Spend set %v — the client counts down the value it is given",
			d.CooldownUntil, ch.CooldownUntil)
	}
}
