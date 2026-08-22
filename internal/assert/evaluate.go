package assert

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// missing is what Actual reads when a json path resolves to nothing. A missing
// path is a failed assertion, not an evaluation error — the target simply did
// not return what the author expected.
const missing = "<missing>"

// EvaluateAll runs every assertion against one response. An empty set passes
// vacuously, which is what makes a request with no assertions a plain probe.
func EvaluateAll(as []Assertion, t Target) ([]Outcome, bool) {
	outcomes := make([]Outcome, 0, len(as))
	passed := true
	for _, a := range as {
		o := Evaluate(a, t)
		if !o.Passed {
			passed = false
		}
		outcomes = append(outcomes, o)
	}
	return outcomes, passed
}

// Evaluate checks one assertion against one response. It never returns an
// error: a problem with the assertion or the body is reported in the Outcome,
// because the UI has to render every row either way.
func Evaluate(a Assertion, t Target) Outcome {
	out := Outcome{Assertion: a}
	if err := ValidateAssertion(a); err != nil {
		out.Error = err.Error()
		out.Actual = "<invalid assertion>"
		return out
	}

	switch a.Type {
	case TypeStatus:
		want, _ := toFloat(a.Value)
		got := float64(t.Status)
		out.Expected, out.Actual = formatNumber(want), formatNumber(got)
		if a.Op == "eq" {
			out.Passed = got == want
		} else {
			out.Passed = got != want
			out.Expected = "not " + out.Expected
		}

	case TypeLatency:
		want, _ := toFloat(a.Value)
		out.Expected = "< " + formatNumber(want) + "ms"
		out.Actual = formatNumber(t.LatencyMs) + "ms"
		out.Passed = t.LatencyMs < want

	case TypeBodyContains:
		needle, _ := a.Value.(string)
		out.Expected = "body contains " + formatString(needle)
		out.Actual = fmt.Sprintf("<body %d bytes>", len(t.Body))
		out.Passed = strings.Contains(t.foldedBody(), strings.ToLower(needle))

	case TypeJSON:
		evaluateJSON(a, t, &out)
	}
	return out
}

func evaluateJSON(a Assertion, t Target, out *Outcome) {
	if t.DecodeErr != nil {
		out.Expected = describeJSONExpectation(a)
		out.Actual = "<not json>"
		out.Error = "response body is not JSON: " + t.DecodeErr.Error()
		return
	}

	value, found, err := Lookup(t.Doc, a.Path)
	if err != nil { // ValidateAssertion already rejected malformed paths
		out.Error = err.Error()
		out.Actual = "<invalid path>"
		return
	}

	if a.Op == "exists" {
		out.Expected = a.Path + " is present"
		out.Actual = map[bool]string{true: "present", false: "missing"}[found]
		out.Passed = found
		return
	}

	out.Expected = describeJSONExpectation(a)
	if !found {
		out.Actual = missing
		return
	}

	switch a.Op {
	case "count":
		want, _ := toFloat(a.Value)
		n, ok := countOf(value)
		if !ok {
			out.Actual = describeValue(value)
			out.Error = fmt.Sprintf("%s is %s, count needs an array, an object, or a string", a.Path, kindOf(value))
			return
		}
		out.Actual = formatNumber(float64(n))
		out.Passed = float64(n) == want

	case "gt", "lt":
		want, _ := toFloat(a.Value)
		got, ok := toFloat(value)
		if !ok {
			out.Actual = describeValue(value)
			out.Error = fmt.Sprintf("%s is %s, %s needs a number", a.Path, kindOf(value), a.Op)
			return
		}
		out.Actual = formatNumber(got)
		out.Passed = (a.Op == "gt" && got > want) || (a.Op == "lt" && got < want)

	case "contains":
		out.Actual = describeValue(value)
		switch v := value.(type) {
		case string:
			needle := stringOf(a.Value)
			out.Passed = strings.Contains(strings.ToLower(v), strings.ToLower(needle))
		case []any:
			for _, elem := range v {
				if sameValue(elem, a.Value) {
					out.Passed = true
					break
				}
			}
		default:
			out.Error = fmt.Sprintf("%s is %s, contains needs a string or an array", a.Path, kindOf(value))
		}

	default: // eq, neq
		out.Actual = describeValue(value)
		match, ok := compareEqual(value, a.Value)
		if !ok {
			out.Error = fmt.Sprintf("%s is %s, cannot compare it to %s", a.Path, kindOf(value), kindOf(a.Value))
			return
		}
		out.Passed = match == (a.Op == "eq")
	}
}

// compareEqual reports equality and whether the two values were comparable at
// all. A type mismatch is a failure with an explanation, never a silent false.
func compareEqual(got, want any) (equal, comparable bool) {
	if wf, ok := toFloat(want); ok {
		gf, ok := toFloat(got)
		if !ok {
			return false, false
		}
		return gf == wf, true
	}
	if ws, ok := want.(string); ok {
		gs, ok := got.(string)
		if !ok {
			return false, false
		}
		return gs == ws, true
	}
	return false, false
}

// sameValue is array-membership equality: by value, and only for the scalar
// kinds an assertion can express.
func sameValue(elem, want any) bool {
	equal, ok := compareEqual(elem, want)
	return ok && equal
}

func countOf(v any) (int, bool) {
	switch c := v.(type) {
	case []any:
		return len(c), true
	case map[string]any:
		return len(c), true
	case string:
		return utf8.RuneCountInString(c), true
	default:
		return 0, false
	}
}

func describeJSONExpectation(a Assertion) string {
	switch a.Op {
	case "count":
		return a.Path + " has " + formatValue(a.Value) + " items"
	case "gt":
		return "> " + formatValue(a.Value)
	case "lt":
		return "< " + formatValue(a.Value)
	case "neq":
		return "not " + formatValue(a.Value)
	case "contains":
		return "contains " + formatValue(a.Value)
	default:
		return formatValue(a.Value)
	}
}

// describeValue renders a looked-up JSON value for a report row. Containers are
// summarised rather than dumped: the body preview is where the full text lives.
func describeValue(v any) string {
	switch c := v.(type) {
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(c)
	case string:
		return formatString(c)
	case []any:
		return fmt.Sprintf("<array of %d>", len(c))
	case map[string]any:
		return fmt.Sprintf("<object with %d keys>", len(c))
	default:
		if f, ok := toFloat(v); ok {
			return formatNumber(f)
		}
		return fmt.Sprintf("%v", v)
	}
}

func formatValue(v any) string {
	if f, ok := toFloat(v); ok {
		return formatNumber(f)
	}
	if s, ok := v.(string); ok {
		return formatString(s)
	}
	return describeValue(v)
}

// formatNumber prints a float the way a human writes it: 200, not 200.000000.
func formatNumber(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// formatString quotes only when the quotes earn their keep.
func formatString(s string) string {
	if s == "" || strings.ContainsAny(s, " \t\r\n\"") {
		return strconv.Quote(s)
	}
	return s
}

func stringOf(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if f, ok := toFloat(v); ok {
		return formatNumber(f)
	}
	return fmt.Sprintf("%v", v)
}
