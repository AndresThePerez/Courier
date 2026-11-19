package web

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/budget"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// The frontend copies a handful of server limits so a visitor meets a cap as
// a disabled control and a sentence rather than as a 400. A copy can drift
// silently: the server keeps enforcing its own value and the page goes on
// promising the old one. These tests read the copies out of the shipped source
// text and compare them with the Go values.
//
// Every lookup fails the test when its pattern finds nothing, or finds more
// than one candidate: a renamed or reshaped constant must stop the build, not
// turn the comparison into a check of nothing.

// reporter is the slice of testing.TB the extractors need, so the loud-failure
// rule itself can be tested with a recorder.
type reporter interface {
	Helper()
	Fatalf(format string, args ...any)
}

func shipped(t reporter, name string) string {
	t.Helper()
	src, err := Files.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
		return ""
	}
	return string(src)
}

// numbers returns the capture groups of the single match of pattern in src,
// parsed as numbers.
func numbers(t reporter, file, src, pattern string) []float64 {
	t.Helper()
	re := regexp.MustCompile(pattern)
	all := re.FindAllStringSubmatch(src, -1)
	if len(all) != 1 {
		t.Fatalf("%s: expected exactly one match for %q, found %d - was the constant renamed or reshaped? Update this test with it", file, pattern, len(all))
		return nil
	}
	out := make([]float64, 0, len(all[0])-1)
	for _, raw := range all[0][1:] {
		n, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			t.Fatalf("%s: %q matched %q, which is not a number", file, pattern, raw)
			return nil
		}
		out = append(out, n)
	}
	return out
}

func number(t reporter, file, src, pattern string) float64 {
	t.Helper()
	got := numbers(t, file, src, pattern)
	if len(got) != 1 {
		t.Fatalf("%s: pattern %q must capture exactly one number", file, pattern)
		return 0
	}
	return got[0]
}

func TestFrontendLimitsMatchTheServer(t *testing.T) {
	runner := shipped(t, "js/render-runner.js")
	editor := shipped(t, "js/render-editor.js")
	store := shipped(t, "js/store.js")
	model := shipped(t, "js/request-model.js")
	page := shipped(t, "index.html")

	cases := []struct {
		name string
		got  float64
		want float64
	}{
		{"render-runner.js MaxSequence = sandbox.MaxSequence",
			number(t, "render-runner.js", runner, `const MaxSequence = (\d+);`), sandbox.MaxSequence},
		{"render-editor.js MaxAssertions = sandbox.MaxAssertions",
			number(t, "render-editor.js", editor, `const MaxAssertions = (\d+);`), sandbox.MaxAssertions},
		{"render-editor.js param value maxlength = sandbox.MaxParamValueLen",
			number(t, "render-editor.js", editor, `maxlength: (\d+),`), sandbox.MaxParamValueLen},
		{"index.html #editor-name maxlength = sandbox.MaxNameLen",
			number(t, "index.html", page, `<input id="editor-name"[^>]*\smaxlength="(\d+)"`), sandbox.MaxNameLen},
		{"store.js default concurrency = sandbox.DefaultConcurrency",
			number(t, "store.js", store, `options: \{[^}]*\bconcurrency: (\d+)[^}]*\}`), sandbox.DefaultConcurrency},
		{"store.js default duration_secs = sandbox.DefaultDurationSecs",
			number(t, "store.js", store, `options: \{[^}]*\bduration_secs: (\d+)[^}]*\}`), sandbox.DefaultDurationSecs},
		{"store.js default delay_ms = the server's delay fallback (0)",
			number(t, "store.js", store, `options: \{[^}]*\bdelay_ms: (\d+)[^}]*\}`), 0},
		{"request-model.js MaxAssertionText = sandbox.MaxParamValueLen (assertion path and string value)",
			number(t, "request-model.js", model, `const MaxAssertionText = (\d+);`), sandbox.MaxParamValueLen},
		{"render-runner.js BudgetRefill = budget.Refill",
			number(t, "render-runner.js", runner, `const BudgetRefill = (\d+(?:\.\d+)?);`), budget.Refill},
		{"render-runner.js BudgetBurst = budget.Burst",
			number(t, "render-runner.js", runner, `const BudgetBurst = (\d+(?:\.\d+)?);`), budget.Burst},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: frontend has %v, server has %v", c.name, c.got, c.want)
		}
	}
}

// TestFrontendClampsMatchTheServer checks render-runner.js's Limits table. The
// caps and fallbacks are compared with the named constants; the floors have
// no exported name, so each knob is also run through sandbox.Validate at the
// edges the frontend claims, which is where the server's clamp actually lives.
func TestFrontendClampsMatchTheServer(t *testing.T) {
	runner := shipped(t, "js/render-runner.js")

	knobs := []struct {
		key           string
		hi, fallback  int
		set           func(*sandbox.Options, int)
		get           func(sandbox.Options) int
		namedHi, name string
	}{
		{"delay_ms", sandbox.MaxDelayMs, 0,
			func(o *sandbox.Options, n int) { o.DelayMs = n }, func(o sandbox.Options) int { return o.DelayMs },
			"sandbox.MaxDelayMs", "delay"},
		{"concurrency", sandbox.MaxConcurrency, sandbox.DefaultConcurrency,
			func(o *sandbox.Options, n int) { o.Concurrency = n }, func(o sandbox.Options) int { return o.Concurrency },
			"sandbox.MaxConcurrency", "concurrency"},
		{"duration_secs", sandbox.MaxDurationSecs, sandbox.DefaultDurationSecs,
			func(o *sandbox.Options, n int) { o.DurationSecs = n }, func(o sandbox.Options) int { return o.DurationSecs },
			"sandbox.MaxDurationSecs", "duration"},
	}

	endpoints := sandbox.Endpoints()
	if len(endpoints) == 0 {
		t.Fatal("the sandbox catalog is empty")
	}
	clamped := func(k int, set func(*sandbox.Options, int), get func(sandbox.Options) int) int {
		t.Helper()
		var opts sandbox.Options
		set(&opts, k)
		out, err := sandbox.Validate(sandbox.RunRequest{
			Mode:     sandbox.ModeFunctional,
			Sequence: []sandbox.Request{{ID: "r1", Endpoint: endpoints[0].ID}},
			Options:  opts,
		})
		if err != nil {
			t.Fatalf("Validate: %v", err)
		}
		return get(out.Options)
	}

	for _, k := range knobs {
		pattern := fmt.Sprintf(`\b%s: \{ lo: (\d+), hi: (\d+), fallback: (\d+) \}`, k.key)
		got := numbers(t, "render-runner.js", runner, pattern)
		if len(got) != 3 {
			t.Fatalf("render-runner.js Limits.%s: expected lo, hi and fallback", k.key)
		}
		lo, hi, fallback := int(got[0]), int(got[1]), int(got[2])

		if hi != k.hi {
			t.Errorf("Limits.%s.hi is %d, %s is %d", k.key, hi, k.namedHi, k.hi)
		}
		if fallback != k.fallback {
			t.Errorf("Limits.%s.fallback is %d, the server falls back to %d", k.key, fallback, k.fallback)
		}
		if v := clamped(lo, k.set, k.get); v != lo {
			t.Errorf("Limits.%s.lo is %d, but the server turns %d into %d (the floor is not %d)", k.key, lo, lo, v, lo)
		}
		if v := clamped(lo-1, k.set, k.get); v != k.fallback {
			t.Errorf("Limits.%s.lo is %d, but the server keeps %d as %d instead of falling back (the floor is lower)", k.key, lo, lo-1, v)
		}
		if v := clamped(hi+1, k.set, k.get); v != hi {
			t.Errorf("Limits.%s.hi is %d, but the server turns %d into %d", k.key, hi, hi+1, v)
		}
	}
}

// TestFrontendOperatorsMatchTheServer checks request-model.js's opsByType
// behaviourally: the Go matrix is unexported, and ValidateAssertion is the one
// place it is enforced. Every operator the editor offers must validate, and
// every one it withholds must be refused.
func TestFrontendOperatorsMatchTheServer(t *testing.T) {
	model := shipped(t, "js/request-model.js")
	offered := opsByType(t, model)

	types := []string{assert.TypeStatus, assert.TypeLatency, assert.TypeJSON, assert.TypeBodyContains}
	ops := []string{"eq", "neq", "lt", "gt", "exists", "contains", "count"}

	for name := range offered {
		if !slices.Contains(types, name) {
			t.Errorf("request-model.js offers assertion type %q, which this test does not know; add it here", name)
		}
	}
	for _, typ := range types {
		listed, ok := offered[typ]
		if !ok {
			t.Errorf("request-model.js opsByType has no %q entry", typ)
			continue
		}
		for _, op := range listed {
			if !slices.Contains(ops, op) {
				t.Errorf("request-model.js offers %s %q, which this test does not know; add it here", typ, op)
			}
		}
		for _, op := range ops {
			err := assert.ValidateAssertion(sample(typ, op))
			switch {
			case slices.Contains(listed, op) && err != nil:
				t.Errorf("the editor offers %s %s, but the server refuses it: %v", typ, op, err)
			case !slices.Contains(listed, op) && err == nil:
				t.Errorf("the server accepts %s %s, but the editor does not offer it", typ, op)
			}
		}
	}
}

// sample builds an assertion whose value is valid for its type, so that a
// refusal can only be about the operator.
func sample(typ, op string) assert.Assertion {
	a := assert.Assertion{Type: typ, Op: op}
	switch typ {
	case assert.TypeStatus:
		a.Value = float64(200)
	case assert.TypeLatency:
		a.Value = float64(100)
	case assert.TypeJSON:
		a.Path = "$"
		a.Value = float64(1)
	case assert.TypeBodyContains:
		a.Value = "x"
	}
	return a
}

var (
	opsBlock = regexp.MustCompile(`(?s)const opsByType = \{(.*?)\n\};`)
	opsEntry = regexp.MustCompile(`(?m)^\s*(\w+): \[([^\]]*)\],?\s*$`)
	opsName  = regexp.MustCompile(`'([^']*)'`)
)

func opsByType(t reporter, src string) map[string][]string {
	t.Helper()
	blocks := opsBlock.FindAllStringSubmatch(src, -1)
	if len(blocks) != 1 {
		t.Fatalf("request-model.js: expected exactly one `const opsByType = {...};`, found %d - was it renamed or reshaped? Update this test with it", len(blocks))
		return nil
	}
	body := blocks[0][1]
	out := map[string][]string{}
	for _, line := range strings.Split(strings.TrimSpace(body), "\n") {
		m := opsEntry.FindStringSubmatch(line)
		if m == nil {
			t.Fatalf("request-model.js opsByType: cannot read the line %q", strings.TrimSpace(line))
			return nil
		}
		var names []string
		for _, n := range opsName.FindAllStringSubmatch(m[2], -1) {
			names = append(names, n[1])
		}
		out[m[1]] = names
	}
	if len(out) == 0 {
		t.Fatalf("request-model.js opsByType: no entries found")
	}
	return out
}

// recorder is a reporter that remembers a fatal instead of stopping.
type recorder struct{ fatal string }

func (r *recorder) Helper() {}

func (r *recorder) Fatalf(format string, args ...any) {
	if r.fatal == "" {
		r.fatal = fmt.Sprintf(format, args...)
	}
}

func TestLimitLookupsFailLoudly(t *testing.T) {
	cases := []struct {
		name string
		run  func(*recorder)
	}{
		{"renamed constant", func(r *recorder) {
			number(r, "render-runner.js", "const MaxRunLength = 50;", `const MaxSequence = (\d+);`)
		}},
		{"two candidates", func(r *recorder) {
			number(r, "render-editor.js", "maxlength: 500,\nmaxlength: 120,", `maxlength: (\d+),`)
		}},
		{"opsByType renamed", func(r *recorder) {
			opsByType(r, "const operatorsByType = {\n  status: ['eq'],\n};")
		}},
		{"opsByType reshaped", func(r *recorder) {
			opsByType(r, "const opsByType = {\n  status: ops('eq'),\n};")
		}},
		{"missing file", func(r *recorder) {
			shipped(r, "js/no-such-module.js")
		}},
	}
	for _, c := range cases {
		r := &recorder{}
		c.run(r)
		if r.fatal == "" {
			t.Errorf("%s: the lookup passed silently", c.name)
		}
	}
}

// TestClientAssertionRulesMatchTheServer runs the page's own table of
// assertion cases (web/test/assertion-rules.test.mjs, where the node suite
// holds the page's checks to it) through sandbox.ValidateRequest: a case the
// table says the page refuses must be one the server refuses, and the other
// way round. The table is JSON between two marker lines.
func TestClientAssertionRulesMatchTheServer(t *testing.T) {
	src, err := os.ReadFile("test/assertion-rules.test.mjs")
	if err != nil {
		t.Fatalf("read the case table: %v", err)
	}
	block := regexp.MustCompile(`(?s)// cases:begin\nconst CASES = (\[.*?\]);\n// cases:end`).FindAllSubmatch(src, -1)
	if len(block) != 1 {
		t.Fatalf("assertion-rules.test.mjs: expected exactly one case table between the markers, found %d", len(block))
	}
	var cases []struct {
		Rule      string         `json:"rule"`
		Mirrors   string         `json:"mirrors"`
		Assertion map[string]any `json:"assertion"`
		Refused   bool           `json:"refused"`
		Fill      *struct {
			Key, Prefix, Unit string
			Count             int
		} `json:"fill"`
	}
	if err := json.Unmarshal(block[0][1], &cases); err != nil {
		t.Fatalf("the case table is not JSON: %v", err)
	}
	if len(cases) < 40 {
		t.Fatalf("the case table holds %d cases; it lost some", len(cases))
	}
	endpoints := sandbox.Endpoints()
	if len(endpoints) == 0 {
		t.Fatal("the sandbox catalog is empty")
	}
	for _, c := range cases {
		a := c.Assertion
		if c.Fill != nil {
			a[c.Fill.Key] = c.Fill.Prefix + strings.Repeat(c.Fill.Unit, c.Fill.Count)
		}
		wire, err := json.Marshal(map[string]any{"id": "r1", "endpoint": endpoints[0].ID, "assertions": []any{a}})
		if err != nil {
			t.Fatalf("%s: %v", c.Rule, err)
		}
		var r sandbox.Request
		if err := json.Unmarshal(wire, &r); err != nil {
			t.Fatalf("%s: %v", c.Rule, err)
		}
		_, err = sandbox.ValidateRequest(r)
		if refused := err != nil; refused != c.Refused {
			t.Errorf("%s (%s): the page says refused=%v, the server says refused=%v (%v)", c.Rule, c.Mirrors, c.Refused, refused, err)
		}
	}
}
