package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/AndresThePerez/courier/internal/pdf"
	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sandbox"
	"github.com/AndresThePerez/courier/internal/sse"
)

// Heartbeat is how often an idle stream emits a `: ping` comment.
//
// Two jobs, and the second is the one that sets the interval: it stops proxies
// and the Cloudflare tunnel reaping an idle stream, and it gives the client a
// liveness signal that does not depend on run activity. The client's fallback
// trigger is "no bytes for 5s", so the heartbeat has to be comfortably inside
// that — a functional run against a slow target can legitimately emit no
// events for far longer than 5s and must not be mistaken for a dead stream.
const Heartbeat = 2 * time.Second

// conflictBody is the 409 for POST /api/runs. Exactly one of RunID and
// CooldownUntil is set and the UI branches on which: a live run offers
// spectator mode, a cooldown offers a countdown. Keeping them in one shape with
// both optional is what lets the client make that decision from the body alone.
type conflictBody struct {
	Error         string     `json:"error"`
	RunID         string     `json:"run_id,omitempty"`
	CooldownUntil *time.Time `json:"cooldown_until,omitempty"`
}

// startedBody is the 202. The client opens the stream with this id.
type startedBody struct {
	RunID string `json:"run_id"`
}

// historyEntry is one row of GET /api/runs. It is a summary, not a report: the
// history rail lists runs, and clicking one fetches GET /api/runs/{id}.
type historyEntry struct {
	ID         string    `json:"id"`
	Mode       string    `json:"mode"`
	Status     string    `json:"status"`
	StartedAt  time.Time `json:"started_at"`
	DurationMs int64     `json:"duration_ms"`
	Verdict    string    `json:"verdict,omitempty"`
	Summary    string    `json:"summary"`
}

// handleStartRun validates a payload, admits it, and returns immediately. The
// run proceeds on its own goroutine under the server's run context, so it
// survives this request — and every subscriber — going away.
func (s *Server) handleStartRun(w http.ResponseWriter, r *http.Request) {
	var rr sandbox.RunRequest
	if !decodeJSON(w, r, &rr) {
		return
	}

	id, err := s.mgr.Start(s.runCtx, rr)
	switch {
	case err == nil:
		s.metrics.runStarted()
		writeJSON(w, http.StatusAccepted, startedBody{RunID: id})

	case isValidationError(err):
		var ve sandbox.ValidationError
		errors.As(err, &ve)
		writeError(w, http.StatusBadRequest, ve.Field, "%s", ve.Message)

	case errors.Is(err, runner.ErrBusy):
		// The live run's id rides along so the second visitor can be offered
		// spectator mode rather than only a disabled button.
		writeJSON(w, http.StatusConflict, conflictBody{
			Error: runner.ErrBusy.Error(),
			RunID: s.mgr.Status().RunID,
		})

	case errors.Is(err, runner.ErrCoolingDown):
		// The countdown target comes from the server, so N tabs count down the
		// same instant instead of each inferring one.
		var ce *runner.CooldownError
		errors.As(err, &ce)
		until := ce.Until
		writeJSON(w, http.StatusConflict, conflictBody{
			Error:         runner.ErrCoolingDown.Error(),
			CooldownUntil: &until,
		})

	default:
		writeError(w, http.StatusInternalServerError, "", "%s", err.Error())
	}
}

// handleCancelRun stops the live run. Any visitor may cancel, spectators
// included: cancelling only ever reduces load, and a spectator watching a stuck
// run they cannot stop is the worse experience.
//
// A finished run is not cancellable, which is why an unknown id and a completed
// id answer the same 404 — from the client's point of view they are the same
// fact: there is nothing there to stop.
func (s *Server) handleCancelRun(w http.ResponseWriter, r *http.Request) {
	if err := s.mgr.Cancel(r.PathValue("id")); err != nil {
		writeError(w, http.StatusNotFound, "", "%s", err.Error())
		return
	}
	s.metrics.runCancelled()
	w.WriteHeader(http.StatusNoContent)
}

// handleGetRun serves a run report. While the run is live this is a coherent
// partial report with no body previews — the polling fallback's contract.
func (s *Server) handleGetRun(w http.ResponseWriter, r *http.Request) {
	rep, ok := s.mgr.Report(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "", "no run %q", r.PathValue("id"))
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// handleReportPDF serves the same report handleGetRun serves, rendered.
//
// It 404s on exactly what handleGetRun 404s on — an id the manager has never
// heard of — because from the client's side those are the same fact: there is
// nothing to download. A run still in flight renders its partial report, which
// is the polling fallback's contract in another format; the page says
// "running" and withholds the verdict rather than pretending to a judgement.
//
// The render is synchronous and small (a single page, a few kilobytes, no
// image decoding), so it is done on the request goroutine rather than cached.
func (s *Server) handleReportPDF(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rep, ok := s.mgr.Report(id)
	if !ok {
		writeError(w, http.StatusNotFound, "", "no run %q", id)
		return
	}

	out, err := pdf.Render(rep)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "render report: %s", err.Error())
		return
	}

	h := w.Header()
	h.Set("Content-Type", "application/pdf")
	h.Set("Content-Length", strconv.Itoa(len(out)))
	// The run id is sanitised by Filename; it is server-generated, but a header
	// is the wrong place to find that out the hard way.
	h.Set("Content-Disposition", `attachment; filename="`+pdf.Filename(rep.ID)+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out)
}

// handleHistory lists finished runs, newest first.
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	hist := s.mgr.History()
	out := make([]historyEntry, 0, len(hist))
	for _, rep := range hist {
		out = append(out, historyEntry{
			ID:         rep.ID,
			Mode:       rep.Mode,
			Status:     rep.Status,
			StartedAt:  rep.StartedAt,
			DurationMs: rep.DurationMs,
			Verdict:    verdictOf(rep),
			Summary:    summarize(rep),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": out})
}

// handleStream is the SSE endpoint.
//
// Transport hygiene matters more here than anywhere else in the server: no
// gzip (buffering silently kills streaming, including through the Cloudflare
// tunnel), a flush after every event, and a heartbeat so an idle stream is
// never mistaken for a dead one.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rep, ok := s.mgr.Report(id)
	if !ok {
		writeError(w, http.StatusNotFound, "", "no run %q", id)
		return
	}

	// A finished run whose events the broadcaster no longer holds still gets a
	// terminal event rather than an empty stream: without one the client cannot
	// tell "this run is over" from "the stream died", which is precisely the
	// distinction the polling fallback has to make.
	if rep.Status != report.StatusRunning && s.bus.RunID() != id {
		s.streamHeaders(w)
		rc := http.NewResponseController(w)
		_ = writeEvent(w, rc, s.terminalEvent(rep))
		return
	}

	history, events, unsubscribe, err := s.bus.SubscribeReplay()
	if err != nil {
		// The one deliberate ceiling on this fan-out. {"poll": true} is an
		// immediate fallback trigger, not something the client should retry.
		writeJSON(w, http.StatusServiceUnavailable, errorBody{
			Error: sse.ErrTooManySubscribers.Error(),
			Poll:  true,
		})
		return
	}
	defer unsubscribe()

	s.streamHeaders(w)
	rc := http.NewResponseController(w)
	w.WriteHeader(http.StatusOK)
	if err := rc.Flush(); err != nil {
		return
	}

	// Replay first: a spectator arriving mid-run, or a reconnecting viewer,
	// gets complete state before the first live event.
	for _, e := range history {
		if !belongsTo(e, id) {
			continue
		}
		if err := writeEvent(w, rc, e); err != nil {
			return
		}
	}

	ping := time.NewTicker(Heartbeat)
	defer ping.Stop()
	for {
		select {
		case e, open := <-events:
			if !open {
				// Dropped for falling behind. EventSource reconnects on its own
				// and the replay log restores what was missed.
				return
			}
			if !belongsTo(e, id) {
				continue
			}
			if err := writeEvent(w, rc, e); err != nil {
				return
			}

		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}

		case <-r.Context().Done():
			// The viewer left. The run keeps going.
			return

		case <-s.done:
			// Shutdown. Returning here is what lets http.Server.Shutdown
			// finish instead of waiting on a stream that never ends.
			return
		}
	}
}

func (s *Server) streamHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// Nginx and several tunnels buffer proxied responses by default, which
	// turns a live stream into one delivery at the end.
	h.Set("X-Accel-Buffering", "no")
}

// writeEvent renders one event in SSE wire format and flushes it.
//
// Both the event name and the full envelope are sent: the name lets a client
// use addEventListener per type, and the envelope carries type and run_id so a
// single handler can switch on Type instead. json.Marshal never emits a raw
// newline, so one data: line is always enough.
func writeEvent(w http.ResponseWriter, rc *http.ResponseController, e runner.Event) error {
	payload, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Type, payload); err != nil {
		return err
	}
	return rc.Flush()
}

// terminalEvent reconstructs run_finished from a stored report, for a viewer
// who attached after the broadcaster moved on.
func (s *Server) terminalEvent(rep *report.Report) runner.Event {
	var cooldown time.Time
	if until := s.mgr.Status().CooldownUntil; until != nil {
		cooldown = *until
	}
	return runner.Event{
		Type:  runner.EventRunFinished,
		RunID: rep.ID,
		Data: runner.RunFinished{
			Status:        rep.Status,
			DurationMs:    rep.DurationMs,
			Verdict:       verdictOf(rep),
			CooldownUntil: cooldown,
		},
	}
}

// belongsTo keeps a stream to the run it asked for. The manager stamps every
// event with its run id; an unstamped event (there are none today) is passed
// through rather than silently dropped.
func belongsTo(e runner.Event, id string) bool { return e.RunID == "" || e.RunID == id }

func isValidationError(err error) bool {
	var ve sandbox.ValidationError
	return errors.As(err, &ve)
}

func verdictOf(rep *report.Report) string {
	if rep.Performance == nil {
		return ""
	}
	return rep.Performance.Verdict
}

// summarize is the one-line history label. Functional runs are counted, not
// judged; performance runs carry the number the verdict was made on.
func summarize(rep *report.Report) string {
	switch {
	case rep.Functional != nil:
		f := rep.Functional
		return fmt.Sprintf("%d passed / %d failed / %d skipped", f.Passed, f.Failed, f.Skipped)
	case rep.Performance != nil:
		o := rep.Performance.Overall
		return fmt.Sprintf("%d requests, p95 %.1fms, %s", o.Requests, o.Latency.P95, rep.Performance.Verdict)
	default:
		return rep.Status
	}
}
