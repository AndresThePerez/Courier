// Package runner is Courier's run engine: one sandboxed request executor and
// two orchestrations of it — a sequential functional walker and an N-goroutine
// worker pool — under a manager that makes "one run at a time" true even when a
// run panics.
//
// Lifecycle constants live here (the functional deadline, the run-abort
// sentinel). Payload caps belong to internal/sandbox and the SLO block belongs
// to internal/report; each constant lives where its behaviour lives.
package runner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/AndresThePerez/courier/internal/report"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

const (
	// ClientTimeout is the hard per-request ceiling. It is deliberately the
	// *only* deadline on a request: mode deadlines gate dispatch, never an
	// in-flight request. See the two-context note on RunPerformance.
	ClientTimeout = 10 * time.Second

	// MaxBodyBytes caps how much of a response is retained for assertion
	// evaluation. The remainder is still drained and still counted, so latency
	// measures to true end-of-body and Size reflects the whole response.
	MaxBodyBytes = 1 << 20

	// UserAgent identifies Courier to the target. A load generator that hides
	// what it is makes the target's own logs harder to read.
	UserAgent = "courier/1.0 (+https://courier.andrestheperez.com)"
)

// Error kinds recorded against a failed dispatch.
//
// ErrKindAborted is the one that matters: Courier's own cancel, shutdown, or
// mode deadline kills in-flight requests, and http.Client reports that as
// context.Canceled — indistinguishable from a target-side reset unless it is
// classified deliberately. Left unclassified, cancelling a 50-worker run lands
// up to 50 phantom connection errors and stores a report that blames the target
// for the visitor pressing Cancel.
const (
	ErrKindTimeout    = report.KindTimeout
	ErrKindConnection = report.KindConnection
	ErrKindAborted    = "aborted"
)

// ErrRunAborted is the cause a run's context is cancelled with. Classification
// reads context.Cause rather than context.Err, which makes the discriminator
// structural: a target that resets the connection is still a transport failure
// even though both surface as context.Canceled at the call site.
var ErrRunAborted = errors.New("run aborted by courier")

// Response is one dispatch's outcome.
//
// Status and Err are not mutually exclusive in one case only: a body that fails
// mid-drain has a real status but no usable sample. Accounting checks Err first,
// so such a dispatch is a transport failure (or an abort), never a sample.
type Response struct {
	Status    int
	LatencyMs float64
	Body      []byte // nil when keepBody is false
	Size      int    // full body size in bytes, always counted
	Err       error
	ErrKind   string // "" | "timeout" | "connection" | "aborted"
}

// Executor owns the one tuned *http.Client every run shares and is the only
// place a URL is ever built. The base URL comes from configuration at startup;
// the path comes from the server-side catalog. No client input reaches either.
type Executor struct {
	baseURL string
	client  *http.Client
}

// NewExecutor builds the shared executor for a target base URL.
func NewExecutor(baseURL string) *Executor {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	// Go's default MaxIdleConnsPerHost is 2. At 50 workers against one host
	// that thrashes connections and distorts every latency number in the
	// report — the load test would be measuring its own dialer.
	tr.MaxIdleConns = 256
	tr.MaxIdleConnsPerHost = 256
	tr.IdleConnTimeout = 90 * time.Second
	return &Executor{
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  &http.Client{Timeout: ClientTimeout, Transport: tr},
	}
}

// BaseURL is the fixed target this executor talks to.
func (e *Executor) BaseURL() string { return e.baseURL }

// Query renders a request's allowlisted params as "?a=1&b=2", or "" when there
// are none. Keys are sorted (url.Values.Encode), so the same request always
// renders the same string in a report.
func (e *Executor) Query(r sandbox.Request) string {
	if len(r.Params) == 0 {
		return ""
	}
	v := make(url.Values, len(r.Params))
	for k, s := range r.Params {
		v.Set(k, s)
	}
	enc := v.Encode()
	if enc == "" {
		return ""
	}
	return "?" + enc
}

// URL resolves a request to the absolute URL it would be dispatched to. It is
// for display and logging; Do resolves independently so a caller cannot hand a
// dispatch a URL of its own.
func (e *Executor) URL(r sandbox.Request) (string, error) {
	ep, ok := sandbox.Lookup(r.Endpoint)
	if !ok {
		return "", unknownEndpoint(r.Endpoint)
	}
	return e.baseURL + ep.Path + e.Query(r), nil
}

// Do resolves the endpoint and dispatches. sandbox.Lookup returns a deep copy,
// so a run resolves its sequence once and calls DoResolved per dispatch rather
// than paying for the copy 18,000 times.
func (e *Executor) Do(ctx context.Context, r sandbox.Request, keepBody bool) Response {
	ep, ok := sandbox.Lookup(r.Endpoint)
	if !ok {
		// Unreachable after sandbox.Validate; a guard, not a code path. The
		// kind keeps the report's error breakdown well-formed if it ever fires.
		return Response{Err: unknownEndpoint(r.Endpoint), ErrKind: ErrKindConnection}
	}
	return e.DoResolved(ctx, ep, r, keepBody)
}

// DoResolved dispatches against an endpoint already resolved from the catalog.
//
// The body is always fully drained and closed — not draining leaves the
// connection unreusable, which is the same MaxIdleConnsPerHost bug arriving by
// a different door. Latency is measured to end-of-body, never to first byte: a
// target that flushes headers immediately and streams slowly is a slow target,
// and a first-byte number would hide exactly that.
func (e *Executor) DoResolved(ctx context.Context, ep sandbox.Endpoint, r sandbox.Request, keepBody bool) Response {
	target := e.baseURL + ep.Path + e.Query(r)
	req, err := http.NewRequestWithContext(ctx, ep.Method, target, nil)
	if err != nil {
		return Response{Err: err, ErrKind: classify(ctx, err)}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", UserAgent)

	start := time.Now()
	resp, err := e.client.Do(req)
	if err != nil {
		return Response{LatencyMs: msSince(start), Err: err, ErrKind: classify(ctx, err)}
	}
	defer resp.Body.Close()

	var body []byte
	var n int64
	if keepBody {
		body, err = io.ReadAll(io.LimitReader(resp.Body, MaxBodyBytes))
		n = int64(len(body))
		if err == nil {
			var rest int64
			rest, err = io.Copy(io.Discard, resp.Body)
			n += rest
		}
	} else {
		n, err = io.Copy(io.Discard, resp.Body)
	}
	latency := msSince(start)

	if err != nil {
		return Response{Status: resp.StatusCode, LatencyMs: latency, Size: int(n), Err: err, ErrKind: classify(ctx, err)}
	}
	return Response{Status: resp.StatusCode, LatencyMs: latency, Body: body, Size: int(n)}
}

// Entries resolves a sequence into the report metadata that makes a stored run
// readable without the original payload.
func Entries(ex *Executor, seq []sandbox.Request) []report.Entry {
	out := make([]report.Entry, len(seq))
	for i, r := range seq {
		e := report.Entry{Index: i, Name: r.Name, Endpoint: r.Endpoint, Query: ex.Query(r)}
		if ep, ok := sandbox.Lookup(r.Endpoint); ok {
			e.Path = ep.Path
		}
		out[i] = e
	}
	return out
}

// resolve looks every request's endpoint up once, at run start. An unknown
// endpoint yields the zero Endpoint, whose empty method makes the dispatch fail
// without leaving the machine.
func resolve(seq []sandbox.Request) []sandbox.Endpoint {
	eps := make([]sandbox.Endpoint, len(seq))
	for i, r := range seq {
		eps[i], _ = sandbox.Lookup(r.Endpoint)
	}
	return eps
}

// classify names why a dispatch failed.
//
// The abort test comes first and is deliberately narrow: this run's own
// sentinel, either surfaced directly by net/http (which unwraps the request
// context's cause into the returned *url.Error) or reached via context.Cause
// when only a bare context.Canceled comes back. Both shapes are checked because
// which one appears is a net/http implementation detail, and the accounting
// rule that rests on this discriminator is not.
//
// A per-request timeout surfaces as DeadlineExceeded and a target-side reset
// carries no cause at all, so neither can be mistaken for a visitor pressing
// Cancel.
func classify(ctx context.Context, err error) string {
	if errors.Is(err, ErrRunAborted) {
		return ErrKindAborted
	}
	if errors.Is(err, context.Canceled) && errors.Is(context.Cause(ctx), ErrRunAborted) {
		return ErrKindAborted
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ErrKindTimeout
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return ErrKindTimeout
	}
	return ErrKindConnection
}

func unknownEndpoint(id string) error {
	return fmt.Errorf("unknown endpoint %q: no request was sent", id)
}

// msSince reports elapsed milliseconds at microsecond resolution. Against a
// target that answers in 1-30ms, integer milliseconds would quantise the whole
// distribution into three or four values.
func msSince(start time.Time) float64 {
	return float64(time.Since(start).Microseconds()) / 1000
}
