# v13 — Real-competition fidelity (any sport)

> **Status (2026-07-16):** design only. PROMPT-59 + PROMPT-60 not yet implemented.
> Target branch (build time): `feat/v13-real-competition-fidelity` (own worktree
> off `main`). **No hard cross-version deps.** PROMPT-59 (engine) and PROMPT-60
> (entrant identity + bulk enrol) are independent — land in either order.
> **Migrations:** one new column for entrant crest (PROMPT-60). PROMPT-59 is
> engine + config only, no schema change.
> **Sport-agnostic:** every change here lives in the sport-**neutral**
> competition/scheduling layer or the shared entrants surface. Nothing is
> football-specific. It must work identically for cricket, tennis, hockey,
> badminton, board games — any current or future `SportModule`.

## Theme

Seeding a real, large, multi-group tournament (the FIFA World Cup 2026 demo,
2026-07-15) surfaced gaps that block modelling **any** real competition
faithfully — not just football. They fall in three independent parts (a third,
PROMPT-61, is a live bug — knockouts silently finishing as draws):

**Engine fidelity (PROMPT-59).** The competition layer can't express the two
things a real cup needs:

1. **Combined multi-tier qualification.** `QualificationSpec`
   (`packages/engine/src/competition/qualification.ts`) is exactly one of
   `TakePicks | TopN | BestOfRank`. There's no way to say "all group winners +
   all runners-up + the best N third-placed" in one spec — the single most
   common group→knockout shape (World Cup, Euros, AFCON, many cricket/hockey
   cups). The demo had to enumerate 32 explicit picks and compute best-thirds by
   hand, bypassing the engine's own `BestOfRank.normaliseUnequalPools`.

2. **No explicit bracket slotting.** `generateSingleElim`
   (`packages/engine/src/scheduling/bracket.ts`) seeds strictly by the standard
   fold (`seedPositions`). Real cups publish a **fixed slot map** (which
   qualifier meets which, e.g. the World Cup's third-place lookup). There's no
   way to feed an explicit seed→slot order, so a real bracket can't be
   reproduced — the demo's knockout pairings were engine-standard, not the real
   draw.

   Related footgun: pools carry both `name` ("Pool A") and `key` ("A") and
   `qualification.take[].pool` matches the **key** — silently resolving nothing
   if you pass the name. Fix it in the same pass.

**Team identity + bulk enrolment (PROMPT-60).** Representing and loading a real
field of teams is disproportionately hard:

3. **Entrants have no crest / badge / flag.** The only team imagery path is
   `teams.logo` via a club (Pro `clubs.hierarchy`) uploaded through the bulk
   multipart endpoint — a club tree plus N image uploads just to show a crest.
   There's no lightweight per-entrant badge and no way to point at an image.

4. **No bulk person-create.** Full rosters mean one `POST /api/v1/persons` per
   player (the demo made 1248 sequential calls). Entrant `members` only accept
   a pre-existing `person_id`.

## Non-goals

- No sport-specific rules or scoring changes — this is competition structure +
  entrant representation only.
- Not hardcoding any real tournament ("wc48" etc.). The bracket work is a
  **generic explicit slot map**; a caller (or a future preset) supplies the
  order. Real-format presets can come later on top of this primitive.
- No club-hierarchy changes; the entrant crest is deliberately independent of
  clubs so free orgs get it too.

## Prompts

- **PROMPT-59** — Competition fidelity: combined qualification + explicit bracket
  slotting + pool name/key hardening. Pure engine + config.
- **PROMPT-60** — Entrant identity + bulk enrolment: `entrants.badge_url` (or
  `crest_ref`) rendered across board/bracket/public, and inline new-person
  members on entrant create.
- **PROMPT-61** — Enforce "knockout produces a winner": wire the declared-but-
  never-invoked `supportsDraws` predicate at finalize so a level knockout can't
  silently persist as a draw + stall the bracket, and make shootout/extra-time
  configurable per knockout stage. Sport-agnostic. (Bug found live on the demo.)
- **PROMPT-62** — Two-sided knockout bracket ("poster"): one pure sport-neutral
  geometry (`twoSidedBracket`) driving three surfaces — an interactive console
  `BracketPanel`, an upgraded public bracket (columns → connected centre-Final
  tree), and a landscape results-poster PDF (`DocKind: bracket`, soft-dep v12).

## Reference

- The FIFA WC 2026 demo seed that exposed these:
  `scripts/seed-fifa2026.ts`, `docs/superpowers/specs/2026-07-15-fifa-worldcup-2026-product-gaps.md`.
