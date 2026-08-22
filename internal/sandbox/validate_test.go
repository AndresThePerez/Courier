package sandbox

import (
	"errors"
	"strings"
	"testing"

	"github.com/AndresThePerez/courier/internal/assert"
)

func req(params map[string]string) Request {
	return Request{ID: "r1", Name: "Basic", Endpoint: "search", Params: params,
		Assertions: []assert.Assertion{{Type: "status", Op: "eq", Value: float64(200)}}}
}

func perfRun(seq []Request, o Options) RunRequest {
	return RunRequest{Mode: "performance", Sequence: seq, Options: o}
}

func TestValidateRejects(t *testing.T) {
	tests := []struct {
		name string
		rr   RunRequest
	}{
		{"unknown mode", RunRequest{Mode: "chaos", Sequence: []Request{req(nil)}}},
		{"empty mode", RunRequest{Sequence: []Request{req(nil)}}},
		{"empty sequence", RunRequest{Mode: "functional"}},
		{"sequence over cap", perfRun(make([]Request, MaxSequence+1), Options{})},
		{"unknown endpoint", RunRequest{Mode: "functional", Sequence: []Request{{Endpoint: "admin"}}}},
		{"unknown param", RunRequest{Mode: "functional", Sequence: []Request{req(map[string]string{"limit": "50"})}}},
		{"a url is never a param", RunRequest{Mode: "functional", Sequence: []Request{req(map[string]string{"url": "http://evil.example"})}}},
		{"param not on this endpoint", RunRequest{Mode: "functional", Sequence: []Request{{ID: "s", Name: "s", Endpoint: "suggest", Params: map[string]string{"sort": "hp"}}}}},
		{"healthz takes no params", RunRequest{Mode: "functional", Sequence: []Request{{ID: "h", Name: "h", Endpoint: "healthz", Params: map[string]string{"q": "x"}}}}},
		{"invalid assertion", RunRequest{Mode: "functional", Sequence: []Request{{ID: "a", Name: "a", Endpoint: "search",
			Assertions: []assert.Assertion{{Type: "status", Op: "gt", Value: float64(200)}}}}}},
		{"too many assertions", RunRequest{Mode: "functional", Sequence: []Request{{ID: "a", Name: "a", Endpoint: "search",
			Assertions: make([]assert.Assertion, MaxAssertions+1)}}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Validate(tc.rr); err == nil {
				t.Fatalf("Validate(%s) = nil error, want rejection", tc.name)
			}
		})
	}
}

func TestValidateClamps(t *testing.T) {
	got, err := Validate(perfRun([]Request{req(nil)}, Options{Concurrency: 500, DurationSecs: 600, DelayMs: 99999}))
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if got.Options.Concurrency != MaxConcurrency {
		t.Errorf("concurrency = %d, want %d", got.Options.Concurrency, MaxConcurrency)
	}
	if got.Options.DurationSecs != MaxDurationSecs {
		t.Errorf("duration = %d, want %d", got.Options.DurationSecs, MaxDurationSecs)
	}
	if got.Options.DelayMs != MaxDelayMs {
		t.Errorf("delay = %d, want %d", got.Options.DelayMs, MaxDelayMs)
	}
	zero, err := Validate(perfRun([]Request{req(nil)}, Options{Concurrency: 0, DurationSecs: -5}))
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if zero.Options.Concurrency != DefaultConcurrency || zero.Options.DurationSecs != DefaultDurationSecs {
		t.Errorf("zero values = %d/%d, want defaults %d/%d",
			zero.Options.Concurrency, zero.Options.DurationSecs, DefaultConcurrency, DefaultDurationSecs)
	}
	neg, err := Validate(perfRun([]Request{req(nil)}, Options{DelayMs: -100}))
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if neg.Options.DelayMs != 0 {
		t.Errorf("negative delay = %d, want 0", neg.Options.DelayMs)
	}
}

func TestValidateTruncatesLongValues(t *testing.T) {
	long := strings.Repeat("x", MaxParamValueLen+250)
	got, err := Validate(RunRequest{Mode: "functional", Sequence: []Request{req(map[string]string{"q": long})}})
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if n := len(got.Sequence[0].Params["q"]); n != MaxParamValueLen {
		t.Errorf("param length = %d, want %d (truncated, not rejected)", n, MaxParamValueLen)
	}
	if got.Sequence[0].Name == "" {
		t.Error("names must survive validation")
	}
}

// Truncation counts characters, not bytes, and must never split a rune.
func TestValidateTruncationIsRuneSafe(t *testing.T) {
	long := strings.Repeat("δ", MaxParamValueLen+50)
	got, err := Validate(RunRequest{Mode: "functional", Sequence: []Request{req(map[string]string{"q": long})}})
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	q := got.Sequence[0].Params["q"]
	if n := len([]rune(q)); n != MaxParamValueLen {
		t.Errorf("param runes = %d, want %d", n, MaxParamValueLen)
	}
	if !strings.HasSuffix(q, "δ") || strings.ContainsRune(q, '�') {
		t.Error("truncation split a multi-byte rune")
	}
}

func TestValidateTruncatesNames(t *testing.T) {
	r := req(nil)
	r.Name = strings.Repeat("n", MaxNameLen+40)
	got, err := Validate(RunRequest{Mode: "functional", Sequence: []Request{r}})
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if n := len([]rune(got.Sequence[0].Name)); n != MaxNameLen {
		t.Errorf("name length = %d, want %d", n, MaxNameLen)
	}
}

func TestValidateDoesNotMutateInput(t *testing.T) {
	in := perfRun([]Request{req(map[string]string{"q": strings.Repeat("x", 900)})}, Options{Concurrency: 500})
	if _, err := Validate(in); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if in.Options.Concurrency != 500 || len(in.Sequence[0].Params["q"]) != 900 {
		t.Error("Validate mutated its input; it must return a sanitized copy")
	}
}

// The sanitized copy must not share backing memory with the caller's payload,
// or a later edit by the HTTP layer would reach inside a running run.
func TestValidateReturnsAnUnaliasedCopy(t *testing.T) {
	in := RunRequest{Mode: "functional", Sequence: []Request{req(map[string]string{"q": "charizard"})}}
	got, err := Validate(in)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	got.Sequence[0].Params["q"] = "mutated"
	got.Sequence[0].Assertions[0].Value = float64(404)
	if in.Sequence[0].Params["q"] != "charizard" {
		t.Error("params map is shared with the input")
	}
	if in.Sequence[0].Assertions[0].Value != float64(200) {
		t.Error("assertions slice is shared with the input")
	}
}

func TestValidateAcceptsEveryRealisticShape(t *testing.T) {
	rr := RunRequest{Mode: "functional", Sequence: []Request{
		{ID: "a", Name: "text", Endpoint: "search", Params: map[string]string{"q": "charizard", "sort": "hp", "order": "desc", "page": "2", "page_size": "50", "debug": "1"},
			Assertions: []assert.Assertion{
				{Type: "status", Op: "eq", Value: float64(200)},
				{Type: "latency", Op: "lt", Value: float64(300)},
				{Type: "json", Path: "$.total", Op: "gt", Value: float64(0)},
				{Type: "body_contains", Op: "contains", Value: "results"},
			}},
		{ID: "b", Name: "suggest", Endpoint: "suggest", Params: map[string]string{"q": "alak"}},
		{ID: "c", Name: "health", Endpoint: "healthz"},
	}, Options: Options{StopOnFailure: true, DelayMs: 250}}
	if _, err := Validate(rr); err != nil {
		t.Fatalf("Validate rejected a realistic payload: %v", err)
	}
}

// The message goes straight into a 400 body, so it must name the exact field.
func TestValidationErrorNamesTheField(t *testing.T) {
	_, err := Validate(RunRequest{Mode: "functional", Sequence: []Request{
		req(nil),
		req(map[string]string{"limit": "50"}),
	}})
	if err == nil {
		t.Fatal("want a rejection")
	}
	var ve ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("error is %T, want a ValidationError", err)
	}
	if ve.Field != "sequence[1].params" {
		t.Errorf("Field = %q, want sequence[1].params", ve.Field)
	}
	for _, want := range []string{"sequence[1].params", "limit", "search"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message %q does not mention %q", err.Error(), want)
		}
	}
}

func TestValidationErrorNamesTheAssertion(t *testing.T) {
	_, err := Validate(RunRequest{Mode: "functional", Sequence: []Request{{ID: "a", Name: "a", Endpoint: "search",
		Assertions: []assert.Assertion{
			{Type: "status", Op: "eq", Value: float64(200)},
			{Type: "json", Path: "not-a-path", Op: "eq", Value: float64(1)},
		}}}})
	if err == nil {
		t.Fatal("want a rejection")
	}
	if !strings.Contains(err.Error(), "sequence[0].assertions[1]") {
		t.Errorf("message %q does not locate the bad assertion", err.Error())
	}
}

// /api/send validates one request through the same code path as a run.
func TestValidateRequestStandsAlone(t *testing.T) {
	got, err := ValidateRequest(Request{ID: "s", Name: strings.Repeat("x", MaxNameLen+5),
		Endpoint: "search", Params: map[string]string{"q": strings.Repeat("y", MaxParamValueLen+5)}})
	if err != nil {
		t.Fatalf("ValidateRequest: %v", err)
	}
	if len([]rune(got.Name)) != MaxNameLen || len(got.Params["q"]) != MaxParamValueLen {
		t.Errorf("ValidateRequest did not clamp: name %d, q %d", len([]rune(got.Name)), len(got.Params["q"]))
	}
	if _, err := ValidateRequest(Request{Endpoint: "admin"}); err == nil {
		t.Error("ValidateRequest must reject an endpoint outside the catalog")
	}
}

func TestValidateAcceptsBothModes(t *testing.T) {
	for _, mode := range []string{ModeFunctional, ModePerformance} {
		if _, err := Validate(RunRequest{Mode: mode, Sequence: []Request{req(nil)}}); err != nil {
			t.Errorf("mode %q rejected: %v", mode, err)
		}
	}
}

func TestValidateAcceptsSequenceAtTheCap(t *testing.T) {
	seq := make([]Request, MaxSequence)
	for i := range seq {
		seq[i] = req(nil)
	}
	if _, err := Validate(perfRun(seq, Options{})); err != nil {
		t.Errorf("a sequence of exactly %d must be accepted: %v", MaxSequence, err)
	}
}
