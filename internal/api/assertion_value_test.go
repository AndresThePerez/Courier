package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/AndresThePerez/courier/internal/collections"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// assertionForms is every assertion type with each of its operators, as JSON
// with the value left open.
var assertionForms = []string{
	`{"type":"status","op":"eq","value":%s}`,
	`{"type":"status","op":"neq","value":%s}`,
	`{"type":"latency","op":"lt","value":%s}`,
	`{"type":"body_contains","op":"contains","value":%s}`,
	`{"type":"json","path":"$.total","op":"eq","value":%s}`,
	`{"type":"json","path":"$.total","op":"neq","value":%s}`,
	`{"type":"json","path":"$.total","op":"gt","value":%s}`,
	`{"type":"json","path":"$.total","op":"lt","value":%s}`,
	`{"type":"json","path":"$.total","op":"exists","value":%s}`,
	`{"type":"json","path":"$.results","op":"contains","value":%s}`,
	`{"type":"json","path":"$.results","op":"count","value":%s}`,
}

// structuredValues are values that are an object or an array, empty, small
// and nested.
var structuredValues = []string{`{}`, `[]`, `{"a":1}`, `[1,2]`, `[[],{}]`, `{"a":[1,{"b":[null,true,"s"]}]}`}

const okAssertion = `{"type":"status","op":"eq","value":200}`

// An assertion's value is one number, string, boolean or null. An object or an
// array is refused by the shape check, named by its field, at every position
// on both routes and for every type and operator: `exists` ignores its value,
// and a structure kept there would be stored in the run's report and frames.
func TestAnAssertionValueThatIsAnObjectOrArrayIsRefused(t *testing.T) {
	target := newCountingTarget(t)
	s := newServer(t, target.URL, nil)
	for _, form := range assertionForms {
		for _, v := range structuredValues {
			kind := "an object"
			if v[0] == '[' {
				kind = "an array"
			}
			bad := fmt.Sprintf(form, v)
			send := `{"endpoint":"search","assertions":[` + okAssertion + `,` + okAssertion + `,` + bad + `]}`
			run := `{"mode":"functional","sequence":[{"endpoint":"healthz"},{"endpoint":"search","assertions":[` + bad + `]}]}`
			for _, tc := range []struct{ path, body, field string }{
				{"/api/send", send, "assertions[2].value"},
				{"/api/runs", run, "sequence[1].assertions[0].value"},
			} {
				rec := postRaw(t, s, tc.path, strings.NewReader(tc.body), "application/json")
				eb := wantAPIError(t, rec, http.MethodPost, tc.path, http.StatusBadRequest)
				if eb.Field != tc.field {
					t.Errorf("%s %s: field = %q, want %q", tc.path, bad, eb.Field, tc.field)
				}
				if want := "expected a number, a string, true, false or null, got " + kind; eb.Error != want {
					t.Errorf("%s %s: error = %q, want %q", tc.path, bad, eb.Error, want)
				}
			}
		}
	}
	if n := target.hits.Load(); n != 0 {
		t.Errorf("the target received %d requests, want 0", n)
	}
	if st := s.mgr.Status(); st.Running || st.RunID != "" {
		t.Errorf("a run was started: %+v", st)
	}
}

// The shape check passes a number, a string, a boolean and null at every
// assertion position exactly as before; what each one means is the
// validator's to say, and that is pinned below for booleans and null.
func TestScalarAssertionValuesStillPassTheShapeCheck(t *testing.T) {
	for _, form := range assertionForms {
		for _, v := range []string{`200`, `-0.5`, `1e2`, `"Charizard"`, `""`, `true`, `false`, `null`} {
			for _, tc := range []struct {
				body string
				typ  reflect.Type
			}{
				{`{"endpoint":"search","assertions":[` + fmt.Sprintf(form, v) + `]}`, reflect.TypeOf(&sandbox.Request{})},
				{`{"mode":"functional","sequence":[{"endpoint":"search","assertions":[` + fmt.Sprintf(form, v) + `]}]}`, reflect.TypeOf(&sandbox.RunRequest{})},
			} {
				if field, msg, ok := checkBody([]byte(tc.body), tc.typ); !ok {
					t.Errorf("%s: refused at %q: %s", tc.body, field, msg)
				}
			}
		}
	}
}

// What the validator does with a boolean or a null value, unchanged: only
// `json exists`, which ignores its value, takes one.
func TestBooleanAndNullAssertionValuesKeepTheirMeaning(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	for _, tc := range []struct {
		assertion string
		status    int
	}{
		{`{"type":"json","path":"$.total","op":"exists","value":true}`, http.StatusOK},
		{`{"type":"json","path":"$.total","op":"exists","value":false}`, http.StatusOK},
		{`{"type":"json","path":"$.total","op":"exists","value":null}`, http.StatusOK},
		{`{"type":"status","op":"eq","value":true}`, http.StatusBadRequest},
		{`{"type":"status","op":"eq","value":null}`, http.StatusBadRequest},
		{`{"type":"latency","op":"lt","value":false}`, http.StatusBadRequest},
		{`{"type":"body_contains","op":"contains","value":true}`, http.StatusBadRequest},
		{`{"type":"json","path":"$.total","op":"eq","value":true}`, http.StatusBadRequest},
		{`{"type":"json","path":"$.total","op":"count","value":null}`, http.StatusBadRequest},
	} {
		body := `{"endpoint":"search","assertions":[` + tc.assertion + `]}`
		rec := postRaw(t, s, "/api/send", strings.NewReader(body), "application/json")
		if rec.Code != tc.status {
			t.Errorf("%s: %d %s, want %d", tc.assertion, rec.Code, rec.Body.String(), tc.status)
			continue
		}
		if tc.status == http.StatusBadRequest {
			if eb := decode[errorBody](t, rec); eb.Field != "assertions[0]" {
				t.Errorf("%s: field = %q, want the validator's assertions[0]", tc.assertion, eb.Field)
			}
		}
	}
}

// Every curated request, as the catalog serves it to the page, passes the
// body check on its own and as a run of its collection.
func TestEveryCuratedRequestPassesTheBodyCheck(t *testing.T) {
	cols := collections.All()
	if len(cols) == 0 {
		t.Fatal("no curated collections")
	}
	for _, c := range cols {
		for _, r := range c.Requests {
			raw, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			rec := httptest.NewRecorder()
			var got sandbox.Request
			if !decodeBody(rec, raw, &got) {
				t.Errorf("%s/%s: refused: %s", c.ID, r.ID, rec.Body.String())
			}
		}
		raw, err := json.Marshal(sandbox.RunRequest{Mode: sandbox.ModeFunctional, Sequence: c.Requests})
		if err != nil {
			t.Fatal(err)
		}
		if field, msg, ok := checkBody(raw, reflect.TypeOf(&sandbox.RunRequest{})); !ok {
			t.Errorf("%s as a run: refused at %q: %s", c.ID, field, msg)
		}
	}
}
