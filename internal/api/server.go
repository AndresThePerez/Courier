// Package api is Courier's HTTP layer: the JSON API, the SSE stream, and the
// embedded frontend. Nothing outside this package speaks HTTP to the browser.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/AndresThePerez/courier/internal/collections"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sandbox"
	"github.com/AndresThePerez/courier/internal/sse"
)

// MaxBodyBytes caps a request body. A run payload is 50 requests x 20
// assertions of small JSON; a quarter of a megabyte is generous for that and
// still bounds what an anonymous visitor can make the decoder allocate.
const MaxBodyBytes = 256 << 10

// Log event names this package writes, in the same "event" + "run_id"
// vocabulary internal/runner uses, so one jq filter reads the whole trail.
const (
	// EventSendExecuted is one editor Send, with what it cost the ledger.
	EventSendExecuted = "send_executed"

	// EventServerClosed is the end of a graceful shutdown: the engine drained
	// and the connection pool released.
	EventServerClosed = "server_closed"
)

// Options configures a Server at startup. The target is fixed here and can
// never be influenced by a client request.
type Options struct {
	TargetURL     string // internal base URL requests actually execute against
	TargetDisplay string // friendly name shown in the UI and PDF

	// Logger is the one logger the whole server tree writes to. It is passed
	// explicitly rather than taken from a package global, the same rule
	// internal/runner follows. Nil is accepted and discarded.
	Logger *slog.Logger

	// Now is the clock the run manager and its load budget read. Production
	// leaves it nil, meaning time.Now; a handler test injects one so the
	// budget's 5s cooldown floor can be crossed without sleeping through it
	// once per run.
	Now func() time.Time
}

// Server is Courier's http.Handler. It owns the executor, the run manager, and
// the SSE broadcaster, so a process has exactly one of each.
type Server struct {
	mux  *http.ServeMux
	opts Options
	log  *slog.Logger
	now  func() time.Time

	ex  *runner.Executor
	bus *sse.Broadcaster
	mgr *runner.Manager

	// sending is the one-in-flight rule for POST /api/send. An atomic.Bool is
	// right here and wrong for the run lifecycle: this really is two states
	// with no metadata, where the lifecycle is three states plus a run id, a
	// mode, and a start time.
	sending atomic.Bool

	metrics *metrics
	started time.Time

	// runCtx is the parent of every run context. It outlives the HTTP request
	// that started the run — a visitor closing the tab must not cancel the run
	// everyone else is watching — and is cancelled by Close, which is what
	// makes graceful shutdown stop the engine rather than orphan it.
	runCtx   context.Context
	stopRuns context.CancelCauseFunc

	// done releases the SSE handlers at shutdown. Without it http.Server's
	// Shutdown waits forever on streams that are, by design, never finished.
	done      chan struct{}
	closeOnce sync.Once
}

// New builds a Server that serves static from the given filesystem.
func New(static fs.FS, opts Options) *Server {
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}

	ex := runner.NewExecutor(opts.TargetURL)
	bus := sse.New(log)
	ctx, stop := context.WithCancelCause(context.Background())

	s := &Server{
		mux:      http.NewServeMux(),
		opts:     opts,
		log:      log,
		now:      now,
		ex:       ex,
		bus:      bus,
		started:  now(),
		runCtx:   ctx,
		stopRuns: stop,
		done:     make(chan struct{}),
	}
	// Three-step rather than one literal, because the wiring is genuinely
	// circular: the run manager publishes through the metrics tap, and the tap
	// belongs to the server the manager is being built for.
	s.metrics = newMetrics()
	s.mgr = runner.NewManagerAt(ex, opts.TargetDisplay, meteredBus{bus, s.metrics}, log, now)
	s.routes(static)
	return s
}

// routes is the whole public surface.
//
// There is deliberately no /debug/pprof here. Profiling is mounted on a
// separate loopback-only listener (debug.go): the public interface of a sandbox
// demo must not expose an endpoint that dumps process memory or lets an
// anonymous visitor pin a CPU for thirty seconds.
func (s *Server) routes(static fs.FS) {
	s.mux.HandleFunc("GET /healthz", s.handleHealthz)
	s.mux.HandleFunc("GET /metrics", s.handleMetrics)
	s.mux.HandleFunc("GET /api/status", s.handleStatus)
	s.mux.HandleFunc("GET /api/collections", s.handleCollections)
	s.mux.HandleFunc("POST /api/send", s.handleSend)

	s.mux.HandleFunc("POST /api/runs", s.handleStartRun)
	s.mux.HandleFunc("GET /api/runs", s.handleHistory)
	s.mux.HandleFunc("GET /api/runs/{id}", s.handleGetRun)
	s.mux.HandleFunc("DELETE /api/runs/{id}", s.handleCancelRun)
	s.mux.HandleFunc("GET /api/runs/{id}/stream", s.handleStream)

	s.mux.Handle("GET /", http.FileServerFS(static))
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// Manager exposes the run manager for wiring and tests. Handlers reach it
// directly; nothing outside this package needs it for anything else.
func (s *Server) Manager() *runner.Manager { return s.mgr }

// Close stops the live run, waits for the engine to finish, and releases the
// streams. It is bounded by ctx: shutdown must not hang on a target that has
// stopped answering.
//
// Cancelling first means the wait is bounded by one in-flight request rather
// than by a full run duration, and closing done first means an SSE handler is
// never what holds http.Server.Shutdown open.
func (s *Server) Close(ctx context.Context) error {
	s.closeOnce.Do(func() {
		close(s.done)
		s.stopRuns(runner.ErrRunAborted)
	})

	waited := make(chan struct{})
	go func() {
		s.mgr.Wait()
		close(waited)
	}()

	var err error
	select {
	case <-waited:
	case <-ctx.Done():
		err = ctx.Err()
		s.log.Warn("shutdown drain did not finish",
			"event", "shutdown_drain_timeout", "err", err.Error())
	}
	// Idle keep-alive connections each hold a transport goroutine pair. After a
	// 50-worker run that is ~100 goroutines waiting out IdleConnTimeout for no
	// reason, and at shutdown there is nobody left to reuse them.
	s.ex.CloseIdleConnections()
	s.log.Info("server closed", "event", EventServerClosed)
	return err
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// errorBody is the error shape every route answers with.
//
// Field names the offending part of the payload when there is one, which is
// what the request editor highlights. Poll appears only on the stream route's
// 503: it tells the client to fall back to polling rather than retry, because
// the subscriber ceiling will not clear just because it asked again.
type errorBody struct {
	Error string `json:"error"`
	Field string `json:"field,omitempty"`
	Poll  bool   `json:"poll,omitempty"`
}

func writeError(w http.ResponseWriter, status int, field, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if field != "" {
		msg = field + ": " + msg
	}
	writeJSON(w, status, errorBody{Error: msg, Field: field})
}

// decodeJSON reads a capped, single-value JSON body. It answers the client and
// returns false on any failure, so callers read as one guard clause.
//
// The cap is enforced by http.MaxBytesReader rather than by trusting
// Content-Length, which a client controls and can simply lie about.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusBadRequest, "body", "payload exceeds the %d byte limit", MaxBodyBytes)
			return false
		}
		writeError(w, http.StatusBadRequest, "body", "%s", err.Error())
		return false
	}
	return true
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// handleStatus drives three UI states — idle, cooling down, run in progress —
// from one poll, so N idle tabs do not invent their own cadence.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.mgr.Status())
}

// handleCollections serves the curated content and the endpoint catalog
// together.
//
// The catalog rides along deliberately: the editor's parameter dropdown is
// built from it, so the sandbox is not merely enforced server-side, it is the
// thing the UI offers. A visitor can see the allowlist rather than discover it
// by getting a 400.
func (s *Server) handleCollections(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"collections": collections.All(),
		"endpoints":   sandbox.Endpoints(),
		"target":      s.opts.TargetDisplay,
	})
}
