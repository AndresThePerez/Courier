package api

import (
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// The run id comes from the URL, which a client sizes up to the header limit;
// quoting escapes each invalid byte into four, so an unclipped id turns a
// 900 KB URL into a multi-megabyte error body.
func TestUnknownRunErrorsClipTheID(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	long := strings.Repeat("%FF", 300_000)
	for _, tc := range []struct{ name, method, path string }{
		{"report", http.MethodGet, "/api/runs/" + long},
		{"pdf", http.MethodGet, "/api/runs/" + long + "/report.pdf"},
		{"stream", http.MethodGet, "/api/runs/" + long + "/stream"},
	} {
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", tc.name, rec.Code)
		}
		if n := rec.Body.Len(); n >= 1024 {
			t.Errorf("%s: error body is %d bytes, want under 1 KB", tc.name, n)
		}
	}
}

func TestUnknownRunErrorsQuoteAShortIDWhole(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	for _, path := range []string{"/api/runs/abc", "/api/runs/abc/report.pdf", "/api/runs/abc/stream"} {
		rec := do(t, s, http.MethodGet, path, nil)
		eb := decode[errorBody](t, rec)
		if rec.Code != http.StatusNotFound || eb.Error != `no run "abc"` {
			t.Errorf("%s: %d %q, want 404 %q", path, rec.Code, eb.Error, `no run "abc"`)
		}
	}
}

// The final decode refuses a key its type does not have, whatever the shape
// walk in front of it models: if a payload type ever grows a shape the walk
// passes over, the decoder still refuses the unknown key.
func TestFinalDecodeRefusesUnknownFields(t *testing.T) {
	var req sandbox.Request
	if err := decodeChecked([]byte(`{"endpoint":"healthz","url":"http://192.0.2.10/"}`), &req); err == nil {
		t.Fatal("a body with an unknown key decoded without error")
	}
	if err := decodeChecked([]byte(`{"endpoint":"healthz"}`), &req); err != nil || req.Endpoint != "healthz" {
		t.Fatalf("a well-formed body: endpoint %q, err %v", req.Endpoint, err)
	}
}

// walkSeeds are well-formed bodies of each payload type, the material the
// mutations below are cut from.
var walkSeeds = []struct {
	body string
	typ  reflect.Type
}{
	{`{"endpoint":"search","params":{"q":"charizard","page":"2"},"assertions":[{"type":"status","op":"eq","value":200},{"type":"json","path":"$.total","op":"gt","value":1.5e2}]}`, reflect.TypeOf(&sandbox.Request{})},
	{`{"mode":"functional","options":{"delay_ms":10,"stop_on_failure":true},"sequence":[{"endpoint":"healthz","name":"h \"q\" \\ ü","assertions":[{"type":"json","path":"$.a","op":"eq","value":{"x":[null,true,false,-0.5,"s"]}}]}]}`, reflect.TypeOf(&sandbox.RunRequest{})},
	{` { "endpoint" : "suggest" , "params" : { } , "assertions" : [ ] } `, reflect.TypeOf(&sandbox.Request{})},
}

// walkOnce runs the shape walk over b directly, reporting a panic as an error
// rather than letting it end the test binary.
func walkOnce(t *testing.T, b []byte, typ reflect.Type) (ok bool) {
	t.Helper()
	defer func() {
		if p := recover(); p != nil {
			t.Errorf("shape walk panicked on %.200q: %v", b, p)
			ok = false
		}
	}()
	w := shapeWalk{b: b}
	_ = w.value(typ, 0)
	return true
}

// The walk is fed decoder-checked bytes in production, but it must not depend
// on that to be safe: on any bytes at all it returns, and never panics.
func TestShapeWalkFailsClosedOnMalformedBytes(t *testing.T) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		rng := rand.New(rand.NewPCG(20261118, 1))
		alphabet := []byte(`{}[]:,"\ nulltruefalse0123456789.-+eE` + "\x00\xff")
		for _, seed := range walkSeeds {
			b := []byte(seed.body)
			for n := 0; n <= len(b); n++ { // every truncation
				if !walkOnce(t, b[:n], seed.typ) {
					return
				}
			}
			for range 2000 { // byte flips
				m := append([]byte(nil), b...)
				for range 1 + rng.IntN(3) {
					m[rng.IntN(len(m))] = alphabet[rng.IntN(len(alphabet))]
				}
				if !walkOnce(t, m[:rng.IntN(len(m)+1)], seed.typ) || !walkOnce(t, m, seed.typ) {
					return
				}
			}
		}
		for range 3000 { // random bytes, mostly JSON punctuation
			m := make([]byte, rng.IntN(64))
			for i := range m {
				if rng.IntN(4) == 0 {
					m[i] = byte(rng.IntN(256))
				} else {
					m[i] = alphabet[rng.IntN(len(alphabet))]
				}
			}
			if !walkOnce(t, m, walkSeeds[rng.IntN(len(walkSeeds))].typ) {
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		t.Fatal("the shape walk did not terminate on malformed bytes")
	}
}

// A malformed walk names the body and says so in the decoder's own words.
func TestShapeWalkReportsMalformedBytesAsMalformedJSON(t *testing.T) {
	for _, b := range []string{``, `{`, `{"endpoint"`, `{"endpoint":`, `{"endpoint":"x"`, `{"assertions":[`, `{"assertions":[{}`, `{"endpoint" "x"}`, `{"x":tru}`} {
		w := shapeWalk{b: []byte(b)}
		var se *shapeError
		func() {
			defer func() {
				if p := recover(); p != nil {
					t.Errorf("%q: panicked: %v", b, p)
				}
			}()
			se = w.value(reflect.TypeOf(&sandbox.Request{}), 0)
		}()
		if se == nil {
			t.Errorf("%q: walk accepted malformed bytes", b)
			continue
		}
		if !strings.HasPrefix(se.msg, "malformed JSON at byte ") && b != `{"x":tru}` {
			t.Errorf("%q: %q, want a malformed JSON error", b, se.msg)
		}
	}
}
