# What happens when the target dies

Evidence for Addendum Task 36. The polished prose belongs in the README (Task 35) and
`docs/design.md` (Task 29); this file is the drill and what it produced.

## The drill

| | |
|---|---|
| Date | 2026-08-22 |
| Run | `run-20260822-223241-8e9c`, performance mode, 10 workers x 15s |
| Sequence | the curated `search-basics` collection, 5 requests |
| Target | a scratch Pokesearch-shaped stub on `127.0.0.1:8091` |
| What was killed | the stub process, `SIGKILL`, **5.00 s into the 15 s run** |
| Artefacts | [`report.json`](report.json) (the stored report, verbatim) · [`dashboard.png`](dashboard.png) (the rendered report) |

**Why a stub and not the real Pokesearch.** The only Pokesearch instance reachable from here
is a shared dev target another session owns (NOTE.md N1). Killing it to prove a point about
Courier would break it for everyone, so this drill kills something disposable that speaks the
same protocol. Nothing about the behaviour under test is target-specific: Courier sees TCP
connections refused either way.

## What the report shows

```
status            completed          — not "cancelled", not "expired", not a wedge
wall clock        15,000 ms          overrun_ms 0
dispatches        974,606
  ok                  5,910          the first 5 seconds, before the kill
  errors            968,696          every dispatch after it
  aborted                 0          nobody cancelled anything
success ratio        0.606 %
status counts     {0: 968696, 200: 5910}      0 = transport failure, no response
error kinds       {connection: 968696}        not timeout, not aborted
apdex             0.006 "Unacceptable"        5,910 satisfied / 0 tolerating / 968,696 frustrated
verdict           FAIL — "error rate 99.39% is at or above the 1.00% gate"
```

Five things this is evidence of, in the order they matter:

1. **The run completed.** Status is `completed`, the wall clock is the 15 s that was asked
   for, and `overrun_ms` is 0. The target dying is not an exception path — it is a
   measurement.
2. **The errors are attributed correctly.** All 968,696 are `connection`: dispatches that
   never got a response because the socket was refused. **Zero** are `aborted`. That
   distinction is the accounting rule the Task 6 rewrite exists for — `aborted` means
   *Courier* killed the dispatch (a cancel, a shutdown, the functional deadline), and
   laundering a real target failure into it, or the reverse, would let a report blame the
   wrong party. Nothing here was cancelled, so nothing here is aborted.
3. **`requests == ok + errors + aborted`**: 974,606 = 5,910 + 968,696 + 0. A dispatch
   contributes exactly one of everything.
4. **The lock was released.** `GET /api/status` immediately afterwards:
   `{"running": false, "cooldown_until": ..., "budget_balance": 1346.68}` — idle, and the
   dead run was charged to the load budget like any other.
5. **History is intact and the next run is fine.** The failed run is in `GET /api/runs` and
   opens from the history rail (that is the screenshot). With the stub restarted, the next
   run — `run-20260822-223449-e631`, 5 workers x 4 s — returned 2,395 requests, 100% 2xx,
   verdict PASS. No restart of Courier, no manual intervention.

## Two numbers that look wrong and are not

**974,606 dispatches in 15 seconds — 64,973 req/s.** A refused TCP connection comes back in
microseconds, so once the target is gone a closed-loop generator stops being rate-limited by
the target and starts being rate-limited by the kernel. Against the live target the same
10 workers manage about 600 req/s. The huge number *is* the failure: it is what "the target
answers instantly, with nothing" looks like from the load generator's side.

**p50 8.43 ms, p95 8.68 ms, and an SLA ladder reading 100% under 25 ms.** Those are computed
over the 5,910 responses that actually happened — a transport failure produces no latency
sample, because there is no latency to sample. The dashboard says how many samples the
numbers rest on (`974606 judged`, `5910 satisfied`) beside them, and Apdex is where the
failures land: every transport failure counts frustrated however fast the refusal was. A
report that let 968,696 non-responses quietly improve a percentile would be worse than one
with no percentiles at all.

## Reproducing it

```bash
# a target you are allowed to kill
PORT=8090 TARGET_URL=http://127.0.0.1:8091 PPROF_ADDR=off go run ./cmd/server &

curl -s localhost:8090/api/collections \
  | jq '{mode:"performance", sequence:(.collections[]|select(.id=="search-basics").requests),
         options:{concurrency:10, duration_secs:15}}' \
  | curl -s -X POST localhost:8090/api/runs -H 'content-type: application/json' -d @-

sleep 5 && pkill -x <the target>          # then watch the dashboard
curl -s localhost:8090/api/status         # running:false, every time
```
