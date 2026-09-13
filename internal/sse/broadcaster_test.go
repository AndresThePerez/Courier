package sse

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/runner"
)

func result(i int) runner.Event {
	return runner.Event{Type: runner.EventRequestResult, RunID: "run-1", Data: i}
}

func progress(n int) runner.Event {
	return runner.Event{Type: runner.EventProgress, RunID: "run-1", Data: runner.Progress{Requests: n}}
}

func drain(ch <-chan runner.Event) []runner.Event {
	var out []runner.Event
	for e := range ch {
		out = append(out, e)
	}
	return out
}

func TestTwoSubscribersBothReceive(t *testing.T) {
	b := New(nil)
	a, cancelA, err := b.Subscribe()
	if err != nil {
		t.Fatalf("subscribe a: %v", err)
	}
	c, cancelC, err := b.Subscribe()
	if err != nil {
		t.Fatalf("subscribe c: %v", err)
	}

	for i := range 3 {
		b.Publish(result(i))
	}
	cancelA()
	cancelC()

	for name, got := range map[string][]runner.Event{"a": drain(a), "c": drain(c)} {
		if len(got) != 3 {
			t.Fatalf("subscriber %s got %d events, want 3", name, len(got))
		}
		for i, e := range got {
			if e.Data != i {
				t.Errorf("subscriber %s event %d = %v, want %d (out of order)", name, i, e.Data, i)
			}
		}
	}
}

// A slow subscriber is disconnected, not starved. A subscriber that silently
// keeps receiving a subset is the failure mode this rule exists to prevent:
// the viewer ends up with holes in the results table and no signal that
// anything went wrong.
func TestSlowSubscriberIsDisconnectedNotStarved(t *testing.T) {
	b := New(nil)
	fast, cancelFast, err := b.Subscribe()
	if err != nil {
		t.Fatalf("subscribe fast: %v", err)
	}
	defer cancelFast()
	slow, cancelSlow, err := b.Subscribe()
	if err != nil {
		t.Fatalf("subscribe slow: %v", err)
	}
	defer cancelSlow()

	// The fast subscriber is read after every publish, so it never falls
	// behind; the slow one is never read at all. Interleaving the reads makes
	// this deterministic rather than a race between two goroutines.
	const n = 10_000
	start := time.Now()
	var got []runner.Event
	for i := range n {
		b.Publish(result(i))
		select {
		case e, ok := <-fast:
			if !ok {
				t.Fatalf("the fast subscriber was disconnected at event %d", i)
			}
			got = append(got, e)
		default:
			t.Fatalf("the fast subscriber missed event %d", i)
		}
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("publishing %d events took %s — a stalled subscriber is back-pressuring the run", n, elapsed)
	}

	if len(got) != n {
		t.Fatalf("the fast subscriber got %d events, want %d", len(got), n)
	}
	for i, e := range got {
		if e.Data != i {
			t.Fatalf("fast subscriber event %d = %v, want %d", i, e.Data, i)
		}
	}

	select {
	case _, ok := <-slow:
		// Buffered events drain first; the channel must be closed underneath.
		for ok {
			_, ok = <-slow
		}
	default:
		t.Fatal("the slow subscriber's channel is neither closed nor holding buffered events")
	}
	if b.Subscribers() != 1 {
		t.Errorf("Subscribers() = %d, want 1 (the slow one should be gone)", b.Subscribers())
	}
}

func TestSubscriberCap(t *testing.T) {
	b := New(nil)
	cancels := make([]func(), 0, MaxSubscribers)
	for i := range MaxSubscribers {
		_, cancel, err := b.Subscribe()
		if err != nil {
			t.Fatalf("subscriber %d: %v", i, err)
		}
		cancels = append(cancels, cancel)
	}
	if _, _, err := b.Subscribe(); !errors.Is(err, ErrTooManySubscribers) {
		t.Fatalf("subscriber %d: err = %v, want ErrTooManySubscribers", MaxSubscribers+1, err)
	}

	// A departure frees a slot; the cap is a ceiling, not a lifetime quota.
	cancels[0]()
	if _, _, err := b.Subscribe(); err != nil {
		t.Fatalf("after one subscriber left: %v", err)
	}
	for _, cancel := range cancels[1:] {
		cancel()
	}
}

func TestReplayCapAndLatestOnlyProgress(t *testing.T) {
	b := New(nil)
	const n = ReplayCap + 100
	for i := range n {
		b.Publish(result(i))
	}
	log := b.Replay()
	if len(log) != ReplayCap {
		t.Fatalf("len(Replay()) = %d, want %d", len(log), ReplayCap)
	}
	if first := log[0].Data; first != n-ReplayCap {
		t.Errorf("oldest replayed event = %v, want %d — the cap must drop the oldest, not the newest", first, n-ReplayCap)
	}
	if last := log[len(log)-1].Data; last != n-1 {
		t.Errorf("newest replayed event = %v, want %d", last, n-1)
	}

	// Progress replays latest-only: a reconnecting viewer wants the current
	// counters, not a re-run of every stale tick.
	b.Reset("run-2")
	b.Publish(runner.Event{Type: runner.EventRunStarted, RunID: "run-2"})
	for i := 1; i <= 200; i++ {
		b.Publish(progress(i))
	}
	log = b.Replay()
	if len(log) != 2 {
		t.Fatalf("len(Replay()) = %d, want 2 (run_started + the latest progress)", len(log))
	}
	if log[0].Type != runner.EventRunStarted {
		t.Errorf("replay[0].Type = %q, want %q", log[0].Type, runner.EventRunStarted)
	}
	p, ok := log[1].Data.(runner.Progress)
	if !ok {
		t.Fatalf("replay[1].Data = %T, want runner.Progress", log[1].Data)
	}
	if p.Requests != 200 {
		t.Errorf("replayed progress.Requests = %d, want 200 (the latest tick)", p.Requests)
	}
}

func TestUnsubscribeStopsDelivery(t *testing.T) {
	b := New(nil)
	ch, cancel, err := b.Subscribe()
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	b.Publish(result(0))
	cancel()
	cancel() // idempotent: a handler may unsubscribe on both exit paths

	if got := drain(ch); len(got) != 1 {
		t.Fatalf("drained %d events, want the 1 published before unsubscribing", len(got))
	}
	// Publishing to nobody must not panic on a closed channel.
	b.Publish(result(1))
	if b.Subscribers() != 0 {
		t.Errorf("Subscribers() = %d, want 0", b.Subscribers())
	}
}

func TestReplayGivesMidRunState(t *testing.T) {
	b := New(nil)
	b.Reset("run-1")
	for i := range 3 {
		b.Publish(result(i))
	}

	history, ch, cancel, err := b.SubscribeReplay()
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if len(history) != 3 {
		t.Fatalf("replayed %d events, want 3 — a spectator must see what it missed", len(history))
	}
	b.Publish(result(3))
	select {
	case e := <-ch:
		if e.Data != 3 {
			t.Errorf("live event after replay = %v, want 3", e.Data)
		}
	case <-time.After(time.Second):
		t.Fatal("no live event after the replay")
	}
	cancel()

	b.Reset("run-2")
	if got := b.Replay(); len(got) != 0 {
		t.Errorf("after Reset, Replay() has %d events, want 0", len(got))
	}
}

func TestConcurrentPublishAndSubscribe(t *testing.T) {
	b := New(nil)
	var wg sync.WaitGroup
	stop := make(chan struct{})

	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; ; i++ {
				select {
				case <-stop:
					return
				default:
				}
				b.Publish(result(i))
			}
		}()
	}
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				ch, cancel, err := b.Subscribe()
				if err != nil {
					continue
				}
				select {
				case <-ch:
				default:
				}
				cancel()
			}
		}()
	}

	time.Sleep(150 * time.Millisecond)
	close(stop)
	wg.Wait()
	if n := b.Subscribers(); n != 0 {
		t.Errorf("Subscribers() = %d after everyone left, want 0", n)
	}
}

// A subscriber connecting and disconnecting is part of the run's log trail, in
// the same "event" + "run_id" vocabulary internal/runner uses.
func TestSubscriberLifecycleIsLogged(t *testing.T) {
	var buf bytes.Buffer
	b := New(slog.New(slog.NewJSONHandler(&buf, nil)))
	b.Reset("run-1")

	_, cancel, err := b.Subscribe()
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	cancel()

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d log lines, want 2 (connect + disconnect):\n%s", len(lines), buf.String())
	}
	want := []struct{ event, reason string }{
		{EventSubscribed, ""},
		{EventUnsubscribed, ReasonClosed},
	}
	for i, line := range lines {
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("line %d is not JSON: %v", i, err)
		}
		if rec["event"] != want[i].event {
			t.Errorf("line %d event = %v, want %q", i, rec["event"], want[i].event)
		}
		if rec["run_id"] != "run-1" {
			t.Errorf("line %d run_id = %v, want run-1", i, rec["run_id"])
		}
		if want[i].reason != "" && rec["reason"] != want[i].reason {
			t.Errorf("line %d reason = %v, want %q", i, rec["reason"], want[i].reason)
		}
	}
}

// The broadcaster is the manager's Publisher. If that ever stops being true the
// compiler should say so here, not in cmd/server.
var _ runner.Publisher = (*Broadcaster)(nil)
