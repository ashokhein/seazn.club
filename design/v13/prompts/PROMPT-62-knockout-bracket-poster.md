# PROMPT-62 — Two-sided knockout bracket ("poster") across console, public, PDF

**Sport-agnostic.** The bracket is pure round/seat geometry over knockout
fixtures — no per-sport code (scorelines come from the shared
`ScoreSummary.headline`, exactly like today's public bracket). It must render
identically for a football cup, a tennis draw, a chess knockout, any sport.

**Read first:**
- `apps/web/src/components/public-site/bracket.tsx` — the existing bracket: one
  column per round of `FixtureCard`s, `flex gap-6`, **no connector lines**, round
  names Final/Semi-finals/Quarter-finals. This is the "columns, not a tree" start
  point to upgrade.
- `packages/engine/src/scheduling/bracket.ts` — `generateSingleElim`/
  `buildSingleElim`/`seedPositions`: the source of `round_no` + `seq_in_round`
  semantics and the `homeFrom: winnerOf(prev)` feed wiring the layout mirrors.
- `apps/web/src/components/v2/stages-panel.tsx` — the console per-stage fixture
  list (round headers + `FixtureLine`). Knockout currently renders here as a flat
  list; the new bracket panel is the knockout counterpart.
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` — the division
  page that already **picks a panel per stage kind** (`AmericanoPanel` for
  americano, else `StagesPanel`, ~lines 209/224). The knockout branch renders the
  new `BracketPanel` the same way.
- `apps/web/src/server/public-site/data.ts` — `PublicFixture` (round_no,
  seq_in_round, entrants, outcome, summary.headline, status) — the read shape the
  geometry consumes.
- PDF pipeline (soft-dep **v12 PROMPT-58**): `packages/engine/src/exports/
  types.ts` (`DocKind`, `DocModel`, `DocBranding`), `packages/engine/src/exports/
  build.ts` (builders), `apps/web/src/server/doc-render.ts` (renderer),
  `apps/web/src/app/api/v1/divisions/[id]/exports/[kind]/route.ts` (export route).

**Depends:** the PDF surface **soft-depends on v12 PROMPT-58** (branded renderer +
`DocKind` extension). Console + public surfaces are independent — land them first.
**Migration:** none (reads existing fixtures).

## Context

The knockout stage has no bracket tree anywhere the way a real cup shows it:
the console renders a flat fixture list, and the public bracket is disconnected
columns. Organisers and fans expect the classic **two-sided bracket converging on
a centre Final** (the FIFA-poster shape). Because a knockout's structure is fully
determined by `round_no` + `seq_in_round` + bracket size, one pure geometry
function can drive every surface — so they never diverge.

This is **live product data**, not a blank predictor: the bracket fills as matches
are decided (unresolved feeds render as `TBD`, in-play matches highlighted). No
fill-in/print-blank mode.

## Task

### 1. Shared bracket geometry (pure, sport-neutral)

New `packages/engine/src/scheduling/bracket-layout.ts`:

```ts
export interface BracketNode {
  fixtureId: string;
  side: "L" | "R" | "center";   // centre = the Final (+ 3rd place)
  col: number;                   // 0 = outermost round on each side
  row: number;                   // vertical order within the column
}
export interface BracketConnector { fromRow: number; toRow: number; col: number; side: "L" | "R" }
export interface BracketLayout { nodes: BracketNode[]; connectors: BracketConnector[]; rounds: number; thirdPlaceId?: string }

// Positions a single-elim field two-sided: first-round matches split top-half →
// left, bottom-half → right; each subsequent round halves inward; the last round
// (Final) is centre; a 3rd-place playoff (thirdPlace fixture) hangs under the
// Final. Pure + deterministic from (round_no, seq_in_round) — no sport code.
export function twoSidedBracket(fixtures: readonly BracketFixtureRef[]): BracketLayout;
```

- Single-elim only. Double-elim (WB/LB/GF lanes) and stepladder keep their
  current column/ladder view — return a discriminated "unsupported → fall back"
  signal rather than mis-laying them.
- Golden test across **two sports** and sizes 4/8/16/32 (and an odd/bye field):
  node coordinates + connectors are stable; the Final is centre; halves balance.

### 2. Console — `BracketPanel` (interactive)

New `apps/web/src/components/v2/bracket-panel.tsx`, rendered by the division page
for `kind === "knockout"` (mirror the `AmericanoPanel` branch). Uses
`twoSidedBracket` for positions; draws **connector lines** (inline SVG or CSS
borders) between a match and the one it feeds. Each node: two sides
(winner bold, loser muted, `TBD` for unresolved feeds), `summary.headline` score,
live pulse for in-play, and a link to score the fixture (`routes.fixture`).
Horizontal scroll for depth (32-team). Respects the console (floodlit) theme
tokens, not raw slate.

### 3. Public — upgrade `bracket.tsx`

Replace the disconnected columns with the same `twoSidedBracket` geometry +
connectors, read-only, linking to the public fixture view. Keep the existing
`FixtureCard` styling/headline/live treatment. Double-elim/stepladder keep the
current column/ladder branch (the fallback signal from §1).

### 4. PDF — `DocKind: "bracket"` (results poster, landscape)

- Add `bracket` to the `DocKind` enum (engine `types.ts`) and
  `buildBracket(...)` in `build.ts` → a `DocModel` carrying the laid-out nodes +
  connectors + branding (pure; `printedAt` an input, golden-asserted).
- Render it in `doc-render.ts` as a **landscape** two-sided tree with drawn
  connector lines, filled from live data (decided → names + score, unresolved →
  `TBD`). Reuse v12's branded masthead/sponsor chrome.
- New export route wiring (`exports/[kind]` accepts `bracket`, `format=pdf`).
  Multi-page fold only if a 32-team tree can't fit one landscape sheet.

## Tests (regression — each fails without its change)

- `bracket-layout.test.ts`: golden node/connector coordinates for 4/8/16/32,
  centre Final, balanced halves, 3rd-place placement, bye handling; run for two
  sports; double-elim/stepladder → fallback signal.
- Console: `BracketPanel` renders N round columns two-sided, a decided match
  shows winner bold + score, an unresolved feed shows `TBD`, node links to the
  fixture. (jsdom render test.)
- Public: upgraded `bracket.tsx` snapshot shows connectors + centre Final.
- PDF: `buildBracket` golden `DocModel`; a route test that `exports/bracket?
  format=pdf` returns a PDF for a knockout division.

## Non-goals

- Single-elim only (double-elim/stepladder unchanged).
- No blank/fill-in predictor poster — results only, filled from live data.
- No new sport logic; geometry is pure round/seat math.
- No drag-to-edit bracket; it's a view (scoring stays in the fixture console).

## Help / docs pass (mandatory)

Update `content/help/*` on knockout/brackets: where the bracket appears (console,
public, PDF export), sport-neutral wording, same PR.
