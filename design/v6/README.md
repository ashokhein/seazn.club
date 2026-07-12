# v6 — Sport Expansion: Tennis · Ice Hockey · Field Hockey

> **Status (2026-07-12):** not started. PROMPT-48 ⏳ · PROMPT-49 ⏳ · PROMPT-50 ⏳.
> Branch (planned): `feat/v6-sports`. Migrations: none expected (sports are catalog rows
> via `scripts/sync-sports.ts`, not schema).

## Theme

Add three sports as first-class engine modules: **tennis** (ITF), **ice hockey** (IIHF),
**field hockey** (FIH — key `hockey`, matching the existing `match-length.ts`/`venue.ts`
placeholders). Rules, scoring, officiating and standings conventions are digested from the
official rulebooks in `01-rules-digest.md` — that digest is the normative source for every
number in the modules.

**The audit verdict: two new engine patterns are required.**

1. **Nested scoring kernel** (tennis): the existing set-based kernel folds points straight
   into sets (`setTo/winBy/cap`) — tennis is points→games→sets with deuce/advantage,
   tie-break games, match tie-breaks and no-ad variants. New `nested/` kernel, reused
   later by padel.
2. **Period kernel + suspension & shootout primitives** (both hockeys): football is the
   only timed-period module and hardcodes `halves: z.literal(2)`, with cards buried in its
   private event union. Extract a generalized period phase machine (n periods, overtime
   policy), a **timed-suspension track** (power-play strength, PIM, progressive cards)
   and a **parameterized shootout primitive** (football pens, IIHF GWS, FIH SO are one
   shape: best-of-5 alternating + sudden death).

Everything else reuses the existing machinery: event-sourced fold, `MatchOutcome`,
`StandingsDelta` + points config, tiebreaker comparator registry (h2h chain already
matches IIHF), officials roles, format generators (fully sport-agnostic — no new formats
needed; Americano/Swiss/knockout all work day one for the new sports).

## Document index

| # | File | Contents | Prompt |
|---|------|----------|--------|
| 00 | `00-sport-expansion-spec.md` | Normative spec: module designs, kernels, suspension/shootout primitives, pads, standings, decisions | 48–50 |
| 01 | `01-rules-digest.md` | Official-rules digests with citations (ITF 2026, IIHF 2025/26 + Event Code 2026, FIH 2026 + Tournament Regs) | 48–50 |

## Prompt index (prompts/)

| Prompt | Delivers | Depends on |
|--------|----------|------------|
| PROMPT-48 | Tennis: nested kernel, `tennis` module (variants: tour-bo3, grand-slam-bo5, fast4, no-ad+MTB10), TennisPad, dispatch + catalog wiring | — |
| PROMPT-49 | Period kernel extraction, suspension + shootout primitives, `icehockey` + `hockey` modules (engine only), football refactored onto the kernel unchanged | — |
| PROMPT-50 | Hockey UX + ops: PeriodPad (goals/penalties/cards/period controls), strength on live scorebug, PIM/discipline stats, officials presets, seed + smoke | PROMPT-49 |

## Build order (canonical)

48 ∥ 49 (disjoint engine areas) → 50. PROMPT-49 refactors `football.ts`; nothing else may
touch it concurrently.

## House rules

PROMPT-00 conventions apply. Every change ships a failing-without-it regression test;
`scripts/smoke.ts` extended (pro + free paths); `tsc` + unit green before push. New sports
require `scripts/sync-sports.ts` re-run against every environment DB (stale
`sport_variants` gotcha — the division builder reads the DB catalog, not the engine
registry). Engine determinism gate: no `Date.now()` inside modules.
