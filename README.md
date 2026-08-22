# Courier

[![CI](https://github.com/AndresThePerez/courier/actions/workflows/ci.yml/badge.svg)](https://github.com/AndresThePerez/courier/actions/workflows/ci.yml)
[![Go](https://img.shields.io/badge/go-1.26-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![Dependencies](https://img.shields.io/badge/direct%20deps-1-brightgreen)](go.mod)

> Badges resolve once the repository is pushed to GitHub. `.github/workflows/ci.yml`
> runs `go vet ./...`, `go test -race ./...`, `go build ./...`, and the Docker image
> build on every push and pull request to `main`.

A public, Postman-style API test runner and load tester: one Go binary that serves an
embedded three-pane UI, runs curated request collections against a fixed target in two
modes — **Functional** (declarative assertions) and **Performance** (a worker-pool load
engine) — streams results live over SSE, and exports any run report as a PDF rendered in
pure Go. Stdlib only, with a single direct dependency for PDF output and no frontend
build step.

> Skeleton README. Filled out in Task 21 / Task 35.

## Sandbox model

**The server never accepts a URL from the client. Ever.**

A run payload is `{endpoint_id, params, assertions}` — never a host, never a path. The
target base URL comes from the `TARGET_URL` environment variable and is fixed at startup;
paths come from a server-side endpoint catalog that is a closed set. Each endpoint carries
its own ordered parameter allowlist, and that allowlist is the single source of truth:
unknown keys are rejected, values are truncated to the length bound, and curated and
visitor-edited requests go through identical validation. Any code path that would let a
run payload influence the host is a design violation, not a bug.

## Caps

Server-enforced regardless of client input. Structural violations are **rejected**;
numeric knobs are **clamped**.

| Cap | Value |
|---|---|
| Max concurrency (performance) | 50 workers (clamped) |
| Max duration (performance) | 30s (clamped) |
| Max wall-clock (functional) | 120s hard deadline; remaining entries marked skipped |
| Concurrent runs | 1 globally — `409 Conflict` |
| Cooldown between runs | A global load budget: token bucket in worker-seconds (refill 5/s, burst 1500), floored at 5s; `409` with `cooldown_until` |
| Per-request timeout | ~10s hard `http.Client.Timeout` |
| Max requests per sequence | 50 |
| Max assertions per request | 20 |
| Functional `delay_ms` | ≤ 1000 |
| Param value length | ≤ 500 chars (truncated, not rejected) |
| Concurrent single-request sends | 1 globally — `429` |

## Engine overhead

Courier measures a target, so its own cost has to be small enough not to be part of
the measurement. These are `go test -bench` numbers from the pure cores, on a Ryzen
5800X (`go test -bench . -benchmem ./internal/...`):

| Operation | Cost | Allocations |
|---|---|---|
| JSON path lookup, shallow (`$.total`) | 132 ns | 1 |
| JSON path lookup, deep (`$.results[23].attacks[0].cost[3]`) | 661 ns | 3 |
| Assertion evaluation, `status` / `latency` | 131 / 143 ns | 2 / 4 |
| Assertion evaluation, `json` ops | 245–511 ns | 4–7 |
| Assertion evaluation, `body_contains` | 284 ns | 4 |
| Decode + fold one 36KB search response (`NewTarget`) | 438 µs | 5,998 |
| **Full functional request: decode + 20 assertions at the cap** | **452 µs** | 6,141 |
| Percentile over 1k / 18k / 100k samples | 1.7 ns (O(1)) | 0 |
| Histogram over 18k samples | 30 µs | 1 |
| `ComputeStats` over 18k samples (sort + percentiles + ladder + Apdex + histogram) | 1.06 ms | 6 |
| Record one response into a `Tally` | 31 ns | 0 |

Reading them: a functional request costs ~452 µs of Courier against 1–30 ms of network
and target time — the assertions themselves are ~103 µs of that, and the JSON decode is
the rest. Percentile computation is a constant-time index into a sorted slice
(nearest-rank, no interpolation), so report assembly does not grow with run length; only
the one sort inside `ComputeStats` does.

**Performance mode does none of this.** It evaluates no assertions and drains bodies to
`io.Discard`, so the per-dispatch hot path never decodes JSON. The measured per-dispatch
engine overhead lands here once the run engine exists.

## Closed-loop honesty note

Courier is a **closed-loop** tester: workers wait for each response before issuing the
next, like `hey`, not open-loop fixed-rate like `vegeta`. Under saturation this
understates tail latency (coordinated omission). That is a fine trade for this
demonstration, and it is stated plainly here and in the report footer rather than
quietly assumed.

## Running locally

```bash
# Target: the shared dev Pokesearch on 8081 (8080 is taken on the dev workstation).
PORT=8084 TARGET_URL=http://127.0.0.1:8081 go run ./cmd/server

curl -s localhost:8084/healthz    # -> {"status":"ok"}
open http://localhost:8084/
```

Environment: `PORT` (default `8080`), `TARGET_URL` (default `http://127.0.0.1:8081`),
`TARGET_DISPLAY` (the friendly target name shown in the UI and the PDF).
