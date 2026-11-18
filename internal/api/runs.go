package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/AndresThePerez/courier/internal/assert"
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

// ReconnectDelay is the retry: a stream sends after its run's terminal event,
// just before it ends. The client closes its EventSource on run_finished; a
// client that does not would otherwise reconnect every few seconds, each time
// to be told the same thing, so the server asks it to wait a minute first.
const ReconnectDelay = 60 * time.Second

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
//
// Truncated names the payload strings that were cut to a length cap, in the
// validator's field notation (sequence[0].params.q); absent when none were.
type startedBody struct {
	RunID     string   `json:"run_id"`
	Truncated []string `json:"truncated,omitempty"`
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
		writeJSON(w, http.StatusAccepted, startedBody{RunID: id, Truncated: sandbox.Truncations(rr)})

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
		until := ce.Until.UTC()
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
		writeError(w, http.StatusNotFound, "", "no run %q", assert.Clip(r.PathValue("id")))
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
		writeError(w, http.StatusNotFound, "", "no run %q", assert.Clip(id))
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
//
// A stream lives exactly as long as its run. After the run's run_finished it
// sends a retry: line and returns, which releases the subscriber slot: a tab
// left open on a finished run must not hold one of the capped slots against
// the viewers of the next run. No server timeout does this job, because a
// write timeout would also cut every live stream.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rep, ok := s.mgr.Report(id)
	if !ok {
		writeError(w, http.StatusNotFound, "", "no run %q", assert.Clip(id))
		return
	}

	// A finished run whose events the broadcaster no longer holds still gets a
	// terminal event rather than an empty stream: without one the client cannot
	// tell "this run is over" from "the stream died", which is precisely the
	// distinction the polling fallback has to make.
	if rep.Status != report.StatusRunning && s.bus.RunID() != id {
		if e, ok := s.terminalEvent(rep); ok {
			s.streamHeaders(w)
			rc := http.NewResponseController(w)
			if writeEvent(w, rc, e) == nil {
				endStream(w, rc)
			}
			return
		}
	}

	sub, err := s.bus.SubscribeRun(lastEventID(r))
	if err != nil {
		// The one deliberate ceiling on this fan-out. {"poll": true} is an
		// immediate fallback trigger, not something the client should retry.
		writeJSON(w, http.StatusServiceUnavailable, errorBody{
			Error: sse.ErrTooManySubscribers.Error(),
			Poll:  true,
		})
		return
	}
	defer sub.Cancel()

	s.streamHeaders(w)
	rc := http.NewResponseController(w)
	w.WriteHeader(http.StatusOK)
	if err := rc.Flush(); err != nil {
		return
	}

	// The log describes another run. Either a later run reset it between the
	// check above and the subscribe, so this run is over and nothing on the
	// subscription will say so; or this run is registered (its id is already
	// on /api/status) but the broadcaster has not been reset to it yet, so its
	// events are still to come and the viewer stays attached for them. Only
	// the stored report can tell the two apart.
	if sub.RunID != id && s.finishStream(w, rc, id) {
		return
	}

	// Replay first: a spectator arriving mid-run, or a reconnecting viewer,
	// gets complete state before the first live event.
	for _, e := range sub.Replay {
		if !belongsTo(e, id) {
			continue
		}
		if err := writeEvent(w, rc, e); err != nil {
			return
		}
		if e.Type == runner.EventRunFinished {
			endStream(w, rc)
			return
		}
	}
	// The run is over and the viewer's Last-Event-ID is at or past its end:
	// tell it again rather than leave it waiting on a run that will never
	// publish another event.
	if sub.Terminal != nil && belongsTo(*sub.Terminal, id) {
		if writeEvent(w, rc, *sub.Terminal) == nil {
			endStream(w, rc)
		}
		return
	}

	ping := time.NewTicker(Heartbeat)
	defer ping.Stop()
	for {
		select {
		case e, open := <-sub.Events:
			if !open {
				// Dropped for falling behind. EventSource reconnects on its own
				// and the replay log restores what was missed.
				return
			}
			if !belongsTo(e, id) {
				// Another run's event. If this run is over, a later run has
				// started and this run's own run_finished went to a subscriber
				// that was dropped. If it is still running, the event is the
				// tail of the run before it, published while this one waited to
				// be announced.
				if s.finishStream(w, rc, id) {
					return
				}
				continue
			}
			if err := writeEvent(w, rc, e); err != nil {
				return
			}
			if e.Type == runner.EventRunFinished {
				endStream(w, rc)
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

// finishStream ends a stream whose run's own run_finished it can no longer
// deliver, with the terminal event rebuilt from the stored report. It reports
// whether the stream is over: a run that is still running is not, and the
// caller keeps waiting for its events.
func (s *Server) finishStream(w http.ResponseWriter, rc *http.ResponseController, id string) bool {
	rep, ok := s.mgr.Report(id)
	if !ok {
		// Evicted from history: there is nothing left to tell the viewer.
		return true
	}
	e, ok := s.terminalEvent(rep)
	if !ok {
		return false
	}
	if writeEvent(w, rc, e) == nil {
		endStream(w, rc)
	}
	return true
}

// endStream is the last thing a stream sends. EventSource reconnects whenever
// a response ends, so the retry: line is what spaces out a client that does
// not close on run_finished.
func endStream(w http.ResponseWriter, rc *http.ResponseController) {
	if _, err := fmt.Fprintf(w, "retry: %d\n\n", ReconnectDelay.Milliseconds()); err != nil {
		return
	}
	_ = rc.Flush()
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

// lastEventID is the id a reconnecting EventSource says it saw last. Anything
// that is not a plain non-negative integer replays the whole log: a viewer
// with a duplicate row is better off than one with a missing one.
func lastEventID(r *http.Request) uint64 {
	n, err := strconv.ParseUint(r.Header.Get("Last-Event-ID"), 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// writeEvent renders one event in SSE wire format and flushes it.
//
// Both the event name and the full envelope are sent: the name lets a client
// use addEventListener per type, and the envelope carries type and run_id so a
// single handler can switch on Type instead. The id: line is what the browser
// sends back as Last-Event-ID when it reconnects. json.Marshal never emits a
// raw newline, so one data: line is always enough.
func writeEvent(w http.ResponseWriter, rc *http.ResponseController, e runner.Event) error {
	payload, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", e.ID, e.Type, payload); err != nil {
		return err
	}
	return rc.Flush()
}

// terminalEvent reconstructs run_finished from a stored report, for a viewer
// who attached after the broadcaster moved on. It carries the last id the
// run's own events reached, so a client resuming from it is not sent back to
// the start; 1 stands in when the broadcaster no longer remembers the run.
//
// It refuses a run that is still running: a viewer treats run_finished as the
// end of the run and closes, so one built from a live report would hide the
// rest of that run.
func (s *Server) terminalEvent(rep *report.Report) (runner.Event, bool) {
	if rep.Status == report.StatusRunning {
		return runner.Event{}, false
	}
	var cooldown time.Time
	if until := s.mgr.Status().CooldownUntil; until != nil {
		cooldown = *until
	}
	id, ok := s.bus.LastID(rep.ID)
	if !ok {
		id = 1
	}
	return runner.Event{
		ID:    id,
		Type:  runner.EventRunFinished,
		RunID: rep.ID,
		Data: runner.RunFinished{
			Status:        rep.Status,
			DurationMs:    rep.DurationMs,
			Verdict:       verdictOf(rep),
			CooldownUntil: cooldown,
		},
	}, true
}

// belongsTo keeps a stream to the run it asked for. The manager stamps every
// event with its run id; an unstamped event (there are none today) is passed
// through rather than silently dropped.
func belongsTo(e runner.Event, id string) bool { return e.RunID == "" || e.RunID == id }

func isValidationError(err error) bool {
	var ve sandbox.ValidationError
	return errors.As(err, &ve)
}

// verdictOf is the verdict a finished run was given, in either mode.
func verdictOf(rep *report.Report) string {
	switch {
	case rep.Performance != nil:
		return rep.Performance.Verdict
	case rep.Functional != nil:
		return rep.Functional.Verdict
	default:
		return ""
	}
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
