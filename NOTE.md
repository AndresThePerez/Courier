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
