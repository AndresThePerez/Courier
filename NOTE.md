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
