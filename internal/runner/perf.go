package runner

import (
	"context"
	"sync"
	"time"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
	"github.com/AndresThePerez/courier/internal/template"
)

// ProgressInterval is the live-counter cadence. It is a ticker case in the
// aggregator's own select, not a second goroutine, so a snapshot can never be
// torn between reading a counter and reading a sample slice.
const ProgressInterval = 250 * time.Millisecond

// dispatch is one worker's report of one request, on its way to the aggregator.
type dispatch struct {
	index int
	resp  Response
}

// RunPerformance fans N workers out over the sequence for duration_secs and
// fans every result back into a single aggregator goroutine.
//
// Two contexts, deliberately. dispatchCtx carries the run's deadline and gates
// the *loop*; each request executes under ctx with the executor's own 10s
// timeout. That is what makes "at the deadline, no new dispatches, but in-flight
// requests complete and count" true. A single deadline context would cancel
// in-flight requests instead, turning honest tail latency into fake transport
// errors — and the wall clock would look tidy while the report lied. The
// overrun is recorded in Performance.OverrunMs instead of being hidden.
//
// Cancellation is different from expiry on purpose: it cancels ctx too (with
// ErrRunAborted as the cause), so in-flight requests are abandoned rather than
// awaited and each one contributes exactly one aborted dispatch — no sample, no
// error, no Apdex band. A visitor pressing Cancel must never look like a target
// failure.
func RunPerformance(ctx context.Context, ex *Executor, rr sandbox.RunRequest, emit Emitter) Result {
	emit = emitOr(emit)
	seq := rr.Sequence
	eps := resolve(seq)
	workers := rr.Options.Concurrency
	if workers < 1 {
		workers = 1
	}
	duration := time.Duration(rr.Options.DurationSecs) * time.Second

	start := time.Now()
	dispatchCtx, stopDispatch := context.WithDeadline(ctx, start.Add(duration))
	defer stopDispatch()

	emit(Event{Type: EventRunStarted, Data: RunStarted{
		Mode:      sandbox.ModePerformance,
		Total:     len(seq),
		StartedAt: start,
		Config:    configOf(rr.Options),
		Entries:   Entries(ex, seq),
	}})

	// Template entries draw per dispatch. Precomputed per entry: HasPlaceholder
	// is a map walk, and the hot loop's overhead budget is measured in
	// microseconds per dispatch — not a place to answer the same question
	// 18,000 times.
	tpl := make([]bool, len(seq))
	for i, r := range seq {
		tpl[i] = template.HasPlaceholder(r.Params)
	}

	// Buffered so a burst of completions does not serialise the workers behind
	// the aggregator; the aggregator drains until close, so a send can never
	// deadlock.
	results := make(chan dispatch, workers*8)
	tallies := make(chan []report.Tally)
	go aggregate(results, tallies, len(seq), start, emit)

	var wg sync.WaitGroup
	for w := range workers {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			// Worker w starts at its own offset and advances round-robin, so a
			// two-request sequence still spreads load across both.
			i := w % len(seq)
			for dispatchCtx.Err() == nil {
				rq := seq[i]
				if tpl[i] {
					rq = template.Expand(rq)
				}
				results <- dispatch{index: i, resp: ex.DoResolved(ctx, eps[i], rq, false)}
				i = (i + 1) % len(seq)
			}
		}(w)
	}

	// Shutdown order matters: workers finish, then the channel closes, then the
	// aggregator drains what is left and hands its tallies back. Closing before
	// the wait is the classic send-on-closed-channel panic.
	wg.Wait()
	close(results)
	all := <-tallies
	elapsed := time.Since(start)

	perf := &report.Performance{
		Overall:    report.ComputeStats(-1, "overall", all[0], elapsed),
		PerRequest: make([]report.Stats, len(seq)),
	}
	for i := range seq {
		perf.PerRequest[i] = report.ComputeStats(i, seq[i].Name, all[i+1], elapsed)
	}
	if over := elapsed - duration; over > 0 {
		perf.OverrunMs = over.Milliseconds()
	}

	status := perfStatus(ctx)
	if status == report.StatusCompleted {
		perf.Verdict, perf.VerdictReasons = report.Verdict(perf.Overall)
	} else {
		// A run stopped two seconds into thirty has not measured what the SLOs
		// describe. The percentiles, histogram, and throughput still render —
		// they are descriptive. Only the judgement is withheld.
		perf.Verdict = report.VerdictNA
		perf.VerdictReasons = []string{"partial data — the run did not reach its full duration"}
	}
	return Result{Status: status, Performance: perf}
}

// perfStatus distinguishes "we ran out of budgeted time" from "somebody stopped
// us". Reaching the deadline *is* completion in performance mode — expiry is a
// functional-mode status, where the deadline is a safety net rather than the
// point of the run.
func perfStatus(ctx context.Context) string {
	if ctx.Err() != nil {
		return report.StatusCancelled
	}
	return report.StatusCompleted
}

// aggregate owns every tally and every live counter. It is the only goroutine
// that touches them, which is why there is not an atomic or a mutex in sight:
// confinement gives for free what two synchronisation mechanisms were doing
// badly, and a progress snapshot is consistent by construction.
//
// tallies[0] is the overall scope; tallies[i+1] is sequence entry i.
func aggregate(results <-chan dispatch, out chan<- []report.Tally, entries int, start time.Time, emit Emitter) {
	all := make([]report.Tally, entries+1)

	// Running counters for the ticker. ComputeStats is ~1ms over 18k samples —
	// cheap enough per tick, but these are exact and free, and they keep the
	// promise that no percentile is computed mid-run.
	var (
		requests, errs, aborted, samples int
		sumMs                            float64
	)

	ticker := time.NewTicker(ProgressInterval)
	defer ticker.Stop()

	for {
		select {
		case d, ok := <-results:
			if !ok {
				out <- all
				return
			}
			requests++
			switch {
			case d.resp.Err == nil:
				all[0].AddResponse(d.resp.Status, d.resp.LatencyMs, d.resp.Size)
				all[d.index+1].AddResponse(d.resp.Status, d.resp.LatencyMs, d.resp.Size)
				samples++
				sumMs += d.resp.LatencyMs
				if d.resp.Status < 200 || d.resp.Status >= 300 {
					errs++
				}
			case d.resp.ErrKind == ErrKindAborted:
				// Courier killed this one. It is a dispatch and nothing else.
				all[0].AddAborted()
				all[d.index+1].AddAborted()
				aborted++
			default:
				all[0].AddTransportFailure(d.resp.ErrKind)
				all[d.index+1].AddTransportFailure(d.resp.ErrKind)
				errs++
			}

		case <-ticker.C:
			elapsed := time.Since(start)
			p := Progress{
				ElapsedMs: elapsed.Milliseconds(),
				Requests:  requests,
				Errors:    errs,
				Aborted:   aborted,
			}
			if secs := elapsed.Seconds(); secs > 0 {
				p.RPS = float64(requests) / secs
			}
			if samples > 0 {
				p.AvgLatencyMs = sumMs / float64(samples)
			}
			emit(Event{Type: EventProgress, Data: p})
		}
	}
}
