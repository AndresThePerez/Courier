package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// verdict is what the body check and the validator together make of a body:
// accepted, or refused with a field.
type verdict struct {
	ok    bool
	field string
}

// checkedVerdict runs body through the body check and then the validator,
// exactly as the two POST handlers do.
func checkedVerdict(t *testing.T, path, body string) verdict {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	var err error
	if path == "/api/runs" {
		var rr sandbox.RunRequest
		if !decodeJSON(rec, r, &rr) {
			return verdict{false, decode[errorBody](t, rec).Field}
		}
		_, err = sandbox.Validate(rr)
	} else {
		var req sandbox.Request
		if !decodeJSON(rec, r, &req) {
			return verdict{false, decode[errorBody](t, rec).Field}
		}
		_, err = sandbox.ValidateRequest(req)
	}
	return validatorVerdict(t, err)
}

func validatorVerdict(t *testing.T, err error) verdict {
	t.Helper()
	if err == nil {
		return verdict{ok: true}
	}
	var ve sandbox.ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("validator error %v is not a ValidationError", err)
	}
	return verdict{false, ve.Field}
}

// A scalar assertion value gets the answer the standard decoder and the
// validator give it, for every assertion type and operator, on both routes:
// booleans and null are accepted only where the validator accepts them
// (`exists`), numbers out of float range are refused at the value, and the
// 500-character rule binds at 501 characters, not 500.
func TestScalarAssertionValuesKeepTheAnswersTheValidatorGives(t *testing.T) {
	scalars := []string{
		`true`, `false`, `null`, `0`, `-0`, `1.5`, `200`, `2E2`, `1e999`, `-1e999`,
		strings.Repeat("9", 300), strings.Repeat("9", 400), `""`, `"x"`, "\"\u00e9\"",
		`"` + strings.Repeat("\u00e9", 500) + `"`, `"` + strings.Repeat("\u00e9", 501) + `"`,
		`"` + strings.Repeat("\\u00e9", 501) + `"`,
	}
	for _, form := range assertionForms {
		for _, v := range scalars {
			a := fmt.Sprintf(form, v)
			for _, tc := range []struct{ path, body, at string }{
				{"/api/send", `{"endpoint":"search","assertions":[` + okAssertion + `,` + a + `]}`, "assertions[1]"},
				{"/api/runs", `{"mode":"functional","sequence":[{"endpoint":"healthz"},{"endpoint":"search","assertions":[` + okAssertion + `,` + a + `]}]}`, "sequence[1].assertions[1]"},
			} {
				var want verdict
				var std error
				if tc.path == "/api/runs" {
					var rr sandbox.RunRequest
					if std = json.Unmarshal([]byte(tc.body), &rr); std == nil {
						_, err := sandbox.Validate(rr)
						want = validatorVerdict(t, err)
					}
				} else {
					var req sandbox.Request
					if std = json.Unmarshal([]byte(tc.body), &req); std == nil {
						_, err := sandbox.ValidateRequest(req)
						want = validatorVerdict(t, err)
					}
				}
				if std != nil {
					// A number the decoder cannot hold is refused at the value.
					want = verdict{false, tc.at + ".value"}
				}
				if got := checkedVerdict(t, tc.path, tc.body); got != want {
					t.Errorf("%s value %.40s in %s: got %+v, want %+v", tc.path, v, a[:min(len(a), 60)], got, want)
				}
			}
		}
	}
}

// An object or array value is refused wherever the assertion sits and however
// the value is spelled; the value key given twice is refused as a duplicate
// whichever of the two is the structure; a map that is meant to hold an object
// (params) still takes one.
func TestStructuredAssertionValuesAreRefusedWhereverTheyNest(t *testing.T) {
	cases := []struct{ name, path, body, field, contains string }{
		{"third request, second assertion", "/api/runs",
			`{"mode":"functional","sequence":[{"endpoint":"healthz"},{"endpoint":"healthz"},{"endpoint":"healthz","assertions":[` + okAssertion + `,{"type":"json","path":"$.a","op":"exists","value":[[]]}]}]}`,
			"sequence[2].assertions[1].value", "got an array"},
		{"space before the object", "/api/send",
			"{\"endpoint\":\"healthz\",\"assertions\":[{\"type\":\"json\",\"path\":\"$.a\",\"op\":\"exists\",\"value\" : \n\t{ }}]}",
			"assertions[0].value", "got an object"},
		{"value before type", "/api/send",
			`{"endpoint":"healthz","assertions":[{"value":{"type":"status"},"type":"json","path":"$.a","op":"exists"}]}`,
			"assertions[0].value", "got an object"},
		{"scalar then structure", "/api/send",
			`{"endpoint":"healthz","assertions":[{"type":"json","path":"$.a","op":"exists","value":1,"value":{}}]}`,
			"assertions[0].value", "duplicate"},
		{"structure then scalar", "/api/send",
			`{"endpoint":"healthz","assertions":[{"type":"json","path":"$.a","op":"exists","value":{},"value":1}]}`,
			"assertions[0].value", "got an object"},
		{"duplicate key inside the value", "/api/send",
			`{"endpoint":"healthz","assertions":[{"type":"json","path":"$.a","op":"exists","value":{"k":1,"k":2}}]}`,
			"assertions[0].value.k", "duplicate"},
		{"case-folded value key", "/api/send",
			`{"endpoint":"healthz","assertions":[{"type":"json","path":"$.a","op":"exists","VALUE":{}}]}`,
			"assertions[0]", "unknown field"},
		{"escaped value key", "/api/send",
			"{\"endpoint\":\"healthz\",\"assertions\":[{\"type\":\"json\",\"path\":\"$.a\",\"op\":\"exists\",\"\\u0076alue\":[]}]}",
			"assertions[0].value", "got an array"},
		{"object in a param", "/api/send",
			`{"endpoint":"search","params":{"q":{}}}`,
			"params.q", "a string"},
	}
	for _, c := range cases {
		got := checkedVerdict(t, c.path, c.body)
		if got.ok || got.field != c.field {
			t.Errorf("%s: got %+v, want refused at %s", c.name, got, c.field)
			continue
		}
		var into any = new(sandbox.Request)
		if c.path == "/api/runs" {
			into = new(sandbox.RunRequest)
		}
		r := httptest.NewRequest(http.MethodPost, c.path, strings.NewReader(c.body))
		r.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		decodeJSON(rec, r, into)
		if eb := checkSmallCleanError(t, c.name, rec); !strings.Contains(eb.Error, c.contains) {
			t.Errorf("%s: error %q, want it to say %q", c.name, eb.Error, c.contains)
		}
	}

	for _, body := range []string{
		`{"endpoint":"search","params":{}}`,
		`{"endpoint":"search","params":{"q":"x"},"assertions":[]}`,
		`{"endpoint":"healthz","assertions":[{"type":"json","path":"$.a","op":"exists"}]}`,
	} {
		if got := checkedVerdict(t, "/api/send", body); !got.ok {
			t.Errorf("%s: refused at %s, want accepted", body, got.field)
		}
	}
}

// The assertion's value is the only position in either payload whose type is
// open, which is what refusing a structure there and nowhere else rests on.
func TestTheAssertionValueIsThePayloadsOnlyOpenPosition(t *testing.T) {
	var open []string
	seen := map[reflect.Type]bool{}
	var walk func(t reflect.Type, at string)
	walk = func(t reflect.Type, at string) {
		for t.Kind() == reflect.Pointer || t.Kind() == reflect.Slice || t.Kind() == reflect.Array || t.Kind() == reflect.Map {
			t = t.Elem()
		}
		switch t.Kind() {
		case reflect.Interface:
			open = append(open, at)
		case reflect.Struct:
			if seen[t] {
				return
			}
			seen[t] = true
			for name, ft := range jsonFields(t) {
				walk(ft, t.Name()+"."+name)
			}
		}
	}
	walk(reflect.TypeOf(sandbox.RunRequest{}), "")
	walk(reflect.TypeOf(sandbox.Request{}), "")
	if len(open) != 1 || open[0] != "Assertion.value" {
		t.Errorf("open positions = %v, want only Assertion.value", open)
	}
}

// Two struct types that share a name are different payload shapes; each is
// held to its own fields.
func firstNamesake() reflect.Type {
	type namesake struct {
		A int `json:"a"`
	}
	return reflect.TypeOf(&namesake{})
}

func secondNamesake() reflect.Type {
	type namesake struct {
		B string `json:"b"`
	}
	return reflect.TypeOf(&namesake{})
}

func TestFieldMapsAreKeptPerTypeNotPerName(t *testing.T) {
	a, b := firstNamesake(), secondNamesake()
	if a.Elem().Name() != b.Elem().Name() || a.Elem().String() != b.Elem().String() {
		t.Fatalf("the two types must share a name: %s and %s", a.Elem(), b.Elem())
	}
	for range 2 { // the second pass reads what the first one cached
		for _, c := range []struct {
			body string
			typ  reflect.Type
			ok   bool
		}{
			{`{"a":1}`, a, true},
			{`{"b":"x"}`, b, true},
			{`{"b":"x"}`, a, false},
			{`{"a":1}`, b, false},
		} {
			if _, _, ok := checkBody([]byte(c.body), c.typ); ok != c.ok {
				t.Errorf("%s as %v: accepted = %v, want %v", c.body, c.typ.Elem(), ok, c.ok)
			}
		}
	}
}

// keyForms are spellings of payload keys: exact, escaped, case-folded,
// unknown and near misses, with the value each should carry.
type keyForm struct {
	raw, value string
	exact      string // the field it names exactly once unescaped, or ""
}

var requestKeys = []keyForm{
	{`"endpoint"`, `"healthz"`, "endpoint"},
	{"\"\\u0065ndpoint\"", `"healthz"`, "endpoint"},
	{`"ENDPOINT"`, `"healthz"`, ""},
	{`"Endpoint"`, `"healthz"`, ""},
	{"\"\\u0045ndpoint\"", `"healthz"`, ""},
	{`"endpoint\u0000"`, `"healthz"`, ""},
	{`"id"`, `"x"`, "id"},
	{`"ID"`, `"x"`, ""},
	{`"name"`, `"x"`, "name"},
	{"\"n\\u0061me\"", `"x"`, "name"},
	{`"params"`, `{}`, "params"},
	{`"Params"`, `{}`, ""},
	{`"assertions"`, `[]`, "assertions"},
	{`"url"`, `"http://192.0.2.1/"`, ""},
	{`"host"`, `"192.0.2.1"`, ""},
	{"\"endpo\u0131nt\"", `"healthz"`, ""},
	{"\"\u017ftatus\"", `1`, ""},
}

var runKeys = []keyForm{
	{`"mode"`, `"functional"`, "mode"},
	{`"MODE"`, `"functional"`, ""},
	{"\"m\\u006fde\"", `"functional"`, "mode"},
	{`"options"`, `{}`, "options"},
	{`"Options"`, `{}`, ""},
	{`"options"`, `{"delay_ms":1,"Delay_ms":2}`, ""},
	{`"options"`, `{"stop_on_failure":true}`, "options"},
	{`"target"`, `"x"`, ""},
}

// genObject builds an object from up to four key forms drawn at random, and
// says whether the shape check must accept it: every key names a field
// exactly, and no field is named twice.
func genObject(rng *rand.Rand, forms []keyForm, extra string) (string, bool) {
	n := 1 + rng.IntN(4)
	parts := []string{}
	if extra != "" {
		parts = append(parts, extra)
	}
	seen := map[string]bool{}
	ok := true
	for range n {
		f := forms[rng.IntN(len(forms))]
		parts = append(parts, f.raw+":"+f.value)
		if f.exact == "" || seen[f.exact] {
			ok = false
		}
		seen[f.exact] = true
	}
	return "{" + strings.Join(parts, ",") + "}", ok
}

// On bodies of exact, escaped, case-folded, duplicated and unknown keys, at
// both levels of both payload types, checked from many goroutines at once, the
// shape check accepts exactly the bodies the standard decoder decodes with
// unknown fields refused and whose keys name each field once and exactly.
func TestTheShapeCheckAgreesWithTheStandardDecoderOnGeneratedKeys(t *testing.T) {
	const workers, per = 8, 400
	var accepted, refused atomic.Int64
	var wg sync.WaitGroup
	for w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rng := rand.New(rand.NewPCG(uint64(w), 11))
			for range per {
				var body string
				var want bool
				var into func() any
				switch rng.IntN(3) {
				case 0:
					body, want = genObject(rng, requestKeys, "")
					into = func() any { return new(sandbox.Request) }
				case 1:
					inner, innerOK := genObject(rng, requestKeys, "")
					var outerOK bool
					body, outerOK = genObject(rng, runKeys, `"sequence":[`+inner+`]`)
					want = innerOK && outerOK
					into = func() any { return new(sandbox.RunRequest) }
				default:
					body, want = genObject(rng, runKeys, "")
					into = func() any { return new(sandbox.RunRequest) }
				}
				dec := json.NewDecoder(strings.NewReader(body))
				dec.DisallowUnknownFields()
				std := dec.Decode(into()) == nil
				_, _, got := checkBody([]byte(body), reflect.TypeOf(into()))
				if got {
					accepted.Add(1)
				} else {
					refused.Add(1)
				}
				if got != (want && std) {
					t.Errorf("%s: shape check accepted = %v, want %v (standard decoder: %v)", body, got, want && std, std)
				}
				if got && !std {
					t.Errorf("%s: accepted by the shape check, refused by the standard decoder", body)
				}
			}
		}()
	}
	wg.Wait()
	if accepted.Load() < workers*per/20 || refused.Load() < workers*per/20 {
		t.Errorf("%d accepted and %d refused: the corpus must hold plenty of both", accepted.Load(), refused.Load())
	}
}
