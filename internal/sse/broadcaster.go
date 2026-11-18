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

	// PastRuns is how many finished runs keep their last event id after the
	// log has moved on. It covers the manager's history of 20 with room to
	// spare, so every run a viewer can still open a stream on has one.
	PastRuns = 32
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

	// seq is the id of the last event published for runID. Ids start at 1 for
	// each run, which is what lets a reconnecting viewer's Last-Event-ID
	// resume within the run its stream URL names.
	seq uint64

	// past holds the last id of earlier runs, oldest first.
	past []pastRun
}

type pastRun struct {
	runID  string
	lastID uint64
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

// Reset clears the replay log for a new run. It detaches nobody: a stream is
// tied to one run, and its handler ends it after writing that run's terminal
// event, so a viewer never carries a subscriber slot from one run into the
// next.
func (b *Broadcaster) Reset(runID string) {
	b.mu.Lock()
	if b.runID != "" && b.seq > 0 {
		b.past = append(b.past, pastRun{b.runID, b.seq})
		if over := len(b.past) - PastRuns; over > 0 {
			b.past = slices.Delete(b.past, 0, over)
		}
	}
	b.replay = nil
	b.progressAt = -1
	b.runID = runID
	b.seq = 0
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
//
// Publish numbers the event: ids rise by one per event within a run, so the
// replay log and every live subscriber see the same id for the same event.
func (b *Broadcaster) Publish(e runner.Event) {
	b.mu.Lock()
	b.seq++
	e.ID = b.seq
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
	sub, err := b.SubscribeRun(0)
	if err != nil {
		return nil, nil, nil, err
	}
	return sub.Replay, sub.Events, sub.Cancel, nil
}

// Subscription is one attached viewer: the replay snapshot, the run that
// snapshot describes, and the live channel, all taken in one critical section.
type Subscription struct {
	// RunID is the run the replay log described at the moment of attaching. A
	// stream handler compares it with the run it was asked for: if a later run
	// has already reset the log, the requested run is over and nothing on this
	// subscription will ever say so.
	RunID  string
	Replay []runner.Event
	// Terminal is the run's run_finished when the log holds one, whether or
	// not Replay includes it. A viewer that saw it and reconnected anyway must
	// still be told the run is over rather than left waiting on a quiet run.
	Terminal *runner.Event
	Events   <-chan runner.Event
	// Cancel detaches the viewer. It is safe to call more than once.
	Cancel func()
}

// SubscribeRun is SubscribeReplay that also reports which run the replay
// describes, read under the same lock. The replay holds only events with an id
// above after, the Last-Event-ID of a reconnecting viewer (0 for everything).
// The coalesced progress event is included when its own id is above after.
func (b *Broadcaster) SubscribeRun(after uint64) (Subscription, error) {
	b.mu.Lock()
	if len(b.subs) >= MaxSubscribers {
		runID := b.runID
		b.mu.Unlock()
		b.log.Info("sse subscriber refused",
			"event", EventSubscriberRefused,
			"run_id", runID,
			"subscribers", MaxSubscribers)
		return Subscription{}, ErrTooManySubscribers
	}

	ch := make(chan runner.Event, SubscriberBuffer)
	b.subs[ch] = struct{}{}
	var history []runner.Event
	var terminal *runner.Event
	for _, e := range b.replay {
		if e.ID > after {
			history = append(history, e)
		}
		if e.Type == runner.EventRunFinished {
			t := e
			terminal = &t
		}
	}
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
	return Subscription{RunID: runID, Replay: history, Terminal: terminal, Events: ch, Cancel: cancel}, nil
}

// Subscribers is the live stream count, for /metrics.
func (b *Broadcaster) Subscribers() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}

// LastID is the id of the last event published for runID, for a terminal
// event rebuilt after the log has moved on. It reports false for a run the
// broadcaster never numbered an event for, or one too old to remember.
func (b *Broadcaster) LastID(runID string) (uint64, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if runID == b.runID && b.seq > 0 {
		return b.seq, true
	}
	for i := len(b.past) - 1; i >= 0; i-- {
		if b.past[i].runID == runID {
			return b.past[i].lastID, true
		}
	}
	return 0, false
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
