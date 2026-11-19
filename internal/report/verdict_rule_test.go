package report

import (
	"testing"

	"github.com/AndresThePerez/courier/internal/assert"
)

// The whole functional verdict rule, case by case. A request that was
// answered but carried no assertion checks nothing, so a run made only of
// such requests is N/A rather than PASS.
func TestTheFunctionalVerdictRuleCaseByCase(t *testing.T) {
	checked := func(passed bool) []assert.Outcome { return []assert.Outcome{{Passed: passed}} }
	asserted := RequestResult{Status: 200, Passed: true, Assertions: checked(true)}
	failedAssertion := RequestResult{Status: 500, Assertions: checked(false)}
	answered := RequestResult{Status: 200, Passed: true, Assertions: []assert.Outcome{}}
	answeredNil := RequestResult{Status: 200, Passed: true}
	noResponse := RequestResult{Error: "could not connect to the target", ErrorKind: KindConnection, Assertions: []assert.Outcome{}}
	cutOff := RequestResult{Status: 200, Error: "the connection dropped while reading the response", Assertions: []assert.Outcome{}}
	skipped := RequestResult{Skipped: true, Assertions: []assert.Outcome{}}
	// A skipped row never had its assertions evaluated, whatever it lists.
	skippedListing := RequestResult{Skipped: true, Assertions: checked(true)}

	for _, tc := range []struct {
		name    string
		status  string
		results []RequestResult
		want    string
	}{
		{"every assertion passed", StatusCompleted, []RequestResult{asserted, asserted}, VerdictPass},
		{"an assertion failed", StatusCompleted, []RequestResult{asserted, failedAssertion}, VerdictFail},
		{"nothing asserted, every request answered", StatusCompleted, []RequestResult{answered, answeredNil, answered}, VerdictNA},
		{"nothing asserted, one request", StatusCompleted, []RequestResult{answered}, VerdictNA},
		{"nothing asserted, a request got no response", StatusCompleted, []RequestResult{answered, noResponse}, VerdictFail},
		{"nothing asserted, a response cut off", StatusCompleted, []RequestResult{cutOff, answered}, VerdictFail},
		{"some asserted and passed, some not", StatusCompleted, []RequestResult{answered, asserted, answered}, VerdictPass},
		{"some asserted and failed, some not", StatusCompleted, []RequestResult{answered, failedAssertion}, VerdictFail},
		{"asserted and passed, then skipped", StatusCompleted, []RequestResult{asserted, skipped}, VerdictPass},
		{"nothing asserted, then skipped", StatusCompleted, []RequestResult{answered, skipped}, VerdictNA},
		{"nothing asserted but a skipped row lists assertions", StatusCompleted, []RequestResult{answered, skippedListing}, VerdictNA},
		{"every entry skipped", StatusCompleted, []RequestResult{skipped, skipped}, VerdictNA},
		{"no entries", StatusCompleted, nil, VerdictNA},
		{"cancelled after a pass", StatusCancelled, []RequestResult{asserted, skipped}, VerdictNA},
		{"cancelled after a failure", StatusCancelled, []RequestResult{failedAssertion, skipped}, VerdictNA},
		{"expired after a pass", StatusExpired, []RequestResult{asserted, skipped}, VerdictNA},
		{"expired with nothing asserted", StatusExpired, []RequestResult{answered, skipped}, VerdictNA},
	} {
		if got := FunctionalVerdict(tc.status, &Functional{Results: tc.results}); got != tc.want {
			t.Errorf("%s (%s): FunctionalVerdict = %q, want %q", tc.name, tc.status, got, tc.want)
		}
	}
}
