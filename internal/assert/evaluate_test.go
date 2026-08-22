package assert

import "testing"

func target(t *testing.T) Target {
	t.Helper()
	return NewTarget(200, 42.5, []byte(sample)) // sample from jsonpath_test.go
}

func TestEvaluate(t *testing.T) {
	tests := []struct {
		name       string
		a          Assertion
		want       bool
		wantErr    bool
		wantActual string
	}{
		{name: "status eq pass", a: Assertion{Type: "status", Op: "eq", Value: float64(200)}, want: true, wantActual: "200"},
		{name: "status eq fail", a: Assertion{Type: "status", Op: "eq", Value: float64(503)}, want: false, wantActual: "200"},
		{name: "status neq pass", a: Assertion{Type: "status", Op: "neq", Value: float64(503)}, want: true},
		{name: "latency lt pass", a: Assertion{Type: "latency", Op: "lt", Value: float64(300)}, want: true, wantActual: "42.5ms"},
		{name: "latency lt fail", a: Assertion{Type: "latency", Op: "lt", Value: float64(10)}, want: false},
		{name: "latency exact boundary fails", a: Assertion{Type: "latency", Op: "lt", Value: float64(42.5)}, want: false},
		{name: "json gt pass", a: Assertion{Type: "json", Path: "$.total", Op: "gt", Value: float64(0)}, want: true, wantActual: "42"},
		{name: "json gt fail", a: Assertion{Type: "json", Path: "$.total", Op: "gt", Value: float64(100)}, want: false},
		{name: "json lt pass", a: Assertion{Type: "json", Path: "$.total", Op: "lt", Value: float64(100)}, want: true},
		{name: "json eq number", a: Assertion{Type: "json", Path: "$.page", Op: "eq", Value: float64(1)}, want: true},
		{name: "json eq string", a: Assertion{Type: "json", Path: "$.results[0].name", Op: "eq", Value: "Charizard"}, want: true},
		{name: "json neq string", a: Assertion{Type: "json", Path: "$.results[0].name", Op: "neq", Value: "Pikachu"}, want: true},
		{name: "json contains substring", a: Assertion{Type: "json", Path: "$.results[0].name", Op: "contains", Value: "chari"}, want: true},
		{name: "json contains is case-insensitive", a: Assertion{Type: "json", Path: "$.results[0].name", Op: "contains", Value: "CHARI"}, want: true},
		{name: "json contains array membership", a: Assertion{Type: "json", Path: "$.results[0].types", Op: "contains", Value: "Fire"}, want: true},
		{name: "json count array", a: Assertion{Type: "json", Path: "$.results", Op: "count", Value: float64(2)}, want: true, wantActual: "2"},
		{name: "json count object keys", a: Assertion{Type: "json", Path: "$.facets", Op: "count", Value: float64(1)}, want: true},
		{name: "json exists pass", a: Assertion{Type: "json", Path: "$.facets.types", Op: "exists"}, want: true},
		{name: "json exists on null value passes", a: Assertion{Type: "json", Path: "$.results[1].hp", Op: "exists"}, want: true},
		{name: "json exists missing fails", a: Assertion{Type: "json", Path: "$.nope", Op: "exists"}, want: false},
		{name: "missing path is a failure not an error", a: Assertion{Type: "json", Path: "$.nope", Op: "eq", Value: float64(1)}, want: false, wantActual: "<missing>"},
		{name: "type mismatch fails with a message", a: Assertion{Type: "json", Path: "$.results[0].name", Op: "gt", Value: float64(1)}, want: false, wantErr: true},
		{name: "body_contains pass", a: Assertion{Type: "body_contains", Op: "contains", Value: "Alakazam"}, want: true},
		{name: "body_contains fail", a: Assertion{Type: "body_contains", Op: "contains", Value: "Snorlax"}, want: false},
	}
	tg := target(t)
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(tc.a, tg)
			if got.Passed != tc.want {
				t.Errorf("Passed = %v, want %v (actual %q, err %q)", got.Passed, tc.want, got.Actual, got.Error)
			}
			if tc.wantErr && got.Error == "" {
				t.Errorf("Error = empty, want a message")
			}
			if tc.wantActual != "" && got.Actual != tc.wantActual {
				t.Errorf("Actual = %q, want %q", got.Actual, tc.wantActual)
			}
		})
	}
}

func TestEvaluateNonJSONBody(t *testing.T) {
	tg := NewTarget(200, 5, []byte("not json"))
	got := Evaluate(Assertion{Type: "json", Path: "$.total", Op: "gt", Value: float64(0)}, tg)
	if got.Passed || got.Error == "" {
		t.Errorf("json assertion on a non-JSON body: passed=%v err=%q, want failed with an error", got.Passed, got.Error)
	}
	if ok := Evaluate(Assertion{Type: "body_contains", Op: "contains", Value: "not"}, tg); !ok.Passed {
		t.Errorf("body_contains must still work on a non-JSON body")
	}
}

func TestEvaluateAll(t *testing.T) {
	tg := target(t)
	outs, passed := EvaluateAll([]Assertion{
		{Type: "status", Op: "eq", Value: float64(200)},
		{Type: "json", Path: "$.total", Op: "gt", Value: float64(0)},
	}, tg)
	if len(outs) != 2 || !passed {
		t.Fatalf("len=%d passed=%v, want 2 true", len(outs), passed)
	}
	if _, passed := EvaluateAll([]Assertion{
		{Type: "status", Op: "eq", Value: float64(200)},
		{Type: "status", Op: "eq", Value: float64(404)},
	}, tg); passed {
		t.Error("one failing assertion must fail the set")
	}
	if outs, passed := EvaluateAll(nil, tg); len(outs) != 0 || !passed {
		t.Error("no assertions = vacuously passed with an empty slice")
	}
}

// An assertion that never passed ValidateAssertion must not panic or silently
// pass; the evaluator re-validates and reports the reason.
func TestEvaluateRejectsInvalidAssertion(t *testing.T) {
	got := Evaluate(Assertion{Type: "json", Path: "not-a-path", Op: "eq", Value: float64(1)}, target(t))
	if got.Passed || got.Error == "" {
		t.Errorf("invalid assertion: passed=%v err=%q, want failed with an error", got.Passed, got.Error)
	}
}

// The evaluator must decode the body once, not once per assertion.
func TestNewTargetDecodesOnce(t *testing.T) {
	tg := NewTarget(200, 1, []byte(sample))
	if tg.Doc == nil || tg.DecodeErr != nil {
		t.Fatalf("Doc=%v DecodeErr=%v, want a decoded document", tg.Doc, tg.DecodeErr)
	}
	bad := NewTarget(200, 1, []byte("{"))
	if bad.DecodeErr == nil || bad.Doc != nil {
		t.Errorf("malformed JSON: Doc=%v DecodeErr=%v, want nil doc and an error", bad.Doc, bad.DecodeErr)
	}
}

// count is defined over arrays, object keys, and string runes.
func TestEvaluateCountKinds(t *testing.T) {
	tg := NewTarget(200, 1, []byte(`{"arr":[1,2,3],"obj":{"a":1,"b":2},"str":"δδδ","num":7}`))
	for _, tc := range []struct {
		path    string
		want    float64
		wantErr bool
	}{
		{path: "$.arr", want: 3},
		{path: "$.obj", want: 2},
		{path: "$.str", want: 3}, // runes, not bytes
		{path: "$.num", wantErr: true},
	} {
		got := Evaluate(Assertion{Type: "json", Path: tc.path, Op: "count", Value: tc.want}, tg)
		if tc.wantErr {
			if got.Passed || got.Error == "" {
				t.Errorf("count on %s: passed=%v err=%q, want a typed error", tc.path, got.Passed, got.Error)
			}
			continue
		}
		if !got.Passed {
			t.Errorf("count on %s = %q, want %v", tc.path, got.Actual, tc.want)
		}
	}
}
