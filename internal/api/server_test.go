package api

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

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
