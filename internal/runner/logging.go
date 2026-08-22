package runner

// Log event names.
//
// Every log line the engine writes carries an "event" attribute drawn from this
// list and a "run_id" wherever one exists, which is what makes the trail
// greppable: `jq 'select(.run_id=="run-20260822-141233-9f2a")'` returns one
// run's complete story, admission decision included.
//
// The four stream event names are reused deliberately — run_started means the
// same thing in the log as it does on the wire, and a second vocabulary for the
// same events would only invite them to drift apart. The names below are the
// ones with no stream counterpart: refusals and budget arithmetic are the
// server's business, not the browser's.
const (
	// EventRunRefused is a run rejected by the one-run lock.
	EventRunRefused = "run_refused"

	// EventRunCancelled is a visitor stopping the live run.
	EventRunCancelled = "run_cancelled"

	// EventRunPanicked is the guard rail firing. It should never appear; if it
	// does, the line carries the panic value and the run still finalized.
	EventRunPanicked = "run_panicked"

	// EventBudgetAdmitted and EventBudgetDenied are the load budget's two
	// answers, each carrying the requested cost and the balance it decided on.
	EventBudgetAdmitted = "budget_admitted"
	EventBudgetDenied   = "budget_denied"

	// EventBudgetCharged is the debit at the end of a run: what it actually
	// consumed, the balance either side of it, and the cooldown that bought.
	EventBudgetCharged = "budget_charged"
)
