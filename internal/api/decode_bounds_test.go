package api

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/assert"
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
	// The deepest level holds a duplicate key, which only a walk that reached
	// it can report: a body refused before its nesting was read fails here.
	const bottom = `{"a":1,"a":2}`
	cases := []struct{ name, body string }{
		{"object", valueBody(deepObject(bottom))},
		{"array", valueBody(strings.Repeat("[", deepDepth) + bottom + strings.Repeat("]", deepDepth))},
		{"two keys a level", valueBody(strings.Repeat(`{"a":1,`+deepKey+`:`, 8000) + bottom + strings.Repeat(`}`, 8000))},
	}
	// Linear with room to spare under -race and across toolchains; a cost that
	// grows with the square of the depth allocates about a gigabyte here.
	const bound = 64 * MaxBodyBytes
	s := newServer(t, newTarget(t, 0), nil)
	for _, tc := range cases {
		if len(tc.body) > MaxBodyBytes {
			t.Fatalf("%s: body is %d bytes, over the cap", tc.name, len(tc.body))
		}
		var ok bool
		var rec *httptest.ResponseRecorder
		alloc := minAlloc(t, func() {
			r := httptest.NewRequest(http.MethodPost, "/api/send", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			rec = httptest.NewRecorder()
			var req sandbox.Request
			ok = s.decodeJSON(rec, r, &req)
		})
		if ok {
			t.Errorf("%s: a %d-byte structure was accepted as an assertion value", tc.name, len(tc.body))
		}
		if eb := decode[errorBody](t, rec); eb.Error != `duplicate key "a"` || eb.Field != "assertions[0].value" {
			t.Errorf("%s: %q at %q, want the duplicate key at the bottom named, at assertions[0].value", tc.name, eb.Error, eb.Field)
		}
		t.Logf("%s: %d-byte body allocated %d bytes", tc.name, len(tc.body), alloc)
		if alloc > bound {
			t.Errorf("%s: decoding a %d-byte body allocated %d bytes, want at most %d",
				tc.name, len(tc.body), alloc, bound)
		}
	}
}

// wideDecodeBound is the most one check of a body at the cap may allocate.
// The widest bodies allocate about 140 times their size; the rest is room
// across toolchains.
const wideDecodeBound = 192 * MaxBodyBytes

// distinctKeys fills prefix "k0":"","k1":"",... suffix up to the size cap,
// every key different, so the walk accepts every one and the decode builds
// the whole map.
func distinctKeys(prefix, suffix string) string {
	var b strings.Builder
	b.WriteString(prefix)
	for i := 0; ; i++ {
		kv := `"k` + strconv.Itoa(i) + `":""`
		if b.Len()+1+len(kv)+len(suffix) > MaxBodyBytes {
			break
		}
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(kv)
	}
	b.WriteString(suffix)
	return b.String()
}

// wide fills prefix unit,unit,... suffix up to the size cap.
func wide(prefix, unit, suffix string) string {
	n := (MaxBodyBytes - len(prefix) - len(suffix) + 1) / (len(unit) + 1)
	return prefix + strings.TrimSuffix(strings.Repeat(unit+",", n), ",") + suffix
}

// A body at the size cap made of as many small values as it can hold is the
// most the decode can be made to build from it: tens of thousands of payload
// structs, grown into place. This is the per-check figure the bound on
// concurrent checks (MaxBodyChecks) is reasoned from.
func TestDecodingAWideBodyStaysLinearInItsSize(t *testing.T) {
	cases := []struct {
		name, path, body string
		into             func() any
	}{
		{"empty requests", "/api/runs", manyObjects(), func() any { return new(sandbox.RunRequest) }},
		{"requests with empty params", "/api/runs", wide(`{"mode":"functional","sequence":[`, `{"params":{}}`, `]}`), func() any { return new(sandbox.RunRequest) }},
		{"requests with empty assertions", "/api/runs", wide(`{"mode":"functional","sequence":[`, `{"assertions":[]}`, `]}`), func() any { return new(sandbox.RunRequest) }},
		{"empty assertions", "/api/send", wide(`{"endpoint":"healthz","assertions":[`, `{}`, `]}`), func() any { return new(sandbox.Request) }},
		{"numeric assertions", "/api/send", wide(`{"endpoint":"healthz","assertions":[`, `{"value":0}`, `]}`), func() any { return new(sandbox.Request) }},
		{"parameters", "/api/send", distinctKeys(`{"endpoint":"search","params":{`, `}}`), func() any { return new(sandbox.Request) }},
	}
	const bound = wideDecodeBound
	s := newServer(t, newTarget(t, 0), nil)
	for _, tc := range cases {
		var ok bool
		alloc := minAlloc(t, func() {
			r := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			ok = s.decodeJSON(httptest.NewRecorder(), r, tc.into())
		})
		t.Logf("%s: %d-byte body allocated %d bytes (decoded: %v)", tc.name, len(tc.body), alloc, ok)
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

// The shape check looks up a payload type's fields once per type, not once per
// JSON object: a body of empty objects at the size cap is tens of thousands of
// objects, and a field map built for each is several allocations apiece.
func TestTheShapeCheckBuildsEachTypesFieldMapOnce(t *testing.T) {
	body := []byte(manyObjects())
	objects := strings.Count(manyObjects(), "{}")
	typ := reflect.TypeOf(&sandbox.RunRequest{})
	allocs := testing.AllocsPerRun(3, func() {
		if _, _, ok := checkBody(body, typ); !ok {
			t.Fatal("a well-formed body was refused")
		}
	})
	t.Logf("%d objects: %.0f allocations", objects, allocs)
	// The check's own allocations do not grow with the number of objects; a
	// map per object is at least one allocation each.
	if limit := float64(objects) / 100; allocs > limit {
		t.Errorf("checking %d objects made %.0f allocations, want at most %.0f", objects, allocs, limit)
	}
}

// Two requests that meet a payload type for the first time at the same moment
// share one field map, and both read it whole.
func TestFieldMapsAreSharedSafelyOnFirstUse(t *testing.T) {
	types := []reflect.Type{
		reflect.TypeOf(sandbox.RunRequest{}),
		reflect.TypeOf(sandbox.Request{}),
		reflect.TypeOf(sandbox.Options{}),
		reflect.TypeOf(assert.Assertion{}),
	}
	var cache fieldCache
	const readers = 16
	got := make([][]map[string]reflect.Type, readers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range readers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for _, typ := range types {
				got[i] = append(got[i], cache.of(typ))
			}
		}()
	}
	close(start)
	wg.Wait()
	for j, typ := range types {
		want := jsonFields(typ)
		first := reflect.ValueOf(got[0][j]).UnsafePointer()
		for i := range readers {
			if !reflect.DeepEqual(got[i][j], want) {
				t.Errorf("%s: reader %d saw %v, want %v", typ, i, got[i][j], want)
			}
			if reflect.ValueOf(got[i][j]).UnsafePointer() != first {
				t.Errorf("%s: reader %d was given a field map of its own, want the one shared map", typ, i)
			}
		}
	}
}

// An object or array filling an assertion's value is refused before anything
// is built from it, so refusing it costs about what holding the body costs,
// however many values it packs: decoded, the same bytes are tens of times
// their size.
func TestARefusedAssertionValueCostsAboutItsSize(t *testing.T) {
	fill := func(unit string) string {
		const prefix, suffix = `{"endpoint":"healthz","assertions":[{"type":"json","path":"$.a","op":"exists","value":[`, `]}]}`
		n := (MaxBodyBytes - len(prefix) - len(suffix) + 1) / (len(unit) + 1)
		return prefix + strings.TrimSuffix(strings.Repeat(unit+",", n), ",") + suffix
	}
	cases := []struct{ name, body string }{
		{"empty objects", fill(`{}`)},
		{"one-key objects", fill(`{"":0}`)},
		{"empty arrays", fill(`[]`)},
		{"numbers", fill(`0`)},
	}
	// Reading and scanning any body at the cap allocates several times its
	// size, whatever it holds: the numbers case is the baseline. Decoding the
	// objects instead allocates over fifty times it.
	const bound = 16 * MaxBodyBytes
	s := newServer(t, newTarget(t, 0), nil)
	for _, tc := range cases {
		var rec *httptest.ResponseRecorder
		alloc := minAlloc(t, func() {
			r := httptest.NewRequest(http.MethodPost, "/api/send", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			rec = httptest.NewRecorder()
			var req sandbox.Request
			s.decodeJSON(rec, r, &req)
		})
		t.Logf("%s: %d-byte body allocated %d bytes", tc.name, len(tc.body), alloc)
		if eb := checkBoundedEcho(t, tc.name, rec, http.StatusBadRequest); eb.Field != "assertions[0].value" {
			t.Errorf("%s: field = %q, want assertions[0].value", tc.name, eb.Field)
		}
		if alloc > bound {
			t.Errorf("%s: refusing a %d-byte body allocated %d bytes, want at most %d",
				tc.name, len(tc.body), alloc, bound)
		}
	}
}
