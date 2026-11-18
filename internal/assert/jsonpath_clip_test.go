package assert

import (
	"strings"
	"testing"
)

// A path error is shown to the visitor, so what it quotes is clipped: a path is
// capped at 500 characters before it gets here, but quoting escapes each
// control byte into four, which is still kilobytes of echo.
func TestPathErrorsClipThePathTheyQuote(t *testing.T) {
	ctl := strings.Repeat("\x01", 500)
	for _, path := range []string{
		ctl,                                  // does not start with $
		"$." + ctl + "..x",                   // empty field name
		"$." + ctl + "[",                     // unclosed [
		"$." + ctl + "[x]",                   // bad array index
		"$[0]" + ctl,                         // unexpected character
		"$[0]" + strings.Repeat("\x01", 498), // unexpected character, the byte itself
	} {
		err := ValidatePath(path)
		if err == nil {
			t.Fatalf("ValidatePath(%.40q) = nil, want an error", path)
		}
		if n := len(err.Error()); n > 400 {
			t.Errorf("ValidatePath(%.40q) error is %d bytes, want at most 400: %.120s", path, n, err.Error())
		}
	}
}

// A short path renders exactly as it always has.
func TestShortPathErrorsAreUnchanged(t *testing.T) {
	want := map[string]string{
		"results":      `path must start with $: "results"`,
		"$..name":      `empty field name in "$..name"`,
		"$.results[":   `unclosed [ in "$.results["`,
		"$.results[a]": `bad array index in "$.results[a]"`,
		"$[0]x":        `unexpected 'x' in "$[0]x"`,
	}
	for path, msg := range want {
		err := ValidatePath(path)
		if err == nil || err.Error() != msg {
			t.Errorf("ValidatePath(%q) = %v, want %s", path, err, msg)
		}
	}
}
