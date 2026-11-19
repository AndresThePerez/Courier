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

	// bodies bounds the bytes of the request bodies checked and decoded at
	// once, on both POST routes together (MaxBodyChecks).
	bodies *bodyGate

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
		bodies:   newBodyGate(MaxBodyChecks*MaxBodyBytes, MaxBodyWaiters*MaxBodyBytes),
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
//
// This is the check alone. Handlers go through Server.decodeJSON, which also
// bounds the bytes of the bodies checked at once.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	body, ok := readJSONBody(w, r)
	return ok && decodeBody(w, body, v)
}

// decodeJSON is the package's decodeJSON with the body check bounded by the
// bytes of the bodies in it (bodyGate). The body is read in full before it
// takes its place, so an upload in progress holds none.
func (s *Server) decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	body, ok := readJSONBody(w, r)
	if !ok {
		return false
	}
	n := bodyWeight(len(body))
	if !s.bodies.enter(r.Context(), n) {
		w.Header().Set("Retry-After", bodyGateRetryAfter)
		writeError(w, http.StatusServiceUnavailable, "", bodyGateBusy)
		return false
	}
	defer s.bodies.leave(n)
	if s.bodies.checking != nil {
		s.bodies.checking(n)
	}
	return decodeBody(w, body, v)
}

// readJSONBody answers 415 for a body that is not JSON and 413 for one over
// the cap, and otherwise returns the body whole.
func readJSONBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	if !isJSONContentType(r.Header.Values("Content-Type")) {
		writeError(w, http.StatusUnsupportedMediaType, "body", "Content-Type must be application/json")
		return nil, false
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "body", "payload exceeds the %d byte limit", MaxBodyBytes)
			return nil, false
		}
		writeError(w, http.StatusBadRequest, "body", "the body could not be read")
		return nil, false
	}
	return body, true
}

// decodeBody holds body to v's shape and decodes it into v, answering 400
// when it does not fit.
func decodeBody(w http.ResponseWriter, body []byte, v any) bool {
	if field, msg, ok := checkBody(body, reflect.TypeOf(v)); !ok {
		writeError(w, http.StatusBadRequest, field, "%s", msg)
		return false
	}

	// checkBody has already held every key and value to v's shape; this decode
	// cannot meet an unknown field unless the walk and the type have drifted.
	if err := decodeChecked(body, v); err != nil {
		// A backstop; its text is Go's and is not shown.
		writeError(w, http.StatusBadRequest, "body", "the body does not match the expected shape")
		return false
	}
	return true
}

// Bounds on the body check, which runs before the one-run lock and the
// one-send limit and so is open to every visitor at once. They are weighed in
// body bytes, not in bodies: what a check allocates grows with its body's
// size, so a small body must not take the place of a body at the cap.
//
// What the checks can allocate at once follows from the constants. The bodies
// in the check weigh at most MaxBodyChecks x MaxBodyBytes in all. The widest
// bodies at the cap measured allocate about 140 x their size to check and
// decode, and TestDecodingAWideBodyStaysLinearInItsSize holds them to 192 x
// (wideDecodeBound); TestAShortBodyWeighsTheFloor holds short bodies to
// 192 x minBodyWeight. So the checks in flight allocate at most
// 192 x 2 x 256 KiB, on the reading that bodies between the two ends allocate
// in the same proportion, which is measured at the ends only. The bodies
// waiting weigh at most MaxBodyWaiters x MaxBodyBytes, 16 x 256 KiB.
//
// The bound leaves out what scales with connections rather than with these
// constants: bodies read in full and then answered 503, and bodies still
// arriving. It also leaves out the decoded value a request keeps after its
// check, through validation and the start or the send, and garbage not yet
// collected.
const (
	// MaxBodyChecks is how many bodies at the cap are checked and decoded at
	// once; smaller bodies share the same MaxBodyChecks x MaxBodyBytes
	// (TestNoMoreThanMaxBodyChecksBodiesAreCheckedAtOnce,
	// TestAnOrdinaryBurstOfSmallPostsNeverSeesTheBodyGate). Two rather than
	// one, so a body at the cap being checked does not hold up a small one.
	MaxBodyChecks = 2

	// MaxBodyWaiters is how many bodies at the cap, already read, may wait for
	// room, again shared by weight with smaller ones. A body that would take
	// the waiting bodies past MaxBodyWaiters x MaxBodyBytes is answered 503 at
	// once, unchecked
	// (TestABodyBeyondMaxBodyWaitersIsAnswered503WithoutBeingChecked).
	MaxBodyWaiters = 16

	// minBodyWeight is what a body weighs however short it is. A check has a
	// cost of its own beside its body's bytes, and without a floor the number
	// of empty bodies in the check at once would have no bound
	// (TestAShortBodyWeighsTheFloor).
	minBodyWeight = 4 << 10
)

// bodyWeight is what a body of n bytes weighs in the gate.
func bodyWeight(n int) int64 { return int64(max(n, minBodyWeight)) }

// bodyGateBusy is the 503's message. The page shows it after "Refused - " on
// Send and after "Could not start the run - " on Start.
const bodyGateBusy = "the server is busy checking other requests; try again in a moment"

// bodyGateRetryAfter is the 503's Retry-After, in seconds: room frees as soon
// as one check ends.
const bodyGateRetryAfter = "1"

// bodyGate admits bodies to the check by weight, in strict arrival order: a
// body that does not fit waits, and every body that arrives after it waits
// behind it, however small, so a body at the cap is never held out by a
// stream of small ones (TestABodyAtTheCapIsAdmittedBeforeSmallerOnesBehindIt).
//
// Invariant, under mu: inside <= maxInside, queued <= maxQueued, queued and
// waiting are the sum and the count of the bodies in line, and the head of
// line does not fit (inside + line[0].n > maxInside) whenever line is not
// empty. A body weighs at most MaxBodyBytes, so one alone always fits.
type bodyGate struct {
	mu        sync.Mutex
	inside    int64
	queued    int64
	line      []*bodyWaiter
	maxInside int64
	maxQueued int64

	// waiting is len(line), kept where a test can read it without the lock.
	waiting atomic.Int64

	// checking, when set, runs while a body is in the check, after its
	// release is deferred. Tests park bodies in it to count how many are
	// inside at once; production leaves it nil.
	checking func(n int64)
}

// bodyWaiter is one body in line. admit is closed once it is let in.
type bodyWaiter struct {
	n     int64
	admit chan struct{}
}

func newBodyGate(maxInside, maxQueued int64) *bodyGate {
	return &bodyGate{maxInside: maxInside, maxQueued: maxQueued}
}

// enter lets in a body of weight n, waiting in line for room when there is
// none. It reports false when the line has no room for n or ctx ends first:
// a waiter whose client has gone leaves the line.
func (g *bodyGate) enter(ctx context.Context, n int64) bool {
	g.mu.Lock()
	if len(g.line) == 0 && g.inside+n <= g.maxInside {
		g.inside += n
		g.mu.Unlock()
		return true
	}
	if g.queued+n > g.maxQueued {
		g.mu.Unlock()
		return false
	}
	bw := &bodyWaiter{n: n, admit: make(chan struct{})}
	g.line = append(g.line, bw)
	g.queued += n
	g.waiting.Store(int64(len(g.line)))
	g.mu.Unlock()

	select {
	case <-bw.admit:
		return true
	case <-ctx.Done():
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	select {
	case <-bw.admit:
		// Let in as ctx ended: it holds room it will not use.
		g.inside -= n
	default:
		i := slices.Index(g.line, bw)
		g.line = slices.Delete(g.line, i, i+1)
		g.queued -= n
		g.waiting.Store(int64(len(g.line)))
	}
	g.admitLocked()
	return false
}

// leave gives back the room of a body of weight n.
func (g *bodyGate) leave(n int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.inside -= n
	g.admitLocked()
}

// admitLocked lets in, in order, every body at the head of the line that fits.
func (g *bodyGate) admitLocked() {
	for len(g.line) > 0 && g.inside+g.line[0].n <= g.maxInside {
		bw := g.line[0]
		g.line = slices.Delete(g.line, 0, 1)
		g.queued -= bw.n
		g.inside += bw.n
		close(bw.admit)
	}
	g.waiting.Store(int64(len(g.line)))
}

// load reports the weight in the check and the weight in line.
func (g *bodyGate) load() (inside, queued int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.inside, g.queued
}

// decodeChecked is the decode that follows checkBody. The walk has already
// refused every key v lacks; the decoder refuses them again so that a payload
// type growing a shape the walk does not model is still held to its fields,
// rather than having an unknown key silently dropped.
func decodeChecked(body []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
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
// place. checkBody hands it only a value the decoder has already accepted, so
// it is well-formed and at most the decoder's nesting limit deep, which is
// what bounds the recursion here. The walk does not rely on that to be safe:
// every byte read is bounds-checked, and bytes that are not JSON end the walk
// with a malformed-JSON error, never a panic or a loop. Each step consumes at
// least one byte, so the recursion is bounded by the input on any bytes.
//
// A walk over encoding/json's tokens would cost a decode, an interface value
// and, after every key, a syntax error allocated and thrown away: a few hundred
// bytes per key, which ten thousand nested keys turn into megabytes.
type shapeWalk struct {
	b    []byte
	i    int
	path shapePath
}

// malformed is the walk's answer to bytes that are not JSON.
func (w *shapeWalk) malformed() *shapeError {
	return &shapeError{"body", fmt.Sprintf("malformed JSON at byte %d", w.i)}
}

// peek returns the byte at w.i, or false at the end of the input.
func (w *shapeWalk) peek() (byte, bool) {
	if w.i >= len(w.b) {
		return 0, false
	}
	return w.b[w.i], true
}

// expect moves past c, or reports that the next byte is not c.
func (w *shapeWalk) expect(c byte) bool {
	if b, ok := w.peek(); !ok || b != c {
		return false
	}
	w.i++
	return true
}

// literal moves past lit, or reports that the input does not hold it here.
func (w *shapeWalk) literal(lit string) bool {
	if !bytes.HasPrefix(w.b[w.i:], []byte(lit)) {
		return false
	}
	w.i += len(lit)
	return true
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
// quotes included, or false when there is no whole string there.
func (w *shapeWalk) skipString() ([]byte, bool) {
	start := w.i
	if !w.expect('"') {
		return nil, false
	}
	for ; w.i < len(w.b); w.i++ {
		switch w.b[w.i] {
		case '\\':
			w.i++
		case '"':
			w.i++
			return w.b[start:w.i], true
		}
	}
	return nil, false
}

// key reads an object key as encoding/json will see it, escapes resolved and
// invalid UTF-8 replaced, so the key checked is the key decoded.
func (w *shapeWalk) key() (string, bool) {
	quoted, ok := w.skipString()
	if !ok {
		return "", false
	}
	inner := quoted[1 : len(quoted)-1]
	if bytes.IndexByte(inner, '\\') < 0 && utf8.Valid(inner) {
		return string(inner), true
	}
	var k string
	_ = json.Unmarshal(quoted, &k)
	return k, true
}

// value checks the value at w.i against t. A nil t (an `any` field) accepts
// any value, though duplicate keys are still refused. typed is the depth of
// the nearest typed value at or above this one.
func (w *shapeWalk) value(t reflect.Type, typed int) *shapeError {
	w.skipSpace()
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	c, ok := w.peek()
	if !ok {
		return w.malformed()
	}
	if c == 'n' { // null leaves a field at its zero value
		if !w.literal("null") {
			return w.malformed()
		}
		return nil
	}
	untyped := false
	if t != nil {
		// An `any` field is itself a typed position; only what it holds is not.
		typed = len(w.path.segs)
		if t.Kind() == reflect.Interface {
			t, untyped = nil, true
		}
	}
	mismatch := func(got string) *shapeError {
		return w.path.fail(typed, fmt.Sprintf("expected %s, got %s", jsonKind(t), got))
	}
	switch c {
	case '{', '[':
		se := w.array
		got := "an array"
		if c == '{' {
			se, got = w.object, "an object"
		}
		if err := se(t, typed); err != nil {
			return err
		}
		// An `any` field holds one scalar. The only one in the payloads is an
		// assertion's value, which `exists` ignores and every other operator
		// compares with a number or a string; a structure there is kept, and
		// stored in the run's report, replay log and frames, so a body could
		// fill each of those with a quarter of a megabyte of it. It is walked
		// first so that a fault inside it is still named where it is.
		if untyped {
			return w.path.fail(typed, "expected a number, a string, true, false or null, got "+got)
		}
		return nil
	case '"':
		if _, ok := w.skipString(); !ok {
			return w.malformed()
		}
		if t != nil && t.Kind() != reflect.String {
			return mismatch("a string")
		}
	case 't', 'f':
		lit := "false"
		if c == 't' {
			lit = "true"
		}
		if !w.literal(lit) {
			return w.malformed()
		}
		if t != nil && t.Kind() != reflect.Bool {
			return mismatch("a boolean")
		}
	default:
		start := w.i
		for w.i < len(w.b) && strings.IndexByte("+-.0123456789eE", w.b[w.i]) >= 0 {
			w.i++
		}
		if w.i == start {
			return w.malformed()
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
		fields = structFields.of(t)
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
		if c, ok := w.peek(); !ok {
			return w.malformed()
		} else if c == '}' {
			w.i++
			return nil
		}
		if n > 0 {
			if !w.expect(',') {
				return w.malformed()
			}
			w.skipSpace()
		}
		key, ok := w.key()
		if !ok {
			return w.malformed()
		}
		w.skipSpace()
		if !w.expect(':') {
			return w.malformed()
		}

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
		if c, ok := w.peek(); !ok {
			return w.malformed()
		} else if c == ']' {
			w.i++
			return nil
		}
		if i > 0 && !w.expect(',') {
			return w.malformed()
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

// fieldCache holds each struct type's field map, built on its first use and
// only read after that. A body at the size cap holds tens of thousands of JSON
// objects; building a map for each one cost several allocations apiece
// (BenchmarkCheckBodyManyObjects). Its keys are the struct types reachable
// from the payload types, so it never grows past a handful of entries.
type fieldCache struct{ m sync.Map } // reflect.Type -> map[string]reflect.Type

// structFields is the one cache every request shares.
var structFields fieldCache

func (c *fieldCache) of(t reflect.Type) map[string]reflect.Type {
	if f, ok := c.m.Load(t); ok {
		return f.(map[string]reflect.Type)
	}
	f, _ := c.m.LoadOrStore(t, jsonFields(t))
	return f.(map[string]reflect.Type)
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
