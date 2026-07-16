# Scoring-vocab i18n — sport names, wicket/extra kinds, card colours, brand swatches

**Date:** 2026-07-16
**Branch:** off `main` (fresh; reuses worktree `.claude/worktrees/v5-i18n-cycle46`)
**Status:** design approved, plan pending

## Problem

The app UI is fully localized en/fr/es/nl (console, off-console, auth, register,
directory, panels, tips, marketing, emails, all 8 score pads' chrome). Four
**domain vocabularies** were deliberately kept English as "proper nouns". Two of
them leak to **spectators** on localized pages:

1. **Sport names** — render English on a French public page. Verified live on
   `/fr/discover`: the sport filter chips show `♟️ Board Game` and `🏅 Generic`
   in English while the rest of the page is French. Also on `(public)/shared/*`
   pages and console (division-builder, funnel, onboarding).
2. **Card colours** (`yellow`/`red`) — football/period pad buttons (console) AND
   public shared competition page + `ticket.png`.
3. **Wicket / extra kinds** (`bowled`, `wide`, …) — console only: cricket-pad
   dropdowns render raw `W: bowled`; the activity feed (`describeEvent`) prints
   `Innings · runs: 3, wickets: 5, legalBalls: 12` in English on a French console
   (verified live on an in_play cricket fixture).
4. **Brand swatch names** (`Teal`, `Crimson`, …) — console only: the
   brand-colour picker. The colour themes public pages but the *name* is never
   shown publicly.

User decision: localize all four, everywhere they render.

## Non-goals (stay English by design)

Chess methods (`checkmate`/`resign`), tennis point numerals + `Ad`/`Deuce`
calls, and format / variant / official NAMES remain English. Stored enums are
never touched.

## Principle

**Localize display only. Storage stays English.** DB `sport_key`, event-ledger
payloads (`wicket.kind="bowled"`, `card.color="yellow"`), and the palette
hex→name map are unchanged. Every leak is a *render-time* lookup. This mirrors
every prior i18n cycle and keeps engine/API/tests stable.

## Vocab & keys

All new keys land in the existing `ui` catalog (`dictionaries/<locale>/ui.json`),
reachable from both client (`useMsg`/`useT`) and server (`msgFor`/`t`).

| Namespace | Count | Members |
|---|---|---|
| `sport.<key>` | 11 | badminton, boardgame, carrom, cricket, football, generic, hockey, icehockey, tabletennis, tennis, volleyball |
| `wicket.<kind>` | 9 | bowled, caught, lbw, runout, stumped, hitwicket, retired, obstructed, timedout |
| `extra.<kind>` | 5 | wide, noball, bye, legbye, penalty |
| `card.<colour>` | 2 | yellow, red |
| `swatch.<name>` | 11 | Teal, Ocean, Cobalt, Midnight, Forest, Ember, Bronze, Crimson, Magenta, Graphite (+ any palette additions) |
| `event.scalar.<key>` | ~5 | runs, wickets, legalBalls, partial, overs (the cricket-summary scalar keys surfaced by `describeEvent`) |

~43 en keys → `npm run i18n:translate` fills fr/es/nl → `npm run i18n:check`
parity gate (hard-fails on drift).

## Helpers

Pure lookup helpers, each taking a **bound translator** `tf: (key) => string` so
the same helper works server-side (`tf = (k) => t(dict, k)`) and client-side
(`tf = useMsg()` / `useT()`), matching the `familyCopy` pattern from #105.

```
sportLabel(key, tf)            -> tf(`sport.${key}`),  fallback titleCase(key)
wicketLabel(kind, tf)          -> tf(`wicket.${kind}`)
extraLabel(kind, tf)           -> tf(`extra.${kind}`)
cardLabel(colour, tf)          -> tf(`card.${colour}`)
swatchLabel(hex, tf)           -> swatchName(hex) -> tf(`swatch.${name}`)  (null-safe)
```

Location: a new `apps/web/src/lib/scoring-vocab.ts` (pure, no server-only
imports so client bundles are safe). Unknown keys fall back to a humanized token
(never throw) — same posture as existing lookup helpers.

## Wiring by surface

| Surface | File | Mechanism |
|---|---|---|
| Cricket pad dropdowns | `components/v2/pads/cricket-pad.tsx` | `useMsg` → `wicketLabel`/`extraLabel` (render `W: {wicketLabel(k)}`) |
| Football card buttons | `components/v2/pads/football-pad.tsx` | `useMsg` → `cardLabel` |
| Period pad card/class | `components/v2/pads/period-pad.tsx` | `useMsg` → `cardLabel` |
| Discover chips (public) | `app/[lang]/(marketing)/discover/**` | server `sportLabel(key, k=>t(dict,k))` |
| Shared public pages | `app/(public)/shared/**` | server `sportLabel` + `cardLabel` |
| Activity feed | `lib/event-copy.ts` `describeEvent` | **optional `t` param**; scalars via `event.scalar.*`; card via `cardLabel` |
| Swatch picker | `components/brand-color-picker.tsx` | `useMsg` → `swatchLabel` |
| Ticket / OG images | `app/(public)/r/[ref]/ticket.png`, `app/(public)/shared/**/opengraph-image.tsx` | server `msgFor(locale, ...)` (sport + card) |

### `describeEvent` backward-compat (the one nuance)

`describeEvent(row, names)` is isomorphic and English-only today; its only app
caller is `fixture-console.tsx` (client). Change the signature to
`describeEvent(row, names, t?)`:

- **No `t`** → English exactly as now. Keeps every existing test, any engine/
  isomorphic caller, and API/log paths byte-identical.
- **With `t`** → localizes the label (`Innings`, `Started`, …), the scalar keys
  (`runs`/`wickets`/…), and the football card colour. `fixture-console` passes a
  bound translator from `useMsg`.

`scalars(p)` gains an optional `tf` param; when present it maps each key via
`event.scalar.<key>` before rendering `label: value`.

## Testing (regression-per-change, per house rule)

- `scoring-vocab.test.ts` — each helper: stub-dict returns localized, unknown
  key falls back, `swatchLabel(null)` → null.
- `event-copy` test — `describeEvent` with no `t` = current English strings
  (pin); with a fr stub `t` = localized label + scalars + card, **no English
  leak**.
- Pad tests — cricket-pad wicket/extra options localized under a `fr`
  `<DictProvider>`; football-pad card buttons; update existing
  `device-score-pad.test`.
- Public — discover chip + shared-page render assert `sportLabel` output under fr
  and absence of the English token.
- OG — unit-assert the ImageResponse builder receives the localized sport/card
  string (no pixel test).

## Pipeline & docs

`i18n:translate` (chunked ≤30, ANTHROPIC key in `apps/web/.env.local`) →
`i18n:check`. Update `content/help/sharing/languages.md` with a "scoring vocabulary"
line. Extend `scripts/smoke.ts` (pro + free) with one assertion that a fr
console surface shows a localized sport name.

## Rollout

Single branch, single PR. No migration (display-only). tsc 0 + full unit + smoke
green + live-verify fr on the two demoed surfaces (`/fr/discover` chips,
fr fixture-console activity feed) before PR.
