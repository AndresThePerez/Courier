package assert

import (
	"math"
	"strings"
	"testing"
)

func TestValidateAssertion(t *testing.T) {
	ok := []Assertion{
		{Type: "status", Op: "eq", Value: float64(200)},
		{Type: "status", Op: "neq", Value: float64(503)},
		{Type: "latency", Op: "lt", Value: float64(300)},
		{Type: "json", Path: "$.total", Op: "gt", Value: float64(0)},
		{Type: "json", Path: "$.results", Op: "count", Value: float64(24)},
		{Type: "json", Path: "$.dsl", Op: "exists"},
		{Type: "json", Path: "$.results[0].name", Op: "contains", Value: "Charizard"},
		{Type: "body_contains", Op: "contains", Value: "suggestions"},
	}
	for _, a := range ok {
		if err := ValidateAssertion(a); err != nil {
			t.Errorf("ValidateAssertion(%+v) = %v, want nil", a, err)
		}
	}
	bad := []Assertion{
		{Type: "bogus", Op: "eq", Value: float64(1)},
		{Type: "status", Op: "gt", Value: float64(200)},                  // op not allowed for status
		{Type: "status", Op: "eq", Value: "200"},                         // value must be numeric
		{Type: "status", Path: "$.total", Op: "eq", Value: float64(200)}, // path forbidden
		{Type: "latency", Op: "gt", Value: float64(300)},                 // only lt
		{Type: "json", Op: "eq", Value: float64(1)},                      // path required
		{Type: "json", Path: "results", Op: "eq", Value: float64(1)},     // malformed path
		{Type: "json", Path: "$.total", Op: "bogus", Value: float64(1)},
		{Type: "json", Path: "$.total", Op: "gt", Value: "many"}, // gt needs a number
		{Type: "json", Path: "$.total", Op: "count", Value: "2"}, // count needs a number
		{Type: "body_contains", Op: "eq", Value: "x"},
		{Type: "body_contains", Op: "contains", Value: float64(3)},
	}
	for _, a := range bad {
		if err := ValidateAssertion(a); err == nil {
			t.Errorf("ValidateAssertion(%+v) = nil, want an error", a)
		}
	}
}

// Go-side construction uses int; JSON decoding produces float64. Both must work.
func TestValidateAssertionAcceptsGoNumericTypes(t *testing.T) {
	for _, a := range []Assertion{
		{Type: "status", Op: "eq", Value: 200},
		{Type: "latency", Op: "lt", Value: 300},
		{Type: "json", Path: "$.total", Op: "gt", Value: int64(0)},
	} {
		if err := ValidateAssertion(a); err != nil {
			t.Errorf("ValidateAssertion(%+v) = %v, want nil", a, err)
		}
	}
}

// A value the target can never produce makes an assertion that can never
// mean anything: status 200.5 never holds, latency lt -5 always fails, and a
// count of 1.5 elements does not exist.
func TestValidateAssertionRefusesMeaninglessNumbers(t *testing.T) {
	negZero := math.Copysign(0, -1)
	bad := []Assertion{
		{Type: "status", Op: "eq", Value: 200.5},
		{Type: "status", Op: "eq", Value: float64(99)},
		{Type: "status", Op: "neq", Value: float64(600)},
		{Type: "status", Op: "eq", Value: float64(-200)},
		{Type: "status", Op: "eq", Value: math.NaN()},
		{Type: "latency", Op: "lt", Value: float64(-5)},
		{Type: "latency", Op: "lt", Value: float64(0)},
		{Type: "latency", Op: "lt", Value: negZero},
		{Type: "latency", Op: "lt", Value: math.NaN()},
		{Type: "json", Path: "$.results", Op: "count", Value: float64(-1)},
		{Type: "json", Path: "$.results", Op: "count", Value: 1.5},
	}
	for _, a := range bad {
		if err := ValidateAssertion(a); err == nil {
			t.Errorf("ValidateAssertion(%+v) = nil, want an error", a)
		}
	}
	good := []Assertion{
		{Type: "status", Op: "eq", Value: float64(100)},
		{Type: "status", Op: "eq", Value: float64(599)},
		{Type: "status", Op: "eq", Value: 2e2},
		{Type: "status", Op: "neq", Value: 200},
		{Type: "latency", Op: "lt", Value: 0.001},
		{Type: "json", Path: "$.results", Op: "count", Value: float64(0)},
		{Type: "json", Path: "$.total", Op: "gt", Value: float64(-5)},
		{Type: "json", Path: "$.score", Op: "eq", Value: 1.5},
	}
	for _, a := range good {
		if err := ValidateAssertion(a); err != nil {
			t.Errorf("ValidateAssertion(%+v) = %v, want nil", a, err)
		}
	}
}

func TestClipBoundsQuotedClientText(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"eq", "eq"},
		{strings.Repeat("k", 64), strings.Repeat("k", 64)},
		{strings.Repeat("k", 65), strings.Repeat("k", 64) + "..."},
		{strings.Repeat("ü", 64), strings.Repeat("ü", 64)},
		{strings.Repeat("ü", 200_000), strings.Repeat("ü", 64) + "..."},
	}
	for _, c := range cases {
		if got := Clip(c.in); got != c.want {
			t.Errorf("Clip(%d bytes) = %.80q (%d bytes), want %.80q", len(c.in), got, len(got), c.want)
		}
	}
}

// A message quotes what the client sent, so a short value reads exactly as
// written and a long one is cut to a length a person can read.
func TestValidationMessagesClipWhatTheyQuote(t *testing.T) {
	long := strings.Repeat("ü", 100_000)
	cases := []struct {
		a    Assertion
		want string
	}{
		{Assertion{Type: "x", Op: "eq", Value: float64(200)}, `unknown assertion type "x"`},
		{Assertion{Type: "status", Op: "x", Value: float64(200)}, `operator "x" is not valid for a status assertion (allowed: [eq neq])`},
		{Assertion{Type: long, Op: "eq", Value: float64(200)}, `unknown assertion type "` + Clip(long) + `"`},
		{Assertion{Type: "status", Op: long, Value: float64(200)}, `operator "` + Clip(long) + `" is not valid for a status assertion (allowed: [eq neq])`},
	}
	for _, c := range cases {
		err := ValidateAssertion(c.a)
		if err == nil || err.Error() != c.want {
			t.Errorf("ValidateAssertion = %.300v, want %q", err, c.want)
		}
	}
}
