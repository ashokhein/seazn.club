# Console cards + division Settings tab Implementation Plan (v8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline — user forbade subagents). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Image-led competition/division cards (sport banner / logo-or-monogram tile) and a division Settings tab collecting name+logo, format (locked once fixtures exist), embed snippet, and danger zone.

**Architecture:** `EntityCard` gains an optional media slot; division identity comes from new `divisions.logo_*` columns (V274) with a monogram fallback in the division's existing accent hue (`lib/division-hue.ts`). The Settings tab is a new client component on the division page; the format lock is a pure `formatLocked()` shared by UI and the PATCH guard (409 `FORMAT_LOCKED`). Logo upload mirrors the org-logo signed-URL flow (`supabase-storage.getSignedUploadUrl`).

**Tech stack:** Next 16 App Router, Flyway V274, zod v1 schemas, vitest (pure + real-PG), Playwright e2e.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-console-cards-division-settings-design.md`.
- Branch `feat/v8-cards-div-settings`; no subagents; verify before push (tsc, eslint, vitest, smoke, screenshots desktop+390).
- Lock rule: format editable only while **no stage has fixtures**; API enforces with 409 code `FORMAT_LOCKED`.
- Read UI copy exactly from spec §2. Help-page pass mandatory at the end.
- DB-backed tests: ephemeral PG recipe (port 54335 pattern, own instance), run vitest from `apps/web`.

---

### Task 1: V274 + division logo plumbing (columns, storage path, upload URL, patch)

**Files:**
- Create: `db/migration/deltas/V274__division_logo.sql`
- Modify: `apps/web/src/lib/supabase-storage.ts` (add `divisionLogoPath`), `apps/web/src/server/usecases/divisions.ts` (COLS + `DivisionRow` + patch passthrough), `apps/web/src/server/api-v1/schemas.ts` (`PatchDivision` + `logo_storage_path`), `apps/web/src/server/usecases/public.ts`/logo resolution only if cards need public URLs (console-only for now — resolve via existing `resolveLogoUrl` helper where the page queries).
- Create: `apps/web/src/app/api/v1/divisions/[id]/logo-upload-url/route.ts` (POST, `requireResourceAuth(req,"division",id,"edit")`, same shape as org route; no plan gate — division logos ride the card design, not Pro branding).
- Test: `apps/web/src/server/usecases/__tests__/division-settings.test.ts` (new, DB-backed; also used by Task 2).

**Interfaces produced:** `DivisionRow.logo_url: string | null`, `DivisionRow.logo_storage_path: string | null`; `PatchDivision.logo_storage_path?: string | null`; `divisionLogoPath(divisionId: string): string`; POST logo-upload-url → `{ upload_url, token, storage_path }`.

- [ ] Migration:
```sql
-- V274: division identity for console cards (v8 spec 2026-07-13).
alter table divisions
  add column logo_url text,
  add column logo_storage_path text;
```
- [ ] TDD: failing test — `patchDivision` round-trips `logo_storage_path`, `getDivision` returns it; run (fails: column/schema missing); apply migration to the ephemeral DB; implement plumbing; green.
- [ ] Commit `feat(div): V274 division logo columns + upload URL`.

### Task 2: formatLocked + format fields on PATCH (409 guard)

**Files:**
- Create: `apps/web/src/lib/format-lock.ts`
- Test: `apps/web/src/lib/__tests__/format-lock.test.ts` (pure) + cases in `division-settings.test.ts` (DB)
- Modify: `schemas.ts` (`PatchDivision` gains `variant_key: z.string().min(1)`, `config: z.record(z.string(), z.unknown())` — both optional like all patch fields), `divisions.ts` (`patchDivision` guard + variant validation copied from `createDivision`'s variant/config checks)

**Interfaces produced:**
```ts
/** True once any stage owns fixtures — the format is then history, not a setting. */
export function formatLocked(stages: { fixture_count: number }[]): boolean;
```
PATCH with `variant_key`/`config` while locked → `HttpError(409, "Format is locked — fixtures exist", "FORMAT_LOCKED")`.

- [ ] Pure TDD: empty → false; stages w/ 0 fixtures → false; any >0 → true.
- [ ] DB TDD: patch variant pre-fixtures 200 + row updated; generate a stage w/ fixtures (reuse suite conventions from stages tests) then patch → 409 FORMAT_LOCKED; non-format fields still patch fine while locked.
- [ ] Commit `feat(div): format editable until fixtures exist (FORMAT_LOCKED)`.

### Task 3: EntityCard media — sport banner + logo/monogram tile

**Files:**
- Modify: `apps/web/src/components/ui/entity-card.tsx` (optional `media?: { kind: "banner"; emoji: string; tint: string } | { kind: "tile"; logoUrl: string | null; monogram: string; hue: string }`)
- Create: `apps/web/src/lib/sport-tints.ts` (`SPORT_TINTS: Record<string,string>` + `sportTint(key)` fallback violet) with unit test `sport-tints.test.ts` (fallback + known keys)
- Modify: `apps/web/src/app/o/[orgSlug]/page.tsx` (comp cards get `media: banner` w/ dominant sport emoji + tint) and `apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx` (division cards get `media: tile` w/ `logo_url` + first-grapheme monogram + `divisionAccent(d.id)`)

Banner: `~64px` gradient strip (`linear-gradient(135deg, tint 0%, white 90%)`-style via inline style), emoji `text-3xl`, `aria-hidden`, `motion-safe:group-hover:scale-105 transition-transform`. Tile: 56px rounded-lg; `<img>` cover when `logoUrl`, else monogram letter on `hue` at 15% alpha background, hue text. Mobile: banner `h-12`.

- [ ] Implement + screenshot org page & comp page (desktop + 390) with the dev server; verify heights/truncation.
- [ ] Commit `feat(ui): entity cards carry sport banners and division tiles`.

### Task 4: Division Settings tab

**Files:**
- Create: `apps/web/src/components/v2/division-settings.tsx` (client; own `Group` disclosure primitive per v7 pattern)
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` — add `settings` to TABS (canEdit only), render `<DivisionSettings/>` on that tab, REMOVE the page-bottom `EmbedSnippet` + `DivisionDangerZone`

**Sections** (spec §2): General — name input (PATCH `{name}`) + logo uploader (POST logo-upload-url → PUT file to signed URL → PATCH `{logo_storage_path}`; Remove → PATCH null) + live 56px tile preview. Format — variant select (sport's variants via existing sport-module data passed from the page) + config JSON textarea (advanced), disabled+read-only summary with lock copy when `formatLocked`; uses stages' fixture counts passed from the page. Sharing & embed — `<EmbedSnippet/>` (private comps: existing note). Danger zone — `<DivisionDangerZone/>`.

- [ ] Implement; tsc+eslint; screenshots (unlocked + locked format states, desktop + 390).
- [ ] Commit `feat(div): settings tab — general/format/sharing/danger`.

### Task 5: e2e + smoke

- [ ] `apps/web/e2e/division-settings.spec.ts`: seed comp+division; Settings tab shows 4 sections; rename via General persists; format section editable → generate fixtures (existing stages API) → reload → locked copy + PATCH 409; embed snippet lives under Sharing and NOT at page bottom; danger-zone delete works from its new home; comp card shows banner (`data-testid="card-banner"`), division card shows monogram tile (`data-testid="card-tile"`).
- [ ] smoke: `divisionSettingsSuite` — PATCH variant pre-fixtures 200, post-fixtures 409 FORMAT_LOCKED, logo-upload-url 200 shape (before gapSuite; active-org derivation per v7 gotcha).
- [ ] Commit `test(div): settings tab + format lock coverage`.

### Task 6: Help pages + verify + PR (closing pass — mandatory)

- [ ] Grep help for `embed`, `danger`, `delete division`, `format`, `division settings`; update articles (embed article: path now "division page → Settings → Sharing & embed"; format lock explained; logo upload documented).
- [ ] Full gate: tsc, eslint, full vitest (DB), full smoke, screenshots; db:apply note for V274 in PR body; push; `gh pr create` → new PR (base main).

## Self-review

- Spec coverage: cards (T3), logo (T1/T4), settings tab + moves (T4), lock (T2/T4/T5), migration (T1), tests/help (T5/T6). ✓
- Type names consistent: `formatLocked`, `FORMAT_LOCKED`, `media.kind`, `divisionLogoPath`. ✓
- No placeholders; format editor scope pinned (variant select + config JSON — exactly create-time validation, no new engine surface). ✓
