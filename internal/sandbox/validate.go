package sandbox

import (
	"errors"
	"fmt"
	"maps"
	"slices"

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
	MaxSequence      = 50
	MaxAssertions    = 20
	MaxParamValueLen = 500 // characters, not bytes
	MaxNameLen       = 120 // characters, not bytes
	MaxConcurrency   = 50
	MaxDurationSecs  = 30
	MaxDelayMs       = 1000

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
		return RunRequest{}, invalid("mode", "must be %q or %q, got %q", ModeFunctional, ModePerformance, rr.Mode)
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
		return Request{}, invalid("endpoint", "unknown endpoint %q", r.Endpoint)
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
				return Request{}, invalid("params", "unknown parameter %q for endpoint %q", key, ep.ID)
			}
			out.Params[key] = truncate(r.Params[key], MaxParamValueLen)
		}
	}

	if len(r.Assertions) > MaxAssertions {
		return Request{}, invalid("assertions", "%d assertions exceeds the cap of %d", len(r.Assertions), MaxAssertions)
	}
	if len(r.Assertions) > 0 {
		out.Assertions = make([]assert.Assertion, len(r.Assertions))
		for i, a := range r.Assertions {
			if err := assert.ValidateAssertion(a); err != nil {
				return Request{}, invalid(fmt.Sprintf("assertions[%d]", i), "%s", err.Error())
			}
			out.Assertions[i] = a
		}
	}
	return out, nil
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
