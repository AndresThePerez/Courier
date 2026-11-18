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
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/assert"
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
	s.handler = secureHeaders(s.withRequestID(s.apiMisses(s.mux)))
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

	s.mux.Handle(staticPattern, newStaticHandler(static))
}

// staticPattern is the file server's catch-all. Under /api/ a match on it is a
// miss: the path names no endpoint for this verb.
const staticPattern = "GET /"

// probeMethods are the verbs an Allow header can name. The routes use no
// others.
var probeMethods = []string{
	http.MethodDelete, http.MethodGet, http.MethodHead,
	http.MethodPatch, http.MethodPost, http.MethodPut,
}

// apiMisses answers every /api request that no API route takes, whatever the
// verb, in the one error shape: a 405 with Allow when the path exists under
// another verb, a 404 otherwise. Left to the mux, a wrong verb is a plain-text
// 405 and a GET falls through to the file server.
//
// It sits in front of the mux rather than as a method-less "/api/" pattern,
// which conflicts with "GET /" and makes the mux panic at registration. Allow
// is read back from the mux itself, so the route table stays the only place
// the verb contract is written.
func (s *Server) apiMisses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isAPIPath(r.URL.Path) || s.routed(r, r.Method) {
			next.ServeHTTP(w, r)
			return
		}
		var allow []string
		for _, m := range probeMethods {
			if s.routed(r, m) {
				allow = append(allow, m)
			}
		}
		if len(allow) > 0 {
			w.Header().Set("Allow", strings.Join(allow, ", "))
			writeError(w, http.StatusMethodNotAllowed, "", "method %q is not allowed on %q", assert.Clip(r.Method), assert.Clip(r.URL.Path))
			return
		}
		writeError(w, http.StatusNotFound, "", "no such endpoint %q", assert.Clip(r.URL.Path))
	})
}

func isAPIPath(p string) bool { return p == "/api" || strings.HasPrefix(p, "/api/") }

// routed reports whether an API route, rather than the file server or the
// mux's own 404/405, would take r under the given method.
func (s *Server) routed(r *http.Request, method string) bool {
	probe := r
	if method != r.Method {
		probe = r.Clone(r.Context())
		probe.Method = method
	}
	_, pattern := s.mux.Handler(probe)
	return pattern != "" && pattern != staticPattern
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

	// checkBody has already held every key and value to v's shape, so this
	// decode cannot meet an unknown field, and a second Decoder would only
	// buffer the body over again.
	if err := json.Unmarshal(body, v); err != nil {
		// A backstop; its text is Go's and is not shown.
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

	w := shapeWalk{b: raw}
	if se := w.value(t, 0); se != nil {
		return se.field, se.msg, false
	}
	return "", "", true
}

// shapeError is a value that does not fit the payload's shape, at a field in
// the same notation the validator uses (sequence[2].params.q).
type shapeError struct{ field, msg string }

// maxFieldLen bounds the field an error body names. Within the schema a field
// is a handful of short segments; only nesting inside an untyped value can
// make one longer.
const maxFieldLen = 200

// shapePath is where the walk is, kept as segments on one reused stack and
// rendered only when an error names it.
//
// A body nests ten thousand levels deep inside an assertion's value within the
// size cap. A path string built per level, and held by every level beneath it,
// costs the square of the depth: about a gigabyte for one request. Inside an
// untyped value the stack also stops growing past what a field could show, so
// its size is set by the schema, not by the body.
type shapePath struct {
	segs []pathSeg
	// dropped counts the levels below the deepest segment kept. Levels are
	// dropped only from the bottom, so push and pop stay in step.
	dropped int
}

// pathSeg is an object key, or an array index when isKey is false.
type pathSeg struct {
	key   string
	index int
	isKey bool
}

// maxUntypedSegs is how far below a typed value segments are kept: a segment
// renders as at least two characters, so a deeper path cannot fit in a field.
const maxUntypedSegs = maxFieldLen / 2

func (p *shapePath) push(sg pathSeg, typed int) {
	if p.dropped > 0 || len(p.segs)-typed >= maxUntypedSegs {
		p.dropped++
		return
	}
	p.segs = append(p.segs, sg)
}

func (p *shapePath) pop() {
	if p.dropped > 0 {
		p.dropped--
		return
	}
	p.segs = p.segs[:len(p.segs)-1]
}

// fail reports msg at the current position. typed is how many segments lead to
// the nearest value the schema types: a position inside an untyped value whose
// full path will not fit is named by that value instead, which is still the
// thing the editor can highlight.
func (p *shapePath) fail(typed int, msg string) *shapeError {
	field, ok := renderPath(p.segs, maxFieldLen)
	if !ok || p.dropped > 0 {
		field, ok = renderPath(p.segs[:typed], maxFieldLen)
	}
	if !ok {
		field = clipRunes(field, maxFieldLen)
	}
	if field == "" {
		field = "body"
	}
	return &shapeError{field, msg}
}

// renderPath writes segs in the validator's notation, each key clipped, and
// reports whether the result fits in limit characters. It stops writing once
// it is past the limit, so a deep path costs no more than a short one.
func renderPath(segs []pathSeg, limit int) (string, bool) {
	var b strings.Builder
	for _, sg := range segs {
		if utf8.RuneCountInString(b.String()) > limit {
			return b.String(), false
		}
		if !sg.isKey {
			b.WriteByte('[')
			b.WriteString(strconv.Itoa(sg.index))
			b.WriteByte(']')
			continue
		}
		if b.Len() > 0 {
			b.WriteByte('.')
		}
		b.WriteString(assert.Clip(sg.key))
	}
	out := b.String()
	return out, utf8.RuneCountInString(out) <= limit
}

// clipRunes cuts s to at most n characters, the last three of them "...",
// never splitting a character.
func clipRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n-3 {
			return s[:i] + "..."
		}
		count++
	}
	return s
}

// shapeWalk checks a JSON value against a Go type by reading its bytes in
// place. The value has already been through the decoder once, so it is known
// to be well-formed and at most the decoder's nesting limit deep, which is
// what bounds the recursion here.
//
// A walk over encoding/json's tokens would cost a decode, an interface value
// and, after every key, a syntax error allocated and thrown away: a few hundred
// bytes per key, which ten thousand nested keys turn into megabytes.
type shapeWalk struct {
	b    []byte
	i    int
	path shapePath
}

func (w *shapeWalk) skipSpace() {
	for w.i < len(w.b) {
		switch w.b[w.i] {
		case ' ', '\t', '\r', '\n':
			w.i++
		default:
			return
		}
	}
}

// skipString moves past the string starting at w.i and returns its bytes,
// quotes included.
func (w *shapeWalk) skipString() []byte {
	start := w.i
	for w.i++; w.i < len(w.b); w.i++ {
		switch w.b[w.i] {
		case '\\':
			w.i++
		case '"':
			w.i++
			return w.b[start:w.i]
		}
	}
	return w.b[start:]
}

// key reads an object key as encoding/json will see it, escapes resolved and
// invalid UTF-8 replaced, so the key checked is the key decoded.
func (w *shapeWalk) key() string {
	quoted := w.skipString()
	inner := quoted[1 : len(quoted)-1]
	if bytes.IndexByte(inner, '\\') < 0 && utf8.Valid(inner) {
		return string(inner)
	}
	var k string
	_ = json.Unmarshal(quoted, &k)
	return k
}

// value checks the value at w.i against t. A nil t (an `any` field) accepts
// any value, though duplicate keys are still refused. typed is the depth of
// the nearest typed value at or above this one.
func (w *shapeWalk) value(t reflect.Type, typed int) *shapeError {
	w.skipSpace()
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	c := w.b[w.i]
	if c == 'n' { // null leaves a field at its zero value
		w.i += len("null")
		return nil
	}
	if t != nil {
		// An `any` field is itself a typed position; only what it holds is not.
		typed = len(w.path.segs)
		if t.Kind() == reflect.Interface {
			t = nil
		}
	}
	mismatch := func(got string) *shapeError {
		return w.path.fail(typed, fmt.Sprintf("expected %s, got %s", jsonKind(t), got))
	}
	switch c {
	case '{':
		return w.object(t, typed)
	case '[':
		return w.array(t, typed)
	case '"':
		w.skipString()
		if t != nil && t.Kind() != reflect.String {
			return mismatch("a string")
		}
	case 't', 'f':
		if c == 't' {
			w.i += len("true")
		} else {
			w.i += len("false")
		}
		if t != nil && t.Kind() != reflect.Bool {
			return mismatch("a boolean")
		}
	default:
		start := w.i
		for w.i < len(w.b) && strings.IndexByte("+-.0123456789eE", w.b[w.i]) >= 0 {
			w.i++
		}
		n := json.Number(w.b[start:w.i])
		return checkNumber(n, t, func() *shapeError {
			return w.path.fail(typed, fmt.Sprintf("the number %s is out of range", assert.Clip(n.String())))
		}, mismatch)
	}
	return nil
}

func (w *shapeWalk) object(t reflect.Type, typed int) *shapeError {
	var fields map[string]reflect.Type
	switch {
	case t == nil:
	case t.Kind() == reflect.Struct:
		fields = jsonFields(t)
	case t.Kind() == reflect.Map:
	default:
		return w.path.fail(typed, fmt.Sprintf("expected %s, got an object", jsonKind(t)))
	}
	w.i++ // '{'
	// Objects in a payload hold a few keys, and nesting is where the count of
	// objects is large, so a set is only built past a handful of keys.
	var few [4]string
	keys := few[:0]
	var seen map[string]bool
	for n := 0; ; n++ {
		w.skipSpace()
		if w.b[w.i] == '}' {
			w.i++
			return nil
		}
		if n > 0 {
			w.i++ // ','
			w.skipSpace()
		}
		key := w.key()
		w.skipSpace()
		w.i++ // ':'

		if seen[key] || (seen == nil && slices.Contains(keys, key)) {
			w.path.push(pathSeg{key: key, isKey: true}, typed)
			se := w.path.fail(typed, fmt.Sprintf("duplicate key %q", assert.Clip(key)))
			w.path.pop()
			return se
		}
		switch {
		case seen != nil:
			seen[key] = true
		case len(keys) < cap(keys):
			keys = append(keys, key)
		default:
			seen = make(map[string]bool, 2*len(keys))
			for _, k := range keys {
				seen[k] = true
			}
			seen[key] = true
		}

		var elem reflect.Type
		switch {
		case t == nil:
		case fields != nil:
			ft, known := fields[key]
			if !known {
				return w.path.fail(typed, fmt.Sprintf("unknown field %q", assert.Clip(key)))
			}
			elem = ft
		default:
			elem = t.Elem()
		}
		w.path.push(pathSeg{key: key, isKey: true}, typed)
		se := w.value(elem, typed)
		w.path.pop()
		if se != nil {
			return se
		}
	}
}

func (w *shapeWalk) array(t reflect.Type, typed int) *shapeError {
	var elem reflect.Type
	if t != nil {
		if t.Kind() != reflect.Slice && t.Kind() != reflect.Array {
			return w.path.fail(typed, fmt.Sprintf("expected %s, got an array", jsonKind(t)))
		}
		elem = t.Elem()
	}
	w.i++ // '['
	for i := 0; ; i++ {
		w.skipSpace()
		if w.b[w.i] == ']' {
			w.i++
			return nil
		}
		if i > 0 {
			w.i++ // ','
		}
		w.path.push(pathSeg{index: i}, typed)
		se := w.value(elem, typed)
		w.path.pop()
		if se != nil {
			return se
		}
	}
}

// checkNumber holds a number to what encoding/json will accept for t, so the
// decode that follows cannot fail on it.
func checkNumber(n json.Number, t reflect.Type, outOfRange func() *shapeError, mismatch func(string) *shapeError) *shapeError {
	kind := reflect.Float64
	if t != nil {
		kind = t.Kind()
	}
	switch kind {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if _, err := strconv.ParseInt(n.String(), 10, t.Bits()); err != nil {
			if errors.Is(err, strconv.ErrRange) {
				return outOfRange()
			}
			return mismatch("the number " + assert.Clip(n.String()))
		}
	case reflect.Float32, reflect.Float64:
		bits := 64
		if t != nil {
			bits = t.Bits()
		}
		if _, err := strconv.ParseFloat(n.String(), bits); err != nil {
			return outOfRange()
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
