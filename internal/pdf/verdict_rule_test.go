package pdf

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AndresThePerez/courier/internal/assert"
	"github.com/AndresThePerez/courier/internal/report"
)

// A run whose request was answered with nothing asserted prints the band a
// run with nothing asserted has always printed, not PASS; with an assertion
// it still prints PASS.
func TestAPrintedRunThatAssertedNothingIsNA(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"total":1}`)
	}))
	defer srv.Close()

	for _, tc := range []struct {
		name       string
		assertions []assert.Assertion
		band       string
	}{
		{"nothing asserted", nil, "VERDICT: N/A - nothing was asserted"},
		{"one assertion", []assert.Assertion{{Type: assert.TypeStatus, Op: "eq", Value: float64(200)}}, "VERDICT: PASS"},
	} {
		rep := runAgainst(t, srv.URL, tc.assertions)
		if r := rep.Functional.Results[0]; !r.Passed || r.Status != http.StatusOK {
			t.Fatalf("%s: the request was not answered: %+v", tc.name, r)
		}
		body := text(t, rep)
		if !strings.Contains(body, tc.band) {
			t.Errorf("%s: the page does not read %q", tc.name, tc.band)
		}
		if tc.assertions == nil && strings.Contains(body, "VERDICT: PASS") {
			t.Errorf("%s: the page reads VERDICT: PASS", tc.name)
		}
	}
}

// A row's result column says what the page's row says: an answered request
// with nothing asserted reads "no checks", not a PASS nobody earned; a row
// with assertions keeps PASS or FAIL, and a skipped row or one that got no
// response keeps what it printed before.
func TestARowThatAssertedNothingPrintsNoChecks(t *testing.T) {
	status := func(code int) []assert.Assertion {
		return []assert.Assertion{{Type: assert.TypeStatus, Op: "eq", Value: float64(code)}}
	}
	rep := &report.Report{
		ID: "r", Mode: "functional", Status: report.StatusCompleted, Target: "test-target",
		Functional: &report.Functional{Total: 5, Verdict: report.VerdictFail, Results: []report.RequestResult{
			{Index: 0, Name: "answered-nothing-asserted", Endpoint: "search", Status: 200, Passed: true, Assertions: []assert.Outcome{}},
			{Index: 1, Name: "answered-asserted", Endpoint: "search", Status: 200, Passed: true,
				Assertions: []assert.Outcome{{Assertion: status(200)[0], Passed: true, Expected: "200", Actual: "200"}}},
			{Index: 2, Name: "answered-failed", Endpoint: "search", Status: 500, Passed: false,
				Assertions: []assert.Outcome{{Assertion: status(200)[0], Passed: false, Expected: "200", Actual: "500"}}},
			{Index: 3, Name: "no-response", Endpoint: "search", Error: "could not connect to the target", ErrorKind: "connection", Assertions: []assert.Outcome{}},
			{Index: 4, Name: "skipped", Endpoint: "search", Skipped: true, Assertions: []assert.Outcome{}},
		}},
	}
	body := text(t, rep)
	want := []string{"(no checks)", "(PASS)", "(FAIL)", "(FAIL)", "(SKIP)"}
	var got []string
	for _, line := range strings.Split(body, "\n") {
		for _, w := range []string{"(no checks)", "(PASS)", "(FAIL)", "(SKIP)"} {
			if strings.Contains(line, w+" Tj") || strings.Contains(line, w+"Tj") {
				got = append(got, w)
			}
		}
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("result column reads %v, want %v", got, want)
	}
}
