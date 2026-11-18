// Package api is Courier's HTTP layer: the JSON API, the SSE stream, and the
// embedded frontend. Nothing outside this package speaks HTTP to the browser.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/collections"
	"github.com/AndresThePerez/courier/internal/runner"
	"github.com/AndresThePerez/courier/internal/sandbox"
	"github.com/AndresThePerez/courier/internal/sse"
)

// MaxBodyBytes caps a request body. A run payload is 50 requests x 20
// assertions of small JSON; a quarter of a megabyte is generous for that and
// still bounds what an anonymous visitor can make the decoder allocate.
//
// It is the request-body cap and is deliberately the same number as
// SendBodyMax, the response-preview cap in send.go: de-duplicating the two
// would couple a request limit to a response limit.
const MaxBodyBytes = 256 << 10

// Log event names this package writes, in the same "event" + "run_id"
// vocabulary internal/runner uses, so one jq filter reads the whole trail.
const (
	// EventRequestReceived carries the edge's own request id, so a visitor's
	// report can be joined to a log line.
	EventRequestReceived = "request_received"

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
	mux *http.ServeMux
	// handler is the mux with its middleware already wrapped around it, built
	// once at construction. ServeHTTP is the only entry point, so this is the
	// whole composition point for anything that has to see every route.
	handler http.Handler
	opts    Options
	log     *slog.Logger
	now     func() time.Time

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
	s.handler = secureHeaders(s.withRequestID(s.mux))
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
	s.mux.HandleFunc("GET /api/runs/{id}/report.pdf", s.handleReportPDF)

	// Every GET on an /api/ path that no method-scoped pattern above matched.
	// Without this a GET /api/send falls through to the file server and answers
	// 404, while /api/runs answers 405 with an Allow header, so the verb
	// contract the README claims held unevenly. The pattern is GET-scoped
	// because a method-less "/api/" conflicts with "GET /" and makes the mux
	// panic at registration; a wrong non-GET verb on a GET-only path never needs
	// it, because the mux answers that 405 itself with an Allow header it
	// computes. Go's mux prefers the more specific pattern, so the
	// method-scoped routes above still win for their own verbs.
	s.mux.HandleFunc("GET /api/", s.handleAPIFallback)

	s.mux.Handle("GET /", newStaticHandler(static))
}

// apiAllow is the verb contract for the fixed API paths. The catalogue is
// closed and small, so a request that reaches the fallback on a known path is
// a wrong verb rather than a wrong path, and Allow is what the client needs.
var apiAllow = map[string]string{
	"/api/send":        "POST",
	"/api/status":      "GET, HEAD",
	"/api/collections": "GET, HEAD",
	"/api/runs":        "GET, HEAD, POST",
}

func (s *Server) handleAPIFallback(w http.ResponseWriter, r *http.Request) {
	if allow, ok := apiAllow[r.URL.Path]; ok {
		w.Header().Set("Allow", allow)
		writeError(w, http.StatusMethodNotAllowed, "", "method %s is not allowed on %s", r.Method, r.URL.Path)
		return
	}
	writeError(w, http.StatusNotFound, "", "no such endpoint %q", r.URL.Path)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

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

// writeError answers with errorBody. The message never repeats the field: the
// field has its own key, and a client that shows the two side by side would
// otherwise print it twice.
func writeError(w http.ResponseWriter, status int, field, format string, args ...any) {
	writeJSON(w, status, errorBody{Error: fmt.Sprintf(format, args...), Field: field})
}

// decodeJSON reads a capped body holding exactly one JSON object whose shape
// is exactly v's. It answers the client and returns false on any failure, so
// callers read as one guard clause.
//
// The cap is enforced by http.MaxBytesReader rather than by trusting
// Content-Length, which a client controls and can simply lie about.
//
// Strict because a key the server does not read is a key the author believes
// does something: a "url" that is silently dropped looks, from the outside,
// exactly like a "url" that is honoured. The same goes for a second "endpoint"
// that quietly wins over the first, and for a key that only matches a field
// because encoding/json folds case.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if !isJSONContentType(r.Header.Values("Content-Type")) {
		writeError(w, http.StatusUnsupportedMediaType, "body", "Content-Type must be application/json")
		return false
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "body", "payload exceeds the %d byte limit", MaxBodyBytes)
			return false
		}
		writeError(w, http.StatusBadRequest, "body", "the body could not be read")
		return false
	}

	if field, msg, ok := checkBody(body, reflect.TypeOf(v)); !ok {
		writeError(w, http.StatusBadRequest, field, "%s", msg)
		return false
	}

	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		// checkBody has already walked every value against v's shape, so this
		// is a backstop; its text is Go's and is not shown.
		writeError(w, http.StatusBadRequest, "body", "the body does not match the expected shape")
		return false
	}
	return true
}

// isJSONContentType accepts exactly one Content-Type naming application/json,
// with no parameter but an optional UTF-8 charset: JSON on the wire is UTF-8.
func isJSONContentType(values []string) bool {
	if len(values) != 1 {
		return false
	}
	mt, params, err := mime.ParseMediaType(values[0])
	if err != nil || mt != "application/json" {
		return false
	}
	for k, v := range params {
		if k != "charset" || !strings.EqualFold(v, "utf-8") {
			return false
		}
	}
	return true
}

// checkBody validates body against the shape of t (a pointer to the payload
// type) and returns the offending field and a message when it does not fit.
// Messages describe JSON, never Go: a visitor has no use for a struct name.
func checkBody(body []byte, t reflect.Type) (field, msg string, ok bool) {
	dec := json.NewDecoder(bytes.NewReader(body))
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		var syn *json.SyntaxError
		switch {
		case errors.As(err, &syn):
			return "body", fmt.Sprintf("malformed JSON at byte %d", syn.Offset), false
		case errors.Is(err, io.EOF):
			return "body", "body must hold exactly one JSON value", false
		default: // io.ErrUnexpectedEOF: the body stops inside a value
			return "body", fmt.Sprintf("malformed JSON at byte %d", len(body)), false
		}
	}
	if len(bytes.TrimLeft(body[dec.InputOffset():], " \t\r\n")) > 0 {
		return "body", "body must hold exactly one JSON value", false
	}
	if raw[0] != '{' {
		return "body", "body must be a JSON object", false
	}

	walk := json.NewDecoder(bytes.NewReader(raw))
	walk.UseNumber()
	if err := checkValue(walk, t, ""); err != nil {
		var se *shapeError
		if errors.As(err, &se) {
			return fieldName(se.path), se.msg, false
		}
		return "body", "malformed JSON", false
	}
	return "", "", true
}

// shapeError is a value that does not fit the payload's shape, at a path in
// the same notation the validator uses (sequence[2].params.q).
type shapeError struct{ path, msg string }

func (e *shapeError) Error() string { return e.path + ": " + e.msg }

func fieldName(path string) string {
	if path == "" {
		return "body"
	}
	return path
}

func joinKey(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

// checkValue reads one value from dec and checks it against t. A nil t (an
// `any` field) accepts any value, though duplicate keys are still refused.
func checkValue(dec *json.Decoder, t reflect.Type, path string) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if tok == nil { // null leaves a field at its zero value
		return nil
	}
	if t != nil && t.Kind() == reflect.Interface {
		t = nil
	}
	if d, isDelim := tok.(json.Delim); isDelim {
		if d == '{' {
			return checkObject(dec, t, path)
		}
		return checkArray(dec, t, path)
	}
	return checkScalar(tok, t, path)
}

func checkObject(dec *json.Decoder, t reflect.Type, path string) error {
	var fields map[string]reflect.Type
	switch {
	case t == nil:
	case t.Kind() == reflect.Struct:
		fields = jsonFields(t)
	case t.Kind() == reflect.Map:
	default:
		return &shapeError{path, fmt.Sprintf("expected %s, got an object", jsonKind(t))}
	}
	seen := make(map[string]bool)
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		key, _ := tok.(string)
		if seen[key] {
			return &shapeError{joinKey(path, key), fmt.Sprintf("duplicate key %q", clip(key))}
		}
		seen[key] = true

		var elem reflect.Type
		switch {
		case t == nil:
		case fields != nil:
			ft, known := fields[key]
			if !known {
				return &shapeError{path, fmt.Sprintf("unknown field %q", clip(key))}
			}
			elem = ft
		default:
			elem = t.Elem()
		}
		if err := checkValue(dec, elem, joinKey(path, key)); err != nil {
			return err
		}
	}
	_, err := dec.Token() // '}'
	return err
}

func checkArray(dec *json.Decoder, t reflect.Type, path string) error {
	var elem reflect.Type
	if t != nil {
		if t.Kind() != reflect.Slice && t.Kind() != reflect.Array {
			return &shapeError{path, fmt.Sprintf("expected %s, got an array", jsonKind(t))}
		}
		elem = t.Elem()
	}
	for i := 0; dec.More(); i++ {
		if err := checkValue(dec, elem, fmt.Sprintf("%s[%d]", path, i)); err != nil {
			return err
		}
	}
	_, err := dec.Token() // ']'
	return err
}

func checkScalar(tok json.Token, t reflect.Type, path string) error {
	mismatch := func(got string) error {
		return &shapeError{path, fmt.Sprintf("expected %s, got %s", jsonKind(t), got)}
	}
	switch v := tok.(type) {
	case string:
		if t != nil && t.Kind() != reflect.String {
			return mismatch("a string")
		}
	case bool:
		if t != nil && t.Kind() != reflect.Bool {
			return mismatch("a boolean")
		}
	case json.Number:
		return checkNumber(v, t, path, mismatch)
	}
	return nil
}

// checkNumber holds a number to what encoding/json will accept for t, so the
// decode that follows cannot fail on it.
func checkNumber(n json.Number, t reflect.Type, path string, mismatch func(string) error) error {
	outOfRange := &shapeError{path, fmt.Sprintf("the number %s is out of range", clip(n.String()))}
	kind := reflect.Float64
	if t != nil {
		kind = t.Kind()
	}
	switch kind {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if _, err := strconv.ParseInt(n.String(), 10, t.Bits()); err != nil {
			if errors.Is(err, strconv.ErrRange) {
				return outOfRange
			}
			return mismatch("the number " + clip(n.String()))
		}
	case reflect.Float32, reflect.Float64:
		bits := 64
		if t != nil {
			bits = t.Bits()
		}
		if _, err := strconv.ParseFloat(n.String(), bits); err != nil {
			return outOfRange
		}
	default:
		return mismatch("a number")
	}
	return nil
}

// jsonFields maps each JSON key of a struct to its field type, by the exact
// tag name only.
func jsonFields(t reflect.Type) map[string]reflect.Type {
	out := make(map[string]reflect.Type, t.NumField())
	for f := range t.Fields() {
		if !f.IsExported() {
			continue
		}
		name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
		if name == "-" {
			continue
		}
		if name == "" {
			name = f.Name
		}
		out[name] = f.Type
	}
	return out
}

// jsonKind names what a Go type accepts, in JSON's vocabulary.
func jsonKind(t reflect.Type) string {
	if t == nil {
		return "a JSON value"
	}
	switch t.Kind() {
	case reflect.String:
		return "a string"
	case reflect.Bool:
		return "true or false"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return "a whole number"
	case reflect.Float32, reflect.Float64:
		return "a number"
	case reflect.Struct, reflect.Map:
		return "an object"
	case reflect.Slice, reflect.Array:
		return "an array"
	default:
		return "a JSON value"
	}
}

// clip bounds a client-supplied fragment echoed in an error message.
func clip(s string) string {
	const max = 64
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max]) + "..."
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
