package runner

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// refusalLog keeps the running_run_id of every busy refusal it is handed.
type refusalLog struct {
	mu  sync.Mutex
	ids []string
}

func (h *refusalLog) Enabled(context.Context, slog.Level) bool { return true }
func (h *refusalLog) WithAttrs([]slog.Attr) slog.Handler       { return h }
func (h *refusalLog) WithGroup(string) slog.Handler            { return h }
func (h *refusalLog) Handle(_ context.Context, r slog.Record) error {
	var refused bool
	var id string
	r.Attrs(func(a slog.Attr) bool {
		switch a.Key {
		case "event":
			refused = a.Value.String() == EventRunRefused
		case "running_run_id":
			id = a.Value.String()
		}
		return true
	})
	if refused {
		h.mu.Lock()
		h.ids = append(h.ids, id)
		h.mu.Unlock()
	}
	return nil
}

// Starts refused while runs begin and end around them each name a run that was
// really in progress, never an empty or torn id, under -race.
func TestRefusedStartsNameARealRunWhileRunsComeAndGo(t *testing.T) {
	logs := &refusalLog{}
	m, clk, _ := newTestManager(t, "http://target.invalid")
	m.log = slog.New(logs)
	finish := make(chan struct{})
	m.run = func(ctx context.Context, _ *Executor, _ sandbox.RunRequest, _ Emitter) Result {
		select {
		case <-finish:
		case <-ctx.Done():
		}
		return Result{Status: report.StatusCompleted}
	}

	started := map[string]bool{}
	var mu sync.Mutex
	const rounds, racers, tries = 20, 8, 10
	for round := range rounds {
		clk.Advance(time.Hour)
		id, err := m.Start(context.Background(), functionalRun())
		if err != nil {
			t.Fatalf("round %d: Start = %v", round, err)
		}
		mu.Lock()
		started[id] = true
		mu.Unlock()

		var wg sync.WaitGroup
		extra := make(chan struct{}, racers*tries)
		for range racers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for range tries {
					id, err := m.Start(context.Background(), functionalRun())
					switch {
					case err == nil:
						mu.Lock()
						started[id] = true
						mu.Unlock()
						extra <- struct{}{}
					case errors.Is(err, ErrBusy), errors.Is(err, ErrCoolingDown):
					default:
						t.Errorf("Start = %v, want ErrBusy or a cooldown", err)
					}
				}
			}()
		}
		finish <- struct{}{}
		wg.Wait()
		close(extra)
		for range extra {
			finish <- struct{}{}
		}
		m.Wait()
	}

	logs.mu.Lock()
	defer logs.mu.Unlock()
	if len(logs.ids) == 0 {
		t.Fatal("no start was refused as busy; the race was never run")
	}
	for _, id := range logs.ids {
		if !started[id] {
			t.Errorf("a refused start named run %q, which never started", id)
		}
	}
}
