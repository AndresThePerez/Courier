package runner

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/report"
)

// The wait restarts from its first step after any answer in the middle of a
// run of refusals, a 500 included, and after a timeout.
func TestBackoffRestartsAfterAnAnswerInTheMiddleOfRefusals(t *testing.T) {
	refused := Response{Err: errors.New("dial: connection refused"), ErrKind: ErrKindConnection}
	answered := Response{Status: 500}
	timedOut := Response{Err: errors.New("deadline"), ErrKind: ErrKindTimeout}
	ms := time.Millisecond

	steps := []struct {
		r    Response
		want time.Duration
	}{
		{refused, 10 * ms}, {refused, 20 * ms}, {refused, 40 * ms},
		{answered, 0},
		{refused, 10 * ms}, {refused, 20 * ms},
		{timedOut, 0},
		{refused, 10 * ms},
	}
	var wait time.Duration
	for i, s := range steps {
		wait = nextBackoff(wait, s.r)
		if wait != s.want {
			t.Fatalf("step %d: wait = %v, want %v", i, wait, s.want)
		}
	}
	if got := nextBackoff(BackoffMax, refused); got != BackoffMax {
		t.Errorf("a refusal at the cap waits %v, want it held at %v", got, BackoffMax)
	}
}

// Cancelling a run whose workers are all parked in their wait ends it
// promptly, still completes the accounting identity, and leaves nothing
// aborted: a worker that is waiting has no dispatch for Courier to kill.
func TestPerfCancelWhileEveryWorkerIsBackedOff(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	addr := srv.URL
	srv.Close()

	ctx, cancel := context.WithCancelCause(context.Background())
	done := make(chan Result, 1)
	start := time.Now()
	go func() {
		done <- RunPerformance(ctx, NewExecutor(addr), perfRun(oneRequest(), 4, 60), nil)
	}()
	// Long enough for the waits to have climbed past their first steps.
	time.Sleep(600 * time.Millisecond)
	cancel(ErrRunAborted)

	select {
	case res := <-done:
		if elapsed := time.Since(start); elapsed > 20*time.Second {
			t.Errorf("a cancelled run took %s to end", elapsed)
		}
		if res.Status != report.StatusCancelled {
			t.Errorf("status = %q, want cancelled", res.Status)
		}
		o := res.Performance.Overall
		if o.Requests != o.OK+o.Errors+o.Aborted {
			t.Errorf("requests %d != ok %d + errors %d + aborted %d", o.Requests, o.OK, o.Errors, o.Aborted)
		}
		if o.Requests == 0 || o.Requests > 100 {
			t.Errorf("requests = %d in 0.6s from 4 workers against a refused port", o.Requests)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the run did not end after Cancel while its workers were waiting")
	}
}
