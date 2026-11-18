package api

import (
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// deepKey is a 20-character key: long enough that building a path string at
// every level of a deep nesting is what dominates the cost.
const deepKey = `"kkkkkkkkkkkkkkkkkkkk"`

// deepDepth is just under the decoder's 10,000-level nesting limit once the
// three levels of the surrounding payload are counted.
const deepDepth = 9990

// valueBody puts value inside an assertion's untyped value.
func valueBody(value string) string {
	return `{"endpoint":"healthz","assertions":[{"type":"status","op":"eq","value":` + value + `}]}`
}

func deepObject(leaf string) string {
	return strings.Repeat(`{`+deepKey+`:`, deepDepth) + leaf + strings.Repeat(`}`, deepDepth)
}

// minAlloc is the smallest number of heap bytes one call of f allocates over a
// few tries; the minimum sheds whatever the runtime did in the background.
func minAlloc(t *testing.T, f func()) uint64 {
	t.Helper()
	var best uint64
	for i := range 3 {
		var before, after runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&before)
		f()
		runtime.ReadMemStats(&after)
		if d := after.TotalAlloc - before.TotalAlloc; i == 0 || d < best {
			best = d
		}
	}
	return best
}

// A body at the size cap must cost memory in proportion to its size, however
// it is nested: /api/send decodes before its one-in-flight check, so anyone
// can make the server do this several times at once.
func TestDecodingADeeplyNestedBodyStaysLinearInItsSize(t *testing.T) {
	cases := []struct{ name, body string }{
		{"object", valueBody(deepObject("1"))},
		{"array", valueBody(strings.Repeat("[", deepDepth) + "1" + strings.Repeat("]", deepDepth))},
		{"two keys a level", valueBody(strings.Repeat(`{"a":1,`+deepKey+`:`, 8000) + "1" + strings.Repeat(`}`, 8000))},
	}
	const bound = 32 * MaxBodyBytes
	for _, tc := range cases {
		if len(tc.body) > MaxBodyBytes {
			t.Fatalf("%s: body is %d bytes, over the cap", tc.name, len(tc.body))
		}
		var ok bool
		alloc := minAlloc(t, func() {
			r := httptest.NewRequest(http.MethodPost, "/api/send", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			var req sandbox.Request
			ok = decodeJSON(httptest.NewRecorder(), r, &req)
		})
		if !ok {
			t.Errorf("%s: a well-formed %d-byte body was refused", tc.name, len(tc.body))
		}
		t.Logf("%s: %d-byte body allocated %d bytes", tc.name, len(tc.body), alloc)
		if alloc > bound {
			t.Errorf("%s: decoding a %d-byte body allocated %d bytes, want at most %d",
				tc.name, len(tc.body), alloc, bound)
		}
	}
}

// checkBoundedEcho holds an error body to a size a client can show whole: the
// echoed text is clipped, and clipped on a character boundary.
func checkBoundedEcho(t *testing.T, name string, rec *httptest.ResponseRecorder, status int) errorBody {
	t.Helper()
	if rec.Code != status {
		t.Errorf("%s: status = %d %.300s, want %d", name, rec.Code, rec.Body.String(), status)
	}
	if n := rec.Body.Len(); n >= 1024 {
		t.Errorf("%s: error body is %d bytes, want under 1 KB: %.300s", name, n, rec.Body.String())
	}
	if !utf8.Valid(rec.Body.Bytes()) {
		t.Errorf("%s: error body is not valid UTF-8", name)
	}
	eb := decode[errorBody](t, rec)
	if n := utf8.RuneCountInString(eb.Field); n > 200 {
		t.Errorf("%s: field is %d characters, want at most 200: %.300s", name, n, eb.Field)
	}
	// Text cut inside a multi-byte character is re-encoded as U+FFFD.
	for _, s := range []string{eb.Error, eb.Field} {
		if strings.ContainsRune(s, utf8.RuneError) {
			t.Errorf("%s: %q was cut inside a character", name, s)
		}
	}
	if eb.Error == "" {
		t.Errorf("%s: no error message", name)
	}
	return eb
}

func TestErrorBodiesBoundWhatTheyEcho(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)

	// Multi-byte, so a cut by bytes rather than by characters shows.
	long := strings.Repeat("ü", 100_000)  // 200 KB
	dupKey := strings.Repeat("ü", 64_000) // twice over still fits the cap

	bodies := []struct {
		name, path, body, field string
	}{
		{"deep duplicate key", "/api/send", valueBody(deepObject(`{"a":1,"a":2}`)), "assertions[0].value"},
		{"long parameter key, wrong type", "/api/send", `{"params":{"` + strings.Repeat("k", 200_000) + `":5}}`, "params." + strings.Repeat("k", 64) + "..."},
		{"duplicate long parameter key", "/api/send", `{"endpoint":"search","params":{"` + dupKey + `":"a","` + dupKey + `":"b"}}`, "params." + strings.Repeat("ü", 64) + "..."},
		{"long parameter key in a run", "/api/runs", `{"mode":"functional","sequence":[{"endpoint":"search","params":{"` + long + `":5}}]}`, "sequence[0].params." + strings.Repeat("ü", 64) + "..."},
		{"long endpoint", "/api/send", `{"endpoint":"` + long + `"}`, "endpoint"},
		{"long assertion type", "/api/send", `{"endpoint":"healthz","assertions":[{"type":"` + long + `","op":"eq","value":200}]}`, "assertions[0]"},
		{"long operator", "/api/send", `{"endpoint":"healthz","assertions":[{"type":"status","op":"` + long + `","value":200}]}`, "assertions[0]"},
		{"long mode", "/api/runs", `{"mode":"` + long + `","sequence":[{"endpoint":"healthz"}]}`, "mode"},
		{"long unknown parameter", "/api/send", `{"endpoint":"search","params":{"` + long + `":"x"}}`, "params"},
	}
	for _, tc := range bodies {
		rec := postRaw(t, s, tc.path, strings.NewReader(tc.body), "application/json")
		eb := checkBoundedEcho(t, tc.name, rec, http.StatusBadRequest)
		if eb.Field != tc.field {
			t.Errorf("%s: field = %.300q, want %q", tc.name, eb.Field, tc.field)
		}
	}

	longPath := "/api/" + strings.Repeat("%C3%BC", 2048) // 4 KB once decoded
	verbs := []struct {
		name, method, path string
		status             int
	}{
		{"unknown path, POST", http.MethodPost, longPath, http.StatusNotFound},
		{"unknown path, GET", http.MethodGet, longPath, http.StatusNotFound},
		{"unknown path, DELETE", http.MethodDelete, longPath, http.StatusNotFound},
		{"wrong verb on a long run id", http.MethodPut, "/api/runs/" + strings.Repeat("%C3%BC", 2048), http.StatusMethodNotAllowed},
	}
	for _, tc := range verbs {
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
		checkBoundedEcho(t, tc.name, rec, tc.status)
	}
}
