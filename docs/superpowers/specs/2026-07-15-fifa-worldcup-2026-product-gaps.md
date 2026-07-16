# Product gaps found while building the FIFA WC 2026 demo

Running log of limitations discovered in the product while seeding a real, large,
multi-stage tournament. Each entry: what I hit, why it matters, rough fix.

## 1. Knockout bracket generator only does standard seeding

**Hit:** Wanted FIFA's real R32 pairings (12 winners + 12 runners-up + 8 best thirds
slotted by a fixed lookup table). The knockout stage generator seeds the bracket by
standard 1-v-N seeding off the qualification order — there's no way to pass an explicit
slot map / bespoke bracket.

**Why it matters:** Any real-world cup with a published fixed bracket (World Cup, Euros)
can't be reproduced exactly. Demo brackets are structurally plausible but not the real
pairings.

**Rough fix:** allow a stage to accept an explicit seed→slot mapping (or a named bracket
template) instead of only derived standard seeding.

## 2. Qualification can't combine tiers (winners + runners-up + best thirds)

**Hit:** FIFA advances 12 group winners + 12 runners-up + 8 best third-placed = 32.
`QualificationSpec` is one of TakePicks | TopN | BestOfRank — a single shape. There's no
way to union "all rank-1 + all rank-2 + best-8-of-rank-3" in one qualification.

**Why it matters:** the most common real multi-group→knockout format (World Cup, Euros,
AFCON with best-thirds) can't be expressed directly.

**Workaround used:** enumerate all 32 as explicit `TakePicks` `{pool,rank}` entries, computing
the 8 best-third pools myself from the real standings. Works, but the engine's own best-third
logic (`BestOfRank.normaliseUnequalPools`) is bypassed.

**Rough fix:** allow `qualification.take` to accept a `bestOfRank` sub-clause, or accept an
array of specs that concatenate into the seed list.

## 3. Entrants have no crest / flag / badge field

**Hit:** wanted a country flag on each of the 48 national-team entrants. `entrants` has no
image column. The only team imagery path is `teams.logo` via a club (clubs.hierarchy, a Pro
feature) uploaded through the multipart bulk-logo endpoint — i.e. 48 image uploads plus a club
tree, just to show a flag.

**Why it matters:** any "teams with logos" demo (leagues, cups) is disproportionately hard;
there's no lightweight per-entrant badge, and no way to point at an external image URL.

**Rough fix:** an optional `entrants.badge_url` (or `crest_ref`) settable at create time,
rendered on board/bracket/public — no club hierarchy required.

## 4. Pool `name` vs `key` is a silent footgun when authoring qualification

**Hit:** generated pools are `name = "Pool A"` but `key = "A"`; `qualification.take[].pool`
matches the **key**. Referencing "Pool A" would silently resolve nothing. Nothing in the API
surfaces which one `take.pool` expects.

**Rough fix:** document it on the schema, and/or accept either name or key in `take.pool`.

## 5. No bulk person-create — 1248 individual POSTs for full squads

**Hit:** seeding 48×26 players = 1248 sequential `POST /api/v1/persons`. There's no batch
person endpoint; entrants accept inline `members` only by pre-existing `person_id`.

**Rough fix:** accept inline new-person members (name + number + position) on entrant create,
or a `POST /api/v1/persons` batch body.

## 6. Knockout fixtures can silently finalize as a DRAW — bracket stalls (real bug)

**Hit:** in the "Group Stage" division (stg), several knockout R32 matches entered with a
level score finalized as `outcome = {kind:"draw"}`, status `decided`. A knockout fixture with
no winner leaves the bracket unable to advance — the round-2 (R16) feeds stayed `(TBD)` and the
round was unplayable. No error was shown; it just stalled.

**Root cause (traced):** the finalize path is **stage-blind**.
`apps/web/src/server/engine-db/append-event.ts` folds the event stream with
`foldMatch(sportModule, division.config, …)` and takes `sportModule.outcome(state)` — it never
loads the fixture's **stage kind** and never calls `supportsDraws`. Every sport module declares
`supportsDraws(cfg, stage) === false` for knockout (and the comments claim "the engine refuses
to finalize a drawn knockout fixture via supportsDraws"), but **`supportsDraws` is invoked
nowhere in the codebase** — the safety net is documented, not implemented. Football's
`resolveFullTime` returns `{kind:"draw"}` on a level FT whenever `cfg.extraTime`/`cfg.shootout`
are both off, and nothing rejects it.

Compounding: shootout/extra-time are read from **`division.config`** (what `foldMatch` gets),
not stage config — so in a groups+knockout division there's no way to say "groups may draw,
knockout must produce a winner." Enabling shootout on the knockout **stage** config is inert.

**Rough fix (sport-agnostic — see v13 PROMPT-61):**
1. In `append-event.ts` (and `fold.ts` / `rebuild.ts`), load the fixture's stage `kind` and,
   after computing `outcome`, reject when `outcome.kind === "draw" &&
   !sportModule.supportsDraws(cfg, stageKind)` with a clear `EngineError` — wire the net that
   already has a name. Applies to every draw-forbidding sport (set-based, etc.), not just football.
2. Overlay knockout-stage `shootout`/`extraTime` into the cfg passed to `foldMatch` so a
   knockout stage can require a decider while its sibling group stage still draws.

