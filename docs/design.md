# Courier — design notes

The stories behind the load budget, the sandbox, and the metrics model: what was
designed, what was falsified, and what replaced it. Every claim here links to an
in-repo proof — a test, a benchmark, or a measured number — so the arc is
claim → mechanism → proof without needing anything outside this repository.

---

## The cooldown that failed simulation, and the budget that replaced it

Courier runs one load test at a time against a live public service, so something
has to bound the *aggregate* load a stream of anonymous visitors can produce.
Three designs were tried. Two died under review. The third carries a proof.

**Attempt 1 — a flat 10-second cooldown** between runs. Simple, and wrong: it
bounds *concurrent* load but not *sustained* load. A script that starts a
maximum run (50 workers × 30s), waits out the 10s, and repeats holds the target
at a **~75% duty cycle forever**. The cooldown reads as protection and provides
almost none.

**Attempt 2 — tiered cooldowns** keyed on how many runs finished in a rolling
window (10s / 60s / 300s). This is the design that *sounded* airtight and
claimed a ~9% duty cycle. Simulating it falsified three separate claims:

1. **The bound was false.** Each long cooldown ages runs out of the rolling
   window, dropping the tier back down, so the system oscillates between tiers
   instead of holding the top one. Measured duty cycle: **~24%, not the claimed
   9%.**
2. **It measured the wrong thing.** A run cancelled after one second counted
   exactly like a 30-second 50-worker blast. Six start-cancel cycles could hold
   the global cooldown active **~99.9% of the time at under 1% of the load** —
   a denial-of-availability lever that cost the attacker almost nothing.
3. **It punished the happy path.** Walking the curated collections is a handful
   of *functional* runs — near-zero load — yet the run counter escalated an
   honest visitor to a 300-second wall.

All three failures share one root cause: **counting events instead of pricing
load.**

**Attempt 3 — a token bucket priced in worker-seconds**, the unit that actually
tracks cost to the target. A run consumes `workers × elapsed_seconds` (functional
mode counts as one worker). The bucket refills at `R = 5` worker-seconds per
second, holds at most `B = 1500` (exactly one nominal maximum run, so a visitor
arriving after a quiet period never waits), and the cooldown is nothing but the
time the balance needs to climb back to zero, floored at 5 seconds:

```
cooldown = max(5s, −min(balance, 0) / R)        balance ≤ B (refill clamps at the cap)
```

This is classic **token-bucket admission control**, applied to run admission
rather than packet forwarding. It fixes all three failures at once:

- **The bound is exact, and it is `R / max_workers`.** Sustained consumption
  cannot exceed the refill rate — the only way to acquire budget is to wait for
  it — so a determined script is held to `5/50` = a **10% duty cycle at maximum
  concurrency**, forever. No schedule of runs beats it.
- **A cancel costs exactly what it consumed.** A 50-worker run cancelled after
  one second debits 50 worker-seconds, not a tier. Start-cancel spam converges
  to the same 10% bound as everything else.
- **The curated stroll is free.** The full curated suite costs ~18
  worker-seconds against a bucket refilling 5 per second — an honest visitor
  never leaves the 5-second floor.

**The proof is executable and in-repo:** [`internal/budget/budget_sim_test.go`](../internal/budget/budget_sim_test.go)
ports the adversarial simulation into a Go test **against the real budget
implementation, not a model of it**, driving the bucket through both of its
charge paths (`Spend` for a run, `Debit` for a send), over a simulated
≥24-hour horizon per shape (simulated clock; it runs in normal CI time).
Measured sustained duty cycles against the derived 10.0% bound:

| Traffic shape | Measured duty cycle |
|---|---|
| Maximum runs back-to-back | **10.031%** |
| Start → immediate-cancel spam | **10.035%** |
| Interleaved send + run | **10.031%** |
| Curated happy path | **0.75%** |

The bound holds and is tight: the adversarial shapes converge to 5.016
worker-seconds/second against `R = 5`, matching the design claim to three
figures. Run it with `go test ./internal/budget/ -run Sim -v`.

Two implementation notes that matter to the proof (details in
[`docs/deviations.md`](deviations.md), entries N10/N10a/N20): refill accrues **continuously,
including while a run is in flight** — that is the reading under which the
convergence claim is exactly true (a no-in-run-refill model converges to 4.55,
not 5.0) — and `/api/send` **debits the bucket but never opens a cooldown
window**, because the one-send-in-flight rule already caps that path at one
worker-second per second; its debit simply lengthens the next run's cooldown,
and total load still converges on `R`.

**Accepted limitation, stated on purpose:** the budget is global and
identity-free, so a determined griefer can deny *availability* by consuming it.
That is the right trade — the guarantee that matters is that the **host** stays
protected, and the bucket delivers exactly that. Per-IP fairness, if it ever
matters, belongs at the Cloudflare edge, not in Courier.

---

## The sandbox boundary: the server never accepts a URL

A load tester that takes a target URL from the browser is a DDoS cannon with a
nice UI. Courier's security core is that the client cannot express a target at
all:

- A run payload is `{endpoint_id, params, assertions}` — never a host, never a
  path. The target base URL is fixed at startup from the environment; paths come
  from a server-side endpoint catalog that is a **closed set**
  ([`internal/sandbox/catalog.go`](../internal/sandbox/catalog.go)).
- Every endpoint carries an ordered **parameter allowlist** — the real,
  source-verified PokéSearch M3 contract, kept as data in exactly one place.
  Unknown keys are rejected; values are truncated to a length bound.
- Curated and visitor-edited requests pass through **identical validation**
  ([`internal/sandbox/validate.go`](../internal/sandbox/validate.go)) — the
  server trusts neither.
- Numeric knobs **clamp** (concurrency 50, duration 30s); structural violations
  **reject** with a field-naming 400. The distinction is deliberate: clamping a
  number is harmless, silently "fixing" a malformed sequence is not.

The same posture extends inward: `/metrics` is a hand-rolled expvar map that
deliberately does not expose `cmdline`/`memstats` (a public demo should not
hand out its own command line), and pprof lives on a **loopback-only listener
that refuses to bind anywhere else** — `PPROF_ADDR=0.0.0.0:6060` fails loudly
instead of quietly publishing process memory
([`internal/api`](../internal/api), docs/deviations.md N25).

---

## Metrics accounting: aborted is a category, not an error

The report model was rebuilt once, after two falsifiable defects surfaced:

**Double-counting.** The first model counted a 503 twice — once as a latency
sample, once as an error — so `requests != ok + errors` under degradation.
The rebuilt model ([`internal/report`](../internal/report)) counts
**dispatches**: every dispatch lands in exactly one of `ok / error / aborted`,
and the invariant `requests == ok + errors + aborted` is asserted in tests.
Non-2xx responses keep their latency samples — a 503 has both a latency and an
error, and the histogram must show it.

**Phantom errors from cancellation.** Cancelling a 50-worker run abandons ~50
in-flight requests. Counted naively as transport errors, a visitor pressing
Cancel would manufacture ~50 red rows the target never earned and flip the
verdict to FAIL. So **aborted dispatches are their own category**: killed by
Courier's own context cancellation (cancel, SIGTERM, deadline), attributed to
Courier, never to the target. In functional mode the same rule renders an
aborted entry as `skipped`, and a cancelled or expired run's verdict is
**"N/A — partial data"** rather than a PASS/FAIL computed from a truncated
sample. Classification handles both shapes `net/http` produces for a cancelled
request (docs/deviations.md N14), and a test pins that foreign cancellations are *not*
laundered into aborts.

**Coordinated omission, disclosed.** Courier is a closed-loop tester — workers
wait for responses, like `hey` — so under saturation it understates tail
latency relative to an open-loop fixed-rate design (`vegeta`). That is fine for
this demo and it is stated in the README and in every report footer, because
the honest version of a load-testing story includes what the numbers cannot say.

---

## The SLO recalibration: verdicts that can actually fail

The original SLOs (p95 ≤ 200ms) were written before the target was profiled.
Profiling the live corpus showed p95 at 50 workers was **59ms** — the verdict
could never fail, which makes it not a verdict but a decoration. Revision 2
recalibrated every judgment surface against measured reality:

- Verdict gate: **p95 ≤ 50ms** and error rate < 1%.
- SLA ladder: **25 / 50 / 100 ms** (was 100/200/500 — all always-green).
- Apdex **T = 25ms**.
- Histogram buckets **0–5 / 5–10 / 10–25 / 25–50 / 50–100 / 100+ ms**.

The calibration then ran a second time, by design, at deploy (the spec's Deployment
step 5): the deploy host is a 4-core Ryzen 3 2200G with Elasticsearch capped at 1 GB,
and its measured series (p95 38.6 → 407.9 ms across 1 → 50 workers) sat entirely above
the dev-calibrated gate — a verdict that could never *pass* there, the same defect
mirrored. The shipped constants are re-derived from the deploy measurement to keep the
falsifiable shape (PASS at 1 and 10 workers, FAIL at 25 and 50): verdict gate
**p95 ≤ 150ms**, ladder **50 / 150 / 300 ms**, Apdex **T = 50ms**, buckets
**0–25 / 25–50 / 50–100 / 100–200 / 200–400 / 400+ ms**. Both measurements are in
[docs/knee.md](knee.md).

The principle: **an unfalsifiable green is worse than no verdict**. The same
principle shows up at the edges — `Verdict` fails a run with zero dispatches
rather than vacuously passing it (docs/deviations.md N7), and curated assertion values
come from a pinned, measured fixture corpus, not estimates.

---

## The run engine, briefly

Details live in the code; the shape is worth stating:

- **Two contexts per run, in both modes.** The dispatch context carries the
  mode's deadline; each request executes under its own ~10s client timeout. At
  the deadline no new dispatches start, but in-flight requests complete and
  count — a single deadline context would cancel them and turn honest tail
  latency into fake transport errors.
- **Fan-in aggregation, one owner.** Worker results fan into one buffered
  channel; a **single aggregator goroutine owns all run state**, selecting over
  results and a 250ms ticker. No atomics, no mutexes, no torn progress
  snapshots — measured at **115 ns per result, 0 allocations**
  ([`internal/runner/bench_test.go`](../internal/runner/bench_test.go)), which
  at the measured peak throughput costs ~0.02% of one core.
- **Engine overhead ≈ 1.8 µs per dispatch** — the measured difference between
  the perf-mode dispatch path and a bare `http.Client` baseline, i.e. ~0.007%
  of a real 25ms request. The tool stays out of its own measurement.
- **Graceful degradation over silent loss, everywhere.** A slow SSE subscriber
  is disconnected (the reconnect replay log restores complete state) rather
  than silently starved; over the subscriber cap the stream endpoint answers
  `503 {"poll": true}` and the client falls back to 500ms polling of the same
  report shape; both transports feed one reducer, so the UI cannot tell them
  apart ([`internal/sse`](../internal/sse), `web/js/api.js`, docs/deviations.md N22/N28).
  `run_finished` publishes only after the report is stored, so fetch-on-finish
  is race-free by construction (N12) — and there is a test that pins it.

---

## Where the deviations live

Every place the implementation deliberately differs from the written plan is a
numbered entry in [`docs/deviations.md`](deviations.md) — what the plan said, what the code
does, and why, from N1 (dev-target port) through the budget reading (N10),
SSE wire decisions (N22), and the PDF's determinism mechanics (N30). The log
exists so no future session rediscovers a decision the hard way.

---

## Try it in 60 seconds

*The README keeps a four-step summary of this walkthrough; "the table above" is its
[numbers table](../README.md#the-numbers).*

Open the [live demo](https://courier.andrestheperez.com), then:

1. Expand **01 — Search Basics** in the sidebar and click **Add all to run**, then
   **Start Run** — watch functional results stream in live, row by row, each with its
   assertion outcomes.
2. Switch the mode to **Performance** and press **10 workers - the knee** in the
   **Find the breaking point** panel, which loads the same five-request sequence
   the table above was measured with. Start it and watch the live counters, then
   the verdict, SLA ladder, Apdex and histogram render from the finished report.
   Then climb to 25 or 50 workers and watch the verdict flip: that is the knee,
   and the flip is the point of having a gate at all.
3. Open any request in the editor, change a parameter, and **Send** it. Try an illegal
   value (`page_size=abc`) — the field-naming `400` that comes back is the target's
   strict contract, surfaced verbatim. Courier's own sandbox sits in front of it:
   param *keys* are chosen from each endpoint's server-provided allowlist, and anything
   outside it is refused before a byte reaches the target. Editing a built-in request
   forks a private copy into **My Workspace** (fork-on-write; the curated tree never
   mutates).
4. Expand **05 — Randomized Traffic**: those params are template variables —
   `{{randomWord}}` and `{{randomPokemon}}` resolve to a fresh random value for
   every dispatched request, so a performance run queries something different
   each iteration. Note their loose assertions next to the exact totals the
   curated searches pin: assertions are per-request choices, editable in the
   Request tab.

---

## Architecture

Routes are registered with method-scoped patterns, so the verb is part of the contract.
`pprof` is deliberately *not* on this mux — it gets its own loopback-only listener.
`SIGINT` and `SIGTERM` start a graceful shutdown whose order is the whole trick: the
in-flight run is cancelled first, which bounds the drain by one request instead of a
whole run and releases the SSE handlers, and only then does the HTTP server stop, since
a live stream is an active handler by design and would otherwise hold it open forever.

---

## Design decisions

- **The server never accepts a URL from the client.** A run payload is
  `{endpoint_id, params, assertions}`; the target is fixed at startup and paths come
  from a closed server-side catalog with per-endpoint parameter allowlists. Curated and
  visitor-edited requests pass identical validation. A load tester that takes a target
  URL from the browser is a DDoS cannon with a nice UI — this one physically cannot be.
- **The cooldown is a load budget** — a token bucket in worker-seconds (refill 5/s,
  burst 1500, 5s floor). Sustained load provably converges to `R / max_workers` = a
  **10.0% duty cycle** under every adversarial shape; the in-repo simulator
  (`go test ./internal/budget/ -run Sim`) measures 10.03% for max-runs, cancel-spam,
  and interleaved traffic, and **0.75%** for the curated happy path. Cancels cost
  exactly what they consumed; honest visitors never leave the 5s floor. This is the
  admission control layer, and it sits in one place: a run is admitted only when the
  bucket can pay for the worker-seconds it asks for, and is refused with its
  `cooldown_until` when it cannot.
- **Walk me through the concurrency:** two contexts per run (the dispatch deadline
  never cancels an in-flight request — that would turn honest tail latency into fake
  transport errors); N workers fan results into one channel; **a single aggregator
  goroutine owns all run state** — no atomics, no mutexes, no torn snapshots. Share
  memory by communicating, one owner per piece of state.
- **Aborted is a category, not an error.** Requests killed by Courier's own
  cancel/deadline/shutdown are attributed to Courier, never to the target — so a
  visitor pressing Cancel cannot manufacture a failing verdict. Cancelled and expired
  runs render **"N/A — partial data"** instead of a verdict computed from a truncated
  sample, and a completed run whose sequence is not the calibrated five-request
  `search-basics` collection renders a plain N/A with a reason naming that calibration,
  withholding only the judgement. The invariant `requests == ok + errors + aborted` is
  tested.
- **Live updates degrade, never lie.** SSE first (2s heartbeat, a 512-entry replay log
  on subscribe, so a mid-run spectator repaints complete state from the replay log); a
  slow subscriber is disconnected and self-heals via replay rather than silently losing
  rows; past the 100-subscriber cap the server answers `503 {"poll":true}`. Both of
  those are backpressure, and both put the cost on the reader: a subscriber that cannot
  keep up, or one subscriber too many, never slows the run or bends its numbers. A
  transport error then hands the run to 500ms polling of the same report shape for the
  rest of the run, because the shipped client routes every `EventSource` error to the
  fallback and closes the source; the replay log is what the server guarantees a fresh
  subscriber, not a reconnect the browser performs. Both transports feed one
  reducer — no render code knows which is active. SSE meets the Cloudflare tunnel at
  deploy; the fallback exists because buffering there would otherwise kill live
  results outright.
- **The transport is tuned for measurement:** `MaxIdleConnsPerHost` ≥ worker count
  (Go's default of 2 would thrash connections and distort latency), every body drained
  to `io.Discard` so connections are reused, latency measured to end-of-body in both
  modes so the numbers are comparable with `hey`.
- **One direct dependency** (`go-pdf/fpdf`), stdlib for everything else — including
  the SSE broadcaster, the token bucket, the histogram, and the frontend (vanilla ES
  modules served from `embed.FS`).

---

## Observability

Courier instruments itself, not only its target. `/metrics` is a curated expvar
map (no `cmdline`, no `memstats`: a public demo should not hand out its own
command line), and pprof binds loopback-only and **refuses** any other address
rather than quietly publishing process memory. Every engine log line for a run
that started is structured JSON carrying an `event` name and a `run_id`, so one
`jq` filter returns a single run's complete story including the admission
decision and the budget arithmetic behind its cooldown. Requests that arrive
through the edge log its request id, so a visitor's report can be joined to a
server log line.

What is deliberately absent, since the honest version of an observability story
includes its limits: no metrics history (every counter resets on redeploy and the
twenty-run history ring is in memory), no Prometheus exposition format, no
scrape target, no tracing, and no alerting. For a single binary with one direct
dependency that is the right amount; it is named here rather than left for a
reader to notice.

---

## Caps

Server-enforced regardless of client input. Structural violations are **rejected**;
numeric knobs are **clamped**.

The table of values stays in [the README](../README.md#caps).

---

## Engine overhead

Courier measures a target, so its own cost has to be small enough not to be part of
the measurement. `go test -bench` numbers on a Ryzen 5800X:

| Operation | Cost | Allocations |
|---|---|---|
| Per-dispatch engine overhead, performance mode (`DispatchDrain` − bare-client baseline) | **~1.8 µs** | +11 |
| Fan-in aggregator, record one result | 115 ns | 0 |
| JSON path lookup, shallow (`$.total`) | 132 ns | 1 |
| JSON path lookup, deep (`$.results[23].attacks[0].cost[3]`) | 661 ns | 3 |
| Assertion evaluation, `status` / `latency` | 131 / 143 ns | 2 / 4 |
| Assertion evaluation, `json` ops | 245–511 ns | 4–7 |
| Assertion evaluation, `body_contains` (body folded once at decode) | 284 ns | 4 |
| Decode + fold one 36KB search response (`NewTarget`) | 438 µs | 5,998 |
| **Full functional request: decode + 20 assertions at the cap** | **452 µs** | 6,141 |
| Percentile over 1k / 18k / 100k samples | 1.7 ns (O(1)) | 0 |
| `ComputeStats` over 18k samples (sort + percentiles + ladder + Apdex + histogram) | 1.06 ms | 6 |
| Record one response into a `Tally` | 31 ns | 0 |

Reading them: a functional request costs ~452 µs of Courier against 1–30 ms of network
and target time. **Performance mode does none of that work** — no assertion evaluation,
bodies straight to `io.Discard` — which is what the 1.8 µs figure measures, about
0.007% of a real 25ms request at 50 workers.

**Whole-process footprint during a maximum run** (50 workers × 30s, 20,624 requests
against the live target, measured from `/proc`): **3.3 CPU-seconds — about 10% of one
core** (~160 µs of total process CPU per request, kernel networking and SSE included)
and a **peak RSS of 20 MB**. That is the co-hosting cost the Host decision discloses:
running the tester next to the target spends a tenth of a core and twenty megabytes.

---

## What happens when the target dies

Evidence, not claims, because reliability asserted is reliability unmeasured. This is a
chaos drill: during a 10-worker 15-second run the target process was SIGKILLed at the
5-second mark, on purpose. The run **completed cleanly at its full duration** —
974,606 dispatches accounted as 5,910 ok + 968,696 errors + 0 aborted (the invariant
holds), every failure attributed as a `connection` error with status `0 (transport
error)`, Apdex 0.006, verdict FAIL at a 99.39% error rate. No phantom aborts, no wedged
lock (`/api/status` returned `running:false` immediately after), history intact, and the
next run — target restored — passed at 100% 2xx without restarting Courier. The saved
report, the rendered dashboard screenshot, and the drill notes are in
[docs/failure-story/](failure-story/).

---

## Closed-loop honesty note

Courier is a **closed-loop** tester: workers wait for each response before issuing the
next, like `hey`, not open-loop fixed-rate like `vegeta`. Under saturation this
understates tail latency (coordinated omission). That is a fine trade for this
demonstration, and it is stated plainly here and in the report footer rather than
quietly assumed. Tester and target also share one host over the internal network —
Courier's per-request work is measured above precisely so that contention stays
disclosed rather than hidden in the target's numbers.

---

## Running locally

*The commands these notes annotate stay in the README's
[Running locally](../README.md#running-locally) section.*

Courier needs a target to point at. Any HTTP service that serves the endpoint catalog's
paths will do — the live demo uses PokéSearch. Note that the curated collections'
assertions are pinned to the 20,324-card PokéSearch index, so against a different target
the app runs fine but those assertions will fail; edit them in the Request tab, or read
the run as a load test rather than a functional one.

Any free port works; these examples use `8084` to match the port the Compose files
publish.

Container:

The base file publishes `${APP_PORT:-8084}:8080`; the dev overlay points the container
at a host-side target via `host.docker.internal` (see [docs/deviations.md](deviations.md) N31 for the Compose
deep-merge and firewalld caveats).

The runtime stage is distroless (`gcr.io/distroless/static-debian12:nonroot`, pinned by
digest and running as uid 65532): no shell, no package manager, nothing to exec into.
The static binary it copies in measures **11.8 MB** here
(`CGO_ENABLED=0 go build -trimpath -o /tmp/courier-size ./cmd/server` on the dev
workstation), so the image is that plus the distroless base, which is the honest way to
state it when nothing in this repository measures an image.
