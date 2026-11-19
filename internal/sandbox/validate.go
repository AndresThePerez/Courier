package sandbox

import (
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/assert"
)

// Run modes.
const (
	ModeFunctional  = "functional"
	ModePerformance = "performance"
)

// Payload caps. These bound what a *request body* may contain and are enforced
// regardless of what the client sends.
//
// Lifecycle constants live with their behaviour, not here: the 120s functional
// deadline is runner.FunctionalDeadline and the 5s cooldown floor is
// budget.MinCooldown. The SLO constants belong to internal/report.
// Each cap lives where its behaviour lives; this is not a grab-bag.
const (
	MaxSequence   = 50
	MaxAssertions = 20

	// A parameter value is cut, never refused, to the target's own limits on
	// a search text: it refuses a q over 256 characters or 32 terms with a
	// 400, so a longer value sent whole would come back as that refusal.
	// CutParamValue states the rule exactly.
	MaxParamValueLen = 256 // characters, not bytes
	MaxParamWords    = 32  // white-space-separated words

	// MaxAssertionTextLen bounds an assertion's JSON path and string value,
	// which are refused over it rather than cut (validateAssertion).
	MaxAssertionTextLen = 500 // characters, not bytes

	MaxNameLen      = 120 // characters, not bytes
	MaxConcurrency  = 50
	MaxDurationSecs = 30
	MaxDelayMs      = 1000

	DefaultConcurrency  = 10
	DefaultDurationSecs = 10
)

// Request is one request in a run: an endpoint ID plus allowlisted params.
// There is no URL field, and there never will be.
type Request struct {
	ID         string             `json:"id"`
	Name       string             `json:"name"`
	Endpoint   string             `json:"endpoint"`
	Params     map[string]string  `json:"params"`
	Assertions []assert.Assertion `json:"assertions"`
}

// Options are the run's knobs. Which ones are read depends on the mode:
// functional reads StopOnFailure and DelayMs, performance reads Concurrency
// and DurationSecs. All four are clamped either way so a stored report never
// shows a value the engine would not have honoured.
type Options struct {
	StopOnFailure bool `json:"stop_on_failure"`
	DelayMs       int  `json:"delay_ms"`
	Concurrency   int  `json:"concurrency"`
	DurationSecs  int  `json:"duration_secs"`
}

// RunRequest is the whole POST /api/runs payload.
type RunRequest struct {
	Mode     string    `json:"mode"` // functional | performance
	Sequence []Request `json:"sequence"`
	Options  Options   `json:"options"`
}

// ValidationError names the exact offending field, because its message is the
// 400 response body a visitor sees.
type ValidationError struct {
	Field   string
	Message string
}

func (e ValidationError) Error() string { return e.Field + ": " + e.Message }

// at returns a copy of e scoped under a parent field path.
func (e ValidationError) at(parent string) ValidationError {
	e.Field = parent + "." + e.Field
	return e
}

func invalid(field, format string, args ...any) ValidationError {
	return ValidationError{Field: field, Message: fmt.Sprintf(format, args...)}
}

// Validate checks a run payload and returns a sanitized, fully unaliased copy.
//
// Structural violations are rejected; numeric knobs are clamped. The split is
// deliberate: a payload naming an endpoint that does not exist is a mistake the
// author must see, while a concurrency of 500 is a request the server is simply
// allowed to answer with 50.
//
// The input is never mutated.
func Validate(rr RunRequest) (RunRequest, error) {
	if rr.Mode != ModeFunctional && rr.Mode != ModePerformance {
		return RunRequest{}, invalid("mode", "must be %q or %q, got %q", ModeFunctional, ModePerformance, assert.Clip(rr.Mode))
	}
	if len(rr.Sequence) == 0 {
		return RunRequest{}, invalid("sequence", "a run needs at least one request")
	}
	if len(rr.Sequence) > MaxSequence {
		return RunRequest{}, invalid("sequence", "%d requests exceeds the cap of %d", len(rr.Sequence), MaxSequence)
	}

	out := RunRequest{Mode: rr.Mode, Options: clampOptions(rr.Options)}
	out.Sequence = make([]Request, len(rr.Sequence))
	for i, r := range rr.Sequence {
		clean, err := ValidateRequest(r)
		if err != nil {
			var ve ValidationError
			if errors.As(err, &ve) {
				return RunRequest{}, ve.at(fmt.Sprintf("sequence[%d]", i))
			}
			return RunRequest{}, err
		}
		out.Sequence[i] = clean
	}
	return out, nil
}

// ValidateRequest checks a single request and returns a sanitized copy. It is
// the same code path /api/send uses, so a curated request, a visitor-edited
// request, and a one-off Send are all held to identical rules.
func ValidateRequest(r Request) (Request, error) {
	ep, ok := Lookup(r.Endpoint)
	if !ok {
		return Request{}, invalid("endpoint", "unknown endpoint %q", assert.Clip(r.Endpoint))
	}

	out := Request{
		// ID is client-chosen and never read server-side, but the caps table
		// says every string in a payload is bounded, so this one is too.
		ID:       truncate(r.ID, MaxNameLen),
		Name:     truncate(r.Name, MaxNameLen),
		Endpoint: ep.ID,
	}

	if len(r.Params) > 0 {
		out.Params = make(map[string]string, len(r.Params))
		// Sorted so that a payload with two bad keys always names the same one:
		// a validation message that changes between identical requests is a
		// bug report nobody can reproduce.
		for _, key := range slices.Sorted(maps.Keys(r.Params)) {
			if !ep.Allows(key) {
				return Request{}, invalid("params", "unknown parameter %q for endpoint %q", assert.Clip(key), ep.ID)
			}
			out.Params[key] = CutParamValue(r.Params[key])
		}
	}

	if len(r.Assertions) > MaxAssertions {
		return Request{}, invalid("assertions", "%d assertions exceeds the cap of %d", len(r.Assertions), MaxAssertions)
	}
	if len(r.Assertions) > 0 {
		out.Assertions = make([]assert.Assertion, len(r.Assertions))
		for i, a := range r.Assertions {
			if err := validateAssertion(a); err != nil {
				return Request{}, invalid(fmt.Sprintf("assertions[%d]", i), "%s", err.Error())
			}
			out.Assertions[i] = a
		}
	}
	return out, nil
}

// validateAssertion bounds an assertion's strings before checking its meaning.
//
// They are refused over their cap rather than cut: a parameter cut short is
// still a query the target answers, while an expected value cut short is a
// different assertion from the one the author wrote. Their cap is not the
// parameter's: the target's limit on a search text says nothing about what a
// response may be checked for.
func validateAssertion(a assert.Assertion) error {
	if n := utf8.RuneCountInString(a.Path); n > MaxAssertionTextLen {
		return fmt.Errorf("the path is %d characters; the cap is %d", n, MaxAssertionTextLen)
	}
	if v, ok := a.Value.(string); ok {
		if n := utf8.RuneCountInString(v); n > MaxAssertionTextLen {
			return fmt.Errorf("the value is %d characters; the cap is %d", n, MaxAssertionTextLen)
		}
	}
	return assert.ValidateAssertion(a)
}

// clampOptions folds every knob into the range the engine will honour.
// Zero and negative mean "unset" for the sizing knobs and "none" for the delay.
func clampOptions(o Options) Options {
	return Options{
		StopOnFailure: o.StopOnFailure,
		DelayMs:       clamp(o.DelayMs, 0, MaxDelayMs, 0),
		Concurrency:   clamp(o.Concurrency, 1, MaxConcurrency, DefaultConcurrency),
		DurationSecs:  clamp(o.DurationSecs, 1, MaxDurationSecs, DefaultDurationSecs),
	}
}

func clamp(n, lo, hi, fallback int) int {
	if n < lo {
		return fallback
	}
	if n > hi {
		return hi
	}
	return n
}

// truncate cuts to at most n characters, never splitting a rune.
func truncate(s string, n int) string {
	if len(s) <= n { // bytes >= runes, so this is a safe fast path
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// Truncations names, in the validator's field notation, every string in a run
// payload that Validate cuts to a length cap, or nil when nothing is cut.
//
// Cutting rather than refusing is the caps table's rule for these strings; this
// is what keeps the cut from being silent.
func Truncations(rr RunRequest) []string {
	var out []string
	for i, r := range rr.Sequence {
		for _, f := range RequestTruncations(r) {
			out = append(out, fmt.Sprintf("sequence[%d].%s", i, f))
		}
	}
	return out
}

// RequestTruncations is Truncations for one request, as /api/send takes it.
func RequestTruncations(r Request) []string {
	var out []string
	if utf8.RuneCountInString(r.ID) > MaxNameLen {
		out = append(out, "id")
	}
	if utf8.RuneCountInString(r.Name) > MaxNameLen {
		out = append(out, "name")
	}
	for _, key := range slices.Sorted(maps.Keys(r.Params)) {
		if CutParamValue(r.Params[key]) != r.Params[key] {
			out = append(out, "params."+key)
		}
	}
	return out
}

// CutParamValue is the value a parameter is sent with: its first
// MaxParamWords words, then its first MaxParamValueLen characters.
//
// The rule, exactly. A character is a rune, as in every cap here. A word is a
// maximal run of characters that are not Unicode white space (unicode.IsSpace:
// the space, tab, newline, carriage return, the non-breaking and ideographic
// spaces and the other Zs spaces among them; a zero-width space is not one).
// The word cut comes first: a value with more than MaxParamWords words ends
// at the end of its last word kept, so the white space after that word goes
// with the words cut, while white space before and between the words kept
// stays as written. A value within the word limit keeps all its white space,
// at either end too. The character cut then keeps the first MaxParamValueLen
// characters, which may end inside a word or in white space. So the result is
// a prefix of the value, within both limits, never ends inside a character,
// and is the value itself exactly when the value is within both limits; a
// value of only white space has no words and is cut by characters alone.
func CutParamValue(s string) string {
	words, inWord := 0, false
	for i, r := range s {
		if unicode.IsSpace(r) {
			inWord = false
			continue
		}
		if !inWord {
			if words == MaxParamWords {
				s = strings.TrimRightFunc(s[:i], unicode.IsSpace)
				break
			}
			words++
			inWord = true
		}
	}
	return truncate(s, MaxParamValueLen)
}
