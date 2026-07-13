# Console cards with images + division Settings tab (v8)

**Status:** shapes approved 2026-07-13 (hybrid cards; Settings tab + accordion; format locked once fixtures exist).
**Branch:** `feat/v8-cards-div-settings` off main (worktree `.claude/worktrees/v8-cards-div-settings`). Independent of PR #75.
**Migration:** V274 — `divisions.logo_url text`, `divisions.logo_storage_path text` (nullable, mirrors `organizations`).

## Goal

The console's competition and division cards are text-first (20px emoji glyph); the division page dumps the embed snippet and danger zone under every tab and offers no way to change format, name, or identity after creation. Give cards real visual identity (sport for competitions, logo/monogram for divisions), and give divisions a Settings tab that collects the strays.

## 1. Cards (EntityCard evolves — anatomy kept)

The v3 match-day anatomy (name · chip / meta / next / progress, accent left border) stays; `EntityCard` gains an optional `media` slot rendered per level:

- **Competition cards — banner strip.** A ~64px top strip: sport-tinted gradient (small `SPORT_TINTS` map keyed by the comp's dominant `sport_key`; multi-sport comps use the violet house tint) with the sport emoji large (~28px) at the left. Hover nudges the icon scale 1.05 (wrapped in `motion-safe:`). Strip is decorative — `aria-hidden`, no new focus targets.
- **Division cards — 56px square tile** left of the name: the division's uploaded logo (cover-fit, rounded-lg) or, when none, a **monogram** — the division name's first letter on the division's existing accent hue at ~15% opacity background with the hue as text color. The tile replaces the emoji glyph; the 3px accent border stays (wayfinding unchanged).
- Both render inside the existing grids; card heights stay within one row-step of today so busy orgs keep their density. Mobile: banner strip shortens to ~48px; tile stays 56px.

## 2. Division Settings tab

The division page gains a **Settings** tab (visible to `canEdit` only) beside Entrants / Fixtures / Standings / Stats. Inside, tap-per-section staged disclosure (same Group primitive style as the v7 registration accordion):

1. **General** — division name (existing rename semantics), **logo upload** (reuses the org-logo storage flow: upload → storage path + public URL on the division row; remove button reverts to monogram). Preview of the resulting card tile.
2. **Format** — shows sport / variant / config summary. Editable (variant + config via the existing division PUT validation) **only while no stage has generated fixtures**; once fixtures exist the section renders read-only with: "Format is locked — fixtures exist. Delete the stages first if you must change it." (links the Fixtures tab). Lock predicate is a pure exported function `formatLocked(stages: {fixtureCount: number}[]): boolean` so it's unit-testable and shared with the API guard — the PUT also rejects format fields with 409 `FORMAT_LOCKED` when locked (UI hiding is not enforcement).
3. **Sharing & embed** — `EmbedSnippet` moves here (same component, same entitlement gate). Private comps show the existing "no public link" note instead.
4. **Danger zone** — `DivisionDangerZone` moves here unchanged (archive/delete stay owner/admin actions, still allowed on frozen comps).

The page bottom loses the always-visible EmbedSnippet + DangerZone on every tab.

## 3. Out of scope

Public-page cards (courtside system untouched), competition-level settings restructure, org logo flows, entrant logos, any scoring/format engine changes — the Format section edits exactly what division-create already validates.

## 4. Testing

- Unit: `formatLocked` (0 stages / stages without fixtures → false; any fixtures → true); monogram fallback helper (first grapheme, hue passthrough).
- API: division PUT with variant/config → 200 pre-fixtures, 409 `FORMAT_LOCKED` after generation (DB-backed test, new file).
- e2e: Settings tab renders all four sections; format section flips to locked after generating fixtures; embed snippet present under Sharing (and gone from page bottom); danger-zone delete still works from its new home; division card shows monogram then uploaded logo after upload; comp card shows banner.
- Screenshots desktop + 390px (cards grid + settings tab); no horizontal scroll at 390.
- smoke: settings-tab format lock probe (PUT 409 after fixtures) + card render sanity.
- Help pages (mandatory closing pass): division/format articles + embed article pointers move ("division page → Settings → Sharing & embed"); grep nouns `embed`, `danger`, `delete division`, `format`.
- `tsc --noEmit`, eslint, full vitest green.

## 5. Decisions log

- Hybrid card look chosen over uniform banner/tile (hierarchy: comps read bigger than divisions).
- Settings tab + accordion over dedicated route/drawer (one hop, matches v7 registration pattern).
- Lock rule = fixtures exist (data-based, zero destructive paths) over first-result or date-based.
- Migration accepted (division logo columns) — first schema change of the wave, V274.
