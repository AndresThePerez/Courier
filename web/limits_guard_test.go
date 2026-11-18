package web

import (
	"io/fs"
	"slices"
	"strings"
	"testing"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/sandbox"
)

// The limit lookups read source text, so the ways a source edit could slip a
// drifted copy past them are pinned here: a stale copy left behind in a
// comment, a reformatted constant, and a quote-style change inside opsByType.

func TestLimitLookupRefusesEditsThatHideADrift(t *testing.T) {
	cases := []struct {
		name, src, pattern string
	}{
		{"old value kept in a comment beside the new one",
			"// const MaxSequence = 50;\nconst MaxSequence = 49;", `const MaxSequence = (\d+);`},
		{"constant commented out and redeclared in a block comment",
			"/* const MaxAssertions = 10; */\nconst MaxAssertions = 10;", `const MaxAssertions = (\d+);`},
		{"spacing changed around the value",
			"const MaxSequence=50;", `const MaxSequence = (\d+);`},
		{"double-quoted maxlength in the page",
			`<input id="editor-name" maxlength='120'>`, `<input id="editor-name"[^>]*\smaxlength="(\d+)"`},
		{"Limits entry duplicated",
			"concurrency: { lo: 1, hi: 50, fallback: 10 },\nconcurrency: { lo: 1, hi: 49, fallback: 10 },",
			`\bconcurrency: \{ lo: (\d+), hi: (\d+), fallback: (\d+) \}`},
	}
	for _, c := range cases {
		r := &recorder{}
		numbers(r, "case", c.src, c.pattern)
		if r.fatal == "" {
			t.Errorf("%s: the lookup accepted it", c.name)
		}
	}
}

func TestLimitLookupReadsADriftedValue(t *testing.T) {
	r := &recorder{}
	got := number(r, "render-runner.js", "const MaxSequence = 49;", `const MaxSequence = (\d+);`)
	if r.fatal != "" {
		t.Fatalf("lookup failed: %s", r.fatal)
	}
	if got == sandbox.MaxSequence {
		t.Fatalf("a drifted MaxSequence read back as the server's value %v", got)
	}
}

func TestOpsByTypeQuoteChangeIsCaughtByTheBehaviouralCheck(t *testing.T) {
	r := &recorder{}
	offered := opsByType(r, "const opsByType = {\n  status: ['eq', \"neq\"],\n};")
	if r.fatal != "" {
		// Refusing the line outright is also a loud failure.
		return
	}
	listed := offered[assert.TypeStatus]
	if slices.Contains(listed, "neq") {
		return
	}
	// neq was dropped by the reader; the comparison must then flag it, which
	// it only does if the server accepts status neq.
	if err := assert.ValidateAssertion(sample(assert.TypeStatus, "neq")); err != nil {
		t.Fatalf("a double-quoted operator vanished and nothing would flag it: %v", err)
	}
}

func TestEmbeddedFilesExcludeTheTests(t *testing.T) {
	err := fs.WalkDir(Files, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == "test" || strings.HasPrefix(path, "test/") || strings.HasSuffix(path, ".mjs") {
			t.Errorf("%s is embedded in the binary", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
