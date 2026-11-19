package api

import (
	"sync/atomic"
	"time"
)

// Bounds on the bodies of POST /api/send and POST /api/runs while they are
// read, which the body gate does not cover: the gate weighs a body only once
// it has arrived, so without these every connection could hold a body in
// memory while it arrives, and a stalled one could hold it for ever.
//
// What they bound. A body holds a place from the moment its read begins until
// the read ends, however it ends, so at most MaxBodyReads bodies are being
// read at once. A body read to the cap holds about 380 KB while it is read,
// so the reads hold at most about 128 x 380 KB, 49 MB. Once read, a body is
// the gate's: the line holds at most MaxBodyWaiters x MaxBodyBytes, 4 MiB,
// and the checks in flight allocate at most 192 x 2 x 256 KiB, 96 MiB
// (body_gate.go). The three add up to about 150 MB, within the Go memory
// limit of 192 MiB that docker-compose.yml gives the container's 256 MB. A
// body waiting in the line holds no place: the line is already bounded by
// its bytes, and a place held there as well would shrink the line's room for
// small bodies to the places left over, so an ordinary burst of small posts
// would meet a 503 whenever the check was full for a moment.
//
// What they do not bound. A POST that finds every place taken is answered 503
// at once, its body unread, and its connection closed. Places are not shared
// between clients: a client that keeps every place filled with uploads that
// stall, each for up to the deadline, makes every other visitor's POST a 503
// until it stops, instead of getting the process killed. What limits one
// client is the tunnel in front of the server.
const (
	// MaxBodyReads is how many POST bodies may be read at once
	// (TestAPostBeyondMaxBodyReadsIsAnswered503WithoutBeingRead,
	// TestABodyWaitingInTheGatesLineHoldsNoPlace). An ordinary post is read
	// in microseconds, so a burst of a thousand small ones never finds them
	// all taken (TestLargeBurstsOfSmallPostsNeverSeeTheBodyGate).
	MaxBodyReads = 128

	// BodyReadDeadline is how long a POST body may take to arrive, counted
	// from the start of its read, and is the server's only time limit besides
	// ReadHeaderTimeout. It is set on the connection when the read begins and
	// cleared when the read ends, so it never reaches the handler's own work,
	// a stream or the connection's next request: a write or idle timeout on the
	// server would cut live streams and long Sends, and this is neither
	// (TestTheBodyReadDeadlineDoesNotReachTheHandlersOwnWork,
	// TestAStreamOutlivesTheBodyReadDeadline,
	// TestTheNextRequestOnAConnectionIsNotHeldToTheLastBodysDeadline). Ten
	// seconds is generous for 256 KiB on the slowest link the page is used on.
	BodyReadDeadline = 10 * time.Second
)

// readPlaces counts the bodies being read.
type readPlaces struct {
	held atomic.Int64
	max  int64
}

// take holds a place, or reports false when every place is held.
func (p *readPlaces) take() bool {
	for {
		n := p.held.Load()
		if n >= p.max {
			return false
		}
		if p.held.CompareAndSwap(n, n+1) {
			return true
		}
	}
}

// give hands a place back.
func (p *readPlaces) give() { p.held.Add(-1) }
