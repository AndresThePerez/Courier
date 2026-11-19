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
	"unicode"
	"unicode/utf8"

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
		{"request-model.js MaxAssertionText = sandbox.MaxAssertionTextLen (assertion path and string value)",
			number(t, "request-model.js", model, `const MaxAssertionText = (\d+);`), sandbox.MaxAssertionTextLen},
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
	opsEntry = regexp.MustCompile(`(?m)^\s*(\w+): \[([^\]]*)\],?\s*$`)
	opsName  = regexp.MustCompile(`'([^']*)'`)
)

func opsByType(t reporter, src string) map[string][]string {
	t.Helper()
	return matrix(t, "request-model.js", "opsByType", src)
}

// matrix reads one `const <name> = { type: ['op', ...], ... };` block out of
// a source file.
func matrix(t reporter, file, name, src string) map[string][]string {
	t.Helper()
	block := regexp.MustCompile(`(?s)const ` + regexp.QuoteMeta(name) + ` = \{(.*?)\n\};`)
	blocks := block.FindAllStringSubmatch(src, -1)
	if len(blocks) != 1 {
		t.Fatalf("%s: expected exactly one `const %s = {...};`, found %d - was it renamed or reshaped? Update this test with it", file, name, len(blocks))
		return nil
	}
	body := blocks[0][1]
	out := map[string][]string{}
	for _, line := range strings.Split(strings.TrimSpace(body), "\n") {
		m := opsEntry.FindStringSubmatch(line)
		if m == nil {
			t.Fatalf("%s %s: cannot read the line %q", file, name, strings.TrimSpace(line))
			return nil
		}
		var names []string
		for _, n := range opsName.FindAllStringSubmatch(m[2], -1) {
			names = append(names, n[1])
		}
		out[m[1]] = names
	}
	if len(out) == 0 {
		t.Fatalf("%s %s: no entries found", file, name)
	}
	return out
}

// TestStoredRequestRulesMatchTheEditorAndTheServer holds storage.js's own
// copy of the assertion matrix and of its three caps to the editor's and the
// server's. storage.js rebuilds every request read back from the run setup
// and saved collections, and drops an assertion whose operator its matrix
// lacks: a copy behind the editor's would lose a stored check on reload with
// nothing else failing. (It cannot import request-model.js, which imports it.)
func TestStoredRequestRulesMatchTheEditorAndTheServer(t *testing.T) {
	model := shipped(t, "js/request-model.js")
	store := shipped(t, "js/storage.js")
	for _, d := range storedMatrixDrift(t, model, store) {
		t.Error(d)
	}
	cases := []struct {
		name      string
		got, want float64
	}{
		{"storage.js MaxStoredAssertions = sandbox.MaxAssertions",
			number(t, "storage.js", store, `const MaxStoredAssertions = (\d+);`), sandbox.MaxAssertions},
		{"storage.js MaxParamValue = sandbox.MaxParamValueLen",
			number(t, "storage.js", store, `const MaxParamValue = (\d+);`), sandbox.MaxParamValueLen},
		{"storage.js MaxParamWords = sandbox.MaxParamWords",
			number(t, "storage.js", store, `const MaxParamWords = (\d+);`), sandbox.MaxParamWords},
		{"storage.js MaxName = sandbox.MaxNameLen",
			number(t, "storage.js", store, `const MaxName = (\d+);`), sandbox.MaxNameLen},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s: frontend has %v, server has %v", c.name, c.got, c.want)
		}
	}
}

// storedMatrixDrift lists every way storage.js's assertionOps differs from
// request-model.js's opsByType, which TestFrontendOperatorsMatchTheServer
// holds to the server.
func storedMatrixDrift(t reporter, model, store string) []string {
	t.Helper()
	editor := matrix(t, "request-model.js", "opsByType", model)
	stored := matrix(t, "storage.js", "assertionOps", store)
	var out []string
	for typ, ops := range editor {
		kept, ok := stored[typ]
		if !ok {
			out = append(out, fmt.Sprintf("storage.js assertionOps has no %q entry; a stored %s assertion is dropped on reload", typ, typ))
			continue
		}
		for _, op := range ops {
			if !slices.Contains(kept, op) {
				out = append(out, fmt.Sprintf("storage.js assertionOps lacks %s %q, which the editor offers; it is dropped on reload", typ, op))
			}
		}
		for _, op := range kept {
			if !slices.Contains(ops, op) {
				out = append(out, fmt.Sprintf("storage.js assertionOps keeps %s %q, which the editor does not offer", typ, op))
			}
		}
	}
	for typ := range stored {
		if _, ok := editor[typ]; !ok {
			out = append(out, fmt.Sprintf("storage.js assertionOps keeps type %q, which the editor does not offer", typ))
		}
	}
	slices.Sort(out)
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
	// The table's size today: a case that goes missing fails here, and a
	// case added raises this number with it.
	const tableSize = 48
	if len(cases) < tableSize {
		t.Fatalf("the case table holds %d cases, not %d; it lost some", len(cases), tableSize)
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

// TestPageParamCutMatchesTheServer runs the page's table of parameter cuts
// (web/test/param-cut.test.mjs, where the node suite holds storage.js's
// cutParamValue to it) through sandbox.CutParamValue: every case's expected
// value must be the server's, so the page and the server cut alike.
func TestPageParamCutMatchesTheServer(t *testing.T) {
	src, err := os.ReadFile("test/param-cut.test.mjs")
	if err != nil {
		t.Fatalf("read the case table: %v", err)
	}
	block := regexp.MustCompile(`(?s)// cases:begin\nconst CASES = (\[.*?\]);\n// cases:end`).FindAllSubmatch(src, -1)
	if len(block) != 1 {
		t.Fatalf("param-cut.test.mjs: expected exactly one case table between the markers, found %d", len(block))
	}
	var cases []struct {
		Rule  string               `json:"rule"`
		Input [][2]json.RawMessage `json:"input"`
		Want  [][2]json.RawMessage `json:"want"`
		Cut   bool                 `json:"cut"`
	}
	if err := json.Unmarshal(block[0][1], &cases); err != nil {
		t.Fatalf("the case table is not JSON: %v", err)
	}
	const tableSize = 40
	if len(cases) < tableSize {
		t.Fatalf("the case table holds %d cases, not %d; it lost some", len(cases), tableSize)
	}
	built := func(parts [][2]json.RawMessage) string {
		var b strings.Builder
		for _, p := range parts {
			var text string
			var count int
			if err := json.Unmarshal(p[0], &text); err != nil {
				t.Fatalf("a part's text is not a string: %v", err)
			}
			if err := json.Unmarshal(p[1], &count); err != nil {
				t.Fatalf("a part's count is not a number: %v", err)
			}
			b.WriteString(strings.Repeat(text, count))
		}
		return b.String()
	}
	for _, c := range cases {
		in, want := built(c.Input), built(c.Want)
		got := sandbox.CutParamValue(in)
		if got != want {
			t.Errorf("%s: the server sends %q (%d characters), the table says %q", c.Rule, clip(got), utf8.RuneCountInString(got), clip(want))
		}
		if (got != in) != c.Cut {
			t.Errorf("%s: the server cut=%v, the table says cut=%v", c.Rule, got != in, c.Cut)
		}
	}
}

func clip(s string) string {
	if r := []rune(s); len(r) > 40 {
		return string(r[:40]) + "..."
	}
	return s
}

// TestPageWhiteSpaceIsTheServers holds storage.js's white-space ranges, the
// characters that separate words in the parameter cut, to unicode.IsSpace
// over every code point.
func TestPageWhiteSpaceIsTheServers(t *testing.T) {
	ranges := spaceRanges(t, shipped(t, "js/storage.js"))
	in := func(r rune) bool {
		for _, rg := range ranges {
			if r >= rg[0] && r <= rg[1] {
				return true
			}
		}
		return false
	}
	for r := rune(0); r <= unicode.MaxRune; r++ {
		if in(r) != unicode.IsSpace(r) {
			t.Errorf("U+%04X: storage.js says white space %v, unicode.IsSpace says %v", r, in(r), unicode.IsSpace(r))
		}
	}
}

var (
	spaceBlock = regexp.MustCompile(`(?s)const Spaces = \[(.*?)\];`)
	spacePair  = regexp.MustCompile(`\[0x([0-9a-fA-F]+), 0x([0-9a-fA-F]+)\]`)
)

func spaceRanges(t reporter, src string) [][2]rune {
	t.Helper()
	blocks := spaceBlock.FindAllStringSubmatch(src, -1)
	if len(blocks) != 1 {
		t.Fatalf("storage.js: expected exactly one `const Spaces = [...];`, found %d", len(blocks))
		return nil
	}
	var out [][2]rune
	rest := blocks[0][1]
	for _, m := range spacePair.FindAllStringSubmatch(rest, -1) {
		lo, err1 := strconv.ParseInt(m[1], 16, 32)
		hi, err2 := strconv.ParseInt(m[2], 16, 32)
		if err1 != nil || err2 != nil || hi < lo {
			t.Fatalf("storage.js Spaces: cannot read %q", m[0])
			return nil
		}
		out = append(out, [2]rune{rune(lo), rune(hi)})
	}
	if strings.Trim(spacePair.ReplaceAllString(rest, ""), ", \n\t") != "" {
		t.Fatalf("storage.js Spaces: something other than [0x.., 0x..] pairs is listed")
	}
	if len(out) == 0 {
		t.Fatalf("storage.js Spaces: no ranges found")
	}
	return out
}
