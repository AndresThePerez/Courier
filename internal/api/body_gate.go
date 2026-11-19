package api

import (
	"context"
	"slices"
	"sync"
	"sync/atomic"
)

// Bounds on the body check, which runs before the one-run lock and the
// one-send limit and so is open to every visitor at once. They are weighed in
// body bytes, not in bodies: what a check allocates grows with its body's
// size, so a small body must not take the place of a body at the cap.
//
// What the checks can allocate at once follows from the constants. The bodies
// in the check weigh at most MaxBodyChecks x MaxBodyBytes in all. The widest
// bodies at the cap measured allocate about 140 x their size to check and
// decode, and TestDecodingAWideBodyStaysLinearInItsSize holds them to 192 x
// (wideDecodeBound); TestAShortBodyWeighsTheFloor holds short bodies to
// 192 x minBodyWeight. So the checks in flight allocate at most
// 192 x 2 x 256 KiB, on the reading that bodies between the two ends allocate
// in the same proportion, which is measured at the ends only. The bodies
// waiting weigh at most MaxBodyWaiters x MaxBodyBytes, 16 x 256 KiB.
//
// The bound leaves out what scales with connections rather than with these
// constants: bodies read in full and then answered 503, and bodies still
// arriving. It also leaves out the decoded value a request keeps after its
// check, through validation and the start or the send, and garbage not yet
// collected.
const (
	// MaxBodyChecks is how many bodies at the cap are checked and decoded at
	// once; smaller bodies share the same MaxBodyChecks x MaxBodyBytes
	// (TestNoMoreThanMaxBodyChecksBodiesAreCheckedAtOnce,
	// TestAnOrdinaryBurstOfSmallPostsNeverSeesTheBodyGate). Two rather than
	// one, so a body at the cap being checked does not hold up a small one.
	MaxBodyChecks = 2

	// MaxBodyWaiters is how many bodies at the cap, already read, may wait for
	// room, again shared by weight with smaller ones. A body that would take
	// the waiting bodies past MaxBodyWaiters x MaxBodyBytes is answered 503 at
	// once, unchecked
	// (TestABodyBeyondMaxBodyWaitersIsAnswered503WithoutBeingChecked).
	MaxBodyWaiters = 16

	// minBodyWeight is what a body weighs however short it is. A check has a
	// cost of its own beside its body's bytes, and without a floor the number
	// of empty bodies in the check at once would have no bound
	// (TestAShortBodyWeighsTheFloor).
	minBodyWeight = 4 << 10
)

// bodyWeight is what a body of n bytes weighs in the gate.
func bodyWeight(n int) int64 { return int64(max(n, minBodyWeight)) }

// bodyGateBusy is the 503's message. The page shows it after "Busy - " on
// Send and on Start.
const bodyGateBusy = "the server is busy checking other requests; try again in a moment"

// bodyGateRetryAfter is the 503's Retry-After, in seconds: room frees as soon
// as one check ends. The shipped page does not read it and never retries by
// itself (its visitor presses again); it is available on the wire for other
// clients.
const bodyGateRetryAfter = "1"

// bodyGate admits bodies to the check by weight, in strict arrival order: a
// body that does not fit waits, and every body that arrives after it waits
// behind it, however small, so a body at the cap is never held out by a
// stream of small ones (TestABodyAtTheCapIsAdmittedBeforeSmallerOnesBehindIt).
//
// Invariant, under mu: inside <= maxInside, queued <= maxQueued, queued and
// waiting are the sum and the count of the bodies in line, and the head of
// line does not fit (inside + line[0].n > maxInside) whenever line is not
// empty. A body weighs at most MaxBodyBytes, so one alone always fits.
type bodyGate struct {
	mu        sync.Mutex
	inside    int64
	queued    int64
	line      []*bodyWaiter
	maxInside int64
	maxQueued int64

	// waiting is len(line), kept where a test can read it without the lock.
	waiting atomic.Int64

	// checking, when set, runs while a body is in the check, after its
	// release is deferred. Tests park bodies in it to count how many are
	// inside at once; production leaves it nil.
	checking func(n int64)
}

// bodyWaiter is one body in line. admit is closed once it is let in.
type bodyWaiter struct {
	n     int64
	admit chan struct{}
}

func newBodyGate(maxInside, maxQueued int64) *bodyGate {
	return &bodyGate{maxInside: maxInside, maxQueued: maxQueued}
}

// enter lets in a body of weight n, waiting in line for room when there is
// none. It reports false when the line has no room for n or ctx ends first:
// a waiter whose client has gone leaves the line.
func (g *bodyGate) enter(ctx context.Context, n int64) bool {
	g.mu.Lock()
	if len(g.line) == 0 && g.inside+n <= g.maxInside {
		g.inside += n
		g.mu.Unlock()
		return true
	}
	if g.queued+n > g.maxQueued {
		g.mu.Unlock()
		return false
	}
	bw := &bodyWaiter{n: n, admit: make(chan struct{})}
	g.line = append(g.line, bw)
	g.queued += n
	g.waiting.Store(int64(len(g.line)))
	g.mu.Unlock()

	select {
	case <-bw.admit:
		return true
	case <-ctx.Done():
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	select {
	case <-bw.admit:
		// Let in as ctx ended: it holds room it will not use.
		g.inside -= n
	default:
		i := slices.Index(g.line, bw)
		g.line = slices.Delete(g.line, i, i+1)
		g.queued -= n
		g.waiting.Store(int64(len(g.line)))
	}
	g.admitLocked()
	return false
}

// leave gives back the room of a body of weight n.
func (g *bodyGate) leave(n int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.inside -= n
	g.admitLocked()
}

// admitLocked lets in, in order, every body at the head of the line that fits.
func (g *bodyGate) admitLocked() {
	for len(g.line) > 0 && g.inside+g.line[0].n <= g.maxInside {
		bw := g.line[0]
		g.line = slices.Delete(g.line, 0, 1)
		g.queued -= bw.n
		g.inside += bw.n
		close(bw.admit)
	}
	g.waiting.Store(int64(len(g.line)))
}

// load reports the weight in the check and the weight in line.
func (g *bodyGate) load() (inside, queued int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.inside, g.queued
}
