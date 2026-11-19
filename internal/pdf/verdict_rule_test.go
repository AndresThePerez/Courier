package pdf

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AndresThePerez/courier/internal/assert"
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
