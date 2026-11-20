package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// escapeSpot is one object of either payload: the body it sits in (one %s for
// the object), the field the check names inside it, its fields with a value
// each, and the payload type.
type escapeSpot struct {
	name, wrap, at string
	fields         [][2]string
	into           func() any
}

var escapeSpots = []escapeSpot{
	{"a send", "%s", "", [][2]string{
		{"id", `"r1"`}, {"name", `"n"`}, {"endpoint", `"search"`}, {"params", `{"q":"x"}`},
		{"assertions", `[{"type":"status","op":"eq","value":200}]`},
	}, func() any { return new(sandbox.Request) }},
	{"a send's assertion", `{"endpoint":"search","assertions":[%s]}`, "assertions[0]", [][2]string{
		{"type", `"json"`}, {"path", `"$.a"`}, {"op", `"eq"`}, {"value", `"v"`},
	}, func() any { return new(sandbox.Request) }},
	{"a run", "%s", "", [][2]string{
		{"mode", `"functional"`}, {"sequence", `[{"endpoint":"healthz"}]`}, {"options", `{"delay_ms":1}`},
	}, func() any { return new(sandbox.RunRequest) }},
	{"a run's options", `{"mode":"performance","sequence":[{"endpoint":"healthz"}],"options":%s}`, "options", [][2]string{
		{"stop_on_failure", `true`}, {"delay_ms", `5`}, {"concurrency", `2`}, {"duration_secs", `3`},
	}, func() any { return new(sandbox.RunRequest) }},
	{"a run's request", `{"mode":"functional","sequence":[%s]}`, "sequence[0]", [][2]string{
		{"id", `"r1"`}, {"name", `"n"`}, {"endpoint", `"search"`}, {"params", `{"q":"x"}`},
		{"assertions", `[{"type":"status","op":"eq","value":200}]`},
	}, func() any { return new(sandbox.RunRequest) }},
}

// object writes the spot's fields with key i spelled as spelled, and extra
// appended as written.
func (sp escapeSpot) object(i int, spelled, extra string) string {
	parts := make([]string, 0, len(sp.fields)+1)
	for j, f := range sp.fields {
		k := `"` + f[0] + `"`
		if j == i {
			k = spelled
		}
		parts = append(parts, k+":"+f[1])
	}
	if extra != "" {
		parts = append(parts, extra)
	}
	return fmt.Sprintf(sp.wrap, "{"+strings.Join(parts, ",")+"}")
}

func (sp escapeSpot) field(key string) string {
	if sp.at == "" {
		return key
	}
	return sp.at + "." + key
}

// escapedAt spells key with the character at position p as a \u escape in
// the given hex case.
func escapedAt(key string, p int, upper bool) string {
	esc := fmt.Sprintf(`\u%04x`, key[p])
	if upper {
		esc = fmt.Sprintf(`\u%04X`, key[p])
	}
	return `"` + key[:p] + esc + key[p+1:] + `"`
}

// checkInto runs body through the body check alone, into the spot's type.
func checkInto(t *testing.T, sp escapeSpot, body string) (any, verdict, string) {
	t.Helper()
	v := sp.into()
	rec := httptest.NewRecorder()
	if !decodeBody(rec, []byte(body), v) {
		eb := decode[errorBody](t, rec)
		return v, verdict{false, eb.Field}, eb.Error
	}
	return v, verdict{ok: true}, ""
}

// Every key of both payloads, at every level, spelled with each of its
// characters escaped in lower- and upper-case hex: the check accepts it and
// the value decoded is the one its plain spelling decodes to, as the standard
// decoder gives it; written beside its plain spelling, before or after, it is
// a duplicate refused at that field.
func TestEveryKeySpelledWithAnyOneCharacterEscapedIsThatKey(t *testing.T) {
	for _, sp := range escapeSpots {
		plain, v, _ := checkInto(t, sp, sp.object(-1, "", ""))
		if !v.ok {
			t.Fatalf("%s: the plain body is refused at %s", sp.name, v.field)
		}
		for i, f := range sp.fields {
			key := f[0]
			for p := range len(key) {
				for _, upper := range []bool{false, true} {
					spelled := escapedAt(key, p, upper)
					what := fmt.Sprintf("%s, %s", sp.name, spelled)
					if !bytes.Contains([]byte(spelled), []byte(`\u00`)) {
						t.Fatalf("%s: no escape written", what)
					}
					body := sp.object(i, spelled, "")
					got, v, msg := checkInto(t, sp, body)
					if !v.ok {
						t.Errorf("%s: refused at %s (%s), want accepted", what, v.field, msg)
						continue
					}
					if !reflect.DeepEqual(got, plain) {
						t.Errorf("%s: decoded %+v, want %+v", what, got, plain)
					}
					std := sp.into()
					if err := json.Unmarshal([]byte(body), std); err != nil || !reflect.DeepEqual(std, got) {
						t.Errorf("%s: the standard decoder gives %+v (%v), the check %+v", what, std, err, got)
					}

					for _, dup := range []string{
						sp.object(i, spelled, `"`+key+`":`+f[1]),
						sp.object(-1, "", spelled+":"+f[1]),
					} {
						_, v, msg := checkInto(t, sp, dup)
						if v.ok || v.field != sp.field(key) || !strings.Contains(msg, "duplicate") {
							t.Errorf("%s beside its plain spelling: %+v %q, want refused as a duplicate at %s", what, v, msg, sp.field(key))
						}
					}
				}
			}
		}
	}
}

// Keys that are not a field however they are escaped: a field name with one
// letter escaped as its upper case, as a lookalike (dotless i, long s, the
// Kelvin sign), with a surrogate pair or a lone surrogate added, are unknown
// fields, refused at the object that holds them, though the standard decoder
// folds some of them onto the field.
func TestAnEscapedKeyThatIsNotExactlyAFieldIsRefused(t *testing.T) {
	lookalike := map[byte]string{'i': `\u0131`, 's': `\u017f`, 'k': `\u212a`, 'K': `\u212A`}
	for _, sp := range escapeSpots {
		for i, f := range sp.fields {
			key := f[0]
			var forms []string
			for p := range len(key) {
				if c := key[p]; c >= 'a' && c <= 'z' {
					forms = append(forms, `"`+key[:p]+fmt.Sprintf(`\u%04x`, c-'a'+'A')+key[p+1:]+`"`)
				}
				if l, ok := lookalike[key[p]]; ok {
					forms = append(forms, `"`+key[:p]+l+key[p+1:]+`"`)
				}
			}
			forms = append(forms,
				`"`+key+`\ud83d\ude80"`, `"`+key+`\uD83D\uDE80"`, `"\ud800`+key+`"`, `"`+key+`\udfff"`,
				`"`+key+`\u0000"`, `"`+key[:len(key)-1]+`"`,
			)
			for _, spelled := range forms {
				what := fmt.Sprintf("%s, %s", sp.name, spelled)
				_, v, msg := checkInto(t, sp, sp.object(i, spelled, ""))
				want := sp.at
				if want == "" {
					want = "body"
				}
				if v.ok || v.field != want || !strings.Contains(msg, "unknown field") {
					t.Errorf("%s: %+v %q, want refused as an unknown field at %s", what, v, msg, want)
				}
			}
		}
	}
}

// A name whose 120th UTF-16 unit is the first half of a pair, as the page's
// restore leaves it, reaches the server as a lone surrogate escape: it is
// accepted, read as U+FFFD, and not reported as cut, since it is within the
// server's 120 characters.
func TestANameEndingInALoneHighSurrogateIsAcceptedWhole(t *testing.T) {
	name := strings.Repeat("a", 119) + `\ud83d`
	body := `{"endpoint":"search","name":"` + name + `"}`
	var req sandbox.Request
	rec := httptest.NewRecorder()
	if !decodeBody(rec, []byte(body), &req) {
		t.Fatalf("refused: %s", rec.Body.String())
	}
	if want := strings.Repeat("a", 119) + "\ufffd"; req.Name != want {
		t.Errorf("name = %q, want 119 letters and U+FFFD", req.Name)
	}
	if cut := sandbox.RequestTruncations(req); len(cut) != 0 {
		t.Errorf("reported cut: %v", cut)
	}
	clean, err := sandbox.ValidateRequest(req)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if clean.Name != req.Name {
		t.Errorf("validated name %q, want it unchanged", clean.Name)
	}
}
