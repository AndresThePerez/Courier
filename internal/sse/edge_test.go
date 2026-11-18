package sse

import (
	"fmt"
	"sync"
	"testing"

	"github.com/AndresThePerez/courier/internal/runner"
)

// Ids rise by exactly one per event however many goroutines publish, and every
// subscriber, live or replayed, sees the same gapless sequence.
func TestIDsAreGaplessUnderConcurrentPublishing(t *testing.T) {
	b := New(nil)
	b.Reset("run-1")
	sub, err := b.SubscribeRun(0)
	if err != nil {
		t.Fatal(err)
	}

	// 60 events fit in the subscriber's buffer, so none is dropped however the
	// goroutines are scheduled.
	const writers, each = 6, 10
	var wg sync.WaitGroup
	for range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range each {
				b.Publish(runner.Event{Type: runner.EventRequestResult, RunID: "run-1", Data: i})
			}
		}()
	}
	wg.Wait()
	sub.Cancel()

	var got []uint64
	for e := range sub.Events {
		got = append(got, e.ID)
	}
	if len(got) != writers*each {
		t.Fatalf("subscriber saw %d events, want %d", len(got), writers*each)
	}
	for i, id := range got {
		if id != uint64(i+1) {
			t.Fatalf("event %d has id %d, want %d", i, id, i+1)
		}
	}
	if last, ok := b.LastID("run-1"); !ok || last != writers*each {
		t.Errorf("LastID = %d, %v, want %d", last, ok, writers*each)
	}
}

// The broadcaster remembers the last id of a bounded number of past runs, and
// asking about runs it never numbered neither answers nor makes it remember.
func TestPastRunMemoryIsBoundedAndNotClientDriven(t *testing.T) {
	b := New(nil)
	for i := range PastRuns + 20 {
		id := fmt.Sprintf("run-%d", i)
		b.Reset(id)
		b.Publish(runner.Event{Type: runner.EventRunStarted, RunID: id})
		b.Publish(runner.Event{Type: runner.EventRunFinished, RunID: id})
	}
	b.Reset("run-live")

	if n := len(b.past); n > PastRuns {
		t.Fatalf("remembers %d past runs, want at most %d", n, PastRuns)
	}
	if _, ok := b.LastID("run-0"); ok {
		t.Error("the oldest run is still remembered past the bound")
	}
	if id, ok := b.LastID(fmt.Sprintf("run-%d", PastRuns+19)); !ok || id != 2 {
		t.Errorf("newest past run: LastID = %d, %v, want 2", id, ok)
	}
	for i := range 5000 {
		if _, ok := b.LastID(fmt.Sprintf("never-existed-%d", i)); ok {
			t.Fatalf("LastID invented an id for a run that never existed")
		}
	}
	if n := len(b.past); n > PastRuns {
		t.Errorf("lookups grew the memory to %d runs", n)
	}
	// A run that published nothing is not remembered either.
	b.Reset("run-quiet")
	b.Reset("run-after-quiet")
	if _, ok := b.LastID("run-quiet"); ok {
		t.Error("a run with no events was given a remembered id")
	}
}

// Resuming from an id that is not this run's (older or newer than anything
// published) gives either the newer events or none, never a panic or events of
// an earlier run, and the live channel still delivers what follows.
func TestSubscribeRunWithAWildIDStillReceivesLiveEvents(t *testing.T) {
	b := New(nil)
	b.Reset("run-1")
	b.Publish(runner.Event{Type: runner.EventRunStarted, RunID: "run-1"})
	b.Reset("run-2")
	b.Publish(runner.Event{Type: runner.EventRunStarted, RunID: "run-2"})

	for _, after := range []uint64{0, 1, 2, 3, 1 << 40, ^uint64(0)} {
		sub, err := b.SubscribeRun(after)
		if err != nil {
			t.Fatal(err)
		}
		if sub.RunID != "run-2" {
			t.Errorf("after %d: RunID = %q", after, sub.RunID)
		}
		for _, e := range sub.Replay {
			if e.RunID != "run-2" || e.ID <= after {
				t.Errorf("after %d: replayed %+v", after, e)
			}
		}
		sub.Cancel()
		sub.Cancel() // idempotent
	}
	if n := b.Subscribers(); n != 0 {
		t.Errorf("subscribers = %d after every subscription was cancelled", n)
	}
}
