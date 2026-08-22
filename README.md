# Courier

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

## Closed-loop honesty note

Courier is a **closed-loop** tester: workers wait for each response before issuing the
next, like `hey`, not open-loop fixed-rate like `vegeta`. Under saturation this
understates tail latency (coordinated omission). That is a fine trade for this
demonstration, and it is stated plainly here and in the report footer rather than
quietly assumed.

## Running locally

```bash
# Target: a local Pokesearch on 8085 (8080 is taken on the dev workstation).
PORT=8084 TARGET_URL=http://127.0.0.1:8085 go run ./cmd/server

curl -s localhost:8084/healthz    # -> {"status":"ok"}
open http://localhost:8084/
```

Environment: `PORT` (default `8080`), `TARGET_URL` (default `http://127.0.0.1:8085`),
`TARGET_DISPLAY` (the friendly target name shown in the UI and the PDF).
