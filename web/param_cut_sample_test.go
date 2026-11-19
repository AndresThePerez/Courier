package web

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// TestParamCutSampleIsTheServers runs every value of the sample in
// web/test/param-cut-sample.test.mjs through sandbox.CutParamValue: the
// number of characters each case says the server keeps must be what it
// keeps, and what it keeps must be a prefix of the value, so the node suite
// holds the page's cut to the server's own.
func TestParamCutSampleIsTheServers(t *testing.T) {
	src, err := os.ReadFile("test/param-cut-sample.test.mjs")
	if err != nil {
		t.Fatalf("read the sample: %v", err)
	}
	block := regexp.MustCompile(`(?s)// sample:begin\nconst SAMPLE = (\[.*?\]);\n// sample:end`).FindAllSubmatch(src, -1)
	if len(block) != 1 {
		t.Fatalf("param-cut-sample.test.mjs: expected exactly one sample between the markers, found %d", len(block))
	}
	var cases [][2]json.RawMessage
	if err := json.Unmarshal(block[0][1], &cases); err != nil {
		t.Fatalf("the sample is not JSON: %v", err)
	}
	if len(cases) < 300 {
		t.Fatalf("the sample holds %d cases; it lost some", len(cases))
	}
	cutSome := 0
	for i, c := range cases {
		var parts [][2]json.RawMessage
		var want int
		if err := json.Unmarshal(c[0], &parts); err != nil {
			t.Fatalf("case %d: parts: %v", i, err)
		}
		if err := json.Unmarshal(c[1], &want); err != nil {
			t.Fatalf("case %d: count: %v", i, err)
		}
		var b strings.Builder
		for _, p := range parts {
			var text string
			var count int
			if err := json.Unmarshal(p[0], &text); err != nil {
				t.Fatalf("case %d: a part's text: %v", i, err)
			}
			if err := json.Unmarshal(p[1], &count); err != nil {
				t.Fatalf("case %d: a part's count: %v", i, err)
			}
			b.WriteString(strings.Repeat(text, count))
		}
		in := b.String()
		got := sandbox.CutParamValue(in)
		if !strings.HasPrefix(in, got) {
			t.Errorf("case %d: the server's cut is not a prefix of the value", i)
		}
		if n := utf8.RuneCountInString(got); n != want {
			t.Errorf("case %d: the server keeps %d characters, the sample says %d", i, n, want)
		}
		if got != in {
			cutSome++
		}
	}
	if cutSome < 100 || cutSome == len(cases) {
		t.Errorf("%d of %d cases are cut; the sample should hold both kinds", cutSome, len(cases))
	}
}
