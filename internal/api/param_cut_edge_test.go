package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/collections"
	"github.com/AndresThePerez/courier/internal/sandbox"
	"github.com/AndresThePerez/courier/internal/template"
)

// rawQueryTarget answers like the target and records the raw query string of
// every request it is sent, so a test sees what went on the wire before any
// decoding of its own.
func rawQueryTarget(t *testing.T) (string, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var got []string
	base := serveTarget(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = append(got, r.URL.RawQuery)
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

// sentParams decodes one raw query and checks every value is within both
// parameter limits and is the cut of the value written.
func sentParams(t *testing.T, label, raw string, written map[string]string) {
	t.Helper()
	q, err := url.ParseQuery(raw)
	if err != nil {
		t.Fatalf("%s: the target was sent a query that does not decode: %v", label, err)
	}
	for k, v := range written {
		got := q.Get(k)
		if got != sandbox.CutParamValue(v) {
			t.Errorf("%s: %s went out as %d characters, want the cut of the %d written", label, k, utf8.RuneCountInString(got), utf8.RuneCountInString(v))
		}
		if !utf8.ValidString(got) || utf8.RuneCountInString(got) > sandbox.MaxParamValueLen || wordCount(got) > sandbox.MaxParamWords {
			t.Errorf("%s: %s went out past the limits: %d characters, %d words", label, k, utf8.RuneCountInString(got), wordCount(got))
		}
	}
}

// Several parameters on one Send: each goes out as its own cut, percent-
// encoded so the target decodes exactly that, and truncated names exactly the
// parameters that changed.
func TestSendCutsEachOfSeveralParametersOnTheWire(t *testing.T) {
	base, sent := rawQueryTarget(t)
	s := newServer(t, base, nil)
	params := map[string]string{
		"q":      "\u3000" + joinWords(40, "pika&chu=+%", "\u00a0\t"),
		"set":    strings.Repeat("語", 257),
		"rarity": joinWords(32, "rare", "\r\n"),
		"series": strings.Repeat("e\u0301", 129),
		"types":  "fire\x00water",
	}
	req := sendable()
	req.Params = params
	rec := do(t, s, http.MethodPost, "/api/send", req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d %s, want 200", rec.Code, rec.Body.String())
	}
	got := decode[struct {
		Truncated []string `json:"truncated"`
	}](t, rec)
	if want := []string{"params.q", "params.series", "params.set"}; !slices.Equal(got.Truncated, want) {
		t.Errorf("truncated = %v, want %v", got.Truncated, want)
	}
	all := sent()
	if len(all) != 1 {
		t.Fatalf("the target was sent %d requests, want 1", len(all))
	}
	sentParams(t, "send", all[0], params)
}

// A run of several requests with several parameters names each cut in its
// 202 by sequence index, and each dispatch carries the cut values.
func TestARunCutsEachParameterOfEachRequestOnTheWire(t *testing.T) {
	base, sent := rawQueryTarget(t)
	s := newServer(t, base, nil)
	rr := payload(4, 0)
	rr.Sequence[0].Params = map[string]string{"q": "charizard", "set": strings.Repeat("x", 256)}
	rr.Sequence[1].Params = map[string]string{"q": joinWords(33, "a", "\u2003"), "set": strings.Repeat("x", 257)}
	rr.Sequence[2].Params = map[string]string{"q": strings.Repeat(" ", 300)}
	rr.Sequence[3].Endpoint = "suggest"
	rr.Sequence[3].Params = map[string]string{"q": joinWords(32, "abcdefg", " ") + " z"}
	rec := do(t, s, http.MethodPost, "/api/runs", rr)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d %s, want 202", rec.Code, rec.Body.String())
	}
	got := decode[struct {
		Truncated []string `json:"truncated"`
	}](t, rec)
	want := []string{"sequence[1].params.q", "sequence[1].params.set", "sequence[2].params.q", "sequence[3].params.q"}
	if !slices.Equal(got.Truncated, want) {
		t.Errorf("truncated = %v, want %v", got.Truncated, want)
	}
	waitIdle(t, s)
	all := sent()
	if len(all) != len(rr.Sequence) {
		t.Fatalf("the target was sent %d requests, want %d", len(all), len(rr.Sequence))
	}
	for i, raw := range all {
		sentParams(t, "sequence["+string(rune('0'+i))+"]", raw, rr.Sequence[i].Params)
	}
}

// Every curated request, sent through the real handler, goes out as written
// and reports nothing cut; a name and id of 120 characters are not cut either.
func TestEveryCuratedRequestGoesOutUncutThroughSend(t *testing.T) {
	base, sent := rawQueryTarget(t)
	s := newServer(t, base, nil)
	n := 0
	for _, c := range collections.All() {
		for i, r := range c.Requests {
			rec := do(t, s, http.MethodPost, "/api/send", r)
			if rec.Code != http.StatusOK {
				t.Errorf("%s request %d: status %d %s", c.ID, i, rec.Code, rec.Body.String())
				continue
			}
			if tr := decode[struct {
				Truncated []string `json:"truncated"`
			}](t, rec).Truncated; tr != nil {
				t.Errorf("%s request %d: truncated = %v, want nothing", c.ID, i, tr)
			}
			n++
			all := sent()
			q, _ := url.ParseQuery(all[len(all)-1])
			for k, v := range r.Params {
				// A placeholder goes out drawn; the template tests hold what it draws.
				if template.HasPlaceholder(map[string]string{k: v}) {
					continue
				}
				if q.Get(k) != v {
					t.Errorf("%s request %d: %s went out as %q, want %q", c.ID, i, k, q.Get(k), v)
				}
			}
		}
	}
	if n == 0 {
		t.Fatal("no curated request was sent")
	}
	req := sendable()
	req.ID, req.Name = strings.Repeat("語", 120), strings.Repeat("n", 120)
	rec := do(t, s, http.MethodPost, "/api/send", req)
	if tr := decode[struct {
		Truncated []string `json:"truncated"`
	}](t, rec).Truncated; rec.Code != http.StatusOK || tr != nil {
		t.Errorf("a name and id of 120 characters: status %d, truncated %v; want 200 and nothing cut", rec.Code, tr)
	}
}

// Assertion values and JSON paths of 257 to 500 characters go through Send
// as written, not cut and not refused.
func TestSendTakesAssertionTextFrom257To500(t *testing.T) {
	s := newServer(t, newTarget(t, 0), nil)
	for _, n := range []int{257, 500} {
		req := sendable()
		value := strings.Repeat("é", n)
		req.Assertions = []assert.Assertion{
			{Type: assert.TypeBodyContains, Op: "contains", Value: value},
			{Type: assert.TypeJSON, Path: "$." + strings.Repeat("p", n-2), Op: "exists"},
		}
		rec := do(t, s, http.MethodPost, "/api/send", req)
		if rec.Code != http.StatusOK {
			t.Fatalf("assertion text of %d characters: status %d %s, want 200", n, rec.Code, rec.Body.String())
		}
		var got struct {
			Truncated  []string         `json:"truncated"`
			Assertions []assert.Outcome `json:"assertions"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Truncated != nil || len(got.Assertions) != 2 {
			t.Errorf("assertion text of %d characters: truncated %v, %d outcomes; want nothing cut and 2 outcomes", n, got.Truncated, len(got.Assertions))
		}
	}
}

// Many Sends and Starts with long values at once: each answer is one the
// server documents, every accepted one reports its cut, and nothing reaches
// the target past either limit.
func TestManyLongSendsAndStartsAtOnceStayWithinTheLimits(t *testing.T) {
	base, sent := rawQueryTarget(t)
	s := newServer(t, base, nil)
	long := "\u3000" + joinWords(300, "pikachu", " \u00a0") + strings.Repeat("語", 400)
	var wg sync.WaitGroup
	var mu sync.Mutex
	codes := map[int]int{}
	for i := range 48 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var path string
			var body any
			if i%2 == 0 {
				req := sendable()
				req.Params = map[string]string{"q": long, "set": long}
				path, body = "/api/send", req
			} else {
				rr := payload(2, 0)
				rr.Sequence[1].Params = map[string]string{"q": long}
				path, body = "/api/runs", rr
			}
			r := do(t, s, http.MethodPost, path, body)
			mu.Lock()
			codes[r.Code]++
			mu.Unlock()
			switch r.Code {
			case http.StatusOK, http.StatusAccepted:
				var got struct {
					Truncated []string `json:"truncated"`
				}
				_ = json.Unmarshal(r.Body.Bytes(), &got)
				want := []string{"params.q", "params.set"}
				if path == "/api/runs" {
					want = []string{"sequence[1].params.q"}
				}
				if !slices.Equal(got.Truncated, want) {
					t.Errorf("%s: truncated = %v, want %v", path, got.Truncated, want)
				}
			case http.StatusConflict, http.StatusTooManyRequests, http.StatusServiceUnavailable:
			default:
				t.Errorf("%s: status %d %s", path, r.Code, r.Body.String())
			}
		}()
	}
	wg.Wait()
	waitFor(t, "the run to finish", func() bool { return !s.mgr.Status().Running })
	if codes[http.StatusOK]+codes[http.StatusAccepted] == 0 {
		t.Fatalf("no Send or Start was accepted: %v", codes)
	}
	for _, raw := range sent() {
		q, err := url.ParseQuery(raw)
		if err != nil {
			t.Fatalf("the target was sent a query that does not decode: %v", err)
		}
		for k := range q {
			v := q.Get(k)
			if !utf8.ValidString(v) || utf8.RuneCountInString(v) > sandbox.MaxParamValueLen || wordCount(v) > sandbox.MaxParamWords {
				t.Errorf("%s went out as %d characters and %d words", k, utf8.RuneCountInString(v), wordCount(v))
			}
		}
	}
}
