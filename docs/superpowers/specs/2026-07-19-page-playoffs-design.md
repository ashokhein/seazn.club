# Playoffs (IPL / Page system) — new bracket format

**Problem.** "Group + Stepladder" renders a true stepladder (4→3, winner→2,
winner→1). The user expected the IPL playoff shape — the Page system — which
is a different format: the top two get a second life.

**Decision (user-approved with diagram).** New engine stage kind
`page_playoff`, a fixed 4-team shape, plus a "Group + Playoffs" template.

## 1. Engine — generator

`generatePagePlayoff({ entrants })` in `scheduling/bracket.ts` (reuses the
existing `winnerOf`/`loserOf` feed infra; seeds 1–4 by rank):

| id | round | pairing |
|---|---|---|
| `q1` | 0 | seed 1 vs seed 2 (Qualifier 1) |
| `elim` | 0 | seed 3 vs seed 4 (Eliminator) |
| `q2` | 1 | loserOf(q1) vs winnerOf(elim) (Qualifier 2) |
| `final` | 2, isFinal | winnerOf(q1) vs winnerOf(q2) (Final) |

`StageKind` zod enum + `stages.ts` generate switch gain `page_playoff`;
`bracketToGen` persists rounds 1..3 (no lanes). Qualification: standard
(topN 4 — the resolver already ranks league standings into seeds).

## 2. Geometry

`pagePlayoffBracket(fixtures)` in `bracket-layout.ts` — structural contract
like the others: rounds (1×2, 2×1, 3×1) or `{ok:false}`. Layout mirrors the
IPL card: Q1 top-left; Eliminator bottom-left; Q2 centre (fed by Q1-loser ↓
and Eliminator-winner →); Final right (fed by Q1-winner → and Q2-winner →).
Nodes carry `slot: "q1" | "eliminator" | "q2" | "final"`; labels are the
four match names (i18n on console/slideshow, literals on public/poster like
the other shapes).

## 3. Surfaces (same one-layout-everywhere rule)

- **Public** `Bracket` kind `page_playoff` → new `PagePlayoff` view
  (connected cards + captions QUALIFIER 1 / ELIMINATOR / QUALIFIER 2 /
  FINAL).
- **Console** `BracketPanel` branch (night-styled, same node markup).
- **Slideshow** slide (`stageKind: "page_playoff"`, gate = layout.ok).
- **PDF poster** `buildPagePoster` payload + `pagePlayoffPageGeometry`
  bounds-proved; poster stage select adds the kind.
- Gates to widen (the lesson from #142): console page
  `BRACKET_STAGE_KINDS`, public/embed `BRACKET_KINDS`,
  `BRACKET_SLIDE_KINDS`, poster SQL kind list, public `roundName`
  (Q1/Eliminator → Qualifier 2 → Final).

## 4. Template + settings

`format-templates.ts`: `group_playoffs` — "Group + Playoffs (IPL style)":
league stage + `page_playoff` stage with `qualification: { topN: 4 }`
(qualified count FIXED at 4; the builder disables the qualified selector for
this template). `detectTemplate` maps `league+page_playoff`.

## 5. Tests

Engine: generator feeds (q2 = loserOf q1 + winnerOf elim; final = winners),
layout ok/reject, poster geometry bounds. Web: public + console markup
(4 captions, connector svg), slideshow gate, smoke block (create template →
decide league → complete → 4 playoff fixtures with correct feeds → decide
Q1 → q2 home resolves to Q1 loser). Help: kinds/bracket-view sections.

## Out of scope

5-team Page variants; second-life visuals beyond the connector; reusing
this shape for >4 teams.
