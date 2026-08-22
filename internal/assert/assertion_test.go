package assert

import "testing"

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
