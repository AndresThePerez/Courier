package sandbox

import (
	"errors"
	"math"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

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

// Assertion strings share the parameter cap but are refused over it, not cut:
// a truncated expected value is a different assertion from the one written.
// The cap counts characters, as the parameter cap does.
func TestAssertionStringsOverTheCapAreRefused(t *testing.T) {
	at := func(n int, s string) string { return strings.Repeat(s, n) }
	path := func(n int) string { return "$." + strings.Repeat("a", n-2) }

	over := []assert.Assertion{
		{Type: "body_contains", Op: "contains", Value: at(MaxParamValueLen+1, "x")},
		{Type: "body_contains", Op: "contains", Value: at(MaxParamValueLen+1, "δ")},
		{Type: "json", Path: "$.name", Op: "eq", Value: at(MaxParamValueLen+1, "x")},
		{Type: "json", Path: "$.name", Op: "contains", Value: at(MaxParamValueLen+1, "x")},
		{Type: "json", Path: path(MaxParamValueLen + 1), Op: "exists"},
	}
	for _, a := range over {
		r := req(nil)
		r.Assertions = append(r.Assertions, a)
		_, err := ValidateRequest(r)
		var ve ValidationError
		if !errors.As(err, &ve) || ve.Field != "assertions[1]" {
			t.Errorf("value %d / path %d chars: err = %v, want a rejection at assertions[1]",
				len([]rune(fmtValue(a.Value))), len(a.Path), err)
		}
		_, err = Validate(RunRequest{Mode: ModeFunctional, Sequence: []Request{req(nil), r}})
		if !errors.As(err, &ve) || ve.Field != "sequence[1].assertions[1]" {
			t.Errorf("run: err = %v, want a rejection at sequence[1].assertions[1]", err)
		}
	}

	atCap := []assert.Assertion{
		{Type: "body_contains", Op: "contains", Value: at(MaxParamValueLen, "x")},
		{Type: "body_contains", Op: "contains", Value: at(MaxParamValueLen, "δ")}, // 1000 bytes
		{Type: "json", Path: "$.name", Op: "eq", Value: at(MaxParamValueLen, "x")},
		{Type: "json", Path: path(MaxParamValueLen), Op: "exists"},
	}
	for _, a := range atCap {
		r := req(nil)
		r.Assertions = []assert.Assertion{a}
		if _, err := ValidateRequest(r); err != nil {
			t.Errorf("an assertion at the cap was refused: %v", err)
		}
	}
}

func fmtValue(v any) string { s, _ := v.(string); return s }

// Over-length strings are still cut, not refused; what changes is that the
// client is told which ones were cut.
func TestTruncationsNameWhatWasCut(t *testing.T) {
	long := func(n int) string { return strings.Repeat("δ", n) }

	if got := RequestTruncations(req(map[string]string{"q": long(MaxParamValueLen)})); got != nil {
		t.Errorf("nothing over a cap, got %v, want nil", got)
	}

	r := Request{
		ID:       long(MaxNameLen + 1),
		Name:     long(MaxNameLen + 1),
		Endpoint: "search",
		Params:   map[string]string{"types": long(MaxParamValueLen + 1), "q": long(MaxParamValueLen + 1), "set": "base1"},
	}
	want := []string{"id", "name", "params.q", "params.types"}
	if got := RequestTruncations(r); !slices.Equal(got, want) {
		t.Errorf("RequestTruncations = %v, want %v", got, want)
	}

	rr := RunRequest{Mode: ModeFunctional, Sequence: []Request{req(nil), r}}
	want = []string{"sequence[1].id", "sequence[1].name", "sequence[1].params.q", "sequence[1].params.types"}
	if got := Truncations(rr); !slices.Equal(got, want) {
		t.Errorf("Truncations = %v, want %v", got, want)
	}
	if got := Truncations(RunRequest{Mode: ModeFunctional, Sequence: []Request{req(nil)}}); got != nil {
		t.Errorf("Truncations of a clean run = %v, want nil", got)
	}
}

// The assertion bounds at and either side of each edge, with the string caps
// counted in characters however many bytes or combining marks they take.
func TestAssertionBoundsAtEveryEdge(t *testing.T) {
	combining := strings.Repeat("é", 250)    // 500 characters, 750 bytes
	wide := strings.Repeat("\U0001F525", 500) // 500 characters, 2,000 bytes
	path := "$." + strings.Repeat("a", 498)

	cases := []struct {
		name string
		a    assert.Assertion
		ok   bool
	}{
		{"status 99", assert.Assertion{Type: "status", Op: "eq", Value: float64(99)}, false},
		{"status 100", assert.Assertion{Type: "status", Op: "eq", Value: float64(100)}, true},
		{"status 599", assert.Assertion{Type: "status", Op: "neq", Value: float64(599)}, true},
		{"status 600", assert.Assertion{Type: "status", Op: "eq", Value: float64(600)}, false},
		{"status 200.0", assert.Assertion{Type: "status", Op: "eq", Value: 200.0}, true},
		{"status 200.5", assert.Assertion{Type: "status", Op: "eq", Value: 200.5}, false},
		{"status -200", assert.Assertion{Type: "status", Op: "eq", Value: float64(-200)}, false},
		{"status as a string", assert.Assertion{Type: "status", Op: "eq", Value: "200"}, false},
		{"status +Inf", assert.Assertion{Type: "status", Op: "eq", Value: math.Inf(1)}, false},
		{"status NaN", assert.Assertion{Type: "status", Op: "eq", Value: math.NaN()}, false},
		{"status int 200", assert.Assertion{Type: "status", Op: "eq", Value: 200}, true},
		{"latency 0", assert.Assertion{Type: "latency", Op: "lt", Value: float64(0)}, false},
		{"latency -0", assert.Assertion{Type: "latency", Op: "lt", Value: math.Copysign(0, -1)}, false},
		{"latency NaN", assert.Assertion{Type: "latency", Op: "lt", Value: math.NaN()}, false},
		{"latency 0.001", assert.Assertion{Type: "latency", Op: "lt", Value: 0.001}, true},
		{"latency 1e-320", assert.Assertion{Type: "latency", Op: "lt", Value: 1e-320}, true},
		{"latency 1e300", assert.Assertion{Type: "latency", Op: "lt", Value: 1e300}, true},
		{"count -1", assert.Assertion{Type: "json", Path: "$.results", Op: "count", Value: float64(-1)}, false},
		{"count 0", assert.Assertion{Type: "json", Path: "$.results", Op: "count", Value: float64(0)}, true},
		{"count 1.5", assert.Assertion{Type: "json", Path: "$.results", Op: "count", Value: 1.5}, false},
		{"count 1e3", assert.Assertion{Type: "json", Path: "$.results", Op: "count", Value: 1e3}, true},
		{"count +Inf", assert.Assertion{Type: "json", Path: "$.results", Op: "count", Value: math.Inf(1)}, false},
		{"combining value at 500", assert.Assertion{Type: "body_contains", Op: "contains", Value: combining}, true},
		{"combining value at 501", assert.Assertion{Type: "body_contains", Op: "contains", Value: combining + "e"}, false},
		{"wide value at 500", assert.Assertion{Type: "json", Path: "$.name", Op: "eq", Value: wide}, true},
		{"wide value at 501", assert.Assertion{Type: "json", Path: "$.name", Op: "contains", Value: wide + "x"}, false},
		{"path at 500", assert.Assertion{Type: "json", Path: path, Op: "exists"}, true},
		{"path at 501", assert.Assertion{Type: "json", Path: path + "b", Op: "exists"}, false},
	}
	for _, tc := range cases {
		r := Request{Endpoint: "healthz", Assertions: []assert.Assertion{
			{Type: "status", Op: "eq", Value: float64(200)}, tc.a,
		}}
		_, err := ValidateRequest(r)
		if tc.ok {
			if err != nil {
				t.Errorf("%s: refused: %v", tc.name, err)
			}
			continue
		}
		var ve ValidationError
		if !errors.As(err, &ve) {
			t.Errorf("%s: accepted, want a validation error", tc.name)
			continue
		}
		if ve.Field != "assertions[1]" {
			t.Errorf("%s: field = %q, want assertions[1]", tc.name, ve.Field)
		}
		if len(ve.Message) > 300 {
			t.Errorf("%s: message is %d bytes; it echoes the value", tc.name, len(ve.Message))
		}
	}
}

// Truncation reports exactly what Validate cuts, with indexes that stay right
// when earlier requests are clean, and the cut never splits a character.
func TestTruncationsListExactlyWhatIsCut(t *testing.T) {
	at := func(s string, n int) string { return strings.Repeat(s, n) }
	rr := RunRequest{Mode: ModeFunctional, Sequence: []Request{
		{ID: at("i", MaxNameLen), Name: at("é", MaxNameLen), Endpoint: "search",
			Params: map[string]string{"q": at("é", MaxParamValueLen)}},
		{ID: at("ü", MaxNameLen+1), Name: "ok", Endpoint: "search",
			Params: map[string]string{"q": at("\U0001F525", MaxParamValueLen+1), "page": "1"}},
		{Name: at("n", MaxNameLen+1), Endpoint: "suggest", Params: map[string]string{"q": "ab"}},
	}}
	got := Truncations(rr)
	want := []string{"sequence[1].id", "sequence[1].params.q", "sequence[2].name"}
	if !slices.Equal(got, want) {
		t.Fatalf("Truncations = %q, want %q", got, want)
	}
	clean, err := Validate(rr)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	q := clean.Sequence[1].Params["q"]
	if !utf8.ValidString(q) || utf8.RuneCountInString(q) != MaxParamValueLen || q != at("\U0001F525", MaxParamValueLen) {
		t.Errorf("the cut q is %d characters, valid UTF-8 %v", utf8.RuneCountInString(q), utf8.ValidString(q))
	}
	if clean.Sequence[0].Params["q"] != rr.Sequence[0].Params["q"] {
		t.Error("a q exactly at the cap was changed")
	}
	if got := Truncations(RunRequest{Mode: ModeFunctional, Sequence: []Request{rr.Sequence[0]}}); got != nil {
		t.Errorf("a payload with nothing cut reports %q, want nil", got)
	}
}

// Validation messages are response bodies; a quoted payload string reads
// exactly as written when short and is cut to a readable length when long.
func TestValidationMessagesClipWhatTheyQuote(t *testing.T) {
	long := strings.Repeat("ü", 100_000)
	run := func(r Request) RunRequest {
		return RunRequest{Mode: ModeFunctional, Sequence: []Request{r}}
	}
	cases := []struct {
		name string
		rr   RunRequest
		want string
	}{
		{"short mode", RunRequest{Mode: "x", Sequence: []Request{req(nil)}}, `must be "functional" or "performance", got "x"`},
		{"long mode", RunRequest{Mode: long, Sequence: []Request{req(nil)}}, `must be "functional" or "performance", got "` + assert.Clip(long) + `"`},
		{"short endpoint", run(Request{Endpoint: "admin"}), `unknown endpoint "admin"`},
		{"long endpoint", run(Request{Endpoint: long}), `unknown endpoint "` + assert.Clip(long) + `"`},
		{"short parameter", run(req(map[string]string{"url": "x"})), `unknown parameter "url" for endpoint "search"`},
		{"long parameter", run(req(map[string]string{long: "x"})), `unknown parameter "` + assert.Clip(long) + `" for endpoint "search"`},
	}
	for _, c := range cases {
		_, err := Validate(c.rr)
		var ve ValidationError
		if !errors.As(err, &ve) {
			t.Fatalf("%s: err = %v, want a ValidationError", c.name, err)
		}
		if ve.Message != c.want {
			t.Errorf("%s: message = %.300q, want %.300q", c.name, ve.Message, c.want)
		}
		if n := utf8.RuneCountInString(ve.Message); n > 200 {
			t.Errorf("%s: message is %d characters", c.name, n)
		}
	}
}
