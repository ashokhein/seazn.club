# PROMPT-61 — Enforce "knockout produces a winner" (wire supportsDraws)

**Sport-agnostic.** `supportsDraws(cfg, stage)` is a shared `SportModule`
predicate. Every draw-forbidding sport (football knockout, all set-based sports,
board games, …) benefits — this is not a football fix. The goldens must span
more than one sport.

**Read first:**
- `apps/web/src/server/engine-db/append-event.ts` — the finalize path. It loads
  `division` (config, sport_key, module_version), folds the stream with
  `foldMatch(sportModule, division.config, lineups, stream)`, and takes
  `sportModule.outcome(state)`. It **never loads the fixture's stage kind and
  never calls `supportsDraws`**. This is the bug site.
- `apps/web/src/server/engine-db/fold.ts` + `rebuild.ts` — the rebuild/read
  paths that also fold without stage awareness; keep them consistent.
- `packages/engine/src/sport/module.ts` — the `supportsDraws(cfg, stage:
  StageKind): boolean` contract (currently referenced only in comments).
- `packages/engine/src/sports/football/football.ts` — `resolveFullTime`
  (returns `{kind:"draw"}` on a level FT when `cfg.extraTime`/`cfg.shootout` are
  both off) and `supportsDraws` (false for knockout). `setbased/kernel.ts`,
  `period/kernel.ts` — other modules whose `supportsDraws` is likewise unused.
- `apps/web/src/server/engine-db/competition.ts` — how stage config is already
  overlaid for stage-level concerns (points, rngSeed, rounds, rank_overrides).
  The `shootout`/`extraTime` overlay follows the same pattern.

**Depends:** none. **Migration:** none.

## Context (the defect)

A knockout fixture can silently finalize as a **draw**, leaving the bracket with
no winner to advance — the next round's feeds stay `(TBD)` and the round is
unplayable, with no error surfaced. Observed live on the FIFA WC 2026 "Group
Stage" demo division: level R32 scores persisted as `outcome = {kind:"draw"}`.

Two causes, both real:

1. **`supportsDraws` is never enforced.** Every module declares it
   (`false` for knockout) and the code comments claim the engine "refuses to
   finalize a drawn knockout fixture via supportsDraws" — but there is **no
   invocation anywhere**. `append-event.ts` doesn't even load the stage kind.

2. **Decider config is division-scoped, not stage-scoped.** `foldMatch` receives
   `division.config`; the football decider only sees `cfg.shootout`/`cfg.extraTime`.
   So a groups+knockout division can't say "groups draw, knockout must decide" —
   enabling shootout on the knockout stage config is inert.

## Task

### 1. Enforce the predicate at finalize (primary)

In `append-event.ts`, load the fixture's stage `kind` (join `stages` on
`fixture.stage_id`) and, after `outcome = sportModule.outcome(state)`:

```ts
if (outcome?.kind === "draw" && !sportModule.supportsDraws(cfg, stageKind)) {
  throw new EngineError(
    "DRAW_NOT_ALLOWED",
    "this stage cannot end level — decide it by extra time or a shootout",
    { fixtureId, stage: stageKind },
  );
}
```

- The throw aborts the tx before insert (same guarantee the fold-validate already
  relies on), so the drawing event is rejected with a clear message instead of
  silently stalling the bracket.
- Mirror the same guard wherever an outcome is finalized/persisted from a fold
  (`fold.ts`/`rebuild.ts` read paths must not *invent* a different result, but a
  rebuild that encounters a persisted draw in a knockout should surface it, not
  crash — treat historical rows leniently, new writes strictly).
- Sport-neutral: works for any module whose `supportsDraws` returns false for the
  stage (set-based sports, etc.).

### 2. Stage-scoped decider config (so a winner is actually reachable)

Enforcement alone would block the draw but leave the organiser stuck if no
decider is configured. Let the knockout **stage** carry `shootout` /
`extraTime`, and overlay them onto the sport cfg passed to `foldMatch` for
fixtures in that stage (same overlay pattern `competition.ts` uses for points /
rank_overrides). Then a groups+knockout division draws in the group stage and
requires a shootout in the knockout, from one division sport config.

- Validate the overlay against the sport module (unknown keys ignored, as today).
- Back-comptaible: absent stage overrides ⇒ current behaviour.

## Tests (regression — each fails without its change)

- `append-event` test: a football **knockout** fixture folded to a level FT with
  no decider configured ⇒ finalizing throws `DRAW_NOT_ALLOWED`; the same level
  score in a **group/league** stage still finalizes as a draw. Repeat for one
  set-based sport to prove the predicate is honoured generically.
- Overlay test: a knockout stage with `shootout:true` in its config ⇒ a level FT
  advances to the shootout sub-machine (outcome pending, not draw); the sibling
  group stage in the same division still draws.
- A bracket-advance test: once the knockout fixture has a winner, the next
  round's feed resolves (no lingering `(TBD)`).

## Non-goals

- No new sport rules; `resolveFullTime` etc. are unchanged beyond receiving the
  overlaid cfg. This prompt wires an existing predicate + existing config.
- No auto-resolution of already-drawn historical fixtures (a data-repair concern,
  separate). The demo's 4 stuck fixtures are fixed by re-recording, not migrated.

## Help / docs pass (mandatory)

Update `content/help/*` on knockout scoring: a knockout always produces a winner;
how extra time / shootout is enabled per stage — sport-neutral, same PR.
