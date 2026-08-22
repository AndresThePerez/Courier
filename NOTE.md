# NOTE — deviations from the Implementation Plan

Running log of places where the code intentionally differs from
`Implementation Plan.md` / `Implementation Plan Addendum — Employer Appeal.md`,
and why. Each entry names the task it affects so the next agent can pick it up.

---

## N1 — Dev target port is 8081, not 8085 (Task 1, Task 21)

**Plan says:** "Local environment facts" documents the local Pokesearch target on
`APP_PORT=8085`, brought up with `docker compose up -d` from `~/Repositories/pokesearch`.

**What we do instead:** the documented dev target is `http://127.0.0.1:8081`, and
`docker compose` is never run from `~/Repositories/pokesearch`.

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
and the coordinator's instruction is to encode the new contract rather than the live
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
only reachable target is the shared dev instance on 8081, which another session rebuilds at
task boundaries and which still serves a **partial** M3 contract, and
`docker compose` must not be run from `~/Repositories/pokesearch`. Verifying against it
would produce a false red (or, worse, a false green on the old lenient build).

Every value in the curated set comes from the plan's verified fixture table and the spec's
measured profile. **The verification is owed at Phase 7/8**, where the spec already requires
it: run the full curated suite against the deployed target and require zero assertion
failures *before* announcing the URL. The M3 `400` assertions are the ones most likely to
move, since they were written against a contract document rather than a running server.

The API was still verified end to end by hand (Task 14 step 5) against a local stub target
on 127.0.0.1:8086 — every route, the 400/404/409 paths, the SSE replay, `/metrics`, pprof
reachability, and SIGTERM shutdown.

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
