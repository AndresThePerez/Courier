package api

import (
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/sandbox"
)

// queryTarget answers every request like the target and records each q it
// is sent.
func queryTarget(t *testing.T) (string, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var got []string
	base := serveTarget(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = append(got, r.URL.Query().Get("q"))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"total":107,"results":[]}`)
	})
	return base, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(got)
	}
}

func joinWords(n int, w, sep string) string {
	return strings.Join(slices.Repeat([]string{w}, n), sep)
}

// A Send whose q holds more words than the target takes goes out with the
// first 32, and says so in its 200, as a cut by length does.
func TestSendCutsAParameterToItsFirst32Words(t *testing.T) {
	base, sent := queryTarget(t)
	s := newServer(t, base, nil)
	for _, tc := range []struct {
		q, want string
		cut     bool
	}{
		{joinWords(32, "pikachu", " "), joinWords(32, "pikachu", " "), false},
		{joinWords(33, "pikachu", " "), joinWords(32, "pikachu", " "), true},
		{joinWords(33, "w", "\u3000"), joinWords(32, "w", "\u3000"), true},
		{strings.Repeat("é", 257), strings.Repeat("é", 256), true},
	} {
		req := sendable()
		req.Params = map[string]string{"q": tc.q}
		rec := do(t, s, http.MethodPost, "/api/send", req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d %s, want 200", rec.Code, rec.Body.String())
		}
		var got struct {
			Truncated []string `json:"truncated"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if want := map[bool][]string{true: {"params.q"}}[tc.cut]; !slices.Equal(got.Truncated, want) {
			t.Errorf("%d words, %d characters: truncated = %v, want %v", wordCount(tc.q), utf8.RuneCountInString(tc.q), got.Truncated, want)
		}
		all := sent()
		if q := all[len(all)-1]; q != tc.want {
			t.Errorf("%d words, %d characters: the target was sent %d words and %d characters, want %d and %d",
				wordCount(tc.q), utf8.RuneCountInString(tc.q), wordCount(q), utf8.RuneCountInString(q), wordCount(tc.want), utf8.RuneCountInString(tc.want))
		}
	}
}

func wordCount(s string) int { return len(strings.FieldsFunc(s, unicode.IsSpace)) }

// A run's 202 names each request whose q was cut by words, and the target is
// sent the cut value.
func TestARunCutsAParameterToItsFirst32Words(t *testing.T) {
	base, sent := queryTarget(t)
	s := newServer(t, base, nil)
	rr := payload(3, 0)
	rr.Sequence[0].Params = map[string]string{"q": joinWords(32, "eevee", " ")}
	rr.Sequence[1].Params = map[string]string{"q": joinWords(40, "eevee", "\t")}
	rr.Sequence[2].Params = map[string]string{"q": "  charizard  "}
	rec := do(t, s, http.MethodPost, "/api/runs", rr)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d %s, want 202", rec.Code, rec.Body.String())
	}
	var got struct {
		Truncated []string `json:"truncated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if want := []string{"sequence[1].params.q"}; !slices.Equal(got.Truncated, want) {
		t.Errorf("truncated = %v, want %v", got.Truncated, want)
	}
	waitIdle(t, s)
	want := []string{joinWords(32, "eevee", " "), joinWords(32, "eevee", "\t"), "  charizard  "}
	if q := sent(); !slices.Equal(q, want) {
		t.Errorf("the target was sent %q, want %q", q, want)
	}
	if sandbox.MaxParamWords != 32 {
		t.Errorf("MaxParamWords = %d, want 32", sandbox.MaxParamWords)
	}
}
