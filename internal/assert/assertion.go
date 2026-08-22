package assert

import (
	"encoding/json"
	"fmt"
	"slices"
)

// Assertion types and operators. The matrix below is the whole language —
// there is deliberately no expression syntax to sandbox.
const (
	TypeStatus       = "status"
	TypeLatency      = "latency"
	TypeJSON         = "json"
	TypeBodyContains = "body_contains"
)

// Assertion is one declarative check against a response.
type Assertion struct {
	Type  string `json:"type"`            // status | latency | json | body_contains
	Path  string `json:"path,omitempty"`  // required for type json
	Op    string `json:"op"`              // eq neq lt gt exists contains count
	Value any    `json:"value,omitempty"` // float64 or string after JSON decode
}

// Outcome is the human-readable result of evaluating one Assertion.
type Outcome struct {
	Assertion Assertion `json:"assertion"`
	Passed    bool      `json:"passed"`
	Expected  string    `json:"expected"`
	Actual    string    `json:"actual"`
	Error     string    `json:"error,omitempty"`
}

// Target is one response, with its body decoded exactly once so a request
// carrying twenty assertions still only parses the JSON a single time.
type Target struct {
	Status    int
	LatencyMs float64
	Body      []byte
	Doc       any   // pre-decoded JSON body; nil when the body is not JSON
	DecodeErr error // why Doc is nil, when it is
}

// NewTarget builds a Target, decoding the body once.
func NewTarget(status int, latencyMs float64, body []byte) Target {
	t := Target{Status: status, LatencyMs: latencyMs, Body: body}
	if err := json.Unmarshal(body, &t.Doc); err != nil {
		t.Doc, t.DecodeErr = nil, err
	}
	return t
}

// opsByType is the single source of truth for which operators each assertion
// type accepts. ValidateAssertion enforces exactly this; nothing else does.
var opsByType = map[string][]string{
	TypeStatus:       {"eq", "neq"},
	TypeLatency:      {"lt"},
	TypeJSON:         {"eq", "neq", "gt", "lt", "exists", "contains", "count"},
	TypeBodyContains: {"contains"},
}

// ValidateAssertion reports whether a is well-formed. Callers run it before a
// run starts, so a malformed assertion is a 400 rather than a runtime surprise.
func ValidateAssertion(a Assertion) error {
	ops, ok := opsByType[a.Type]
	if !ok {
		return fmt.Errorf("unknown assertion type %q", a.Type)
	}
	if !slices.Contains(ops, a.Op) {
		return fmt.Errorf("operator %q is not valid for a %s assertion (allowed: %v)", a.Op, a.Type, ops)
	}

	if a.Type == TypeJSON {
		if a.Path == "" {
			return fmt.Errorf("a json assertion requires a path")
		}
		if err := ValidatePath(a.Path); err != nil {
			return err
		}
	} else if a.Path != "" {
		return fmt.Errorf("a %s assertion must not carry a path", a.Type)
	}

	switch a.Type {
	case TypeStatus, TypeLatency:
		if _, ok := toFloat(a.Value); !ok {
			return fmt.Errorf("a %s assertion needs a numeric value, got %s", a.Type, kindOf(a.Value))
		}
	case TypeBodyContains:
		if _, ok := a.Value.(string); !ok {
			return fmt.Errorf("body_contains needs a string value, got %s", kindOf(a.Value))
		}
	case TypeJSON:
		switch a.Op {
		case "exists":
			// Value is ignored.
		case "gt", "lt", "count":
			if _, ok := toFloat(a.Value); !ok {
				return fmt.Errorf("%s needs a numeric value, got %s", a.Op, kindOf(a.Value))
			}
		default: // eq, neq, contains
			if _, ok := toFloat(a.Value); ok {
				return nil
			}
			if _, ok := a.Value.(string); !ok {
				return fmt.Errorf("%s needs a number or a string value, got %s", a.Op, kindOf(a.Value))
			}
		}
	}
	return nil
}

// toFloat accepts both the float64 that encoding/json produces and the plain
// Go numeric types curated collections are written with.
func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

// kindOf names a decoded JSON value's type for error messages.
func kindOf(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "a boolean"
	case string:
		return "a string"
	case []any:
		return "an array"
	case map[string]any:
		return "an object"
	default:
		if _, ok := toFloat(v); ok {
			return "a number"
		}
		return fmt.Sprintf("a %T", v)
	}
}
