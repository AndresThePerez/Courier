// Package sse is Courier's event fan-out: one broadcaster per server, one
// buffered channel per subscriber, and a bounded replay log so that a mid-run
// reconnect — or a spectator who arrives late — sees complete state rather than
// whatever happens to come next.
//
// The broadcaster never blocks the run. Publish is called from the functional
// walker's goroutine and from the performance aggregator's 250ms ticker, and a
// browser that stops reading must not be able to slow either of them down.
package sse

import (
	"errors"
	"log/slog"
	"slices"
	"sync"

	"github.com/AndresThePerez/courier/internal/runner"
)

const (
	// ReplayCap bounds the replay log. A functional run emits at most 52
	// events (one start, 50 results, one finish), so the cap only ever bites
	// on performance progress — which is collapsed to latest-only anyway.
	ReplayCap = 512

	// MaxSubscribers is the ceiling on concurrent streams. Every other
	// resource in this design is capped; this fan-out is capped deliberately
	// rather than by accident. Past it, clients are told to poll.
	MaxSubscribers = 100

	// SubscriberBuffer is how far behind a subscriber may fall before it is
	// disconnected. 64 events is roughly 16 seconds of performance progress or
	// the whole of a functional run.
	SubscriberBuffer = 64
)

// Log event names. They follow internal/runner's vocabulary: an "event"
// attribute plus a "run_id" wherever one exists, so one jq filter returns a
// run's complete story including who was watching it.
const (
	// EventSubscribed and EventUnsubscribed are a viewer arriving and leaving.
	// The reason attribute on a disconnect distinguishes the browser closing
	// the stream from the broadcaster dropping a subscriber that fell behind.
	EventSubscribed   = "sse_subscribed"
	EventUnsubscribed = "sse_unsubscribed"

	// EventSubscriberRefused is the cap turning a viewer away.
	EventSubscriberRefused = "sse_subscriber_refused"
)

// Disconnect reasons, as they appear in the reason attribute.
const (
	ReasonClosed = "client_closed"
	ReasonSlow   = "slow_subscriber"
)

// ErrTooManySubscribers is returned by Subscribe past MaxSubscribers. The
// handler answers 503 {"poll": true}, which the client treats as an immediate
// fallback trigger rather than something to retry.
var ErrTooManySubscribers = errors.New("too many subscribers")

// Broadcaster fans one run's events out to every attached viewer.
//
// One mutex guards the subscriber set and the replay log together. They are
// updated together on every publish, and a subscriber that is dropped while a
// send is in flight is exactly the send-on-closed-channel panic that splitting
// them would invite.
type Broadcaster struct {
	log *slog.Logger

	mu     sync.Mutex
	subs   map[chan runner.Event]struct{}
	replay []runner.Event

	// progressAt indexes the single progress event in the replay log, or -1.
	// A reconnecting viewer wants the current counters, not a re-run of 120
	// stale ticks, so a new progress event replaces the old one instead of
	// appending beside it.
	progressAt int

	runID string
}

// New builds a broadcaster. The logger is passed explicitly rather than taken
// from a package global, the same rule internal/runner.NewManager follows; a
// nil logger is accepted and discarded so tests can pass nothing.
func New(log *slog.Logger) *Broadcaster {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Broadcaster{
		log:        log,
		subs:       map[chan runner.Event]struct{}{},
		progressAt: -1,
	}
}

// Reset clears the replay log for a new run. Subscribers stay attached: a
// spectator who watched the last run and left the tab open is a viewer of the
// next one, and dropping them would make every run start with a reconnect
// storm.
func (b *Broadcaster) Reset(runID string) {
	b.mu.Lock()
	b.replay = nil
	b.progressAt = -1
	b.runID = runID
	b.mu.Unlock()
}

// Publish records an event and fans it out. It never blocks.
//
// A subscriber whose buffer is full is disconnected, not starved. Dropping
// individual events for a slow viewer is quietly broken: a functional viewer
// loses result rows permanently with no signal, later events keep arriving so
// no liveness check ever fires, and the visitor sees holes in the results table
// that look like Courier bugs. Disconnecting self-heals for free, because
// EventSource reconnects on its own and the replay log restores complete state.
func (b *Broadcaster) Publish(e runner.Event) {
	b.mu.Lock()
	b.record(e)

	var dropped []chan runner.Event
	for ch := range b.subs {
		select {
		case ch <- e:
		default:
			dropped = append(dropped, ch)
		}
	}
	for _, ch := range dropped {
		b.drop(ch)
	}
	remaining, runID := len(b.subs), b.runID
	b.mu.Unlock()

	// Logged outside the lock: a slow log sink must not become the back
	// pressure the whole design exists to avoid.
	for range dropped {
		b.log.Info("sse subscriber dropped",
			"event", EventUnsubscribed,
			"run_id", runID,
			"reason", ReasonSlow,
			"subscribers", remaining)
	}
}

// Replay returns the events a viewer attaching now has missed. Callers that
// are also subscribing should use SubscribeReplay, which does both atomically.
func (b *Broadcaster) Replay() []runner.Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.Clone(b.replay)
}

// Subscribe attaches a viewer. The returned function detaches it and is safe to
// call more than once; the channel is closed on detach, so a reader can simply
// range over it.
func (b *Broadcaster) Subscribe() (<-chan runner.Event, func(), error) {
	_, ch, cancel, err := b.SubscribeReplay()
	return ch, cancel, err
}

// SubscribeReplay attaches a viewer and snapshots the replay log in the same
// critical section.
//
// Doing them separately is a real bug, not a tidiness point: an event published
// between the two calls lands in both the snapshot and the channel, and the
// viewer renders a duplicate result row that no run ever produced.
func (b *Broadcaster) SubscribeReplay() ([]runner.Event, <-chan runner.Event, func(), error) {
	b.mu.Lock()
	if len(b.subs) >= MaxSubscribers {
		runID := b.runID
		b.mu.Unlock()
		b.log.Info("sse subscriber refused",
			"event", EventSubscriberRefused,
			"run_id", runID,
			"subscribers", MaxSubscribers)
		return nil, nil, nil, ErrTooManySubscribers
	}

	ch := make(chan runner.Event, SubscriberBuffer)
	b.subs[ch] = struct{}{}
	history := slices.Clone(b.replay)
	n, runID := len(b.subs), b.runID
	b.mu.Unlock()

	b.log.Info("sse subscriber connected",
		"event", EventSubscribed,
		"run_id", runID,
		"subscribers", n,
		"replayed", len(history))

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			b.mu.Lock()
			present := b.drop(ch)
			remaining, runID := len(b.subs), b.runID
			b.mu.Unlock()
			if !present {
				// Already gone — dropped for falling behind, which logged its
				// own line with the reason that actually applies.
				return
			}
			b.log.Info("sse subscriber disconnected",
				"event", EventUnsubscribed,
				"run_id", runID,
				"reason", ReasonClosed,
				"subscribers", remaining)
		})
	}
	return history, ch, cancel, nil
}

// Subscribers is the live stream count, for /metrics.
func (b *Broadcaster) Subscribers() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}

// RunID is the run the replay log currently describes, or "" before the first
// run. A stream handler reads it to tell "this run's events are still here"
// from "the broadcaster has moved on to a later run".
func (b *Broadcaster) RunID() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.runID
}

// record appends to the replay log under the lock, collapsing progress to
// latest-only and trimming the oldest events past the cap.
func (b *Broadcaster) record(e runner.Event) {
	if e.Type == runner.EventProgress && b.progressAt >= 0 {
		b.replay = slices.Delete(b.replay, b.progressAt, b.progressAt+1)
		b.progressAt = -1
	}
	b.replay = append(b.replay, e)
	if e.Type == runner.EventProgress {
		b.progressAt = len(b.replay) - 1
	}
	if over := len(b.replay) - ReplayCap; over > 0 {
		b.replay = slices.Delete(b.replay, 0, over)
		if b.progressAt >= 0 {
			if b.progressAt -= over; b.progressAt < 0 {
				b.progressAt = -1
			}
		}
	}
}

// drop removes and closes a subscriber. It reports whether the subscriber was
// still attached, so a double detach neither closes a closed channel nor logs a
// disconnect twice. Must be called under the lock.
func (b *Broadcaster) drop(ch chan runner.Event) bool {
	if _, ok := b.subs[ch]; !ok {
		return false
	}
	delete(b.subs, ch)
	close(ch)
	return true
}
