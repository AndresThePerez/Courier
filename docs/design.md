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
implementation, not a model of it**, over a simulated ≥24-hour horizon per
shape (simulated clock; it runs in normal CI time). Measured sustained duty
cycles against the derived 10.0% bound:

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
[`NOTE.md`](../NOTE.md), entries N10/N10a/N20): refill accrues **continuously,
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
  source-verified Pokesearch M3 contract, kept as data in exactly one place.
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
([`internal/api`](../internal/api), NOTE.md N25).

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
request (NOTE.md N14), and a test pins that foreign cancellations are *not*
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

The principle: **an unfalsifiable green is worse than no verdict**. The same
principle shows up at the edges — `Verdict` fails a run with zero dispatches
rather than vacuously passing it (NOTE.md N7), and curated assertion values
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
  apart ([`internal/sse`](../internal/sse), `web/js/api.js`, NOTE.md N22/N28).
  `run_finished` publishes only after the report is stored, so fetch-on-finish
  is race-free by construction (N12) — and there is a test that pins it.

---

## Where the deviations live

Every place the implementation deliberately differs from the written plan is a
numbered entry in [`NOTE.md`](../NOTE.md) — what the plan said, what the code
does, and why, from N1 (dev-target port) through the budget reading (N10),
SSE wire decisions (N22), and the PDF's determinism mechanics (N30). The log
exists so no future session rediscovers a decision the hard way.
