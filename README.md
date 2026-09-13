# Courier

[![CI](https://github.com/AndresThePerez/Courier/actions/workflows/ci.yml/badge.svg)](https://github.com/AndresThePerez/Courier/actions/workflows/ci.yml)
[![Go](https://img.shields.io/badge/go-1.26-00ADD8?logo=go&logoColor=white)](go.mod)
[![Dependencies](https://img.shields.io/badge/direct%20deps-1-brightgreen)](go.mod)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

### **[Live demo → courier.andrestheperez.com](https://courier.andrestheperez.com)**

Courier is a Postman-style API test runner and load tester that ships as **one Go binary**: an embedded three-pane UI, curated request collections, a sequential **Functional** runner with declarative assertions, and a worker-pool **Performance** engine with fan-in aggregation. Results stream live over **SSE with reconnect replay and a polling fallback**, aggregate load is priced against a **token-bucket admission budget**, and any report exports as a single-page PDF rendered in pure Go. Stdlib everywhere, one direct dependency (the PDF writer), no frontend build step.

The interesting constraint is that it is *public*. A load tester exposed to the internet is a DDoS cannon with a nice UI unless the design forbids it, so the server never accepts a URL from the client — a run payload is `{endpoint_id, params, assertions}` against a target fixed at startup and a closed server-side endpoint catalog. Sustained load is bounded in worker-seconds by a token-bucket budget whose 10% duty cycle is proven by an in-repo simulator rather than asserted; request volume is bounded only in proportion to target latency, because a dead target and a healthy one are charged the same worker-seconds and the dead one dispatches far more requests for them. Run state is owned by exactly one goroutine (no atomics, no mutexes, no torn snapshots), and Courier publishes its own per-dispatch overhead so you can see it is not part of the measurement.

![Courier's three-pane UI: collections sidebar, the Find the breaking point panel with the measured knee curve, and the run configuration pane](docs/hero.png)

## The numbers

Measured against the pinned 20,324-document Pokesearch index (Milestone 3 build) on
the deploy host, over the internal container network — the numbers the live demo's
panel shows and its SLOs are calibrated to:

| workers | req/s | p50 | p95 | error rate | verdict (p95 ≤ 150ms) |
|---:|---:|---:|---:|---:|---|
| 1 | 46.4 | 29.24 ms | 38.64 ms | 0.00% | PASS |
| **10** | **154.1** | **70.36 ms** | **118.80 ms** | **0.00%** | PASS |
| 25 | 166.5 | 147.85 ms | 262.24 ms | 0.00% | FAIL |
| 50 | 174.8 | 281.83 ms | 407.93 ms | 0.00% | FAIL |

![Throughput and p50 latency against worker count — the knee is at ~10 workers](web/knee.svg)

**The knee is at ~10 workers on this hardware.** Ten workers already deliver 88% of
everything the target ever gives up; 25 buys +8% throughput for double the median
latency, and 50 buys +5% for double again — past the knee the extra concurrency is
queueing, not working. Error rate stays 0.00% at every point (the target degrades
gracefully rather than falling over), and the SLO verdict flips *between* 10 and 25
workers, which is the point of having one. The same series on the dev workstation (a
5800X: knee ~25, peak 692 req/s), the raw data, run ids, and methodology are in
[docs/knee.md](docs/knee.md). Reproduce any point in one click from the UI's
**Find the breaking point** panel. The table prints p50 and p95; every run's report
carries the whole ladder, min, avg, p50, p90, p95, p99 and max, taken nearest-rank so a
published p99 is a latency some request actually experienced rather than an
interpolation between two that did not.
The target is [Pokesearch](https://github.com/AndresThePerez/PokeSearch), an
Elasticsearch search engine for a 20,324-card Pokemon TCG corpus, also built
here: Courier load-tested it and found its knee at ten workers, which is the
number above.

Courier's own cost stays out of the measurement: **engine overhead is ~1.8 µs per
dispatch** (measured: perf-mode dispatch vs a bare `http.Client` baseline), the fan-in
aggregator records a result in **115 ns with zero allocations**, and the sustained-load
ceiling is **provably 10% duty cycle at maximum concurrency** — an executable proof, not
a promise (see below).

**And when the target died mid-run, the run finished cleanly and the accounting
held to the dispatch:** 974,606 dispatches as 5,910 ok plus 968,696 errors plus 0
aborted, every failure attributed to the transport rather than to the target, no
phantom aborts and no wedged lock. The drill, the stored report and the rendered
dashboard are in [what happens when the target dies](#what-happens-when-the-target-dies).

## Tests and CI

214 test functions and 16 benchmarks, per-package coverage of **87.0% to 100%
on every package that carries logic**, and the **race detector** on every push.
The two packages where a defect would cost the most are the two highest:
`internal/report`, the accounting maths, at 96.4%, and `internal/sandbox`, the
security boundary, at 96.8%. CI runs `go vet`, `go test -race`, `go build`, a
`go mod tidy` cleanliness gate, `gofmt`, `staticcheck`, `govulncheck`, a coverage
floor, and the Docker image build. The load-budget proof and the PDF's
byte-determinism are tests, so both re-run on every push.

The coverage range is stated rather than badged on purpose: `cmd/server` carries
no test file of its own and the end-to-end acceptance matrix is build-tagged, so
one repository-wide number would read lower than the floor every package that
carries logic actually clears.

## Try it in 60 seconds

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

![A hand-assembled functional sequence streaming its results live over SSE, one row per request as each response lands, every row carrying its own assertion outcomes](docs/sse-run.gif)

## Architecture

```
Browser (vanilla ES modules, embedded in the binary — no build step)
  └─▶ Cloudflare edge → cloudflared tunnel
        Courier container (Go, net/http, stdlib-first)
          /                         → embedded static UI (embed.FS)
          /api/collections          → curated collections + endpoint catalog
          /api/runs                 → POST start · GET history (in-memory ring)
          /api/runs/{id}            → GET report (partial while running — the
                                      polling fallback) · DELETE cancel
          /api/runs/{id}/stream     → SSE live results (replay log on subscribe)
          /api/runs/{id}/report.pdf → single-page PDF export (pure Go)
          /api/send                 → the editor's single-request Send
          /api/status               → {running, run_id?, cooldown_until?, ...}
          /metrics · /healthz       → self-telemetry (expvar) · liveness
              ── internal Docker network ──▶ target service (never via the public edge)
```

Routes are registered with method-scoped patterns, so the verb is part of the contract.
`pprof` is deliberately *not* on this mux — it gets its own loopback-only listener.
`SIGINT` and `SIGTERM` start a graceful shutdown whose order is the whole trick: the
in-flight run is cancelled first, which bounds the drain by one request instead of a
whole run and releases the SSE handlers, and only then does the HTTP server stop, since
a live stream is an active handler by design and would otherwise hold it open forever.

On the live deployment the target is Pokesearch. Requests display as
`pokesearch.andrestheperez.com`; Courier executes them over the internal container
network, so the numbers measure the target — not Cloudflare's edge, not the tunnel.

## Design decisions

The full stories — including the two admission-control designs that failed simulation
before the budget — are in [docs/design.md](docs/design.md). The short list:

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

## Sandbox model

**The server never accepts a URL from the client. Ever.**

A run payload is `{endpoint_id, params, assertions}` — never a host, never a path. The
target base URL comes from the `TARGET_URL` environment variable and is fixed at startup;
paths come from a server-side endpoint catalog that is a closed set. Each endpoint carries
its own ordered parameter allowlist, and that allowlist is the single source of truth:
unknown keys are rejected, values are truncated to the length bound, and curated and
visitor-edited requests go through identical validation. Any code path that would let a
run payload influence the host is a design violation, not a bug.

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

## Caps

Server-enforced regardless of client input. Structural violations are **rejected**;
numeric knobs are **clamped**.

| Cap | Value |
|---|---|
| Max concurrency (performance) | 50 workers (clamped; default 10) |
| Max duration (performance) | 30s (clamped; default 10s) |
| Max wall-clock (functional) | 120s hard deadline; remaining entries marked skipped |
| Concurrent runs | 1 globally — `409 Conflict` |
| Cooldown between runs | A global load budget: token bucket in worker-seconds (refill 5/s, burst 1500), floored at 5s; `409` with `cooldown_until` |
| Per-request timeout | 10s hard `http.Client.Timeout` |
| Max requests per sequence | 50 (rejected) |
| Max assertions per request | 20 (rejected) |
| Functional `delay_ms` | ≤ 1000 (clamped) |
| Param value length | ≤ 500 chars (truncated, not rejected) |
| Param/request name length | ≤ 120 chars (truncated) |
| API request payload | ≤ 256 KiB (rejected) |
| Response body read for assertions | ≤ 1 MiB (truncated) |
| Response body stored on a run result | ≤ 16 KiB preview |
| Response body kept by the editor's **Send** | ≤ 256 KiB — the one response a visitor is actively reading is not cut to the preview size |
| Run history | last 20 runs (in-memory ring) |
| SSE subscribers per run | 100, then `503 {"poll":true}` |
| Concurrent single-request sends | 1 globally — `429` |

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
[docs/failure-story/](docs/failure-story/).

## Closed-loop honesty note

Courier is a **closed-loop** tester: workers wait for each response before issuing the
next, like `hey`, not open-loop fixed-rate like `vegeta`. Under saturation this
understates tail latency (coordinated omission). That is a fine trade for this
demonstration, and it is stated plainly here and in the report footer rather than
quietly assumed. Tester and target also share one host over the internal network —
Courier's per-request work is measured above precisely so that contention stays
disclosed rather than hidden in the target's numbers.

## Running locally

Courier needs a target to point at. Any HTTP service that serves the endpoint catalog's
paths will do — the live demo uses Pokesearch. Note that the curated collections'
assertions are pinned to the 20,324-card Pokesearch index, so against a different target
the app runs fine but those assertions will fail; edit them in the Request tab, or read
the run as a load test rather than a functional one.

```bash
# Serve Courier on 8084, pointed at a target listening on 8081.
PORT=8084 TARGET_URL=http://127.0.0.1:8081 go run ./cmd/server

curl -s localhost:8084/healthz    # -> {"status":"ok"}
# then open http://localhost:8084/
```

Any free port works; these examples use `8084` to match the port the Compose files
publish.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port the embedded UI and API listen on |
| `TARGET_URL` | `http://127.0.0.1:8081` | Base URL of the target under test. Fixed at startup — never client-supplied |
| `TARGET_DISPLAY` | `pokesearch.andrestheperez.com` | Friendly target name shown in the UI and the PDF |
| `PPROF_ADDR` | `127.0.0.1:6060` | Loopback-only pprof listener. Set `off` to disable; a non-loopback address is refused, not bound |

Container:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The base file publishes `${APP_PORT:-8084}:8080`; the dev overlay points the container
at a host-side target via `host.docker.internal` (see [docs/deviations.md](docs/deviations.md) N31 for the Compose
deep-merge and firewalld caveats).

The runtime stage is distroless (`gcr.io/distroless/static-debian12:nonroot`, pinned by
digest and running as uid 65532): no shell, no package manager, nothing to exec into.
The static binary it copies in measures **11.8 MB** here
(`CGO_ENABLED=0 go build -trimpath -o /tmp/courier-size ./cmd/server` on the dev
workstation), so the image is that plus the distroless base, which is the honest way to
state it when nothing in this repository measures an image.

## Tests

```bash
go vet ./...
go test -race ./...
go build ./...
```

CI runs those three on every push to every branch and on every pull request, alongside
the rest of the gate described in [Tests and CI](#tests-and-ci) above and a separate job
that builds the Docker image.

The admission-budget simulator drives the 10% duty-cycle proof:

```bash
go test ./internal/budget/ -run Sim
```

The acceptance matrix is build-tagged and needs a running Courier and target:

```bash
go test -tags acceptance ./internal/acceptance/ -v -timeout 20m
```

It reads `COURIER_URL` (default `http://127.0.0.1:8084`), plus `STUB_URL` and
`STUB_TARGET_URL` for the stub-target cases.

## License

[MIT](LICENSE) © 2026 Andres Perez.

Postman is a trademark of Postman, Inc.; Courier is an independent project, not
affiliated with or endorsed by Postman, Inc.

The live demo exercises a Pokémon TCG search target and therefore displays Pokémon card
data. Pokémon and Pokémon character names are trademarks of Nintendo, Creatures Inc.,
and GAME FREAK inc.; card data comes from the `pokemon-tcg-data` dataset. This project
is unaffiliated with those companies and is non-commercial.
