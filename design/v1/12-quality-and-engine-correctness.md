# 12 — Quality & Engine Correctness

## 1. Goal

Make the tournament engine **provably correct** and the app **regression-proof** before we
charge money. For a tournament product, a wrong bracket or standings table is the most
damaging possible failure — it happens **in public, on a projector, in front of every
participant**, and it permanently destroys organizer trust. This doc defines the test
strategy, the engine invariants we guarantee, and the CI gates that enforce them.

## 2. Current state

- **Test scripts (no framework):**
  - `scripts/engine-check.ts` — pure-logic checks (`pairing.ts`, `standings.ts`) via a
    hand-rolled `check(label, cond)` + `node --experimental-strip-types`.
  - `scripts/smoke.ts` — E2E against a **running dev server** (HTTP), ~53 assertions.
- **No** unit-test runner, no property-based tests, no browser E2E, no coverage, no CI gate.
- **Known failure class:** the stepladder bug (3-player tie → B and C played both the
  seeding play-off *and* the semi-final). It was found manually, in a real tournament, after
  shipping. That is exactly the class of bug this doc exists to prevent.

## 3. Testing pyramid (target)

```
        ┌─────────────────────────────┐
        │  E2E (Playwright)           │  few — critical user journeys
        ├─────────────────────────────┤
        │  Integration (API + DB)     │  some — route handlers, RLS, entitlements
        ├─────────────────────────────┤
        │  Property + fuzz (engine)   │  many — invariants over random tournaments
        ├─────────────────────────────┤
        │  Unit (Vitest)              │  most — pure functions, helpers, scoring
        └─────────────────────────────┘
```

## 4. Tooling choices

| Layer | Tool | Rationale |
|-------|------|-----------|
| Unit + property | **Vitest** + **fast-check** | Native TS/ESM, fast, watch mode; fast-check gives property-based testing |
| Integration | Vitest + ephemeral Postgres (Testcontainers or a disposable Supabase/branch DB) | Exercise route handlers, transactions, RLS, entitlements against real SQL |
| E2E | **Playwright** | Multi-context (multi-tenant isolation), real browser, traces on failure |
| Coverage | Vitest `c8`/V8 coverage | Gate on engine + lib coverage, not vanity % |
| CI | GitHub Actions (doc 07) | Run all gates on every PR |

Keep the existing `engine-check.ts` / `smoke.ts` working during migration; port their
assertions into Vitest specs incrementally, then retire or wrap them.

### 4.1 New scripts (`package.json`)

```jsonc
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run --dir src",
    "test:property": "vitest run --dir tests/property",
    "test:integration": "vitest run --dir tests/integration",
    "test:e2e": "playwright test",
    "test:coverage": "vitest run --coverage"
  }
}
```

## 5. Engine invariants (the contract we guarantee)

These are **always-true** properties of any valid tournament state, regardless of format,
player count, or result sequence. Each becomes a property-based test and an integration
assertion. This list is the heart of the doc.

### 5.1 Pairing invariants (per round, per format)
- **P1 — No duplicate participation:** within a single round, no player appears in more than
  one non-bye match.
- **P2 — At most one bye:** a round has at most one bye; a bye is only assigned when the
  active player count is odd.
- **P3 — Bye fairness:** no player receives a second bye while another eligible player has
  had none (Swiss/round-robin).
- **P4 — No premature rematch:** within the **group stage**, two players are paired at most
  once until all other pairings are exhausted (Swiss); round-robin pairs every pair exactly
  once across the schedule.
- **P5 — Knockout integrity:** every non-bye knockout match has exactly two distinct
  players; `next_match_id`/`next_slot` form a valid binary tree with no cycles; each match
  feeds exactly one downstream slot.
- **P6 — Stepladder correctness (regression target):** for `progress_stepladder`, the
  generated finals sequence contains **no repeated pairing** across play-off → eliminator →
  semi-final → final. Specifically, for a 3-player tie the play-off winner advances directly
  to the final; **the play-off opponents never meet again in the same finals run.**

### 5.2 Standings invariants
- **S1 — Points conservation:** total points awarded across all completed matches equals
  `wins*points_win + draws*points_draw*2 + losses*points_loss` per the config.
- **S2 — Determinism:** `computeStandings` is pure — identical inputs yield identical order;
  no reliance on object insertion order or `Date.now()`.
- **S3 — Tie-break ordering:** ordering strictly follows points → progress score → Buchholz →
  head-to-head; ties beyond all tiebreaks are stable and documented.
- **S4 — Progress score validity:** progress score never exceeds the number of rounds played;
  only computed when `use_progress_score` and a win/loss model apply (`supportsProgressScore`).

### 5.3 Lifecycle / state-machine invariants
- **L1 — Status transitions:** `setup → active → completed`; `reset` only from `active`;
  `undo` disabled when `completed`; `delete` only from `setup` (matches current rules).
- **L2 — Single champion:** a `completed` tournament resolves exactly one champion.
- **L3 — Undo fidelity:** `undoLast` restores the exact prior state from the `match_events`
  snapshot; applying action then undo is a no-op on observable state; `undo_remaining`
  decrements and floors at 0.
- **L4 — Audit completeness:** every user-visible mutation writes an `audit_log` row that
  survives undo/reset.
- **L5 — Counter integrity:** `usage_counters` (doc 03) stay consistent with reality after
  create/complete/delete + reconcile.

## 6. Property-based testing (the key upgrade)

Property tests generate **thousands of random but valid scenarios** and assert invariants
never break — this is what would have caught the stepladder bug automatically.

### 6.1 Generators (`tests/property/arbitraries.ts`)
- `playerCount`: integer 2–64 (bias toward small/odd counts: 3, 5, 7 — historically buggy).
- `format`: one of the four `TournamentFormat`s.
- `scoringConfig`: valid combinations (win/loss, league points, progress on/off, draws on/off).
- `resultSequence`: for a generated tournament, a random legal sequence of results
  (winner taps / scores / draws where allowed), including ties that force play-offs.

### 6.2 Example properties (pseudo)

```ts
import fc from "fast-check";

test("P1/P2: no double-participation, ≤1 bye per round", () => {
  fc.assert(fc.property(tournamentArb(), ({ players, format, results }) => {
    const sim = simulate(players, format, results); // pure, in-memory engine driver
    for (const round of sim.rounds) {
      const ids = activeMatchPlayerIds(round);
      expect(new Set(ids).size).toBe(ids.length);     // no duplicates
      expect(byesIn(round)).toBeLessThanOrEqual(1);
    }
  }));
});

test("P6: stepladder finals contain no repeated pairing", () => {
  fc.assert(fc.property(stepladderTieArb(), ({ players, results }) => {
    const sim = simulate(players, "progress_stepladder", results);
    const finalsPairings = pairingsInStages(sim, ["playoff","knockout","final"]);
    expect(hasDuplicatePairing(finalsPairings)).toBe(false);
  }));
});

test("S1: points are conserved", () => {
  fc.assert(fc.property(tournamentArb(), ({ players, format, results, cfg }) => {
    const sim = simulate(players, format, results);
    expect(totalStandingPoints(computeStandings(sim, cfg)))
      .toBe(expectedPoints(sim.completedMatches, cfg));
  }));
});
```

### 6.3 Pure simulation driver
Add a **DB-free engine driver** (`tests/property/simulate.ts`) that runs the engine purely
in memory (reusing `pairing.ts`/`standings.ts` and the pure parts of the lifecycle). This
keeps property tests fast (no Postgres) and forces the engine to stay testable in isolation —
reinforcing the "pure core" principle. Where lifecycle logic currently lives in
`tournament.ts` (DB-coupled), extract the pure decision-making into a pure module the driver
can call.

### 6.4 Shrinking & repro
fast-check shrinks failing cases to a minimal counterexample (e.g. "3 players, this exact
result order"). Persist failing seeds as **golden regression tests** so they never recur.

## 7. Golden-scenario suite

Deterministic, human-readable end-to-end expectations for canonical cases:

| Scenario | Asserts |
|----------|---------|
| 3 players, stepladder, all tie | play-off then **direct final**, no B/C rematch (the fixed bug) |
| 4 players, knockout | semi/final tree correct, one champion |
| 5 players, swiss_knockout | bye rotation fair, knockout seeds from standings |
| 6 players, round_robin | every pair meets exactly once |
| odd counts 3/5/7 | bye handling + `recommendGroupRounds` behavior |

Store as fixtures with expected bracket + standings; assert exact equality.

## 8. Integration tests (API + DB + tenancy)

Against an ephemeral Postgres:
- **Auth/RBAC:** viewer cannot mutate; editor can; cross-org access denied.
- **RLS (doc 03):** a query without `app.current_org` set returns zero rows; tenant A cannot
  read tenant B's tournaments even with a forged id.
- **Entitlements (doc 05):** create-tournament blocked at limit; realtime token denied on
  Community; `requireFeature` returns 402 envelope.
- **Transactions:** result + audit + counter update commit atomically; broadcast/notify
  failures (doc 10/14) do **not** roll back the result.
- **Idempotency:** duplicate result submission with same idempotency key applied once.

## 9. E2E (Playwright) — critical journeys

1. **Signup → verify → create org → create tournament → start → score → complete.**
2. **Multi-tenant isolation:** two browser contexts, two orgs, neither sees the other's data.
3. **Live update:** two contexts on one tournament; score in A; B updates (realtime on Pro;
   poll on Community) — guards doc 10.
4. **Billing happy path:** start trial → (Stripe test) checkout → entitlements unlock
   (doc 05; use Stripe test mode + webhook forwarding).
5. **Scorekeeper RBAC:** delegated scorer can only enter results.

Capture Playwright traces + screenshots on failure; upload as CI artifacts.

## 10. CI gates (doc 07 pipeline)

On every PR, **block merge** unless:
1. `npm run lint` + `tsc --noEmit` pass.
2. `npm run test` (unit + property) passes — **property tests run a fixed large sample**
   (e.g. `numRuns: 1000`) in CI, higher nightly.
3. Integration tests pass against ephemeral DB.
4. `npm run test:e2e` critical-path passes (preview deploy or local server).
5. Coverage thresholds met for `src/lib/pairing.ts`, `standings.ts`, scoring, and the pure
   lifecycle module (target ≥ 95% lines/branches on the engine specifically).
6. Security scans (dep audit, gitleaks) pass (doc 04).

Nightly: extended property runs (`numRuns: 50_000`) + full E2E matrix.

## 11. Non-functional quality

- **Performance budgets:** define p95 API latency and live-page load targets; assert in a
  lightweight load test (k6/Artillery) against a hot tournament (many spectators + realtime).
  Wire a smoke load test into CI nightly. (Detail in doc 15.)
- **Accessibility checks:** automated axe-core pass in Playwright on key pages as a gate
  (full a11y program in doc 15).
- **Visual regression (optional):** Playwright screenshots for bracket/slideshow to catch
  layout breakage.

## 12. Observability of correctness in production

- Add **runtime invariant assertions** behind a flag in `tournament.ts` write paths
  (e.g. after generating a round, assert P1/P2/P5) → log to Sentry if violated, so a slipped
  bug surfaces as an alert, not a customer complaint.
- Structured "engine_event" logs (round generated, champion resolved) for forensics.

## 13. Security & failure modes

- Tests must not depend on wall-clock or randomness without a seed (S2 determinism).
- Ephemeral test DBs are isolated and torn down; no shared state across tests.
- Property tests use fixed seeds in CI for reproducibility; record any failing seed.

## 14. Acceptance criteria

- Vitest + fast-check + Playwright installed and wired into CI as **merge gates**.
- All invariants in §5 expressed as property tests; the stepladder case (P6) has a dedicated
  regression test derived from the real bug.
- Pure in-memory engine driver exists; engine logic testable without Postgres.
- Golden-scenario suite covers all four formats + odd player counts.
- Integration tests cover RBAC, RLS, entitlements, transactional atomicity, idempotency.
- Engine coverage ≥ 95%; CI blocks merges on any gate failure.
- Production invariant assertions log violations to Sentry.

## 15. Open questions / decisions

1. Ephemeral DB approach: Testcontainers vs Supabase branch DBs in CI?
2. Extract pure lifecycle decisioning out of `tournament.ts` now (recommended) vs after
   billing ships?
3. Coverage threshold for non-engine code (lower, e.g. 70%) vs engine (95%)?
4. Adopt visual regression for slideshow/bracket, or defer to doc 15?
