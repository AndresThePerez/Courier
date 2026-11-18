package api

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/collections"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

func testStatic() fs.FS {
	return fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>courier</html>")}}
}

func testServer(t *testing.T) *Server {
	t.Helper()
	return New(testStatic(), Options{TargetURL: "http://127.0.0.1:8081", TargetDisplay: "pokesearch.andrestheperez.com"})
}

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	testServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("status field = %v, want ok", body["status"])
	}
}

// The editor's parameter dropdown is built from the catalog this endpoint
// serves, which is what makes the sandbox visible rather than merely enforced.
func TestCollectionsEndpointCarriesTheCatalog(t *testing.T) {
	rec := httptest.NewRecorder()
	testServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/collections", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var body struct {
		Collections []collections.Collection `json:"collections"`
		Endpoints   []sandbox.Endpoint       `json:"endpoints"`
		Target      string                   `json:"target"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Collections) == 0 {
		t.Error("no collections; the demo opens empty")
	}
	if len(body.Endpoints) == 0 {
		t.Fatal("no endpoint catalog; the editor has no parameter dropdown to build")
	}
	if body.Target == "" {
		t.Error("no target name; the UI cannot say what it is testing against")
	}

	search := body.Endpoints[0]
	if search.ID != "search" {
		t.Fatalf("endpoints[0] = %q, want search", search.ID)
	}
	if !slices.Contains(search.Params, "q") {
		t.Errorf("search params %v are missing q", search.Params)
	}
	// The catalog is the one source of truth for the allowlist, so this asserts
	// a property rather than a key count: nothing outside PokéSearch's
	// documented contract has crept in.
	if slices.Contains(search.Params, "url") || slices.Contains(search.Params, "target") {
		t.Errorf("search params %v contain a key that could influence the host", search.Params)
	}
	for _, ep := range body.Endpoints {
		if ep.Path == "" || ep.Method != http.MethodGet {
			t.Errorf("endpoint %q is not a well-formed GET target: %+v", ep.ID, ep)
		}
	}
}

func TestServesEmbeddedIndex(t *testing.T) {
	rec := httptest.NewRecorder()
	testServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() == 0 {
		t.Fatalf("index: status %d, %d bytes", rec.Code, rec.Body.Len())
	}
}

// The README says the verb is part of the contract, and every answer under
// /api/ is JSON: a wrong verb on a known path is a 405 naming the verbs that
// path takes, and anything else is a 404, whatever the method.
func TestWrongVerbOnAnAPIPathAnswers405(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	allow := map[string]string{
		"/api/send":              "POST",
		"/api/status":            "GET, HEAD",
		"/api/collections":       "GET, HEAD",
		"/api/runs":              "GET, HEAD, POST",
		"/api/runs/x":            "DELETE, GET, HEAD",
		"/api/runs/x/stream":     "GET, HEAD",
		"/api/runs/x/report.pdf": "GET, HEAD",
	}
	methods := []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions}
	for path, want := range allow {
		for _, m := range methods {
			if strings.Contains(", "+want+",", ", "+m+",") {
				continue
			}
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, httptest.NewRequest(m, path, nil))
			wantAPIError(t, rec, m, path, http.StatusMethodNotAllowed)
			if got := rec.Header().Get("Allow"); got != want {
				t.Errorf("%s %s Allow = %q, want %q", m, path, got, want)
			}
		}
	}
}

func TestUnknownAPIPathsAnswerAJSON404ForEveryVerb(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	paths := map[string]string{ // as requested -> as named in the error
		"/api/nope":             "/api/nope",
		"/api":                  "/api",
		"/api/":                 "/api/",
		"/api/runs/":            "/api/runs/",
		"/api/runs/x/nope":      "/api/runs/x/nope",
		"/api/%6Eope":           "/api/nope",
		"/api/%3Cscript%3E":     "/api/<script>",
		"/api/send/extra":       "/api/send/extra",
		"/api/status/":          "/api/status/",
		"/api/collections.json": "/api/collections.json",
	}
	methods := []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions, "TRACE"}
	for path, named := range paths {
		for _, m := range methods {
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, httptest.NewRequest(m, path, nil))
			body := wantAPIError(t, rec, m, path, http.StatusNotFound)
			if rec.Header().Get("Allow") != "" {
				t.Errorf("%s %s carries Allow %q on a 404", m, path, rec.Header().Get("Allow"))
			}
			if m == http.MethodHead {
				continue
			}
			if want := fmt.Sprintf("no such endpoint %q", named); body.Error != want {
				t.Errorf("%s %s error = %q, want %q", m, path, body.Error, want)
			}
			if strings.Contains(rec.Body.String(), "<") {
				t.Errorf("%s %s body %s carries a raw '<'", m, path, rec.Body.String())
			}
		}
	}
}

// wantAPIError checks an error answer is JSON, carries the security headers,
// and has the given status.
func wantAPIError(t *testing.T, rec *httptest.ResponseRecorder, method, path string, status int) errorBody {
	t.Helper()
	if rec.Code != status {
		t.Errorf("%s %s = %d %q, want %d", method, path, rec.Code, rec.Body.String(), status)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("%s %s Content-Type = %q, want application/json", method, path, ct)
	}
	for _, h := range []string{"Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"} {
		if rec.Header().Get(h) == "" {
			t.Errorf("%s %s has no %s", method, path, h)
		}
	}
	var body errorBody
	if method != http.MethodHead {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("%s %s body %q is not JSON: %v", method, path, rec.Body.String(), err)
		}
	}
	return body
}

// postRaw sends body exactly as given, with the Content-Type values listed
// (none when the list is empty), so a test controls every byte the decoder sees.
func postRaw(t *testing.T, s *Server, path string, body io.Reader, contentTypes ...string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, path, body)
	for _, ct := range contentTypes {
		r.Header.Add("Content-Type", ct)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, r)
	return rec
}

func wantError(t *testing.T, rec *httptest.ResponseRecorder, status int, field string) errorBody {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d %s, want %d", rec.Code, rec.Body.String(), status)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var body errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body %q is not JSON: %v", rec.Body.String(), err)
	}
	if body.Field != field {
		t.Errorf("field = %q, want %q (body %s)", body.Field, field, rec.Body.String())
	}
	return body
}

// An unknown endpoint is the cheapest proof that a body got past the decoder:
// it is refused by the validator, by name, and nothing is dispatched.
const undispatchable = `{"endpoint":"nope"}`

func TestPostBodiesMustBeDeclaredJSON(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	refused := [][]string{
		nil,
		{"text/plain"},
		{"application/jsonx"},
		{"application/x-www-form-urlencoded"},
		{"application/json; charset=latin1"},
		{"application/json, text/plain"},
		{"application/json", "application/json"},
	}
	for _, path := range []string{"/api/send", "/api/runs"} {
		for _, cts := range refused {
			rec := postRaw(t, s, path, strings.NewReader(undispatchable), cts...)
			body := wantError(t, rec, http.StatusUnsupportedMediaType, "body")
			if body.Error != "Content-Type must be application/json" {
				t.Errorf("%s %q: error = %q", path, cts, body.Error)
			}
		}
	}
	for _, ct := range []string{"application/json", "application/json; charset=utf-8", "Application/JSON", "APPLICATION/JSON ; CHARSET=UTF-8", "application/json;"} {
		rec := postRaw(t, s, "/api/send", strings.NewReader(undispatchable), ct)
		wantError(t, rec, http.StatusBadRequest, "endpoint")
	}
}

func TestOversizeBodiesAre413AtTheExactCap(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	pad := func(n int) string { return undispatchable + strings.Repeat(" ", n-len(undispatchable)) }

	rec := postRaw(t, s, "/api/send", strings.NewReader(pad(MaxBodyBytes)), "application/json")
	wantError(t, rec, http.StatusBadRequest, "endpoint")

	bodies := map[string]func() io.Reader{
		"one byte over": func() io.Reader { return strings.NewReader(pad(MaxBodyBytes + 1)) },
		"300 KiB":       func() io.Reader { return strings.NewReader(pad(300 << 10)) },
		// A reader of unknown length is sent without a Content-Length, the way
		// a chunked upload arrives.
		"no Content-Length": func() io.Reader { return io.MultiReader(strings.NewReader(pad(MaxBodyBytes + 1))) },
	}
	for name, body := range bodies {
		for _, path := range []string{"/api/send", "/api/runs"} {
			rec := postRaw(t, s, path, body(), "application/json")
			got := wantError(t, rec, http.StatusRequestEntityTooLarge, "body")
			if got.Error != "payload exceeds the 262144 byte limit" {
				t.Errorf("%s %s: error = %q", name, path, got.Error)
			}
		}
	}
}

func TestBodiesAreDecodedStrictly(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	cases := []struct {
		name, path, body, field string
		contains                []string
	}{
		{"trailing value", "/api/send", `{"endpoint":"healthz"} {"x":1}`, "body", []string{"body must hold exactly one JSON value"}},
		{"trailing garbage", "/api/send", `{"endpoint":"healthz"}x`, "body", []string{"body must hold exactly one JSON value"}},
		{"unknown field", "/api/send", `{"endpoint":"healthz","url":"http://x"}`, "body", []string{`"url"`}},
		{"unknown field, other case", "/api/send", `{"ENDPOINT":"healthz"}`, "body", []string{`"ENDPOINT"`}},
		{"nested unknown field", "/api/runs", `{"mode":"functional","sequence":[{"endpoint":"healthz"},{"endpoint":"healthz","host":"x"}]}`, "sequence[1]", []string{`"host"`}},
		{"unknown assertion field", "/api/send", `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":200,"expr":"1"}]}`, "assertions[0]", []string{`"expr"`}},
		{"duplicate key", "/api/send", `{"endpoint":"nope","endpoint":"healthz"}`, "endpoint", []string{"duplicate"}},
		{"duplicate param", "/api/send", `{"endpoint":"search","params":{"q":"a","q":"b"}}`, "params.q", []string{"duplicate"}},
		{"type error", "/api/runs", `{"mode":"performance","sequence":[{"endpoint":"healthz"}],"options":{"concurrency":"x"}}`, "options.concurrency", []string{"whole number", "a string"}},
		{"fractional int", "/api/runs", `{"mode":"performance","sequence":[{"endpoint":"healthz"}],"options":{"concurrency":1.5}}`, "options.concurrency", []string{"whole number"}},
		{"huge int", "/api/runs", `{"mode":"performance","sequence":[{"endpoint":"healthz"}],"options":{"concurrency":99999999999999999999}}`, "options.concurrency", []string{"out of range"}},
		{"huge float", "/api/send", `{"endpoint":"healthz","assertions":[{"type":"latency","op":"lt","value":1e400}]}`, "assertions[0].value", []string{"out of range"}},
		{"number as string param", "/api/runs", `{"mode":"functional","sequence":[{"endpoint":"search"},{"endpoint":"search","params":{"q":5}}]}`, "sequence[1].params.q", []string{"a string", "a number"}},
		{"object for an array", "/api/runs", `{"mode":"functional","sequence":{}}`, "sequence", []string{"an array", "an object"}},
		{"bool as string", "/api/runs", `{"mode":"functional","sequence":[{"endpoint":"healthz"}],"options":{"stop_on_failure":"yes"}}`, "options.stop_on_failure", []string{"a string"}},
		{"syntax error", "/api/send", `{"endpoint":}`, "body", []string{"malformed JSON at byte 13"}},
		{"truncated body", "/api/send", `{"endpoint":"heal`, "body", []string{"malformed JSON at byte"}},
		{"empty body", "/api/send", ``, "body", []string{"body must hold exactly one JSON value"}},
		{"null", "/api/send", `null`, "body", []string{"body must be a JSON object"}},
		{"array", "/api/runs", `[{"endpoint":"healthz"}]`, "body", []string{"body must be a JSON object"}},
		{"deep nesting", "/api/send", strings.Repeat("[", 20000) + strings.Repeat("]", 20000), "body", []string{"malformed JSON at byte"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := postRaw(t, s, c.path, strings.NewReader(c.body), "application/json")
			body := wantError(t, rec, http.StatusBadRequest, c.field)
			for _, want := range c.contains {
				if !strings.Contains(body.Error, want) {
					t.Errorf("error = %q, want it to contain %q", body.Error, want)
				}
			}
			for _, leak := range []string{"Go", "struct", "RunRequest", "sandbox.", "of type", "json:", "float64", "interface"} {
				if strings.Contains(body.Error, leak) {
					t.Errorf("error = %q leaks %q", body.Error, leak)
				}
			}
		})
	}

	// Whitespace around the value is not data.
	for _, ws := range []string{" \r\n\t ", "\n"} {
		rec := postRaw(t, s, "/api/send", strings.NewReader(ws+undispatchable+ws), "application/json")
		wantError(t, rec, http.StatusBadRequest, "endpoint")
	}
}

// There is no URL field and an attempt to supply one is refused by name, at
// every depth, rather than dropped.
func TestAClientSuppliedTargetIsRefusedByName(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	for _, c := range []struct{ path, body, key string }{
		{"/api/send", `{"endpoint":"healthz","url":"http://192.0.2.10/"}`, "url"},
		{"/api/send", `{"endpoint":"healthz","host":"192.0.2.10"}`, "host"},
		{"/api/runs", `{"mode":"functional","sequence":[{"endpoint":"healthz","path":"/admin"}]}`, "path"},
		{"/api/runs", `{"mode":"functional","target":"http://192.0.2.10","sequence":[{"endpoint":"healthz"}]}`, "target"},
	} {
		rec := postRaw(t, s, c.path, strings.NewReader(c.body), "application/json")
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `\"`+c.key+`\"`) {
			t.Errorf("%s %s = %d %s, want a 400 naming %q", c.path, c.body, rec.Code, rec.Body.String(), c.key)
		}
	}
}

// The browser builds its two POST bodies by hand (payloadOf in
// render-editor.js, requestPayload and start in render-runner.js) and sends
// them as application/json. Strict decoding must accept exactly those shapes,
// built here from the curated requests as the browser receives them.
func TestTheBrowserClientsPayloadsStillDecode(t *testing.T) {
	c := &clock{}
	s := newServer(t, newTarget(t, 0), c)

	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/collections", nil))
	var served struct {
		Collections []struct {
			Requests []map[string]any `json:"requests"`
		} `json:"collections"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &served); err != nil {
		t.Fatalf("decode collections: %v", err)
	}

	// requestPayload: id, name, endpoint, params and the assertions copied
	// verbatim.
	requestPayload := func(r map[string]any) map[string]any {
		params, _ := r["params"].(map[string]any)
		if params == nil {
			params = map[string]any{}
		}
		assertions, _ := r["assertions"].([]any)
		if assertions == nil {
			assertions = []any{}
		}
		name, _ := r["name"].(string)
		return map[string]any{"id": r["id"], "name": name, "endpoint": r["endpoint"], "params": params, "assertions": assertions}
	}
	// payloadOf: the same, but each assertion is rebuilt from type and op,
	// a json path defaulting to "$", and a value unless the operator takes none.
	payloadOf := func(r map[string]any) map[string]any {
		out := requestPayload(r)
		rows := []any{}
		for _, raw := range out["assertions"].([]any) {
			a := raw.(map[string]any)
			row := map[string]any{"type": a["type"], "op": a["op"]}
			if a["type"] == "json" {
				row["path"] = a["path"]
			}
			if !(a["type"] == "json" && a["op"] == "exists") {
				row["value"] = a["value"]
			}
			rows = append(rows, row)
		}
		out["assertions"] = rows
		return out
	}

	var sequence []any
	for _, col := range served.Collections {
		for _, r := range col.Requests {
			sequence = append(sequence, requestPayload(r))
			if rec := do(t, s, http.MethodPost, "/api/send", payloadOf(r)); rec.Code != http.StatusOK {
				t.Errorf("Send of curated %v = %d %s, want 200", r["id"], rec.Code, rec.Body.String())
			}
		}
	}
	if len(sequence) == 0 || len(sequence) > sandbox.MaxSequence {
		t.Fatalf("%d curated requests; this test sends them as one run", len(sequence))
	}

	// The store's default options, all four keys, in both modes.
	options := map[string]any{"stop_on_failure": false, "delay_ms": 0, "concurrency": 10, "duration_secs": 10}
	rec = do(t, s, http.MethodPost, "/api/runs", map[string]any{"mode": "functional", "sequence": sequence, "options": options})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("functional run = %d %s, want 202", rec.Code, rec.Body.String())
	}
	waitIdle(t, s)
	c.advance(time.Hour)

	options = map[string]any{"stop_on_failure": true, "delay_ms": 250, "concurrency": 1, "duration_secs": 1}
	rec = do(t, s, http.MethodPost, "/api/runs", map[string]any{"mode": "performance", "sequence": sequence[:1], "options": options})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("performance run = %d %s, want 202", rec.Code, rec.Body.String())
	}
	waitIdle(t, s)
}

// countingTarget is a stub target that records every request it receives, so
// a refused body can be shown to have dispatched nothing.
type countingTarget struct {
	URL     string
	hits    atomic.Int64
	mu      sync.Mutex
	queries []url.Values
}

func newCountingTarget(t *testing.T) *countingTarget {
	t.Helper()
	ct := &countingTarget{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ct.hits.Add(1)
		ct.mu.Lock()
		ct.queries = append(ct.queries, r.URL.Query())
		ct.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"ok","total":1,"results":[]}`)
	}))
	t.Cleanup(srv.Close)
	ct.URL = srv.URL
	return ct
}

// errorLeakWords are fragments of Go's own error text and of server internals
// that must never reach a visitor in an error body.
var errorLeakWords = []string{"Go ", "struct", "sandbox.", "RunRequest", "json:", "float64",
	"interface", "runtime", "goroutine", ".go:", "of type", "127.0.0.1"}

func checkSmallCleanError(t *testing.T, name string, rec *httptest.ResponseRecorder) errorBody {
	t.Helper()
	if n := rec.Body.Len(); n > 1024 {
		t.Errorf("%s: error body is %d bytes; client text must be clipped, not echoed whole", name, n)
	}
	for _, w := range errorLeakWords {
		if strings.Contains(rec.Body.String(), w) {
			t.Errorf("%s: error body leaks %q: %.300s", name, w, rec.Body.String())
		}
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("%s: Content-Type = %q, want application/json", name, ct)
	}
	var eb errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &eb); err != nil || eb.Error == "" {
		t.Errorf("%s: body is not the JSON error shape: %.300s", name, rec.Body.String())
	}
	return eb
}

// The shape check runs before encoding/json and must refuse everything the
// decoder would otherwise fold, merge or drop, at every level of the payload,
// and must refuse it before anything is sent to the target.
func TestRefusedBodiesNameTheKeyAndDispatchNothing(t *testing.T) {
	target := newCountingTarget(t)
	s := newServer(t, target.URL, nil)

	hugeKey := strings.Repeat("k", 260_000)
	hugeNumber := "1" + strings.Repeat("0", 10_000)
	deep := strings.Repeat("[", 100_000) + strings.Repeat("]", 100_000)
	manyDuplicates := `{"endpoint":"healthz","params":{` +
		strings.TrimSuffix(strings.Repeat(`"q":"a",`, 30_000), ",") + `}}`
	var manyKeys strings.Builder
	manyKeys.WriteString(`{"endpoint":"search","params":{`)
	for i := 0; manyKeys.Len() < 250_000; i++ {
		if i > 0 {
			manyKeys.WriteString(",")
		}
		fmt.Fprintf(&manyKeys, `"k%d":""`, i)
	}
	manyKeys.WriteString(`}}`)

	cases := []struct {
		name, body, field, mention string
		status                     int
	}{
		{"long-s folds onto assertions", `{"endpoint":"healthz","aſsertions":[{"type":"status","op":"eq","value":500}]}`, "body", "aſsertions", 400},
		{"kelvin sign key", `{"endpoint":"healthz","\u212Aey":1}`, "body", "\u212aey", 400},
		{"upper-case known key", `{"ENDPOINT":"healthz"}`, "body", "ENDPOINT", 400},
		{"url at the top", `{"endpoint":"healthz","url":"http://192.0.2.1/"}`, "body", "url", 400},
		{"escaped url key", `{"endpoint":"healthz","url":"http://192.0.2.1/"}`, "body", "url", 400},
		{"host inside an assertion", `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":200,"host":"192.0.2.1"}]}`, "assertions[0]", "host", 400},
		{"method inside an assertion", `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":200,"method":"POST"}]}`, "assertions[0]", "method", 400},
		{"url as a parameter", `{"endpoint":"search","params":{"q":"x","url":"http://192.0.2.1/"}}`, "params", "url", 400},
		{"headers as a parameter", `{"endpoint":"search","params":{"headers":"x"}}`, "params", "headers", 400},
		{"duplicate endpoint, last would win", `{"endpoint":"healthz","endpoint":"search"}`, "endpoint", "endpoint", 400},
		{"duplicate inside an assertion", `{"endpoint":"healthz","assertions":[{"type":"latency","type":"status","op":"eq","value":200}]}`, "assertions[0].type", "type", 400},
		{"duplicate parameter", `{"endpoint":"search","params":{"q":"a","q":"b"}}`, "params.q", "q", 400},
		{"duplicate inside a value object", `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":{"a":1,"a":2}}]}`, "assertions[0].value.a", "a", 400},
		{"number as a parameter", `{"endpoint":"search","params":{"q":1}}`, "params.q", "", 400},
		{"array as a parameter", `{"endpoint":"search","params":{"q":["a"]}}`, "params.q", "", 400},
		{"object where an array goes", `{"endpoint":"healthz","assertions":{}}`, "assertions", "", 400},
		{"string where an object goes", `{"endpoint":"healthz","params":"q=x"}`, "params", "", 400},
		{"number past float64", `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":1e400}]}`, "assertions[0].value", "", 400},
		{"ten-thousand-digit number", `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":` + hugeNumber + `}]}`, "", "", 400},
		{"260 KB unknown key", `{"endpoint":"healthz","` + hugeKey + `":1}`, "body", "", 400},
		{"100,000 levels of nesting", `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":` + deep + `}]}`, "body", "", 400},
		{"30,000 duplicate keys", manyDuplicates, "params.q", "", 400},
		{"tens of thousands of keys", manyKeys.String(), "params", "", 400},
		{"byte-order mark", "\ufeff" + `{"endpoint":"healthz"}`, "body", "", 400},
		{"leading plus", `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":+200}]}`, "body", "", 400},
		{"leading zero", `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":0200}]}`, "body", "", 400},
		{"top-level null", `null`, "body", "", 400},
		{"top-level array", `[{"endpoint":"healthz"}]`, "body", "", 400},
		{"trailing bracket", `{"endpoint":"healthz"}]`, "body", "", 400},
		{"truncated body", `{"endpoint":"heal`, "body", "", 400},
		{"empty body", ``, "body", "", 400},
	}
	for _, tc := range cases {
		start := time.Now()
		rec := postRaw(t, s, "/api/send", strings.NewReader(tc.body), "application/json")
		if d := time.Since(start); d > 5*time.Second {
			t.Errorf("%s: took %v", tc.name, d)
		}
		if rec.Code != tc.status {
			t.Errorf("%s: status = %d %.300s, want %d", tc.name, rec.Code, rec.Body.String(), tc.status)
			continue
		}
		eb := checkSmallCleanError(t, tc.name, rec)
		if tc.field != "" && eb.Field != tc.field {
			t.Errorf("%s: field = %q, want %q (error %q)", tc.name, eb.Field, tc.field, eb.Error)
		}
		if tc.mention != "" && !strings.Contains(eb.Error, tc.mention) {
			t.Errorf("%s: error %q does not name %q", tc.name, eb.Error, tc.mention)
		}
	}
	if n := target.hits.Load(); n != 0 {
		t.Fatalf("the target received %d requests from refused bodies, want 0", n)
	}

	// What the shape check lets through must still be a request the
	// validator accepts as the author wrote it.
	accepted := []string{
		`{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":2e2}]}`,
		`{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":200.0}]}`,
		`{"id":null,"name":null,"endpoint":"healthz","params":null,"assertions":null}`,
		`{"endpoint":"healthz","params":{},"assertions":[]}`,
		`{"endpoint":"healthz","assertions":[{"type":"json","path":"$.results","op":"count","value":-0}]}`,
		"\r\n\t {\"endpoint\":\"healthz\"} \r\n\t",
	}
	for _, body := range accepted {
		before := target.hits.Load()
		rec := postRaw(t, s, "/api/send", strings.NewReader(body), "application/json")
		if rec.Code != http.StatusOK {
			t.Errorf("%q: status = %d %s, want 200", body, rec.Code, rec.Body.String())
			continue
		}
		if target.hits.Load() != before+1 {
			t.Errorf("%q: accepted but not dispatched exactly once", body)
		}
	}
}

// Only a POST body is held to the JSON media type; reads and cancels carry no
// body and must not start answering 415 because of a stray header.
func TestContentTypeAnswersAreStable(t *testing.T) {
	target := newCountingTarget(t)
	s := newServer(t, target.URL, nil)
	body := `{"endpoint":"healthz"}`

	accepted := []string{
		"application/json",
		"Application/JSON",
		" application/json ",
		"application/json;charset=UTF-8",
		`application/json; charset="utf-8"`,
	}
	for _, ct := range accepted {
		if rec := postRaw(t, s, "/api/send", strings.NewReader(body), ct); rec.Code != http.StatusOK {
			t.Errorf("Content-Type %q: status = %d %s, want 200", ct, rec.Code, rec.Body.String())
		}
	}
	dispatched := target.hits.Load()

	refused := [][]string{
		nil,
		{""},
		{"text/json"},
		{"text/plain"},
		{"application/jsonx"},
		{"application/json+x"},
		{"application/json; charset=latin1"},
		{"application/json, text/plain"},
		{"application/json", "application/json"},
		{"multipart/form-data; boundary=x"},
	}
	for _, cts := range refused {
		for _, path := range []string{"/api/send", "/api/runs"} {
			rec := postRaw(t, s, path, strings.NewReader(body), cts...)
			if rec.Code != http.StatusUnsupportedMediaType {
				t.Errorf("POST %s with Content-Type %q: status = %d %s, want 415", path, cts, rec.Code, rec.Body.String())
				continue
			}
			eb := checkSmallCleanError(t, fmt.Sprint(cts), rec)
			if eb.Field != "body" || eb.Error != "Content-Type must be application/json" {
				t.Errorf("POST %s with Content-Type %q: body = %+v", path, cts, eb)
			}
		}
	}
	if n := target.hits.Load(); n != dispatched {
		t.Errorf("refused media types dispatched %d requests", n-dispatched)
	}

	for _, tc := range []struct {
		method, path string
		want         int
	}{
		{http.MethodGet, "/api/runs", http.StatusOK},
		{http.MethodGet, "/api/status", http.StatusOK},
		{http.MethodDelete, "/api/runs/run-none", http.StatusNotFound},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.Header.Set("Content-Type", "text/plain")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, r)
		if rec.Code != tc.want {
			t.Errorf("%s %s with Content-Type text/plain = %d, want %d", tc.method, tc.path, rec.Code, tc.want)
		}
	}
}

// A body that hides its length, or lies about it, is still held to the cap.
func TestOversizeBodiesWithoutAnHonestLengthAre413(t *testing.T) {
	target := newCountingTarget(t)
	s := newServer(t, target.URL, nil)
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)

	over := `{"endpoint":"healthz","name":"` + strings.Repeat("a", MaxBodyBytes) + `"}`
	// Chunked: the reader hides its length from the client.
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/send", io.MultiReader(strings.NewReader(over)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("chunked post: %v", err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("chunked oversize body = %d %.200s, want 413", resp.StatusCode, b)
	}

	// Content-Length claims a small body; the recorder path reads past it.
	r := httptest.NewRequest(http.MethodPost, "/api/send", strings.NewReader(over))
	r.ContentLength = 20
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, r)
	if rec.Code != http.StatusRequestEntityTooLarge && rec.Code != http.StatusBadRequest {
		t.Errorf("lying Content-Length = %d, want 413 or 400", rec.Code)
	}
	if n := target.hits.Load(); n != 0 {
		t.Errorf("oversize bodies dispatched %d requests", n)
	}
}

// Every verb on every API path, through a real listener so HEAD is answered
// the way a client sees it. Allow must name exactly the verbs the route takes,
// and each verb it names must really be taken.
func TestEveryVerbOnEveryAPIPathAnswersJSON(t *testing.T) {
	s := newServer(t, newCountingTarget(t).URL, nil)
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)

	routes := map[string][]string{
		"/api/status":                 {"GET", "HEAD"},
		"/api/collections":            {"GET", "HEAD"},
		"/api/send":                   {"POST"},
		"/api/runs":                   {"GET", "HEAD", "POST"},
		"/api/runs/run-x":             {"DELETE", "GET", "HEAD"},
		"/api/runs/run-x/stream":      {"GET", "HEAD"},
		"/api/runs/run-x/report.pdf":  {"GET", "HEAD"},
		"/api":                        nil,
		"/api/":                       nil,
		"/api/nope":                   nil,
		"/api/status/":                nil,
		"/api/send/":                  nil,
		"/api/runs/run-x/stream/more": nil,
		"/api/runs%2Frun-x":           nil,
		"/api/%3Cscript%3Ealert(1)%3C%2Fscript%3E": nil,
		"/api/a%0D%0ASet-Cookie:%20x=1":            nil,
		"/api/" + strings.Repeat("p", 4096):        nil,
	}
	methods := []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "BREW"}

	call := func(method, path string) (*http.Response, string) {
		t.Helper()
		req, err := http.NewRequest(method, srv.URL+path, nil)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(b)
	}

	for path, verbs := range routes {
		name := path
		if len(name) > 60 {
			name = name[:60]
		}
		for _, m := range methods {
			resp, body := call(m, path)
			if slices.Contains(verbs, m) {
				if resp.StatusCode == http.StatusMethodNotAllowed {
					t.Errorf("%s %s = 405, but the route takes %s", m, name, m)
				}
				continue
			}
			want := http.StatusNotFound
			if verbs != nil {
				want = http.StatusMethodNotAllowed
			}
			if resp.StatusCode != want {
				t.Errorf("%s %s = %d %.200s, want %d", m, name, resp.StatusCode, body, want)
				continue
			}
			if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
				t.Errorf("%s %s Content-Type = %q", m, name, ct)
			}
			if resp.Header.Get("Content-Security-Policy") != contentSecurityPolicy {
				t.Errorf("%s %s has no Content-Security-Policy", m, name)
			}
			if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
				t.Errorf("%s %s has no X-Content-Type-Options: nosniff", m, name)
			}
			if resp.Header.Get("Set-Cookie") != "" {
				t.Errorf("%s %s: the path injected a header", m, name)
			}
			if want == http.StatusMethodNotAllowed {
				if got := resp.Header.Get("Allow"); got != strings.Join(verbs, ", ") {
					t.Errorf("%s %s Allow = %q, want %q", m, name, got, strings.Join(verbs, ", "))
				}
			}
			if m == http.MethodHead {
				if body != "" {
					t.Errorf("HEAD %s carried a body: %.200s", name, body)
				}
				continue
			}
			var eb errorBody
			if err := json.Unmarshal([]byte(body), &eb); err != nil || eb.Error == "" {
				t.Errorf("%s %s body is not the JSON error shape: %.200s", m, name, body)
			}
			if strings.Contains(body, "<script>") || strings.ContainsAny(body, "\r") {
				t.Errorf("%s %s reflects the path unescaped: %.200s", m, name, body)
			}
		}
	}
}

// What reaches the target is the cut value, whole characters only, and the
// response lists the cut; a clean request and a refused run carry no list.
func TestTruncatedIsWhatTheTargetReceives(t *testing.T) {
	target := newCountingTarget(t)
	s := newServer(t, target.URL, nil)

	long := strings.Repeat("é", sandbox.MaxParamValueLen+100)
	rec := do(t, s, http.MethodPost, "/api/send", map[string]any{
		"id": strings.Repeat("ü", sandbox.MaxNameLen+1), "name": strings.Repeat("n", sandbox.MaxNameLen),
		"endpoint": "search", "params": map[string]string{"q": long, "page": "1"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("send = %d %s", rec.Code, rec.Body.String())
	}
	got := decode[struct {
		Truncated []string `json:"truncated"`
	}](t, rec).Truncated
	if !slices.Equal(got, []string{"id", "params.q"}) {
		t.Errorf("truncated = %q, want [id params.q]", got)
	}
	target.mu.Lock()
	sent := target.queries[len(target.queries)-1].Get("q")
	target.mu.Unlock()
	if !utf8.ValidString(sent) || sent != strings.Repeat("é", sandbox.MaxParamValueLen) {
		t.Errorf("the target received q of %d characters (valid UTF-8 %v), want 500 whole characters",
			utf8.RuneCountInString(sent), utf8.ValidString(sent))
	}

	clean := do(t, s, http.MethodPost, "/api/send", map[string]any{"endpoint": "search", "params": map[string]string{"q": strings.Repeat("é", sandbox.MaxParamValueLen)}})
	if clean.Code != http.StatusOK || strings.Contains(clean.Body.String(), `"truncated"`) {
		t.Errorf("a send at the cap = %d and mentions truncated: %.300s", clean.Code, clean.Body.String())
	}

	refused := do(t, s, http.MethodPost, "/api/runs", map[string]any{
		"mode": "sideways", "sequence": []map[string]any{{"endpoint": "search", "params": map[string]string{"q": long}}},
	})
	if refused.Code != http.StatusBadRequest || strings.Contains(refused.Body.String(), "truncated") {
		t.Errorf("a refused run = %d %.300s, want 400 with no truncated", refused.Code, refused.Body.String())
	}

	run := do(t, s, http.MethodPost, "/api/runs", map[string]any{
		"mode": "functional", "sequence": []map[string]any{
			{"endpoint": "healthz"},
			{"endpoint": "search", "params": map[string]string{"q": long}},
		},
	})
	if run.Code != http.StatusAccepted {
		t.Fatalf("run = %d %s", run.Code, run.Body.String())
	}
	if got := decode[startedBody](t, run).Truncated; !slices.Equal(got, []string{"sequence[1].params.q"}) {
		t.Errorf("run truncated = %q, want [sequence[1].params.q]", got)
	}
	waitIdle(t, s)
	busyOrCooling := do(t, s, http.MethodPost, "/api/runs", map[string]any{
		"mode": "functional", "sequence": []map[string]any{{"endpoint": "search", "params": map[string]string{"q": long}}},
	})
	if busyOrCooling.Code == http.StatusConflict && strings.Contains(busyOrCooling.Body.String(), "truncated") {
		t.Errorf("a refused 409 carries truncated: %s", busyOrCooling.Body.String())
	}
}
