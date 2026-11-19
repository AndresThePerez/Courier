# Deviations

A running log of the places where this implementation intentionally departs
from its original design, and why. Each entry is numbered, append-only, and
kept so a decision never has to be rediscovered the hard way.

---

## N1 — Dev target port is 8081, not 8085 (Task 1, Task 21)

**Plan says:** "Local environment facts" documents the local Pokesearch target on
`APP_PORT=8085`, brought up with `docker compose up -d` from the Pokesearch checkout.

**What we do instead:** the documented dev target is `http://127.0.0.1:8081`, and
`docker compose` is never run from the Pokesearch checkout.

**Why:** parallel sessions share this workstation. Another session's live containers are
keyed to that compose project directory, so `docker compose up` there would recreate
them mid-build. A shared dev target is already running on 8081. Port 9201 (another
session's scratch Elasticsearch) is also off limits. Courier's own dev port stays 8084.

**Affects:** `cmd/server/main.go` (`TARGET_URL` default), `internal/api/server_test.go`,
`README.md`. `TARGET_URL` is an environment variable, so production is unaffected —
only the documented default moved.

---

## N2 — Pokesearch Milestone 3 contract, not the live server's behaviour (Tasks 4, 5, 13)

**Plan says:** "Verified facts" #1 — the `/api/search` allowlist is exactly 13 keys and
there is no `page_size` param; #4 — "Pokesearch never returns 4xx", so the edge-case
collection asserts graceful degradation rather than 400s.

**What we do instead:** the catalog encodes the Milestone 3 contract, which adds
`page_size` to the search allowlist. Milestone 3 is on branch `milestone-3` and is **not
deployed** — the live public server still serves the old, lenient build.

**Why:** the parallel Pokesearch work changes the contract Courier is written against,
and the decision recorded at the time is to encode the new contract rather than the live
server's current behaviour. Error-case behaviour must **not** be verified against the
live server; it would still answer with the old build.

**The Milestone 3 contract, as handed to us:**

- Strict params — `sort`, `order`, `supertype`, and non-integer `hp_min` / `hp_max` /
  `page` / `page_size` — now return `400` with
  `{"error":{"code":"invalid_param","field":"...","message":"..."},"request_id":"..."}`.
- Comma-list members (`types`, `rarity`, `series`) and unknown keys stay lenient/dropped.
- `503` uses the same structured body with code `es_unavailable`.
- `page_size`: 1–100, default 24, strict-validated. Browse `pages` stays exactly 400 at
  the default page size; `page` clamps 1–400 at the default size.
- Search response gains additive fields: `page_size`, `matched`, `highlights`,
  `did_you_mean`.
- Frozen fixture anchors, unchanged: totals, counts, `facets.sets` = 173, suggest ≤ 8,
  `/healthz` shape.

**Still open (Task 13's problem, not ours):** the "05 — Error Handling & Edge Cases"
collection must assert the new 400 contract for strict params while still asserting
graceful degradation for the lenient ones. The plan's blanket "must not assert 400s" no
longer holds.

---

## N3 — The param allowlist is data, in exactly one place (Task 4)

**Plan says:** `catalog_test.go` pins the search allowlist with `slices.Equal` against a
hardcoded 13-key list and asserts `page_size` is rejected.

**What we do instead:** `endpoints` in `internal/sandbox/catalog.go` is the single source
of truth. The tests assert *properties* — every required key is present, forbidden keys
are absent, and no key outside the known Pokesearch contract has crept in — and never
assert a key count.

**Why:** match highlighting may become opt-in via a `highlight=1` param, which would take
the search allowlist from 14 keys to 15. Adding a key must mean editing `catalog.go` and
nothing else. A count assertion (or an exact-list assertion duplicated in a test) is a
second source of truth that turns a one-line contract change into a two-line one, and the
plan's `13` is already stale.

The subset guard (`knownSearchParams`) still catches a garbage key being added by
accident, which is the safety property the exact-list assertion was really there for.

---

## N4 — New Milestone 3 endpoints are deliberately not in the catalog yet (Task 4)

Milestone 3 adds `/livez`, `/api/meta`, `/api/stats`, and `/api/explain`. None are in the
catalog. Their parameter allowlists have not been documented to us, and the catalog is a
security boundary — guessing an allowlist is exactly the kind of invention it exists to
prevent. Adding them is a few lines in `catalog.go` once their param contracts are known;
`Endpoints()` is ordered, so append rather than insert to keep the UI stable.

---

## N5 — `$[0]x` needed a parse-then-walk JSON path (Task 2)

The plan's reference `Lookup` walks and validates in one pass, so a path whose *traversal*
misses before its syntax error is reached returns `found=false, err=nil` instead of the
path error its own test demands — `$[0]x` against an object document is the case that
fails. `jsonpath.go` therefore parses the whole path into segments first (`parsePath`,
pure syntax, no document) and walks second. Same grammar, same behaviour everywhere else,
and it gives `ValidateAssertion` a document-free `ValidatePath` to call, which is cleaner
than the plan's `Lookup(nil, path)` trick.

---

## N6 — `Percentiles` and `SLALadder` got snake_case JSON tags (Task 6)

The plan's interface block declares `type Percentiles struct{ Min, Avg, P50, P90, P95,
P99, Max float64 }` and `type SLALadder struct{ Under25, Under50, Under100 float64 }`
with no struct tags, which would serialize as `"Min"`, `"P50"`, `"Under25"` — the only
Go-cased keys in an otherwise entirely snake_case wire format. Read as an omission
rather than a decision, so both types now carry tags (`min`, `p50`, `under_25`, ...).

**Agent 4 (frontend) and agent 5 (PDF): read these keys as snake_case.** Nothing had been
written against the untagged form when this changed.

`Functional`'s `Total, Passed, Failed, Skipped` keep the plan's explicit `json:"-"` —
that tag was typed deliberately, so it stands. The counts are derivable from `Results`,
and server-side consumers read them off the struct. A frontend showing "12 passed /
3 failed" counts the `results` array itself.

---

## N7 — `Verdict` fails a run with no dispatches (Task 6)

The plan specifies `Verdict` as a pure PASS/FAIL function of p95 and error rate, and does
not say what an empty run returns. Taken literally it would PASS: p95 of nothing is 0,
which is under 50ms, and an error rate of 0/0 is 0. Returning a green verdict for a run
that measured nothing is exactly the unfalsifiable-verdict failure mode the Revision 2
SLO recalibration exists to kill, so `Verdict` returns FAIL with the reason "no dispatches
completed — there is nothing to judge".

This is unreachable in practice — a run that dispatched nothing is `cancelled` or
`expired`, and the assembler overrides those to `N/A` before anyone sees a verdict. It is
a guard, not a code path. `Verdict` still returns only PASS or FAIL; `N/A` remains the
assembler's job, as specified.

---

## N8 — `body_contains` reads a body folded once by `NewTarget` (Tasks 3, 34)

The Task 34 benchmarks showed `body_contains` case-folding the whole response on every
evaluation: ~96 µs and ~82 KB allocated per assertion on a 36KB search response, twenty
times over for a request at the assertion cap.

`Target` now carries an unexported `lowerBody`, folded once by `NewTarget`, the same way
`Doc` is decoded once. `body_contains` drops to 284 ns and 72 B; `NewTarget` rises by
~89 µs.

It is a trade, not a free win: a request with no `body_contains` assertion pays for a
fold it never reads. It is worth it because it bounds the worst case (~1.9 ms and 1.6 MB
becomes ~89 µs and ~82 KB), and because both numbers are noise beside the 1–30 ms the
response took to arrive. Performance mode never touches this path.

`foldedBody()` falls back to folding on the spot, so a `Target` built as a bare struct
literal rather than through `NewTarget` still behaves correctly — covered by
`TestBodyContainsWithoutNewTarget`.

---

## N9 — CI's docker-build job is a no-op until the Dockerfile exists (Task 32)

Addendum Task 32 asks for `docker build` in CI, and its acceptance criterion is a green
run on the scaffold commit. The Dockerfile does not arrive until Phase 7 (Task 22), so
the `docker` job detects the file and skips the build with a GitHub notice when it is
absent. It starts exercising the real multi-stage build the moment the file lands, with
no workflow edit needed.

The workflow cannot run at all yet: there is no remote, and pushing needs Andres's
explicit approval. It is written to be correct on the day the repo is pushed.

---

## N10 — The cooldown is the spec's load budget, not the plan's flat 10s (Tasks 9, 10, 28)

**Plan says:** Task 10's interface block declares `const Cooldown = 10 * time.Second`
and `Start` returns `ErrCoolingDown` when `time.Now().Before(m.cooldownUntil)`.

**What we do instead:** `internal/budget` implements the Design Spec Revision 2.2 load
budget — a token bucket in worker-seconds (refill `R` = 5/s, burst `B` = 1500, floor 5s) —
and the cooldown falls out of it: `cooldown = max(5s, -min(balance, 0) / R)`. There is no
`runner.Cooldown` constant; `budget.MinCooldown` is the floor and `Manager.Start` refuses
with `*CooldownError{Until}` (which unwraps to `ErrCoolingDown`).

**Why:** the spec is authoritative for design questions, and its Revision 2.2 replaced the
flat cooldown outright. A flat cooldown bounds concurrent load but not sustained load — a
script could hold the target at a ~75% duty cycle forever. Addendum Task 28 also asks for
a simulator "against the real budget implementation (not a model of it)", which
presupposes the budget exists. Agent 1's handoff note listing "Cooldown 10s" as a runner
lifecycle constant predates that reading.

**Affects:** anything that expected `runner.Cooldown`. The API layer should read
`Manager.Status().CooldownUntil` and `errors.As` for `*runner.CooldownError`.

### N10a — Refill is continuous, including while a run is in flight

The spec's worked examples say a 50x30s run from an **empty** bucket "yields a 300s
cooldown" and a stalled 2,000 worker-second run "cools ~400s". Those figures are
`cost / R` with the refill accrued *during* the run ignored. Implemented as a real token
bucket — refill accrues continuously — the same runs cool for **270s** and **360s**: the
run itself earns `R x duration` back before the debit lands.

The equation the spec writes down (`cooldown = max(5s, -min(balance,0)/R)`, `balance <= B`)
is implemented exactly; it is only the two arithmetic examples that assumed no in-run
refill. Continuous refill is also the reading that makes the spec's headline claim true:
the third review pass says every adversarial shape "converges to exactly `R` = 5
worker-seconds/second, with a 10.0% duty cycle". Under a no-in-run-refill model the
maximum-run shape converges to 4.55, not 5.0. `budget_sim_test.go` measures 5.016 w-s/s
and a 10.03% duty cycle, which matches the spec's claim to three figures.

Both spec examples should be corrected to 270s and 360s when the spec is next touched.
The behavioural difference is small and in the safe direction for the visitor (shorter
waits), and the bound is unchanged.

## N11 — The modes return a `Result`, not a bare payload (Tasks 8, 9, 10)

**Plan says:** `func RunFunctional(...) *report.Functional` and
`func RunPerformance(...) *report.Performance`.

**What we do instead:** both return `runner.Result{Status, Functional, Performance}`.

**Why:** only the mode knows whether it stopped because it was done, because it was
cancelled, or because it ran out of wall clock, and `report.Status` is spec-level metadata
that three consumers depend on (the polling loop's stop condition, the history label, the
results header). Returning it out of band — inferring it in the manager from elapsed time,
or smuggling it through an event payload — would make the manager guess at something the
runner already knows. The single struct also gives `Manager.run` one signature to inject
against, which is what the panic test needs.

## N12 — `run_finished` is emitted by the manager, not by the modes (Tasks 8, 9, 10)

**Plan says:** "Emit `run_started` before the walk and `run_finished` after."

**What we do instead:** the modes emit `run_started`, `request_result`, and `progress`.
The **manager** emits `run_finished`, after the report is stamped, stored, and charged to
the budget.

**Why:** a client that reacts to `run_finished` by fetching `GET /api/runs/{id}` would
otherwise race finalization and could read `status: running` from a run it was just told
had finished. `TestRunFinishedIsPublishedAfterTheReportIsStored` pins this. The payload
(`runner.RunFinished`) also carries `cooldown_until`, which only the manager knows.

## N13 — `NewManager` takes a `*slog.Logger`; `Event` carries a `RunID` (Tasks 10, 30)

`NewManager(ex, targetDisplay, pub, log)` has a fourth parameter the plan's interface block
does not list. Addendum Task 30 requires "one logger passed explicitly (no globals)", and
the manager is where the run lifecycle lives, so that is where it has to arrive. A nil
logger is accepted and discarded, so tests and Phase 4 can pass nothing.

`runner.Event` likewise gains `RunID string \`json:"run_id,omitempty"\``. The modes do not
know their run's identity; the manager's emitter stamps it. Carrying it on the envelope
rather than inside each `Data` shape means a spectator attaching mid-run can attribute a
replayed event without type-switching on the payload.

**Note on task boundaries:** Task 30's *emission sites* landed in the Task 10 commit,
because writing the manager without its log lines and then threading them back through
every exit path would have been two edits to the same twenty lines. The Task 30 commit
carries the JSON handler wiring in `cmd/server/main.go`, the assertions, and the guard
test.

## N14 — Abort classification checks the unwrapped error as well as `context.Cause` (Task 7)

The spec prescribes `context.WithCancelCause` plus a sentinel, classified via
`context.Cause`. In practice `net/http` unwraps the request context's cause into the
returned `*url.Error`, so `errors.Is(err, context.Canceled)` is **false** on an aborted
dispatch — the error is `ErrRunAborted` directly. `classify` therefore tests both shapes:
`errors.Is(err, ErrRunAborted)` first, then the `context.Canceled` + `context.Cause` pair.

Which shape surfaces is a net/http implementation detail; the accounting rule that rests
on the discriminator is not, so both are covered.
`TestDoDoesNotClaimForeignCancellationsAsAborts` pins the other direction — a bare
`context.WithCancel` from somewhere else must never be laundered into an abort.

## N15 — A panicking run finalizes as `cancelled`; an aborted functional entry is `skipped`

The plan says a panicking run should "mark the report failed", but the status vocabulary is
`running | completed | cancelled | expired` and there is no failed. A panicked run did not
complete, so it finalizes as `cancelled` with a `Note` that says an internal error stopped
it. Adding a fifth status for a should-never-happen path would have put a case into three
frontend switches to describe a bug.

Similarly, in functional mode a dispatch killed by Courier's own abort is recorded
`Skipped: true`, not failed. Counting it as a failure would let a visitor pressing Cancel
manufacture a red row the target never earned — the same reasoning as the `aborted`
dispatch category in performance mode. `Passed + Failed + Skipped` still equals `Total`.

Performance mode never produces `expired`: reaching `duration_secs` *is* completion there.
`expired` is functional-mode-only, where the 120s deadline is a safety net rather than the
point of the run.

## N16 — Executor gained `DoResolved` and `CloseIdleConnections` (Tasks 7, 9)

`sandbox.Lookup` returns a deep copy, so a run resolves its sequence once
(`runner.resolve`) and dispatches through `DoResolved(ctx, ep, req, keepBody)`. `Do` still
exists and resolves per call — it is the right shape for `/api/send`, and for the plan's
own tests.

`CloseIdleConnections` exists because the plan's goroutine-leak test cannot pass without
it: a 50-worker run leaves ~50 pooled keep-alive connections, each holding a transport
read/write goroutine pair, so `runtime.NumGoroutine()` reads ~100 above baseline for a full
`IdleConnTimeout` afterwards. That is the connection pool doing exactly what it was tuned
to do. The test releases the pool first and then polls for the count to settle, so it still
catches a real leak in the worker pool or the aggregator. Graceful shutdown should call it
too.

## N17 — Measured engine overhead (Task 34's deferred item)

Task 34 asked for "a measured per-dispatch engine overhead figure (µs/request) once Task 9
exists". `internal/runner/bench_test.go` provides it, on the 5800X against a loopback
`httptest` server returning a 38KB body:

| Benchmark | ns/op | B/op | allocs/op |
|---|---|---|---|
| `DispatchBaseline` (bare `http.Client`) | 74,545 | 48,716 | 82 |
| `DispatchDrain` (perf mode) | 76,316 | 49,719 | 93 |
| `DispatchKeepBody` (functional mode) | 97,519 | 140,198 | 111 |
| `URLBuild` | 458 | 296 | 10 |
| `AggregatorRecord` | 115 | 81 | 0 |

**Engine overhead is ~1.8 µs per dispatch** — the difference between `DispatchDrain` and
`DispatchBaseline`, or about 0.007% of the 25ms a real request takes at 50 workers. That
is the number the README's "the hot path stays lean" claim should quote. The fan-in
aggregator costs 115 ns per result, so at the measured peak of 1,817 req/s it uses ~0.02%
of one core — which is what justifies it being a single goroutine with no locks at all.

## N18 — `sse.New` takes a logger, and `SubscribeReplay` is one call (Task 11)

**Plan says:** `func New() *Broadcaster`, plus separate `Replay()` and `Subscribe()`.

**What we do instead:** `New(log *slog.Logger)` (nil accepted and discarded, same
contract as `NewManager`), and `SubscribeReplay() ([]Event, <-chan Event, func(), error)`
alongside the plan's `Subscribe`/`Replay`.

**Why:** Addendum Task 30 lists SSE subscriber connect/disconnect in the log trail, and
the broadcaster is where subscribers live — so that is where the logger has to arrive.
Every line carries `event` + `run_id` + `subscribers`, and a disconnect carries `reason`
(`client_closed` vs `slow_subscriber`), which is the distinction that makes the trail
worth having.

`SubscribeReplay` exists because doing the two separately is a real bug, not a tidiness
point: an event published between `Replay()` and `Subscribe()` lands in *both*, and the
viewer renders a duplicate result row no run ever produced. The handler uses the combined
call; the split ones stay for tests and for any caller that only wants one half.

There is no `Broadcaster.Close`. Shutdown releases stream handlers through the API
server's own `done` channel (see N19), which is the thing that actually has to unblock
`http.Server.Shutdown`.

## N19 — `runner.NewManagerAt` and `api.Options.Now` (Tasks 12, 14)

The budget's 5s cooldown floor is real time. `internal/runner`'s own tests inject a clock
by setting the unexported `m.now`, which a test in `internal/api` cannot do — so a handler
test wanting three runs in history would have to sleep 10+ seconds.

`NewManagerAt(ex, target, pub, log, now)` is `NewManager` with the clock passed in (nil
means `time.Now`, and `NewManager` now delegates to it). `api.Options.Now` threads it
through; production leaves it nil. The manager and its bucket still read the *same*
source — that is the whole point of `m.clock`, and it is the only place either is set.

`api.Options` also gained `Logger`, and `Server` gained `Close(ctx) error` and a
`Manager()` accessor. `Close` cancels the run context, releases the SSE handlers, waits
for the engine (bounded by ctx), and drops the idle connection pool.

## N20 — `/api/send` uses `budget.Debit`, not `budget.Spend` (Task 14)

**Spec says:** "`/api/send` debits the same bucket ... a send's debit simply lengthens the
next run's cooldown."

**Problem:** `Spend` sets `cooldownUntil = now + max(floor, deficit/R)` unconditionally, so
routing sends through it would put the Start button into a 5-second countdown every time a
visitor pressed Send in the editor. That is a rate limit the design does not ask for — the
one-in-flight rule already caps that path at one worker-second per second.

**What we do instead:** `Bucket.Debit(workerSeconds)` charges the balance without opening a
cooldown window; `Spend` keeps the floor and both now share one `debit` core. The load
bound is unchanged and this is the spec's own reading of it: the send lowers the balance,
so the *next run's* `Spend` computes a longer cooldown from it, and total load still
converges on `R`.

## N21 — `runner.bodyPreview` is now exported as `runner.Preview` (Tasks 7, 14)

`/api/send` returns a response body to the editor and must truncate it exactly the way a
functional run does — one truncation rule, everywhere, including the partial-rune backoff.
The helper is exported rather than reimplemented; `functional.go` is otherwise unchanged.

## N22 — SSE wire details the plan and the spec disagree on (Task 12)

Where they conflict, the spec (Revision 2.1) wins, because it was written after the plan's
Task 12 prose:

- **Heartbeat is 2s**, not the plan's "`: ping` every 15s". The client's fallback trigger is
  "no bytes for 5s", so a 15s heartbeat would guarantee a false fallback on any quiet run.
- **Over the subscriber cap the handler answers `503 {"poll": true}`** (spec), which the
  client treats as an immediate fallback trigger and does not retry, rather than the plan's
  unspecified "tell the client to poll".
- **The terminal event is `run_finished`**, not a separate `done` (see N12). It is the
  spec's terminal event under the name the engine already publishes.

Three things the plan leaves undefined, decided here:

1. **Every frame carries both.** `event: <type>` *and* a `data:` payload that is the whole
   `runner.Event` envelope (`type`, `run_id`, `data`). A client may use
   `addEventListener(type)` or one handler switching on `type`; neither costs the other
   anything, and `json.Marshal` never emits a raw newline so one `data:` line always suffices.
2. **The stream stays open after `run_finished`.** Closing it would make `EventSource`
   reconnect ~3s later, replay the log, and see the same terminal event — a reconnect loop
   for any tab left open. The frontend closes it on `run_finished`; until then it costs one
   parked handler and a 2s heartbeat.
3. **A finished run whose events the broadcaster has moved past gets a synthesized
   `run_finished`** built from the stored report, then the stream closes. An empty stream
   would leave the client unable to tell "finished" from "died" — the exact distinction the
   polling fallback exists to make.

Events are also filtered by `run_id`, so a stream opened for run A never renders run B's
events if the broadcaster is reset underneath it.

## N23 — Curated collections follow Addendum A2, and the error collection is rewritten (Task 13)

**Plan says:** six collections, 30-40 requests, and a `05 - Error Handling & Edge Cases`
that asserts "graceful degradation, never 400s".

**What we do instead:** **four collections, 18 requests** (A2: 15-18 across 3-4), and the
error collection asserts the **Pokesearch M3 contract in both directions**. The plan's own
test — `len(all) != 6`, `total < 30 || total > 40` — is replaced by the A2 bounds; keeping
it would have failed the amendment it was written before.

| File | ID | Requests |
|---|---|---|
| `01-search-basics.json` | `search-basics` | 5 |
| `02-search-filters.json` | `search-filters` | 4 |
| `03-suggest-health.json` | `suggest-health` | 4 |
| `04-error-handling.json` | `error-handling` | 5 |

Three judgement calls inside the error collection:

- **`400` cases assert `error.code == "invalid_param"` and the exact `error.field`**
  (`sort`, `supertype`, `page_size`), and a test enforces that a request asserting a field
  actually *sends* that parameter.
- **Unknown comma-list members are asserted with a bounded range, not an exact total.**
  `types=Lightning,Wizard` asserts `200`, `total > 1500`, and `total < 5000`. `Lightning`
  alone is a measured 1,513; the total with an unknown member dropped is *inferred*, not
  measured, and the standing policy is that curated values come from the fixture list. The
  range still falsifies both failure modes — a 400, or the filter being dropped entirely
  (20,324).
- **Unknown *query key* leniency is not asserted at all, because Courier cannot exercise
  it.** The sandbox rejects an unknown key before it ever reaches Pokesearch, which is the
  allowlist working. Only list-member leniency is reachable from here.

Cut for A2, all with verified fixtures, ready to re-add if the budget grows: browse page 2
(`q=pikachu&page=2` → page 2, 24 results), sort by name/newest/oldest, `series=Base` (494),
`set=base1` (102), `supertype=energy` (392), special characters (`q=★` → 29), the 300-char
query (0), empty result set (`q=zzzzqqqqxxxx` → 0 total, 0 pages), suggest fuzzy fallback,
and the `debug=1` query inspector.

## N24 — Task 13 step 5 (verify the fixtures against a live index) is NOT done

The task says to run every curated request against local Pokesearch and require zero
assertion failures. That is deliberately skipped here, for the reason N1 and N2 give: the
only reachable target is the shared dev instance on 8081, which is rebuilt out of band at
task boundaries and which still serves a **partial** M3 contract, and
`docker compose` must not be run from the Pokesearch checkout. Verifying against it
would produce a false red (or, worse, a false green on the old lenient build).

Every value in the curated set comes from the plan's verified fixture table and the spec's
measured profile. **The verification is owed at Phase 7/8**, where the spec already requires
it: run the full curated suite against the deployed target and require zero assertion
failures *before* announcing the URL. The M3 `400` assertions are the ones most likely to
move, since they were written against a contract document rather than a running server.

The API was still verified end to end by hand (Task 14 step 5) against a local stub target
on 127.0.0.1:8086 — every route, the 400/404/409 paths, the SSE replay, `/metrics`, pprof
reachability, and SIGTERM shutdown.

**Three fixtures were spot-checked live** afterwards, with Courier on 8084 pointed at the
shared dev target on 8081 (`/healthz` reported the expected `{"docs":20324,"status":"ok"}`
first, so the corpus was the pinned one): `search?q=charizard` → `total` **107**,
`suggest?q=alak` → **8** suggestions, `/healthz` → `docs` **20324**. All three passed, which
is as much of the fixture list as can honestly be checked against the old build. Nothing in
the error-handling collection was run against it, per N2 — those assertions describe the M3
contract and the deployed build still answers with the lenient one. Latency came back at
16-18ms end to end, inside the curated `lt 150` bound with room to spare.

## N25 — Self-telemetry is a server-scoped `expvar.Map`; pprof refuses to bind off-box (Addendum Task 31)

`/metrics` is an `expvar.Map` that is **not** published to expvar's package global, and the
handler is ours rather than `expvar.Handler()`. Two reasons: `expvar.Publish` panics on a
duplicate name and every handler test builds another `Server` in the same process; and the
default handler also renders `cmdline` and `memstats`, i.e. `os.Args` — a public demo that
hands out its own command line is a disclosure, not a feature. A test asserts neither key
appears. Counters: `runs_started`, `runs_cancelled`, `runs_aborted`, `sends_completed`,
`sends_refused`. Gauges (`expvar.Func`, evaluated at render): `budget_balance`,
`sse_subscribers`, `sse_subscriber_cap`, `goroutines`, `uptime_secs`, `run_in_progress`.
The gauges are attached on first render because they read a `Server` that is not finished
being built when its metrics are created.

`runs_aborted` counts terminal events with a status other than `completed`, observed by
wrapping the broadcaster (`meteredBus`) rather than by adding a hook to the run manager.
Counting cancels in the DELETE handler alone would miss expired runs and runs stopped by
shutdown.

pprof is a **separate `http.Server` on its own loopback listener**, never a route on the
public mux. `api.StartPprof` returns an error rather than binding when the address is not
loopback — `0.0.0.0:6060`, `:6060`, a LAN IP and a hostname are all refused, so a deploy
that sets `PPROF_ADDR` by habit fails loudly instead of quietly publishing the process's
memory. `PPROF_ADDR=off` disables it; the default is `127.0.0.1:6060`. Tested from both
sides: every `/debug/pprof/*` path and `/debug/vars` on the public mux, and a real profile
fetch on the loopback listener.

## N26 — The idle status poll is 3s, not the plan's 5s (Tasks 15, 17)

**Plan says:** Task 17 polls `GET /api/status` "on load, then every 5s while idle".

**What we do instead:** `main.js` states `StatusPollMs = 3000` once, and every idle tab
shares that one poll.

**Why:** the Design Spec's status-poll figure is 3s — it is the cadence the spec's
"re-read `cooldown_until` from the status poll" guidance (see the `/api/send` contract:
Send debits the budget but must never start a countdown) was written against. Spec beats
plan where they conflict (precedent N10, N22). The poll is also suppressed entirely while
a run is being watched: the live transport reports run state itself, and the poll exists
for the idle case.

## N27 — The idle status poll is gated on the transport, not on `state.run` (Tasks 15, 17, 18)

**N26 says:** the poll is "suppressed entirely while a run is being watched", and Task 15
implemented that as `if (!get().run) refreshStatus()`.

**What we do instead:** `if (get().transport === 'idle') refreshStatus()`.

**Why:** `state.run` is set the moment a run is *adopted* — Watch records the run it is
watching, and Task 18's history reopen will set it too — which is not the same moment a
transport attaches to it. Task 17's Watch button sets `run` while `api.openLive` is still
a stub, so the `!run` gate would leave that tab with neither a stream nor a poll: it would
never learn the run ended, and Start would stay disabled behind a cooldown it could not
see expire. Gating on the transport says what N26 actually meant — do not poll when
something live is already reporting — and it keeps saying it once Task 18 sets
`transport` to `sse`/`polling`, with no further edit.

**Affects:** `web/js/main.js` only. Task 18 must set `state.transport` when it attaches
and reset it to `idle` when the stream closes, or the poll will not come back.

### N27a — The cooldown countdown ticks through the store in its last second

`render-runner.js`'s countdown repaints locally at 1Hz, because no other view depends on
the second-by-second count. Two exceptions, both about the *phase* change rather than the
count: the final second goes through `set({})` so the topbar (`renderTopbar`, which reads
the clock again for itself) flips with the controls instead of up to one poll later, and
the ticker survives one beat past the deadline so a render that straddled it is corrected
a second later rather than three. Measured before the fix: a tab could show "cooling down"
in the topbar beside an enabled Start button for a full poll interval. Measured after:
zero disagreements across 1,600 samples over four cooldowns, foreground and background.

## N28 — The "no bytes for 5s" fallback trigger is "no events since connect" (Task 18)

**Plan and spec say:** fall back to polling when the stream "delivers nothing within
5s of a run the server reports as running", and the server's 2s `: ping` heartbeat
exists to keep that trigger from firing on a quiet run (N22).

**What we do instead:** `api.openLive` arms a 5s timer when the `EventSource` opens
and disarms it permanently on the first *event*. Heartbeats are not observed at all.

**Why:** `EventSource` never hands a comment line to script — the parser consumes
`: ping` and dispatches nothing — so "no bytes" is not observable from the client.
What is observable is "no events since the stream opened", and that is the case the
timer is really for: a proxy that buffers the response (the Cloudflare tunnel in
Phase 8) accepts the connection and then delivers nothing while the server has
already replayed `run_started` into the void. A live run always replays at least
`run_started` on connect, so silence at open means the bytes are not arriving.

Keeping the timer armed *after* the first event would have been the literal reading
and a bug: a functional run against a slow target can legitimately go far longer
than 5s between events, and the heartbeat that was supposed to prove otherwise is
invisible here. The heartbeat still earns its place — it stops proxies reaping the
connection — it just cannot be the client's liveness signal.

The same limitation folds in the `503 {"poll": true}` case. `EventSource` reports a
refused connection, a dropped one, a mid-flight reconnect, and the subscriber-cap
503 as one bare error with no status code, so the client treats every `onerror`
before `run_finished` as an immediate fallback and never lets `EventSource` retry —
which is exactly what the 503 asks for, arrived at without being able to read it.

## N29 — Every tab attaches to a live run; only the starting tab follows it (Tasks 17, 18)

**Plan says:** Task 17's `watch-run` is what attaches a second visitor to the live
run, and Task 18 step 7 requires that reloading mid-run "re-attaches and repaints
from the replay log".

**What we do instead:** `main.js` attaches whenever `GET /api/status` reports a live
run and nothing is attached — start, Watch, and reload all arrive through that one
rule. `api.js` gained `onRunStarted(fn)`, called on the 202, so the tab that pressed
Start is the only one that also switches itself to the Results tab.

**Why:** a mid-run reload has no memory of what it was watching, so something other
than a button has to decide to re-attach; persisting "I was watching run X" in
sessionStorage would have been a second source of truth about a fact the server
already publishes. Making it one rule also means spectator mode, reconnect, and
"someone else started a run" are the same code path rather than three. Switching
tabs is the one thing that must *not* be shared: hijacking a spectator's tab because
somebody else pressed Start is the wrong half of the behaviour, and the 202 is the
only place a page knows the run is its own.

**One edit outside Task 18's file list:** `render-runner.js`'s `watch()` cleared
`results`, `progress`, and `report` unconditionally. Once the page attaches on its
own, that clears a replay that has already arrived and does not arrive twice — a
functional spectator pressing Watch lost every row rendered so far. It now clears
only when the tab is not already following that run. The clobber was invisible in
Task 17 because `openLive` was still a stub.

A run reopened from history pins the Results view: the page stops following the live
run and does not re-attach until the visitor asks for it back with Watch. Reopening
a stored report and then having a live run paint over it would be the worse default.

---

## N30 — What Amendment A1's one page actually contains (Task 19)

**Plan says:** Task 19 step 4 renders the histogram as native `Rect` bars, a
per-request performance breakdown, a full functional failures detail with
expected-vs-actual, and sets `pdf.SetCreationDate(r.StartedAt)` for determinism.
Step 6 wires "the two Download PDF buttons (results header and each history row)".

**What we do instead**, reading Amendment A1 ("Single-page render: header, verdict,
summary stats table, SLA ladder as text rows. No histogram rect-drawing, no
multi-page layout"):

- **On the page.** Header (wordmark, run/mode/status/started/duration/config, the
  `... (executed via internal network)` target line), the coloured verdict band with
  its reasons, a summary stats table, and — performance only — the percentile table,
  the SLA ladder as text rows, Apdex with its rating and bands, and the status/error
  kind counts. Functional keeps its per-request table plus at most four failure
  lines: a functional report with no request list is a report about nothing, and the
  truncation the plan's step 5 asks for ("no clipped columns") needs a list to
  truncate.
- **Not on the page.** The histogram (A1), the performance per-request breakdown
  (A1), and any second page.
- **One page is structural, not a hope.** `SetAutoPageBreak(false)` plus an accept-
  page-break func that always refuses, and every block checks a `bottom` budget
  before it draws. Lists stop early and say `... and N more requests`. The footer
  is the one block allowed below the budget, because it sets the budget.
  `TestRenderIsSinglePage` renders a 50-request sequence and asserts `PageCount() == 1`.

**Determinism needed two more calls than the plan names.** fpdf stamps *two* dates
with `time.Now` (`/CreationDate` and `/ModDate`), and it writes the font catalog in
map order. Byte-identical output needs `SetCreationDate` **and**
`SetModificationDate` **and** `SetCatalogSort(true)`. With only the plan's one call,
two renders of the same report differ by the order of the two Helvetica font objects.

**The verdict band reads "N/A - partial data" with an ASCII hyphen**, not N15's em
dash. The core PDF fonts are WinAnsi and no font file is embedded — an em dash typed
as UTF-8 would render as mojibake, and shipping a font file to print one character
would cost more than the dash is worth. Everything drawn on the page goes through
`ascii()` for the same reason: request names and query values are visitor-supplied.

**A live run's report renders rather than 404s.** `GET /api/runs/{id}/report.pdf`
404s on exactly what `GET /api/runs/{id}` 404s on — an id the manager never had.
A run in flight has a coherent partial report (the polling fallback's contract), so
it renders one, marked `running`, with the verdict withheld.

**Only one Download PDF button, in the results header** (already wired in Task 18,
pointing at this route). Per-history-row download is product chrome that Amendment
A4 cuts: history is "list + reopen only", and reopening a run shows the button.

---

## N31 — The dev compose override renames `demo` rather than replacing it (Task 22)

**Plan says:** Task 22 step 3 — `docker-compose.dev.yml` "overrides `networks:
{default: {}}` (mapping form, matching the base) ... so the image can be exercised
locally without `demo-net` existing".

**What we do instead:** the dev file declares `default: {}` *and* redefines the
top-level `demo` network as `{external: false, name: courier-dev}`.

**Why:** compose deep-merges mappings across `-f` files, so a key the base declares
cannot be removed by an override — only redefined. Declaring `default` alone leaves
`services.courier.networks.demo` in place, still pointing at the external `demo-net`,
and `up` fails with "network demo-net declared as external, but could not be found"
on any machine where the shared network does not exist. Redefining `demo` as a
project-local bridge under a different name is what actually delivers step 3's
stated goal. The container ends up on both networks; that is the visible cost of the
mapping-merge rule the base file's comment already warns about, and
`docker compose -f docker-compose.yml -f docker-compose.dev.yml config` shows it.

The base file is byte-for-byte the plan's, including `demo: {}` in mapping form and
the service named `courier` rather than `app`.

**`TARGET_URL` in the dev file is `host.docker.internal:8081`, not the plan's 8085** —
that is N1, not a new deviation, and it is a `${TARGET_URL:-...}` default either way.

**Verification footnote:** firewalld
here rejects container-to-host connections to unpublished host ports, so a stub bound
on the host is unreachable at `host.docker.internal` from inside the container
(`connection refused`, from every bridge, including docker0 whose zone target is
ACCEPT). The `host.docker.internal:host-gateway` mapping itself is correct — it
resolves to 172.17.0.1 inside the container. The Task 22 container run was therefore
driven against a stub container on the compose network instead. Nothing in the image
or the compose files works around this; it is a host firewall fact.

---

## N32 — What the acceptance matrix actually runs, and the three items the plan could not have (Task 20)

**Plan says:** Task 20 step 1 brings the target up with `APP_PORT=8085 docker compose up -d`
from the Pokesearch checkout; step 2 lists the E2E matrix; step 4 is a target-down
drill that stops Elasticsearch and then the app container.

**What we do instead:** `internal/acceptance/acceptance_test.go` (build tag `acceptance`,
`COURIER_URL` to name the instance) drives a Courier already pointed at the shared dev
target on 8081 — that is N1, not a new deviation — and the three items that need the
target to *misbehave* run against a scratch stub instead of that shared instance.

**Every item's status, run 2026-08-22 against Pokesearch `milestone-3` (commit `9c042d3`,
20,324 docs):**

| Matrix item | Test | Result |
|---|---|---|
| Every curated collection, zero assertion failures | `TestCuratedCollectionsRunClean` | PASS — 18/18 requests, 4/4 collections |
| Perf report fully populated + `C*D/L` within ±35% | `TestPerformanceSanity` | PASS — 0.2% off |
| Wall clock ≤ duration + one request, `OverrunMs` set | `TestPerformanceSanity` | PASS |
| `concurrency=500, duration=600` clamped to 50/30 | `TestClampsAndBusyConflict` | PASS |
| Second `POST /api/runs` during a run → 409 + `run_id` | `TestClampsAndBusyConflict` | PASS |
| `page_size` → 400 naming the field | `TestStrictParamIsRejectedNamingTheField` | PASS |
| SSE reconnect mid-run + spectator replay-then-live | `TestSSEReconnectAndSpectator` | PASS |
| Cancel: 204 in ~1s, `cancelled` report, lock freed | `TestCancelDuringRun` | PASS — 204 in 4ms |
| Cooldown: immediate rerun 409 + `cooldown_until`, then 202 | `TestCooldownWindow` | PASS |
| Polling contract: coherent partial on every poll | `TestPollingContract` | PASS — 22 polls |
| `report.pdf` parses for both modes | `TestReportPDFParsesForBothModes` | PASS |
| History ≤ 20, newest-first | `TestHistoryIsCappedAndNewestFirst` | PASS — 20 rows |
| Courier starts with its target down | `TestCourierStartsWithItsTargetDown` | PASS |
| Metrics accounting against a real 503 | `TestMetricsAccountingAgainstA503` | PASS — **against the stub** |
| Functional deadline against a stalling target | `TestFunctionalDeadlineAgainstAStallingTarget` | PASS — **against the stub**, 12 dispatched / 38 skipped in 2m5s |

### N32a — N24 is discharged: not one curated fixture had drifted

This is the verification N24 owed. All four collections ran functionally end to end
against the live Milestone 3 build with **zero assertion failures and zero skips** —
including the five error-handling assertions N2 and N24 said could not be checked until
M3 was deployed. `error.code`, `error.field` and `request_id` all came back exactly as the
contract document described.

**Nothing was changed to make this pass.** Every fixture — `charizard` 107, `base1-1` →
Alakazam, browse 20,324 / 24 results / 11 type facets, `charzard` 128, `pikachu` 221 with
9 type facets and 173 set facets, `Rare Holo` 1,617, `Fire,Water` 3,992, hp 300–380 → 491,
`sort=hp&order=desc` → 380 / Mega Venusaur ex, `alak` → 8 / Alakazam, `p` → 8, `zzzzzzzz`
→ 0, `/healthz` 20,324, `page=99999` → page 400 / 0 results, `Lightning,Wizard` → 1,513 —
was independently re-measured with `curl` against 8081 *before* the suite ran, and every
one matched. There are **no vault Design-Spec fixture-table implications**: the table is
correct as written.

### N32b — Two target-manipulation items run against a stub, and the suite says so

The plan's step 2 metrics item says "stop Elasticsearch but leave Pokesearch's app up",
and step 4 stops the app container. Neither is available: the target is a shared instance
that is not this project's to restart, and `docker compose` must never be run from the Pokesearch checkout
(N1). Breaking it to test Courier would break it for everyone.

So `STUB_URL` names a *second* Courier whose target is a scratch stub with a `/__mode`
control plane (`ok` | `fail` → structured M3 503 with code `es_unavailable` | `stall`).
Unset, those two tests **skip with a message that says why** rather than passing quietly —
the suite documents both target modes honestly rather than pretending one covers the other.
What the 503 item asserts is unchanged and is still the regression test the Task 6 rewrite
earned: `requests == ok + errors + aborted`, `status_counts[503] == requests`, every 503
latency binned in the histogram, `error_kinds[non_2xx] == requests` with
`error_kinds[connection] == 0`, and Apdex frustrated == requests with score 0.

### N32c — The polling contract is counters-only mid-run, and that is deliberate

Writing this test found one thing worth recording, and it is a documentation gap rather
than a bug. A partial report fetched mid-run carries `requests`, `errors`, `aborted`,
`requests_per_sec` and `latency.avg` — but **`ok` is 0 and the percentiles are 0**, because
`Manager.absorb` folds the `Progress` tick and that payload has no `OK` field and no
percentiles by design (they are computed once, at the end, over samples the aggregator
alone owns). Mid-run, OK is *derivable* (`requests - errors - aborted`), not published.

The first draft of the test asserted `requests == ok + errors + aborted` on every poll and
failed 21 times in a row. Nothing was changed in the server: the frontend never reads
`overall.ok` mid-run — `api.js`'s polling fallback synthesizes progress events from exactly
the fields `absorb` populates, and the dashboard that renders `overall.ok` is built only
from a finished report. The identity is therefore asserted **on the finished report**, and
the mid-run assertions are the ones that are actually contractual: counters never go
backwards, `errors + aborted` never exceeds `requests`, percentiles stay 0, the verdict
stays `N/A` (never PASS or FAIL), and `finished_at` stays unset.

Likewise, "the verdict is withheld mid-run" means `N/A` — the value the live report is
created with — not the empty string. N30 says the PDF withholds it; the JSON says `N/A`.

### N32d — The suite is ordered and not parallel, and two tests reuse earlier runs

Courier admits one run at a time and every finished run opens a cooldown window, so a
parallel matrix would spend its life in 409s. `startRun` waits out the cooldown before
every POST; `TestCooldownWindow` is the one test that deliberately does not. The PDF item
reuses the run ids the curated and performance items already paid for rather than buying
two more runs and two more cooldowns, and skips with a clear message if they are missing.

`internal/acceptance/doc.go` carries **no** build tag on purpose: without one buildable
file the directory has no Go files at all under the default tags and `go vet ./...` reports
the package as broken.

**Load spent:** the whole suite costs roughly 200 worker-seconds against 8081 out of a
1,500 burst that refills at 5/s, so every cooldown in it is the 5s floor.

---

## N33 — The knee is where the addendum said; the fall is not (Task 33)

**Addendum says:** "Pre-render the curve ... showing the knee at ~25 workers", and the
Pokesearch session's own profiling expects throughput to **peak at ~25 and fall at 50**
while p50 roughly doubles.

**What we measured**, twice, 10s per point, through `POST /api/runs` against Pokesearch
`milestone-3` (commit `9c042d3`, 20,324 docs) over the curated `search-basics` sequence:

| workers | req/s | p50 | p95 | errors |
|---:|---:|---:|---:|---:|
| 1 | 87.2 | 15.89 ms | 20.19 ms | 0.00% |
| 10 | 556.7 | 22.38 ms | 32.63 ms | 0.00% |
| 25 | 676.8 | 39.84 ms | 69.45 ms | 0.00% |
| 50 | 692.0 | 71.40 ms | 128.49 ms | 0.00% |

- **Knee at ~25 workers — reproduced.** Throughput there is within 2% of everything the
  target ever gives up.
- **p50 roughly doubling from 25 to 50 — reproduced** (1.79x).
- **Throughput falling at 50 — not reproduced.** It rose 2.2%, in both series, which
  agreed to within 1.5% on every figure. The curve saturates flat rather than turning over.

Reported as measured, and said out loud in `docs/knee.md` and in the panel's own caption.
A flat top is the milder of the two shapes and is what a target with a bounded work queue
and no depth-dependent contention looks like; a turnover would need a resource ceiling this
run never reached. Nothing was retried or discarded to get this shape — both raw series,
with run ids, are printed in `docs/knee.md`.

**Two things the panel does that the addendum does not name:**

- **The numbers are constants in `render-runner.js`, not a fetch.** The panel is a record of
  a measurement on known hardware against a known corpus; a curve that redrew itself from
  whatever the last run returned would make its own claim unfalsifiable. The four buttons
  are how a visitor takes their own reading and compares — the 1-worker point run from the
  UI during browser verification came back at 86.6 req/s / p50 16.0ms / p95 20.3ms against
  the panel's 87.2 / 15.9 / 20.2.
- **A button replaces the sequence rather than appending to it.** Adding to whatever was
  already queued would reproduce a different run than the table measured, and the table
  would then be describing something the button does not do.

`web/knee.svg` is a hand-written static SVG loaded through `<img>`, with the theme's colours
baked in — an `<img>`-loaded SVG cannot inherit the page's custom properties. `TestNoInnerHTML`
is untouched: the table and the buttons are built with `dom.js` and `textContent` only.
`web/embed.go` names the file explicitly and `TestEmbeddedAssetsArePresent` fails if a
referenced asset is ever left out of the embed directive.

**This does not add a run mode**, per the addendum's own caveat. It is a preset loader.

## N34 — Future: Postman-style scripted assertions (planned, not built)

Requested 2026-08-23: let a visitor write JS assertions that pass/fail like
Postman's `pm.test`. Deliberately not built with the template-variable work.
The server's assertion grammar is a closed, declarative allowlist on purpose
(see docs/design.md); running visitor-supplied JS server-side would need a
real sandbox story. The likely shape when this happens: client-side-only
evaluation (a Web Worker with no DOM, feeding outcomes into the existing
outcome renderer), with scripted outcomes clearly labeled as evaluated in the
browser, never stored in run history.

## N35 — The verdict is scoped to the sequence it was calibrated for (Task 22)

**Plan says:** the verdict is a pure function of the numbers, `Verdict(s Stats) (string, []string)`:
PASS when aggregate p95 is within budget and the error rate is under the gate, applied to
whatever sequence a run happened to dispatch.

**What we do instead:** `Verdict` takes the sequence fact as well,
`Verdict(s Stats, calibrated bool)`. A run that dispatched anything other than the calibrated
sequence renders `VerdictNA` with a reason naming the calibration date and workload, the same
way a cancelled or expired run's judgement is already withheld. `report.IsCalibrated` decides
it by comparing a run's entries against `report.CalibrationEntries`: order does not matter, a
subset is not enough, and a substituted entry is a different workload. The percentiles, the
ladder, the histogram and the throughput all still render and are all still true. Only the
pass-or-fail judgement is withheld.

This supersedes N7's closing claim that `Verdict` returns only PASS or FAIL and that `N/A`
remains the assembler's job: `Verdict` now returns `VerdictNA` itself for an uncalibrated
sequence, while the assembler still owns the cancelled and expired case. N7 itself is left
exactly as written: entries are appended and superseded in place of being edited.

**The SLO constants are unchanged and this is not a recalibration.** `VerdictP95Ms`,
`VerdictMaxErrorRate`, the SLA ladder and the Apdex target are exactly what they were. What
changed is the scope of the claim: the report used to say "this run met the gate" and now says
"this run met the gate the gate was calibrated for". A run of some other sequence gets no
verdict rather than a verdict nobody calibrated.

**Why:** two of the curated collections showed the same defect from opposite sides.

- **Collection 04 (`error-handling`) is a structural FAIL against a correct target.** Most of
  its requests assert a 400, which is Pokesearch honouring its own error contract, and the
  gate counts every one of them as an error. A red verdict there measures the collection, not
  the target.
- **Collection 03 (`suggest-health`) is an unfalsifiable green against a healthy one.**
  Suggest and healthz are the cheapest endpoints the target has, and this package's own
  comment records real responses landing in 1 to 30ms, so a 150ms p95 budget there cannot
  fail whatever the target does. The design notes already argue that an unfalsifiable green
  is worse than no verdict and that an unfalsifiable red is the same defect mirrored; this
  applies that argument to the sequence dimension the notes never considered.

A one-entry subset of the calibrated collection could also flip a PASS into a FAIL on the same
host at the same concurrency, which is the same failure in miniature.

This consumes the calibration record Task 21 stored on the report (`CalibrationEntries`,
`CalibrationDate`, `CalibrationSequence`). The app's partial-verdict note now leans on the
reason lines the server sends instead of restating one of them, because a withheld verdict has
two possible causes rather than one.

## N36 — Curated assertions are bounds that survive index growth, not exact counts

**Supersedes the exact-count policy of N23 and N32a.** N23 recorded every curated assertion
as a value measured against the 20,324-card index, and N32a confirmed each of them exactly.
Both entries stay as written; they describe the index on 2026-08-22. The index is reseeded
and grows, and on 2026-11-17 the live demo failed 9 of its curated requests because
`q=charizard` returned 108 rather than 107 and `/healthz` reported 20,635 documents rather
than 20,324. A functional run that goes red because a card was added is measuring the
fixtures, not the target.

**What we do instead:** a count that follows the index is asserted as a bound, and only a
shape, or a single named card, is asserted exactly. The README numbers are unchanged: they
are dated measurements, and the prose no longer calls the index or the assertions "pinned".

| Request | Old | New |
|---|---|---|
| `search-basics/basic-text` | `$.total eq 107` | `$.total gt 106` |
| `search-basics/browse-all` | `$.total eq 20324` | `$.total gt 20323` |
| `search-basics/fuzzy-typo` | `$.total eq 128` | `$.total gt 127` |
| `search-basics/scoped-facets` | `$.total eq 221` | `$.total gt 220` |
| `search-basics/scoped-facets` | `$.facets.types count 9` | `$.total lt 20324` |
| `search-basics/scoped-facets` | `$.facets.sets count 173` | `$.facets.sets[172] exists` |
| `search-filters/filter-rarity` | `$.total eq 1617` | `$.total gt 1616` and `$.total lt 20324` |
| `search-filters/filter-two-types` | `$.total eq 3992` | `$.total gt 3991` and `$.total lt 20324` |
| `search-filters/filter-two-types` | `$.facets.sets count 173` | removed (see below) |
| `search-filters/filter-hp-range` | `$.total eq 491` | `$.total gt 490` and `$.total lt 20324` |
| `search-filters/sort-hp-desc` | `$.results[0].hp eq 380` | `$.results[0].hp gt 379` |
| `search-filters/sort-hp-desc` | `$.results[0].name eq "Mega Venusaur ex"` | `$.results count 24` |
| `search-filters/sort-hp-desc` | none | `$.results[23].hp gt 299` |
| `suggest-health/prefix-suggestions` | `$.suggestions[0] eq "Alakazam"` | `$.suggestions[0] contains "alak"` |
| `suggest-health/health-check` | `$.docs eq 20324` | `$.docs gt 20323` |
| `error-handling/lenient-list-member` | `$.total eq 1513` | `$.total gt 1512` and `$.total lt 20324` |

Each lower bound is the 2026-08-22 measured value minus one, so a shrinking index fails it.
The `sets[172]` check is a lower bound on an array's length, since the assertion language
has no "at least" operator for counts. `scoped-facets` no longer asserts that the type facet
narrows below the browse's 11: there is no way to assert an upper bound on a length, and an
exact 9 follows the index. A lower bound on the type facet (`types[8] exists`) would not
help either: the browse page's 11 types satisfy it, so a target that ignored `q=pikachu`
would pass. The request's upper bound on `$.total` is what catches that (see below).

`sort-hp-desc` asserts the 24th card as well as the first: `$.results[23].hp gt 299`. A
target that sorted only its top hit, or put one high card first on an unsorted page, passed
the first-card check alone. On 2026-08-22, 491 cards had an hp between 300 and 380, so the
24th-highest hp was at least 300, and it can only rise as the index grows.

**Upper bounds.** `lt 20324` is added to the four totals scoped by a filter and measured
below half the corpus (`filter-rarity`, `filter-two-types`, `filter-hp-range`,
`lenient-list-member`), and to one text query, `scoped-facets` (`q=pikachu`, 221 on
2026-08-22). Dropping the filter, or ignoring the query, makes the target answer with the
whole corpus, which fails the bound on the old index and on any larger one. The other text
queries (`basic-text`, `fuzzy-typo`) keep a lower bound only: their top-hit name check
already fails a browse page, so a ceiling would add nothing to them, while `scoped-facets`
asserts no name and had no other way to fail when its query was ignored.

**`filter-two-types` loses its `facets.sets` check.** Curated requests carry 2 to 4
assertions, and the added upper bound would have made five. `scoped-facets` still asserts
that `facets.sets` holds the whole catalog, so the cached-catalog property stays covered.

**Values kept exact, and why:**

- `search-basics/exact-id`: `$.total eq 1`, `$.results[0].name eq "Alakazam"`,
  `$.results[0].set_id eq "base1"`. An exact id returns that one card whatever the index
  holds. This is the one named exemption from the no-exact-`$.total` rule
  (`exactIDLookups` in `internal/collections/growth_test.go`).
- `search-filters/filter-rarity`: `$.results[0].rarity eq "Rare Holo"`. The filter
  guarantees every hit carries that rarity, whatever the ranking.
- `$.results count 24` (browse, sort) and `$.results count 0` (page overflow): the page size
  and a page past the last one.
- `$.suggestions count 8` and `count 0`: the suggester's size cap and a query nothing can
  match.
- `$.facets.types count 11` on the unfiltered browse: the number of energy types, a property
  of the card game and not of the index.
- `$.page eq 400`, every `error.code`, `error.field` and `request_id`: the error contract.
- `$.results[0].name contains "Charizard"` on `charizard` and `charzard`: a substring
  check on the top hit, not an exact name.

The rank-dependent values, `hp eq 380` with `Mega Venusaur ex` and `suggestions[0] eq
"Alakazam"`, could be displaced by a new card, so they became a bound (the highest hp can
only rise) and shape checks.

**Proof:** `internal/collections/growth_test.go` fails if a curated `$.total` or `$.docs`
assertion uses `eq` or `neq` outside the named allowlist, if a scoped total lacks
either bound, if a `count` or a rank-dependent `eq` is not on a listed allowlist with its
reason, or if the README, the design notes, the package comment or a collection description
calls the index pinned. It also evaluates every curated assertion with `assert.EvaluateAll`
against synthetic responses for the 2026-08-22 index (charizard 107, 20,324 documents) and
for the 2026-11-17 one (charizard 108, 20,635 documents, every other corpus count scaled by
20,635/20,324 and rounded up), and checks that a dropped filter or an ignored query fails
each upper bound.
`internal/collections/bounds_edge_test.go` checks that a browse page with its full facets
fails `scoped-facets` and that a first page whose 24th card has hp 60 fails `sort-hp-desc`.

**Not verified against the real index:** the synthetic responses stand in for it. Only
`charizard` 108 and the 20,635 document count were read off the live index. Every other
bound above is the old value minus one (a lower bound) or the corpus size (an upper
bound), so it holds on any index that has not lost cards, but the exact live values are a
follow-up once the new index is deployed.

## N37 — A dead target is paced by a backoff, and the run still lasts its full duration

**What the code did:** a performance worker dispatched again the moment its last dispatch
returned. A refused TCP connection returns in microseconds, so against a dead port the loop
measured the kernel rather than the target: 50 workers for 5 s made 520,142 failed dials and
reported 104,008 req/s, and the 2026-08-22 failure drill (`docs/failure-story/`) recorded
968,696 refused dials in the 10 seconds after the kill.

**What it does now:** after a dispatch that failed to connect at all (error kind
`connection`, status 0), the worker waits before its next dispatch:

| Consecutive refusals | Wait before the next dispatch |
|---|---|
| 1 | 10 ms |
| 2 | 20 ms |
| 3 | 40 ms |
| 4 | 80 ms |
| 5 | 160 ms |
| 6 and more | 250 ms (the cap) |

- Any dispatch that got a response, 2xx or not, resets the wait to 0, so a target that
  answers is never paced and no number measured against a healthy target (the README, the
  knee) can change.
- Timeouts do not back off: a timed-out dispatch already waited the 10 s client timeout. A
  connection error after a status line (a body that broke mid-read) is a response and does
  not back off either.
- The wait selects on the run's dispatch context, so the deadline and Cancel end a waiting
  worker at once; `overrun_ms` keeps its meaning (the in-flight tail past the deadline).
- **There is no early abort.** A dead-target run keeps its full duration and its `completed`
  status, and `requests == ok + errors + aborted` holds exactly as before. Every refused dial
  is still a `connection` error, never `aborted`.

At the cap a dead target sees at most about four dials per second per worker.

**The recorded drill numbers stay as they are.** 974,606 dispatches, 5,910 ok and 968,696
errors in the README, `docs/design.md` and `docs/failure-story/README.md` are the record of
a run measured on 2026-08-22, before this backoff; each place now says so. The README's
"the dead one dispatches far more requests for them" was rephrased: a dead target would
draw far more dispatches than a live one, and the backoff is what paces them.

**Proof:** `internal/runner/perf_test.go`: `TestBackoffSchedule` (the schedule above, and a
wait of 0 after a 2xx, a 503, a broken body, a timeout and an abort),
`TestBackoffWaitReturnsWhenTheRunStops` (an injected timer that never fires; the wait returns
when the context is cancelled), `TestPerfDeadTargetIsPacedNotHammered` (5 workers for 2 s
against a closed port: `completed`, the identity holds, every dispatch a `connection` error,
none aborted, and at most 100 dispatches, where one unpaced run of the same test made
144,187), and `TestPerfBackoffResetsWhenTheTargetRecovers` (a listener that drops its first
five connections and then serves: the worker returns to full speed).

## N38 — A stream ends after its run's terminal event; events are numbered; times are UTC

**Amends N22 point 2.** N22 kept the stream open after `run_finished` so that a tab left
open would not reconnect into a loop. The cost was a subscriber slot per open tab, held
across runs: 100 idle tabs on a finished run pushed every viewer of the next run onto
polling (`503 {"poll": true}`).

**Stream lifetime.** After a stream writes its run's `run_finished` it writes
`retry: 60000`, unsubscribes and returns, so the slot is released at once. The same holds for
a finished run: the replay (or the `run_finished` rebuilt from the stored report, N22 point
3) is followed by the `retry:` line and the end of the response; it never parks. If a later
run resets the broadcaster before a viewer of the earlier one has seen its `run_finished`,
the viewer gets the rebuilt one instead of waiting on a run that will never publish again.
The reconnect loop N22 avoided does not come back: the client closes its `EventSource` on
`run_finished`, and a client that does not is told by `retry:` to wait a minute before it
reconnects, at which point it is sent `run_finished` again and the stream ends again. No
server timeout was added: `ReadHeaderTimeout` is still the only one, and the lifetime is the
handler's.

**Event ids.** Every frame carries `id: <n>`, starting at 1 for each run and rising by one
per event the broadcaster publishes. A reconnect with `Last-Event-ID: k` replays only events
with an id above k; the coalesced latest `progress` is included when its own id is above k.
An unparseable `Last-Event-ID` replays everything. A `run_finished` rebuilt after the
broadcaster has moved on carries the last id that run's events reached (1 if the broadcaster
no longer remembers it; it remembers the last 32 runs, more than the history's 20), and a
viewer whose `Last-Event-ID` is at or past `run_finished` is still sent it. The id is on the
`id:` line only, not in the JSON envelope.

**Times.** `started_at`, `finished_at` and `cooldown_until` are UTC (ending in `Z`) in every
payload: reports, history rows, `/api/status`, the 409 cooldown body, `run_started` and
`run_finished`. A running report has no `finished_at` key (it used to carry
`0001-01-01T00:00:00Z`), and a rebuilt `run_finished` with no cooldown left has no
`cooldown_until` key.

**Functional verdict.** `report.FunctionalVerdict` is the PDF's rule, moved so every surface
reads one implementation: cancelled or expired → `N/A`; any failed request → `FAIL`; at
least one passed → `PASS`; otherwise `N/A`. The PDF's band labels and bytes are unchanged.
It appears as `verdict` on functional rows of `GET /api/runs`, as `functional.verdict` on a
finished report (absent while running), and as `run_finished.data.verdict`.

| Item | Before | After |
|---|---|---|
| SSE frame | `event:` + `data:` | `id:` + `event:` + `data:` |
| Stream after `run_finished` | stays open | `retry: 60000`, then the response ends |
| `Last-Event-ID` | ignored | replays only later events |
| Times | server-local offset | UTC, ending in `Z` |
| `finished_at` while running | `0001-01-01T00:00:00Z` | absent |
| `run_finished.data.cooldown_until` with no cooldown | `0001-01-01T00:00:00Z` | absent |
| Functional verdict | none | history `verdict`, `functional.verdict`, `run_finished.data.verdict` |

**Proof:** `internal/api/runs_test.go`: `TestStreamEndsAfterTheLiveRunFinishes`,
`TestStreamOfAFinishedRunNeverParks`, `TestFinishedStreamsReleaseTheirSlots` (100 streams on
run A, A ends, the subscriber count reaches 0, run B's stream answers 200 with
`run_started`), `TestStreamFramesCarryRisingIDsAndResume`,
`TestSynthesizedTerminalEventCarriesTheRunsLastID`,
`TestSynthesizedTerminalEventFallsBackToIDOne`, `TestWireTimesAreUTCAndUnsetOnesAbsent`
(a clock in UTC-5), `TestFunctionalRunsCarryAVerdict`; `internal/sse/broadcaster_test.go`:
`TestEventsAreNumberedWithinARun`, `TestSubscribeAfterAnIDReplaysOnlyNewerEvents`;
`internal/report/metrics_test.go`: `TestFunctionalVerdict`; `internal/pdf/report_test.go`:
`TestFunctionalVerdictLabelsAreUnchanged`.

## N39 — A run keeps a bounded sample of latencies for its percentiles

**What the code did:** every completed response appended a 16-byte sample to the run's
overall tally and to its entry's tally, without limit. Against a microsecond target, 4.1M
requests took the process from 15 MB to 290 MB.

**What it does now:** a run's overall tally keeps at most `report.MaxSamples` = 262,144
latencies, and each entry's tally at most ⌈262,144 ÷ entries⌉: about 8.4 MB per run in all,
whatever its volume. Each entry's share is rounded up, so the entries' tallies together may
keep up to (entries − 1) samples more than 262,144. Below the cap every sample is kept and
every number is what it was.
Past it, the kept samples are a uniform random sample of every latency recorded (reservoir
sampling, Algorithm R), drawn with a splitmix64 generator held in the tally: deterministic,
and allocation-free on the per-dispatch path. Every kept sample is a latency a request
really had, so a published p99 is still one some request experienced.

Only the percentiles (p50, p90, p95, p99) are read from the sample. Requests, ok, errors,
transport failures, aborted, bytes, status counts, error kinds, the Apdex bands, the
histogram counts, the SLA ladder, and min, max and average latency are counted as each
response is added, so they are exact at any volume.

**Disclosure:** `Stats` gains `percentile_samples`, the number of latencies the percentiles
rest on (additive; it equals the response count below the cap). The rank error of a
percentile read from k uniform samples is about √(p(1−p)/k): for k = 262,144 that is about
0.02 percentile points at p99 and 0.1 at p50. Runs against the real target stay far below
the cap (about 18,000 responses at the measured knee).

**Cost:** `BenchmarkTallyAddResponse` and `BenchmarkAggregatorRecord` stay at 0 allocs/op.
Measured on one machine at the parent commit and at this change, five runs each: 19–33 ns
before and 14.6 ns after for the first (the benchmark now runs mostly past the cap, where a
sample replaces another instead of growing the slice), and 156–171 ns before and 134–144 ns
after for the second. Below the cap, the path every run against the real target takes,
`BenchmarkTallyAddResponseBelowCap` starts a fresh tally before the cap and measured
27.0–35.0 ns over five runs on the same machine, with 0 allocs/op (86 B/op: the sample
slice's growth, amortised). The figures in `docs/design.md` (31 ns, 115 ns) are an earlier
measurement on another load and are left as they are.

**Proof:** `internal/report/metrics_test.go`: `TestTallyIsExactPastTheSampleCap` (300,000
responses; every count, band, bucket, ladder share, min, max and average exact),
`TestPercentilesPastTheCapStayClose` (latencies 1…1,000,000: p50, p95 and p99 within ±0.5
percentile points, every kept sample a recorded latency),
`TestBelowTheCapEverySampleIsKept`; `internal/runner/perf_test.go`:
`TestAggregatorBoundsTheSamplesARunKeeps`.

## N40 — The run setup and saved sequences persist in this browser; the server stores nothing

**What the page did:** the run sequence, the mode and the options lived in page state only.
Queue requests, pick performance at 25 workers, reload: the sequence was empty, the mode was
functional and the options were the defaults. A sequence could not be saved at all.

**What it does now:** two `localStorage` keys in the visitor's browser. The server stores
none of it, gains no route, and is sent nothing it was not sent before.

- `courier.runner.v1` holds the run setup as one value:
  `{"version":1,"sequence":[{"enabled":true,"request":{…}}],"mode":"performance","options":{"stop_on_failure":false,"delay_ms":0,"concurrency":25,"duration_secs":20}}`.
  Every change to the sequence, the mode or an option writes it whole, and the page restores
  it once at load.
- `courier.collections.v1` holds the sequences saved with "Save sequence as collection":
  `{"version":1,"collections":[{"id":"wc-<random>","name":"…","requests":[{…}]}]}`. They are
  listed under My Workspace with "Add all N to run" (which queues them again in order, up to
  the 50-request cap, with the same cap note as a curated collection) and a delete control
  with an inline Undo. A page saves at most 50 of them; the name is cut to 120 characters
  and shown as text.

**Across tabs.** The run setup is last-writer-wins, one whole value, and is **not** adopted
from another tab's storage event: a second tab must not have its queued sequence replaced
under the visitor's hands, so a tab only ever reads the setup when it loads. Saved
collections merge by id across tabs and follow other tabs live through `storage` events,
under the same rules and the same code as saved requests (`createSyncedList` in
`web/js/storage.js`): only a current read counts, a delete wins over an edit, and a
collection deleted in another tab disappears here.

**Copies.** A queued request is a copy of the request as it was when it was queued (as
before), and persisting the sequence persists those copies. Saving a sequence stores copies
too, of every queued request, checked or not; adding a saved collection to the run copies
them again. Deleting a saved request or a saved collection does not change the queued
sequence.

**What a stored value cannot do.** Every read and write answers instead of throwing: a
refused or impossible read loads the defaults (an empty sequence, functional, the default
options) or an empty list, and a refused write keeps the change on the page and says so
(`Could not save the run setup in this browser.` beside the sequence; the saved-requests
message for a saved collection). A wrong version, garbage, `null` or a non-object loads the
defaults. A stored sequence is cut to 50 entries, a saved collection to 50 requests, and
stored options are clamped by the same rules as the inputs; a mode other than `functional`
or `performance` loads as functional. Entries that are not objects and requests with a
malformed field are dropped. Every request stored under either key is rebuilt from a fixed
set of checked primitive fields before it is shown or sent: `id`, `name` and `endpoint` as
text, `params` as text values, and each assertion as a `type` and `op` the editor offers
(any other pair is dropped), a `path` on a json assertion only, and a `value` that is text
or a finite number. A name is cut to 120 characters and a parameter value to 500, as the
server itself cuts them, and a request keeps its first 20 assertions. An assertion's path
and value are kept as text of any length: an over-long one is not shortened, it is refused
by field when it is sent. Nothing else in a stored value is
kept, so it can neither put a URL, host or method on the wire nor hand the page a value
nested too deeply to show or encode. A request whose endpoint is no longer in the catalog
is kept, and the server refuses the run naming the field, as it would any request.

**Proof:** `web/test/run-config.test.mjs` (the reload, the bad values, the clamps, refused
reads and writes, another tab's write, the payload keys);
`web/test/saved-collections.test.mjs` (saving, listing, Add all at the cap, delete and
Undo, two tabs, garbage by load and by event, 1,000 collections, a 5 MB value);
`web/test/workspace-model.test.mjs` runs its 300 seeded tab, storage and event orderings
over saved collections as well as saved requests; `web/test/stored-requests.test.mjs` and
`web/test/stored-request-kinds.test.mjs` (what a stored request is rebuilt into, field by
field and kind by kind); `web/test/run-setup-hostile.test.mjs` (hostile stored setups);
`web/test/run-setup-writes.test.mjs` (which actions write the setup, and that polls and
renders do not); `web/test/run-panel-failsafe.test.mjs` and
`web/test/run-panel-wire.test.mjs` (a row that cannot be shown or sent, and what a run
puts on the wire); `web/test/saved-collections-tabs.test.mjs` (saved collections across
tabs).

## N41 — A tab showing a finished run does not attach to the next one by itself

**Amends N29.** N29 attached every tab to whatever run `GET /api/status` reported as live,
whenever nothing was attached. A tab reading a finished report was therefore taken off it
the moment another visitor pressed Start: `run_started` cleared the report, and the reader
was left watching somebody else's run.

**What the page does now.** What a tab shows of a run that has ended (its report, a report
reopened from history, or its rows and how it ended when the report could not be fetched)
is replaced only by that tab's visitor: Start, Watch, opening a history entry, or a reload.
While another run is live such a tab keeps its view, and the run banner reads
`A run is live - Watch to follow it.`; Watch attaches and clears the old report. Everything
else in N29 stands: a tab showing nothing still attaches by itself (which is what repaints
a tab reloaded mid-run), the tab that pressed Start attaches and is the only one moved to
the Results tab, and a tab that attached by itself is not marked a spectator. One case is
new: status can name a tab's own run before its 202 is read, and a tab showing nothing has
then already followed the run, possibly to its end. A 202 for a run the tab has seen end
attaches nothing, since the end is already on screen. The
spectating badge is now dropped when the watched run ends, when a history entry is opened
and when the tab starts its own run.

**A run the server no longer has.** A followed run whose report answers 404 (it aged out
of the history, or the server restarted) is not followed again: the tab closes the
transport, reads status once, and does not attach to that id until status reports a
different run or none, however long status goes on naming it. What had arrived stays on
screen marked `unavailable`; a tab that had been sent nothing goes back to showing nothing.
A vanished run costs one stream request; while the server cannot be reached its report is
read at the polling fallback's pace, one request at a time every 500 ms, and once it answers
404 nothing more is asked for that run. When status says
the followed run is not the live one, the tab reads that run's report once rather than
detaching, since status can be a moment ahead of the stream.

**Events.** They are applied only for the attached run and never after its terminal event;
a row that arrives before `run_started` is kept, and `run_started` removes nothing. A run
whose finished report cannot be fetched shows the status its terminal event carried
(`completed`, `cancelled`, `expired`) and says the report can be opened from History.

**Requests.** No call the page makes throws. One that cannot reach Courier, gets no answer
in time (10 s for reads and cancel, 20 s for Send and Start), or loses its body after the
headers arrived is answered as `Could not reach Courier`, and the control that made it
returns to idle with a sentence saying what did not happen. So is a 2xx whose body is not a
JSON object (a proxy's holding page, a body cut short, a JSON `null`), and a 202 to Start
that names no run; each reader also refuses an object without the fields it reads, keeping
what the page held. Cancel's empty 204 is still a cancel. A catalog that cannot be loaded
says so with a Retry. The status poll (still 3 s, still gated on the transport, N26 and
N27) keeps one request in flight, and an answer that was already on its way when the tab
learned something newer is read again instead of applied. A Send answer that arrives after
another request was opened is dropped.

**Where the rules are.** `web/js/live.js` states them at the top and implements them as two
pure functions, `step` and `decideSync`; `createLive` in the same file is the only code
that opens a transport or reads status, history, the catalog or a report, and `main.js`
only wires it to the render modules.

**Proof:** `web/test/live-rules.test.mjs` (each rule on the pure functions);
`web/test/live-page.test.mjs` (the page as `main.js` wires it, against a function standing
for the server: the kept report and the banner, Watch, the vanished run and the stale
status, every control after an unreachable server, the catalog Retry, late Send and
history answers, one status request at a time); `web/test/live.test.mjs` (the transport:
the end of a stream, the 404, the polled verdict, rows across the two transports);
`web/test/api.test.mjs` (every call's network, timeout and cut-off-body outcomes);
`web/test/live-model.test.mjs` (500 seeded event sequences over the pure functions and 120
seeded sequences over the wired page, with the rules checked after every step);
`web/test/live-races.test.mjs` and `web/test/live-orderings.test.mjs` (another visitor's run
at every moment of this tab's own, every call failing every way); `web/test/read-shapes.test.mjs`
(every reader against a 2xx that is not what it reads).

## N42 — Method badges are coloured by method, read from the endpoint catalog

**What the page did:** every request in the sidebar showed the method as plain grey text,
and the text was the literal `GET` written into the sidebar code, under a comment recording
the choice of no coloured method badges. The run sequence and the result rows showed no
method at all.

**What it does now:** the method is read from the catalog `GET /api/collections` serves,
`endpoints[].method`, by the request's endpoint id, and shown as a badge in the sidebar
tree (curated collections, saved requests and saved collections), on every sequence row and
on every functional result row. `GET` is drawn in `--pass`, `POST` in `--warn`, and any other
method in the muted text colour; the method is upper-cased first, so `get` and `Post` read as
`GET` and `POST`. A request whose endpoint the page does not know (one stored for an
endpoint that has since left the catalog, or any request while the catalog has not loaded or
failed to load) shows a muted `---` named "Method unknown", never a guessed `GET`.

**Why the earlier choice is reversed:** a hard-coded `GET` is a claim about the catalog
made in a second place, and it would have gone on saying `GET` the day the catalog gained
another method. Reading the catalog keeps the one statement of each endpoint's method where
the sandbox keeps it, and colour lets a visitor see at a glance which requests write.

**What a visitor sees today:** every endpoint in the catalog is a `GET`, so every badge is
green until a `POST` endpoint exists. No colour is new: both hues are existing tokens.

**Proof:** `web/test/method-badges.test.mjs` (a request for a `POST` endpoint renders
`method-post`; upper, lower and mixed case, an unknown method, an empty, missing or
non-text method, an endpoint id with quotes and brackets, and an endpoint not in the
catalog, in all three lists; every list picking the method up once the catalog arrives; no
list writing a method of its own).

## N43 — The body check is bounded by body bytes; an assertion value is one scalar

**What the server did:** `POST /api/send` and `POST /api/runs` read, checked and decoded a
body before the one-send limit and the one-run lock, for any number of visitors at once.
Decoding a body at the 256 KiB cap builds tens of thousands of values from it, so enough
such posts arriving together could take the process past its container's memory, and every
visitor with it. Separately, an assertion's `value` was bounded only when it was a string:
an object or an array on a `json exists` assertion, which ignores its value, was accepted,
kept, and stored in the run's report, its replay log and its result frames.

**What it does now:**

- The body check is bounded by the bytes of the bodies in it, across both routes: at most
  2 × 256 KiB of bodies at once, with up to 16 × 256 KiB more waiting (`MaxBodyChecks`,
  `MaxBodyWaiters` and `MaxBodyBytes`). A body weighs its length and never less than 4 KiB
  (`minBodyWeight`), so two bodies at the cap fill the check while up to 128 small ones
  fit in it, and an ordinary burst of small posts is not refused. A body is read in full,
  under the size cap as before, before it takes its place, so an upload still arriving
  holds none. Bodies that do not fit wait in arrival order: a body at the cap that is
  waiting goes in before any body that arrived after it, however small. A waiter whose
  client goes away leaves the line. A body that would take the waiting bodies past their
  bound is answered at once, unchecked, with `503`, a `Retry-After: 1` header, the
  security headers and the one error shape:
  `{"error":"the server is busy checking other requests; try again in a moment"}`.
  Before, these routes never answered `503`. The page shows the sentence after
  `Refused - ` on Send and after `Could not start the run - ` on Start. The `400`, `413`
  and `415` answers are unchanged, and `413` and `415` are given without entering the gate.
- What this bounds is what the checks in flight allocate: the widest bodies measured
  allocate about 140 times their size to check and decode, and a test holds them to 192
  times, so the checks in flight allocate at most 192 × 2 × 256 KiB, and the bodies
  waiting weigh at most 16 × 256 KiB. It does not bound what scales with connections
  (bodies read in full and then answered `503`, and bodies still arriving), the decoded
  value a request keeps after its check through validation and the start or the send, or
  garbage not yet collected. The statement beside the constants in
  `internal/api/body_gate.go` says the same. Nor does it share the line between clients:
  the line has no per-client fairness, so a client that keeps it full of bodies at the cap
  makes every other POST an immediate `503` with `Retry-After` until it stops. What limits
  one client is the tunnel in front of the server, not this bound.
- An assertion `value` that is an object or an array is refused by the body check, for
  every assertion type and operator, with a `400` naming the value:
  `{"error":"expected a number, a string, true, false or null, got an object","field":"sequence[1].assertions[0].value"}`
  (`assertions[j].value` on Send; `an array` for an array). The value is walked before it
  is refused, so a fault inside it, such as a duplicate key, is still named where it is.
  Before, `json exists` accepted it with `200` or `202`, and every other type and operator
  refused it later with a `400` at `assertions[j]` (for example "a status assertion needs a
  numeric value, got an object"). A number, a string, `true`, `false` and `null` pass the
  check exactly as before, and mean what they meant: only `json exists` accepts a boolean
  or `null`.
- The body check builds each payload type's field map once and shares it, rather than once
  for every JSON object in the body.

**Proof:** `internal/api/body_gate_test.go`: `TestNoMoreThanMaxBodyChecksBodiesAreCheckedAtOnce`
(64 posts at the cap to both routes: never more than 2 inside, 16 waiting, the other 46
answered `503`, nothing left behind), `TestABodyBeyondMaxBodyWaitersIsAnswered503WithoutBeingChecked`
(the `503`, its header, body and security headers, a malformed body unchecked, `413` and
`415` with the line full), `TestAStalledUploadHoldsNoCheckSlot`,
`TestAWaiterWhoseClientLeavesStopsWaiting`; `internal/api/body_gate_edge_test.go`:
`TestAnOrdinaryBurstOfSmallPostsNeverSeesTheBodyGate`,
`TestACheckSlotIsGivenBackBeforeASendGoesOut`, `TestUploadsStalledAnywhereHoldNoSlotOrPlace`,
`TestAWaiterOnAClosedConnectionStopsWaiting`, `TestWaitersCancelledAllAtOnceGiveBackEveryPlace`,
`TestTheBodyGateKeepsItsCountsThroughMixedCancelAndComplete`,
`TestAPanicInsideTheDecodeGivesBackItsSlot`, `TestA503ThatCannotBeWrittenTakesNoSlotOrPlace`,
`TestAFullBodyGateLeavesEveryOtherRouteAnswered`; `internal/api/body_gate_weight_test.go`:
`TestABodyAtTheCapIsAdmittedBeforeSmallerOnesBehindIt`, `TestAShortBodyWeighsTheFloor`,
`TestTheBodyGateWeighsMixedSizesThroughCancelAndComplete`,
`TestABodyTheShapeCheckRefusesGivesBackItsRoom`; `internal/api/body_gate_docs_test.go`:
`TestTheBodyGateConstantsMatchTheDocuments`;
`internal/api/assertion_value_test.go`:
`TestAnAssertionValueThatIsAnObjectOrArrayIsRefused`,
`TestScalarAssertionValuesStillPassTheShapeCheck`,
`TestBooleanAndNullAssertionValuesKeepTheirMeaning`,
`TestEveryCuratedRequestPassesTheBodyCheck`; `internal/api/decode_bounds_test.go`:
`TestDecodingAWideBodyStaysLinearInItsSize` (the 192 × bound the allocation figure rests
on), `TestARefusedAssertionValueCostsAboutItsSize`,
`TestTheShapeCheckBuildsEachTypesFieldMapOnce`, `TestFieldMapsAreSharedSafelyOnFirstUse`;
`internal/api/bench_test.go`: `BenchmarkCheckBodyManyObjects`. The existing tests of
parallel starts and sends pass unchanged.

## N44 — A parameter value is cut to 256 characters and 32 words

**What the server did:** every parameter value was cut to 500 characters and sent. The
target is about to refuse a search text (`q`) over 256 characters or 32 terms with a `400`,
so a value between those limits and 500 characters would have come back as the target's
refusal rather than as an answer.

**What it does now:** every parameter value, on every endpoint, is cut to its first 32 words and then to its first 256 characters (`MaxParamWords`, `MaxParamValueLen` and
`CutParamValue` in `internal/sandbox/validate.go`). It is still cut, never refused, and the
cut is reported exactly as before: `"truncated":["params.q"]` on Send's `200` and
`"truncated":["sequence[1].params.q"]` on the run's `202`. The rule, exactly:

- A character is a rune, as in every other cap. A word is a maximal run of characters that
  are not Unicode white space (Go's `unicode.IsSpace`: the space, tab, newline, carriage
  return, the non-breaking space, the ideographic space and the other `Zs` spaces; a
  zero-width space is not white space and joins the words either side of it).
- The word cut comes first. A value with more than 32 words ends at the end of its 32nd
  word: the white space after that word goes with the words cut, and the white space before
  and between the words kept stays as written. A value with 32 words or fewer keeps all its
  white space, at either end too.
- The character cut comes second and keeps the first 256 characters, which may end inside
  a word or in white space. A value of only white space has no words and is cut by
  characters alone.
- So what is sent is a prefix of the value, within both limits, never ends inside a
  character, and is the value itself exactly when the value was within both limits, which
  is when `truncated` leaves it out. The order matters in one case: 33 words of seven
  letters put the 256th character on the space after the 32nd word, and that space is not
  sent.

How the target counts "terms" is not stated in anything this repository can read. Courier
counts white-space-separated words as above and characters as runes, so whoever checks the
target's rule can compare the two.

**What does not move:** an assertion's JSON path and string value keep their own cap of
500 characters (`MaxAssertionTextLen`, which they used to share with parameter values) and
are still refused over it; between 257 and 500 characters they are accepted whole. The
name and id cap stays at 120 characters. Every curated request, and so every knee preset,
goes out unchanged.

**Template variables.** `{{randomWord}}` and `{{randomPokemon}}` are expanded after
validation, and the limits are not checked again on the way out. Every pool entry is
shorter than its token and holds no white space, so an expansion never adds a character or
a word: a value within both limits stays within them, whatever is drawn.

**Amends N40**, which says the page cuts a stored parameter value to 500 characters "as
the server itself cuts them": the server now cuts to 256 characters and 32 words. The
editor's parameter input now takes at most 256 characters (its `maxlength`, which the limit
test holds to `MaxParamValueLen`); the page's cut of a stored value is unchanged.

**Proof:** `internal/sandbox/param_cut_test.go`: `TestAParameterValueIsCutTo256Characters`
(255, 256, 257 characters, two- and four-byte characters at the boundary),
`TestAParameterValueIsCutTo32Words` (31, 32, 33 words, white space kept and dropped),
`TestEveryUnicodeWhiteSpaceSeparatesWords` (tab, newline, non-breaking, ideographic and em
spaces; a zero-width space joins), `TestBothLimitsAtOnce` (either limit first, both, and the
order), `TestWhiteSpaceAtTheEdgesAndAValueOfOnlyWhiteSpace`,
`TestTheCutNeverExceedsEitherLimit` (3,000 seeded values), `TestARunReportsWordCutsAtTheirRequest`,
`TestAssertionTextBetweenTheParameterLimitAndItsOwnIsAccepted`,
`TestTheParameterLimitsAreTheTargetsSearchLimits`, `TestTheParameterLimitsMatchTheDocuments`;
`internal/api/param_cut_test.go`: `TestSendCutsAParameterToItsFirst32Words`,
`TestARunCutsAParameterToItsFirst32Words` (what the target receives, and `truncated`);
`internal/collections/param_cut_test.go`: `TestTheParameterLimitsCutNothingCurated`;
`internal/template/template_test.go`: `TestPoolsAreUsable`,
`TestAnExpandedValueAtTheLimitsStaysWithinThem`; `web/limits_test.go`:
`TestFrontendLimitsMatchTheServer`.

## N45 — A functional run that asserted nothing is N/A, not PASS

**Amends N38**, whose rule gave `PASS` to a completed functional run with at least one
request passed. A request with no assertion passes as soon as it is answered, so a run made
only of such requests was a `PASS` that checked nothing.

**What the server does now:** such a run's verdict is `N/A`, in every place the server
states one: `functional.verdict` on the finished report, `verdict` in `run_finished.data`
(live, and when it is rebuilt from the stored report), the history row's `verdict`, and the
PDF, whose band reads `N/A - nothing was asserted`, the band a run with nothing asserted
already had. The history row's summary keeps its counts and adds `, nothing asserted` for
such a run (`3 passed / 0 failed / 0 skipped, nothing asserted`), since its passed count is
not a count of checks passed. A performance run's verdict is untouched. The whole rule, in
`report.FunctionalVerdict`, where a request counts as asserted when it was dispatched and
carries at least one assertion:

| Run | Before | Now |
|---|---|---|
| Completed, at least one assertion, every one passed | PASS | PASS |
| Completed, any assertion failed | FAIL | FAIL |
| Completed, no assertion anywhere, every request answered | PASS | **N/A** |
| Completed, no assertion anywhere, a request got no response or had its response cut off | FAIL | FAIL |
| Completed, some requests asserted and passed, others with none, all answered | PASS | PASS |
| Completed, some requests asserted, one failed, others with none | FAIL | FAIL |
| Completed, nothing asserted among the requests sent, the rest skipped | PASS | **N/A** |
| Completed, every entry skipped, or no entries | N/A | N/A |
| Cancelled or expired, whatever it reached | N/A | N/A |

A request that got no response fails whether or not it carried an assertion; that part of
the rule is kept. A skipped row counts for nothing, whatever assertions it lists, since none
was evaluated.

**What the page shows:** the page takes the verdict the server sends. Its own fallback,
which works the verdict out from the rows when a report carries none, still follows N38's
rule, and is brought into line separately.

**Proof:** `internal/report/verdict_rule_test.go`:
`TestTheFunctionalVerdictRuleCaseByCase` (every row of the table);
`internal/runner/verdict_rule_test.go`: `TestAFunctionalRunThatAssertedNothingIsNotAPass`
(the stored report, the history and `run_finished`); `internal/api/verdict_rule_test.go`:
`TestAFunctionalRunThatAssertedNothingIsNAEverywhere` (the report, the history row and its
summary, the live and the rebuilt `run_finished`); `internal/pdf/verdict_rule_test.go`:
`TestAPrintedRunThatAssertedNothingIsNA`. `TestFunctionalVerdict` and
`TestFunctionalVerdictLabelsAreUnchanged` now give their passing row an assertion that passed.

## N46 — What a client of the API meets that it did not before

N36 to N45 record most of what changed on the wire after commit `1d66ca1`. This entry
records the rest: for a client that is not the shipped page, what `/api` answered at
`1d66ca1` and what it answers now. It does not repeat N43 (the bound on body checks and
its `503`, and an assertion value that is an object or an array) or N44 (the parameter
cut, and the 500-character cap on an assertion's path and string value, which did not
exist at `1d66ca1`: such text was accepted at any length the body cap allowed).

**Bodies of `POST /api/send` and `POST /api/runs`.**

- **Content-Type.** Before, it was not read, and a body sent with none was decoded. Now a
  body needs exactly one `Content-Type` naming `application/json`, with no parameter but an
  optional `charset=utf-8`; anything else is a `415`,
  `{"error":"Content-Type must be application/json","field":"body"}`, given before the
  body is read.
- **Over the 256 KiB cap.** Before, a `400` with `"error":"body: payload exceeds the
  262144 byte limit"`. Now a `413` with `"error":"payload exceeds the 262144 byte limit"`
  and `"field":"body"`, whether or not the client sent an honest `Content-Length`.
- **Strict decoding.** Before, the first JSON value was decoded with Go's defaults: data
  after it was ignored, an unknown key was dropped (`{"endpoint":"healthz","url":"x"}`
  was sent and answered `200`), a duplicate key let the last one win, a key matched a
  field whatever its case, and a syntax or type error came back as Go's decoder text after
  `body: `. Now each of these is a `400`:
  - a syntax error, or a body that stops inside a value: `field` `body`,
    `malformed JSON at byte N`;
  - no value, or data after the first one: `field` `body`,
    `body must hold exactly one JSON value`; a value that is not an object:
    `body must be a JSON object`;
  - an unknown key, a key in another case included: `unknown field "url"`, with `field`
    naming the object it is in (`body` at the top level, `sequence[1]` or `assertions[0]`
    inside);
  - a duplicate key: `duplicate key "endpoint"`, with `field` naming the key itself
    (`endpoint`, `params.q`);
  - a value of the wrong type, named by its JSON path and described in JSON's words:
    `options.concurrency` with `expected a whole number, got a string`,
    `sequence[1].params.q` with `expected a string, got a number`; a number too large for
    its field: `the number ... is out of range`.

**Error bodies.** Before, `error` began with the field it named:
`{"error":"sequence[5].assertions[0]: operator \"x\" is not valid ...","field":"sequence[5].assertions[0]"}`.
Now the field is said once, in `field`, and `error` is the sentence alone. A field reads
as the validator writes it (`sequence[2].params.q`, `assertions[0].value`,
`options.concurrency`), `body` stands for the body as a whole, and an error about no part
of the payload carries no `field`. Client text an error quotes (a run id, a key, an
operator, an endpoint id, a path) is cut to its first 64 characters and marked `...`,
never inside a character, and a `field` is at most 200 characters.

**Routes.** Before, a `GET` on an `/api` path no route took was a JSON `404`, and a `GET`
on `/api/send` a JSON `405`; every other wrong verb, and any verb but `GET` on an unknown
`/api` path, got Go's router's plain-text `Method Not Allowed` (`POST /api/nope` was a
`405` with `Allow: GET, HEAD`). Now every `/api` request no route takes is answered in
JSON, with the security headers: a `405` with `Allow` read from the route table when the
path takes another verb (`PUT /api/runs/x` gets `Allow: DELETE, GET, HEAD`), otherwise a
`404`, `no such endpoint "<path>"`, whatever the verb. Outside `/api`, a directory of the
page (`/js/`) used to answer with a listing of its files; it is now a `404`.

**A request that got no response.**

- **The `error` sentence.** Before, `error` on Send's `200` and on a run's result rows
  was Go's transport error, which names the target's internal address and port. Now it is
  one of four fixed sentences, chosen by what failed: `could not connect to the target`,
  `the connection dropped while reading the response` (a status line arrived and its body
  did not), `the target did not respond within 10s`, and
  `stopped by Courier before a response arrived`. `error_kind` is unchanged. The same
  sentences are what the stream, the stored report and the PDF carry; the raw error is
  logged once per failed dispatch as `dispatch_failed`.
- **Its assertions.** Before, they were evaluated against status 0, an empty body and the
  time the failure took, so `latency lt 10000` passed on a quick refusal and
  `status neq 500` passed on the 0 that stood for no status. Now every one fails, keeps
  its `expected`, and reads `"actual":"no response"` with
  `"error":"not evaluated: the request got no response"`. A body that broke off after its
  status line is still evaluated: that status is real.
- **Redirects.** Before, a `3xx` from the target was followed by Go's client, up to ten
  hops, wherever its `Location` pointed. Now the `3xx` is the answer: its status, size and
  body are what Send returns and the assertions read, and a performance run counts it
  under its own status as a response that is not a `2xx`: an error, never `ok`.

**Numbers in assertions.** Before, any number was accepted. Now a `status` value is a
whole number from 100 to 599, a `latency` bound is above 0 ms, and a json `count` is a
whole number of 0 or more; anything else is a `400` at `assertions[j]`, for example
`a status assertion needs a whole number from 100 to 599, got 200.5` or
`a latency bound must be above 0 ms, got -5`. `gt`, `lt`, `eq` and `neq` on a json path
take any finite number, as before.

**What was cut.** Before, nothing told a client that a string had been cut to its cap.
Now Send's `200` carries `truncated`, the fields it cut (`params.q`, `name`, `id`), and
the run's `202` carries the same list in the run's notation
(`sequence[1].params.q`); the key is absent when nothing was cut. N44 states the
parameter rule.

**Available on the wire for other clients.** The shipped page reads `truncated` (below)
and the history row's `verdict`. It does not read:

- the `id:` line on each stream frame, or resuming with `Last-Event-ID` (N38). The page
  opens one stream per run it follows, closes it on `run_finished` and on any error, and
  then reads the run's report every 500 ms until the run ends rather than reconnecting, so
  it never sends `Last-Event-ID` and never waits out the `retry: 60000` line;
- `percentile_samples` on each block of stats (N39): no file of the page names it;
- `Retry-After: 1` on the body check's `503` (N43): the page does not retry (below).

**What the page does that the wire does not require.**

- **An empty value box is refused.** The server accepts an empty string as an
  assertion's value wherever it accepts a string (`json eq ""`, `body_contains ""`). The
  page sends a box left empty, or typed into and erased, as no value at all, so Send,
  Save and Start refuse the row beside the box, as they refuse a box never typed into. A
  comparison with the empty string can be sent by another client, not from the page.
- **The page says what the server cut.** It reads `truncated` into one sentence beside
  Send's answer (`Cut to fit: parameter q (256 characters, 32 words at most).`), and after
  Start names each request by its row in the run, as a refusal of the same run does. A
  field it does not know is shown as it came, clipped.
- **A `503` from Send or Start reads as busy.** The page shows `Busy - ` and the server's
  sentence, gives the control back at once, marks no field and no row, and sends nothing
  again by itself: the visitor presses again. **Amends N43**, which says the page shows the
  sentence after `Refused - ` on Send and after `Could not start the run - ` on Start.

**Proof:** `internal/api/server_test.go`: `TestPostBodiesMustBeDeclaredJSON`,
`TestOversizeBodiesAre413AtTheExactCap`, `TestOversizeBodiesWithoutAnHonestLengthAre413`,
`TestBodiesAreDecodedStrictly` (every decoding case above),
`TestAClientSuppliedTargetIsRefusedByName`, `TestRefusedBodiesNameTheKeyAndDispatchNothing`,
`TestTheBrowserClientsPayloadsStillDecode`, `TestWrongVerbOnAnAPIPathAnswers405`,
`TestUnknownAPIPathsAnswerAJSON404ForEveryVerb`, `TestEveryVerbOnEveryAPIPathAnswersJSON`;
`internal/api/handler_edges_test.go`: `TestWrongContentTypeIsRefusedBeforeTheBodyIsRead`;
`internal/api/runs_test.go`: `TestErrorBodiesStateTheFieldOnce`,
`TestStartedRunReportsTruncatedFields`; `internal/api/echo_clip_test.go`:
`TestUnknownRunErrorsClipTheID`, `TestUnknownRunErrorsQuoteAShortIDWhole`;
`internal/api/decode_bounds_test.go`: `TestErrorBodiesBoundWhatTheyEcho`;
`internal/api/target_address_test.go`: `TestAdversarialBodiesGetTheOneErrorShape`,
`TestAHugeMultibyteRunIDIsClippedOnARuneBoundary`; `internal/api/static_test.go`:
`TestDirectoriesAreNotListed`; `internal/api/send_test.go`:
`TestSendFailuresCarryFixedMessagesAndNoAddress`, `TestSendLogsTheRawErrorOnce`,
`TestRunSurfacesCarryNoTargetAddress`, `TestSendEvaluatesNoAssertionWithoutAResponse`,
`TestSendRecordsARedirectWithoutFollowingIt`, `TestSendRefusesAMeaninglessAssertion`,
`TestSendReportsTruncatedParameters`; `internal/runner/exec_test.go`:
`TestFailedDispatchesCarryFixedMessages`, `TestRedirectsAreRecordedNotFollowed`;
`internal/runner/functional_test.go`: `TestFunctionalRowsCarryFixedMessagesAndNoAddress`,
`TestAssertionsAreNotEvaluatedWithoutAResponse`, `TestAssertionsReadTheStatusOfADroppedBody`,
`TestFunctionalRecordsARedirectWithoutFollowingIt`; `internal/runner/perf_test.go`:
`TestPerfRecordsRedirectsWithoutFollowingThem`; `internal/runner/broken_target_test.go`:
`TestRedirectsOfEveryShapeStayOnTheTarget`, `TestNoResponseFailsEveryOperator` (which
also holds `contains ""` to be a valid assertion); `internal/assert/assertion_test.go`:
`TestValidateAssertionRefusesMeaninglessNumbers`; `internal/sandbox/validate_test.go`:
`TestAssertionStringsOverTheCapAreRefused`, `TestTruncationsNameWhatWasCut`;
`web/test/live.test.mjs`: `a stream error falls back to polling`,
`a stream that ends before run_finished is polled at once, and the poll delivers the end`;
`web/test/empty-value-box.test.mjs` (an erased box refused by Send, Save and Start, and
the rule that mirrors the server still accepting an empty string);
`web/test/cut-note.test.mjs` (the sentence after Send and after Start);
`web/test/server-busy.test.mjs` and `web/test/param-marks-busy-edges.test.mjs` (the
`503` read as busy on both, never retried).
