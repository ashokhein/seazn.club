# S5 — #431: W4 decisions register — execute the rulings, close the register

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`,
then this. Short session. Engine + one catalog sync.

Branch `feat/s5-w4-decisions-register` in a fresh worktree. One PR. Issue #431.

## Why this is not a decision session

#431 collected 8 singletons that each needed a ruling rather than engineering.
**The owner ruled all 8 on 2026-08-03.** This session executes them and closes
the register. Do **not** re-litigate; if a ruling looks wrong, say so in one line
and ask — do not quietly re-decide.

## The rulings, and where each lands

| # | Item | Ruling | Lands |
|---|---|---|---|
| 1 | Cricket — penalty runs to the **fielding** side | **defer** | record only |
| 2 | Tennis — the game a game penalty concedes | **build** | S4 (#428) |
| 3 | Cricket — `pairs-6-a-side` variant | **drop the variant** | **this session** |
| 4 | Football — quarters instead of halves (mini-soccer) | **build** | S3 (#426) |
| 5 | Variants silently inheriting adult rules | **fix** | S6 (#416) |
| 6a | Hockey — shoot-out foul outcome (retake/stroke) | **fix** | S6 (#416) |
| 6b | Carrom — fresh toss for an extra board | **defer** | record only |
| 7 | Football — disallowed goal / VAR | **stays refused** | record only |
| 8 | Generic — two loose ends | **build** | S7 (#427) |

Reasons worth carrying (do not re-derive):

- **1 defer** — Law 41 adds penalty runs to the fielding side's own score, "i.e.
  to a *different* innings that may not exist yet; it would change `aggregate()`,
  the innings-victory test and the NRR ledger". It reaches net run rate, so a
  half-done version **corrupts standings silently**. Over-rate penalties ride
  along with it.
- **3 drop** — the declared variant "currently only shrinks the side … the actual
  pairs convention is a different scoring grammar, not an extension of this one".
  A variant that cannot score its own sport is worse than no variant.
- **5** — of the three, **volleyball `beach` is the one to fix first**: `records`
  is a **sport** flag, so the kernel accepts `volleyball.sub` under `beach`, which
  has no substitutions. Beach divisions will otherwise accumulate data the sport
  has no rule for, and the fix then becomes a migration rather than an edit.
  Hockey `youth` inherits adult 11-a-side and card durations (wrong strength
  chip); icehockey `recreational` inherits the full IIHF ladder.
- **6a** — "a retake today would be a second attempt event and would **overstate
  the attempt count**".

## Scope

1. **Drop cricket `pairs-6-a-side`.** This is the only build item that lands
   here, and **dropping a variant is not additive**: presets are in-engine and
   sync to the `sport_variants` table via `scripts/sync-sports.ts`. So:
   - check no division is pinned to it (query, and put the result in the PR body);
   - remove the preset;
   - run `sync:sports` and verify the row is gone from `sport_variants`;
   - a test that fails if the key reappears, and a test that a division pinned to
     a removed variant fails **loudly** rather than falling back silently
     (`registry.get(key,version)` has no fallback — prove the failure mode).
2. **Re-home items 2, 4, 5, 6a, 8** — verify each is already written into the
   target prompt file in this directory (`S03`, `S04`, `S06`, `S07`). If any is
   missing, **edit that prompt file now**; that is the whole point of the register.
3. **Record deferrals 1, 6b and the standing refusal 7** in `_INDEX.md`'s
   decision log with their reasons, so nobody re-derives them. Then close #431.

## Acceptance criteria

- [ ] `pairs-6-a-side` gone from the cricket module; `sync:sports` run; the row
      is absent from `sport_variants` (paste the query result)
- [ ] Pinned-division check run and reported — zero pinned, or the migration
      question raised with the owner **before** removal
- [ ] Regression test: a division pinned to a removed variant fails loudly, with
      an identifiable error — not a silent fallback to base cricket
- [ ] Regression test: the removed key cannot be reintroduced by drift (catalog
      ↔ engine parity test)
- [ ] Items 2, 4, 5, 6a, 8 each verified present in their target prompt file —
      list the file + section in the PR body
- [ ] Deferrals 1, 6b, refusal 7 in `_INDEX.md` decision log with reasons
- [ ] Goldens byte-identical (a dropped variant should touch none — if one moves,
      that is a finding worth reporting, not a re-baseline to wave through)
- [ ] Conformance ×11 green; `tsc EXIT=0`; engine + root lint `✖ 0 problems`;
      vitest counts from the JSON reporter
- [ ] #431 closed with a comment pointing at this PR and the index

### Test types

- **Unit** — catalog/engine parity, variant resolution after removal.
- **Regression** — pinned-division loud failure; key-reintroduction drift guard.
- **Smoke** — `sync:sports` runs clean against a fresh schema (`db:apply` **and**
  `sync:sports`; `db:apply` alone is not a fresh schema — `funnel.test.ts` fails
  `expected 'generic' to be 'badminton'` when it is skipped).
- **E2E (Playwright): deferred to S12/S13** — no user-facing surface changes.

## Gotchas

- Greenfield rules say a fresh schema is fine — but `sport_variants` is populated
  by a **script**, not a migration. Removing a preset without running
  `sync:sports` leaves a stale row that still resolves in the database.
- Follow `seazn-local-env` to bring up the DB: a `pg_ctl` that fails with
  "Address already in use" is followed by a `createdb` that **succeeds** against
  another session's server. Confirm `show data_directory` is yours.
- Do not "improve" any deferred item while you are in the file. Item 1 touches
  NRR; a partial fix there is worse than the gap.

## Execution

Small enough for **one inline implementer pass**. Scout only if the variant's
call sites are not obvious.

**Scout (sonnet) brief (optional):** every reference to `pairs-6-a-side` across
`packages/engine`, `scripts/sync-sports.ts`, tests and any seed/demo data; plus
where `sport_variants` rows are written and read. Use `git grep -a`. file:line
table only, under 15 lines.

**Implementer (opus, high):** brief carries the ruling table above verbatim.

**Reviewer (sonnet):** was `sync:sports` actually run against a real DB, or only
asserted in a test? Does the pinned-division failure test assert the **error
identity**, not a bare throw? Gap list only.

## On close

`_INDEX.md`: S5 → DONE, all 8 rulings recorded as executed/deferred/refused, and
a note that the register is closed. Memory + `scripts/agent-memory-snapshot.sh`.
