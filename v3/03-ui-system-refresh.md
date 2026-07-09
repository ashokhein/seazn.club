# v3/03 — UI System Refresh: Cards, ConfirmDialog, Tips, Logos, Plan Scrub, Visibility

Shared UI primitives that several v3 docs depend on. Design language: keep the existing
violet identity (`--brand: #7c3aed` on `#faf7ff`, Geist Sans/Mono) but give the console a
**"match-day card" system** — the one deliberate aesthetic move of v3. Sports UIs the
organisers already trust (broadcast graphics, scoreboards) are built from chips, badges
and fixture cards; the console should read the same way instead of admin-panel tables.

## 1. Card anatomy (the signature primitive)

```
┌─────────────────────────────────────┐
│ 🏸  U16 Boys Singles      [● Live]  │  ← sport glyph · name · status chip
│ Knockout · 14/16 entrants           │  ← format · capacity meter (text, not bar)
│ Next: Arun vs Dev · Court 2 · 14:30 │  ← "what's next" line (the organiser's question)
│ ▁▁▂▄ 12 of 15 played                │  ← progress: played/total, tiny inline meter
└─────────────────────────────────────┘
```

- Status chips are the system vocabulary everywhere (cards, headers, fixtures):
  `Draft` (neutral), `Registration open` (violet outline), `Live` (violet fill + pulse dot,
  `prefers-reduced-motion` respected), `Completed` (muted), `Archived` (ghost).
- Left border 3px in a per-division hue (same hue drives v3/04 board lanes) — cheap
  wayfinding across pages.
- Whole card clickable (route builder from v3/01); actions in `⋯` overflow.

## 2. Grid → cards (intake #11)

- `/o/[org]` competitions list and competition-page divisions list swap table/grid for
  card grid: 1-col <`sm`, 2-col <`lg`, 3-col ≥`lg`.
- Sort: Live first, then Registration open, Draft, Completed; secondary = recently updated.
- Empty state is an invitation (frontend-design rule): "No competitions yet — create one
  in about two minutes." + primary button, not a grey placeholder.
- Keep a compact list toggle for orgs with >20 comps (persist per-user in localStorage).

## 3. `<ConfirmDialog>` — kill `window.confirm` (intake #30)

Eight components call native `confirm()` today (`billing-actions`, `account-actions`,
`v2/stages-panel`, `v2/history-panel`, `v2/clubs-panel`, `v2/registrations-panel`,
`public-site/registration-actions`, `api-keys`). Replace with one primitive:

- API: `confirm({ title, body, confirmLabel, tone: "default" | "danger", typedName? })`
  → promise<boolean>; rendered via a single context provider in the console layout.
- `tone: "danger"`: red confirm button, requires explicit click (no Enter-submit).
- `typedName`: for irreversible bulk ops (delete division v3/09 §4, clear schedule) the
  user types the entity name — matches the existing `confirm:true` API contract.
- Mobile: bottom sheet (v3/02 pattern 3). Focus-trapped, `Esc` cancels, restores focus.
- Lint rule bans `window.confirm`/`window.alert` in `apps/web/src`.

## 4. Tips framework (intake #17)

Contextual education without tooltip soup:

- `<Tip id="division.visibility">` renders a small `ⓘ` inline; tap/hover opens a popover
  with 1–3 sentences + optional "Learn more →" deep link into `/help` (v3/06).
- Content lives in one registry `config/tips.ts` (id → {title, body, helpSlug}) so copy is
  reviewable in one file and i18n-ready.
- Dismissible **callout** variant for first-run moments ("Fixtures are generated per
  stage — preview before you commit"), dismissed-state per user in localStorage.
- Seed list (first 12): division visibility, start-division-locks-scoring, seq-conflict
  meaning, entrant kinds (team/individual/pair), format picker (each format), downgrade
  freeze, event-pass scope, ref-number lookup, schedule locking, undo watermark,
  api-key scopes, slideshow URL.

## 5. Logo placement matrix (intake #9)

Three logo levels exist conceptually; only org + club exist in data (club badge fallback
`team_display_v` shipped in Jul3/01). **Add `teams.logo_url`** (upload path mirrors club
logos; falls back club → org monogram → initials avatar).

| Surface | Org logo | Club logo | Team logo |
|---|---|---|---|
| Console header / org switcher | ✅ 24px | — | — |
| Public site header + hero | ✅ | — | — |
| Standings rows, fixture rows, cards | — | fallback | ✅ 20px chip |
| Slideshow slides | ✅ corner | ✅ | ✅ large on matchup slide |
| PDF/XLSX exports (Jul3/06 branding) | ✅ header | ✅ | ✅ row chip |
| Registration page (v3/05) | ✅ | — | — |
| OG/share images (v3/10 wave 1) | ✅ | — | ✅ matchup |

Rule: one logo per level per surface — never org+club+team side by side except the
slideshow matchup slide.

## 6. Business-plan scrub (intake #5)

`business` stays as a hidden DB plan key (grandfathering/enterprise deals) but disappears
from UI: `plan-badge.tsx` (render map drops the case → falls back to generic label if an
org actually has it), `settings/page.tsx` plan copy, `api-keys.tsx` gating copy
("Business" → "Pro"). Pricing page/marketing never mention it (v3/07 owns that copy).
Grep-gate in CI: `business` forbidden in `apps/web/src/app/(marketing)` and component copy
(allowlist for the plan-key literal in lib code).

## 7. Visibility picker — plain language (intake #16)

"Public/unlisted/private" is engineer vocabulary. Replace every visibility control with
radio cards (division + competition settings, same component):

```
◉ Private        Only your team can see it.
○ Link only      Anyone with the link can view. Hidden from Google and our directory.
○ Public         Anyone can find it — Google, and the Seazn discover page.
```

- Names: **Private / Link only / Public** (map to existing private/unlisted/public keys —
  no schema change; `noindex` behaviour unchanged).
- Each option shows its consequence sentence permanently (not a tooltip) — the decision
  *is* the consequence.
- After choosing Link only/Public, surface the share URL + copy button right there.

Related: [[v3/01]] route builder, [[v3/02]] responsive behaviours, [[v3/04]] lane hues,
[[v3/05]] registration uses card/ticket language, [[v3/06]] help links from Tips.
