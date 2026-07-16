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
   dropdowns render raw `W: bowled`. (The activity feed also prints these
   English via `describeEvent` — see "Out of scope" below.)
4. **Brand swatch names** (`Teal`, `Crimson`, …) — console only: the
   brand-colour picker. The colour themes public pages but the *name* is never
   shown publicly.

User decision: localize all four, everywhere they render.

## Non-goals (stay English by design)

Chess methods (`checkmate`/`resign`), tennis point numerals + `Ad`/`Deuce`
calls, and format / variant / official NAMES remain English. Stored enums are
never touched.

**Out of scope (deliberately skipped): the activity feed (`describeEvent` in
`lib/event-copy.ts`).** It is the only open-ended surface — event payloads carry
arbitrary scalar keys (`runs`/`wickets`/`legalBalls`/…) that are not a closed TS
enum, so localizing it needs a dynamic-key lookup + a contract test rather than
the compile-safe typed maps used everywhere else. It is also console-only (never
public). Left English this cycle; the feed keeps showing `Innings ·
runs: 3, wickets: 5` and `Started`. Everything else below is a **closed enum**,
localized via fully-typed `Record<Enum, MessageKey>` maps.

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

~38 en keys → `npm run i18n:translate` fills fr/es/nl → `npm run i18n:check`
parity gate (hard-fails on drift). Every key added to `dictionaries/en/ui.json`
becomes part of the `MessageKey` union after `npm run i18n:gen-keys`.

## Helpers — typed maps, no dynamic keys

Every vocab is a **closed enum**, so each helper indexes a
`Record<Enum, MessageKey>` map and takes a `MessageKey`-typed translator
`m: (key: MessageKey) => string` (client `useMsg()`, server `msgFor(locale, …)`).
This keeps BOTH compile-time nets: the `Record` forces every enum member to be
mapped (exhaustive), and the `MessageKey` value type forces every referenced key
to exist in `ui.json`. No `useT`/dynamic template strings — no silent-fallback
risk.

```ts
// apps/web/src/lib/scoring-vocab.ts  (pure, no server-only imports)
import type { MessageKey } from "@/lib/messages";
import { swatchName } from "@/lib/brand-palette";

export type WicketKind = "bowled"|"caught"|"lbw"|"runout"|"stumped"|"hitwicket"|"retired"|"obstructed"|"timedout";
export type ExtraKind  = "wide"|"noball"|"bye"|"legbye"|"penalty";
export type CardColour = "yellow"|"red";
export type SportKey   = "badminton"|"boardgame"|"carrom"|"cricket"|"football"|"generic"|"hockey"|"icehockey"|"tabletennis"|"tennis"|"volleyball";

const WICKET_KEY: Record<WicketKind, MessageKey> = { bowled:"wicket.bowled", caught:"wicket.caught", lbw:"wicket.lbw", runout:"wicket.runout", stumped:"wicket.stumped", hitwicket:"wicket.hitwicket", retired:"wicket.retired", obstructed:"wicket.obstructed", timedout:"wicket.timedout" };
const EXTRA_KEY: Record<ExtraKind, MessageKey> = { wide:"extra.wide", noball:"extra.noball", bye:"extra.bye", legbye:"extra.legbye", penalty:"extra.penalty" };
const CARD_KEY:  Record<CardColour, MessageKey> = { yellow:"card.yellow", red:"card.red" };
const SPORT_KEY: Record<SportKey, MessageKey> = { badminton:"sport.badminton", boardgame:"sport.boardgame", carrom:"sport.carrom", cricket:"sport.cricket", football:"sport.football", generic:"sport.generic", hockey:"sport.hockey", icehockey:"sport.icehockey", tabletennis:"sport.tabletennis", tennis:"sport.tennis", volleyball:"sport.volleyball" };
const SWATCH_KEY: Record<string, MessageKey> = { Teal:"swatch.Teal", Ocean:"swatch.Ocean", Cobalt:"swatch.Cobalt", Midnight:"swatch.Midnight", Forest:"swatch.Forest", Ember:"swatch.Ember", Bronze:"swatch.Bronze", Crimson:"swatch.Crimson", Magenta:"swatch.Magenta", Graphite:"swatch.Graphite" };

type M = (key: MessageKey) => string;
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const wicketLabel = (k: string, m: M) => (k in WICKET_KEY ? m(WICKET_KEY[k as WicketKind]) : title(k));
export const extraLabel  = (k: string, m: M) => (k in EXTRA_KEY ? m(EXTRA_KEY[k as ExtraKind]) : title(k));
export const cardLabel   = (c: string, m: M) => (c in CARD_KEY ? m(CARD_KEY[c as CardColour]) : title(c));
export const sportLabel  = (k: string, m: M) => (k in SPORT_KEY ? m(SPORT_KEY[k as SportKey]) : title(k));
export function swatchLabel(hex: string | null | undefined, m: M): string | null {
  const name = swatchName(hex);
  return name ? (name in SWATCH_KEY ? m(SWATCH_KEY[name]) : name) : null;
}
```

Helpers accept `string` for the enum arg (payload/DB values are `string`) but map
lookups are typed; unknown values fall back to a humanized token (never throw) —
same posture as existing lookup helpers.

## Wiring by surface

| Surface | File | Mechanism |
|---|---|---|
| Cricket pad dropdowns | `components/v2/pads/cricket-pad.tsx` | `useMsg` → `wicketLabel`/`extraLabel` (render `W: {wicketLabel(k)}`) |
| Football card buttons | `components/v2/pads/football-pad.tsx` | `useMsg` → `cardLabel` |
| Period pad card/class | `components/v2/pads/period-pad.tsx` | `useMsg` → `cardLabel` |
| Discover chips (public) | `app/[lang]/(marketing)/discover/**` | server `sportLabel(key, k=>t(dict,k))` |
| Shared public pages | `app/(public)/shared/**` | server `sportLabel` + `cardLabel` |
| Swatch picker | `components/brand-color-picker.tsx` | `useMsg` → `swatchLabel` |
| Ticket / OG images | `app/(public)/r/[ref]/ticket.png`, `app/(public)/shared/**/opengraph-image.tsx` | server `msgFor(locale, ...)` (sport + card) |

(Activity feed `describeEvent` is out of scope this cycle — see "Out of scope".)

## Testing (regression-per-change, per house rule)

- `scoring-vocab.test.ts` — each helper: typed-map returns the mapped key's
  value, unknown value falls back to title-case, `swatchLabel(null)` → null;
  and an exhaustiveness assert that every `WICKET_KINDS`/`EXTRA_KINDS`/sport
  key/palette name resolves (guards a future enum addition without a key).
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

## Added scope: two hardcoded console sub-components (found live 2026-07-16)

While demoing, `/o/<org>/settings/payments` on a French org showed a whole
sub-tree in English (page chrome was French). Same #107 root cause: the page was
localized, the client sub-components never went through `msg()`. Both have **zero**
i18n calls today. Fold into this branch (same "finish console i18n" goal).

**`components/org-payment-instructions.tsx`** (296 lines, 1 consumer — the
payments settings page). Hardcoded: "Card payments (Stripe)", the Connect status
line ("● Live — charges enabled" / disabled variants), the three checklist items
(Connect / Verify (KYC) / Go live — long copy), "How do entry fees usually
work?", the two radios "Pay the organiser" / "Card at sign-up", "Cash / bank
transfer instructions" + its helper paragraph, and "Save". → convert to
`useMsg()` (client island under `/o` DictProvider); new `pay.*` keys.

**`components/prose-editor.tsx`** (275 lines, shared — 3 consumers:
`v2/competition-settings.tsx`, `org-about.tsx`, `org-payment-instructions.tsx`).
Hardcoded toolbar button labels/titles: Heading, Subheading, Bold, Italic, Link,
Bullet list, Numbered list, Quote, Divider, Image (up to 2 MB), Sponsor /
call-to-action button, plus the Write / Preview tab labels. → `useMsg()`; new
`editor.*` keys. Localizing here fixes the toolbar in all three consumers at once.

These are ordinary chrome (not domain vocab) so they use `useMsg` with static
`MessageKey`s directly — no maps needed. Same pipeline (translate + parity) and
per-component fr-render regression test.

## Rollout

Single branch, single PR. No migration (display-only). tsc 0 + full unit + smoke
green + live-verify fr on the two demoed surfaces (`/fr/discover` chips,
fr fixture-console activity feed) before PR.
