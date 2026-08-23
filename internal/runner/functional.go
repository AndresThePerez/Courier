package runner

import (
	"context"
	"time"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
	"github.com/AndresThePerez/courier/internal/template"
)

// FunctionalDeadline bounds a functional run's wall clock. Without it, fifty
// requests against a hung target could each burn the executor's 10s timeout and
// hold the global run lock for roughly eight minutes.
const FunctionalDeadline = 120 * time.Second

// RunFunctional walks a sequence in strict order: execute, measure, evaluate,
// emit, sleep, next. One goroutine, no concurrency, no surprises — the point of
// functional mode is that the sequence is reproducible.
func RunFunctional(ctx context.Context, ex *Executor, rr sandbox.RunRequest, emit Emitter) Result {
	return runFunctional(ctx, ex, rr, emit, FunctionalDeadline)
}

// runFunctional carries the deadline as a parameter so a test can prove the
// expiry behaviour without spending two minutes doing it.
//
// Two contexts, deliberately. dispatchCtx carries the wall-clock deadline and
// is checked *between* entries; each request executes under ctx with the
// executor's own 10s timeout. Putting the deadline on the request context
// instead would kill the in-flight request mid-body and record it as a
// transport error the target never caused — the same phantom-error bug the
// aborted-dispatch rule exists to prevent, arriving by a different door.
func runFunctional(ctx context.Context, ex *Executor, rr sandbox.RunRequest, emit Emitter, deadline time.Duration) Result {
	emit = emitOr(emit)
	seq := rr.Sequence
	eps := resolve(seq)

	dispatchCtx, stopDispatch := context.WithTimeout(ctx, deadline)
	defer stopDispatch()

	emit(Event{Type: EventRunStarted, Data: RunStarted{
		Mode:      sandbox.ModeFunctional,
		Total:     len(seq),
		StartedAt: time.Now(),
		Config:    configOf(rr.Options),
		Entries:   Entries(ex, seq),
	}})

	f := &report.Functional{Total: len(seq), Results: make([]report.RequestResult, 0, len(seq))}
	status := report.StatusCompleted
	delay := time.Duration(rr.Options.DelayMs) * time.Millisecond
	skipping := false

	for i, r := range seq {
		if !skipping {
			// Checked between entries, never during one: at expiry the request
			// already in flight runs to completion and counts normally.
			if s, done := stopReason(ctx, dispatchCtx); done {
				status, skipping = s, true
			}
		}
		if skipping {
			res := skippedResult(i, r, ex)
			f.Skipped++
			f.Results = append(f.Results, res)
			emit(Event{Type: EventRequestResult, Data: res})
			continue
		}

		// The delay separates requests; it does not trail the last one.
		if i > 0 && delay > 0 && !sleepCtx(ctx, delay) {
			status, skipping = report.StatusCancelled, true
			res := skippedResult(i, r, ex)
			f.Skipped++
			f.Results = append(f.Results, res)
			emit(Event{Type: EventRequestResult, Data: res})
			continue
		}

		// Expanded at dispatch, not at run start: a template entry repeated in a
		// sequence draws a fresh word each time it fires. The row is built from
		// the expanded request, so it records the word that was actually sent
		// while run_started keeps the literal template.
		rq := template.Expand(r)
		resp := ex.DoResolved(ctx, eps[i], rq, true)
		res := functionalResult(i, rq, ex, resp)

		switch {
		case res.Skipped: // Courier aborted this dispatch; not the target's fault.
			f.Skipped++
			status = report.StatusCancelled
			skipping = true
		case res.Passed:
			f.Passed++
		default:
			f.Failed++
			if rr.Options.StopOnFailure {
				skipping = true
			}
		}
		f.Results = append(f.Results, res)
		emit(Event{Type: EventRequestResult, Data: res})
	}

	return Result{Status: status, Functional: f}
}

// stopReason reports whether the walk must stop, and why. Cancellation is
// checked before expiry: a run cancelled in its final second is cancelled, not
// expired, and the two render differently in history.
func stopReason(ctx, dispatchCtx context.Context) (string, bool) {
	if ctx.Err() != nil {
		return report.StatusCancelled, true
	}
	if dispatchCtx.Err() != nil {
		return report.StatusExpired, true
	}
	return "", false
}

// sleepCtx waits for d, returning false if the run was stopped first.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// skippedResult builds the row for an entry the walk never dispatched.
//
// r is deliberately left unexpanded: a skipped template row reports the literal
// q={{randomPokemon}} while dispatched rows show the word that was actually
// sent. That visible seam is the honest reading — a request that never fired
// drew no word — and hoisting template.Expand above the skip branches to even it
// out would report a word Courier never sent, the phantom-reporting bug the
// aborted-dispatch rule exists to prevent.
func skippedResult(i int, r sandbox.Request, ex *Executor) report.RequestResult {
	return report.RequestResult{
		Index:      i,
		Name:       r.Name,
		Endpoint:   r.Endpoint,
		Query:      ex.Query(r),
		Skipped:    true,
		Assertions: []assert.Outcome{},
	}
}

// functionalResult turns one dispatch into a report row.
//
// An aborted dispatch is reported as skipped rather than failed: Courier killed
// it, so calling it a failure would let a visitor pressing Cancel manufacture a
// red row the target never earned. Assertions are still evaluated against a
// genuinely failed request — a "status eq 200" outcome reading "actual: 0" is
// far more useful than an empty assertion list beside an error string.
func functionalResult(i int, r sandbox.Request, ex *Executor, resp Response) report.RequestResult {
	res := report.RequestResult{
		Index:     i,
		Name:      r.Name,
		Endpoint:  r.Endpoint,
		Query:     ex.Query(r),
		Status:    resp.Status,
		LatencyMs: resp.LatencyMs,
		SizeBytes: resp.Size,
	}
	if resp.Err != nil {
		res.Error = resp.Err.Error()
		res.ErrorKind = resp.ErrKind
		if resp.ErrKind == ErrKindAborted {
			res.Skipped = true
			res.Assertions = []assert.Outcome{}
			return res
		}
	}

	preview, truncated := Preview(resp.Body)
	res.BodyPreview, res.BodyTruncated = preview, truncated

	target := assert.NewTarget(resp.Status, resp.LatencyMs, resp.Body)
	outcomes, allPassed := assert.EvaluateAll(r.Assertions, target)
	if outcomes == nil {
		outcomes = []assert.Outcome{}
	}
	res.Assertions = outcomes
	res.Passed = allPassed && resp.Err == nil
	return res
}

// Preview truncates to report.MaxBodyPreview.
//
// One truncation rule for *runs*, everywhere: this 16KB preview is what streams
// live and what is stored — a search response is 34-42KB, so truncation is the
// normal case, and a twenty-run history of untruncated bodies would be ~100MB.
// The editor's single Send is not a run and carries its own, larger cap
// (api.SendBodyMax): one body, held only by the response.
func Preview(body []byte) (string, bool) {
	return PreviewN(body, report.MaxBodyPreview)
}

// PreviewN truncates to max bytes, backing off a partial rune so the result is
// always valid UTF-8 and JSON encoding does not silently substitute a
// replacement character.
func PreviewN(body []byte, max int) (string, bool) {
	if len(body) == 0 {
		return "", false
	}
	if len(body) <= max {
		return string(body), false
	}
	cut := body[:max]
	for len(cut) > 0 && !utf8.Valid(cut) {
		cut = cut[:len(cut)-1]
	}
	return string(cut), true
}
