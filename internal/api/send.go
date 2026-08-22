package api

import (
	"errors"
	"net/http"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// sendResult is the editor's Send response: one request, one response, and the
// assertion outcomes evaluated against it.
//
// It is deliberately shaped like a functional row rather than like a raw
// response — the editor and the results table then render the same thing, and a
// visitor who presses Send sees exactly what a run would have recorded.
type sendResult struct {
	Endpoint      string           `json:"endpoint"`
	Query         string           `json:"query"`
	Status        int              `json:"status"`
	LatencyMs     float64          `json:"latency_ms"`
	SizeBytes     int              `json:"size_bytes"`
	Body          string           `json:"body"`
	BodyTruncated bool             `json:"body_truncated"`
	Assertions    []assert.Outcome `json:"assertions"`
	Passed        bool             `json:"passed"`
	Error         string           `json:"error,omitempty"`
	ErrorKind     string           `json:"error_kind,omitempty"`
}

// handleSend executes a single request.
//
// It is not gated by the run lock — one request is not a run, and making the
// editor unusable while somebody else's collection walks would be a strange
// product — but it is limited to one in flight globally, so it cannot be turned
// into a load generator by a for loop in a browser console. The 429 is
// deliberate and distinct from the run lock's 409: a busy send is a rate limit,
// a busy run is a state conflict, and the UI says different things about them.
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	var req sandbox.Request
	if !decodeJSON(w, r, &req) {
		return
	}
	// The same validator a run payload passes through. A curated request, a
	// visitor-edited request, and a one-off Send are held to identical rules —
	// the sandbox has exactly one door.
	clean, err := sandbox.ValidateRequest(req)
	if err != nil {
		var ve sandbox.ValidationError
		if errors.As(err, &ve) {
			writeError(w, http.StatusBadRequest, ve.Field, "%s", ve.Message)
			return
		}
		writeError(w, http.StatusBadRequest, "", "%s", err.Error())
		return
	}

	if !s.sending.CompareAndSwap(false, true) {
		s.metrics.sendRefused()
		writeError(w, http.StatusTooManyRequests, "", "a send is already in flight; one at a time keeps this from becoming a load generator")
		return
	}
	defer s.sending.Store(false)

	// The request context, not the run context: a send belongs to the visitor
	// who asked for it, and if they navigate away there is no reason to keep
	// loading the target on their behalf.
	start := s.now()
	resp := s.ex.Do(r.Context(), clean, true)

	// A send debits the same ledger runs draw on. Gating runs while leaving an
	// ungated path to the same target would be incoherent. It never opens a
	// cooldown window of its own — see budget.Debit — it simply makes the next
	// run's cooldown a little longer.
	s.mgr.Budget().Debit(s.now().Sub(start).Seconds())
	s.metrics.sendCompleted()

	out := sendResult{
		Endpoint:  clean.Endpoint,
		Query:     s.ex.Query(clean),
		Status:    resp.Status,
		LatencyMs: resp.LatencyMs,
		SizeBytes: resp.Size,
	}
	if resp.Err != nil {
		out.Error, out.ErrorKind = resp.Err.Error(), resp.ErrKind
	}
	out.Body, out.BodyTruncated = runner.Preview(resp.Body)

	target := assert.NewTarget(resp.Status, resp.LatencyMs, resp.Body)
	outcomes, allPassed := assert.EvaluateAll(clean.Assertions, target)
	if outcomes == nil {
		outcomes = []assert.Outcome{}
	}
	out.Assertions = outcomes
	out.Passed = allPassed && resp.Err == nil

	s.log.Info("send executed",
		"event", EventSendExecuted,
		"endpoint", out.Endpoint,
		"query", out.Query,
		"status", out.Status,
		"latency_ms", out.LatencyMs,
		"passed", out.Passed,
		"err", out.Error)

	writeJSON(w, http.StatusOK, out)
}
