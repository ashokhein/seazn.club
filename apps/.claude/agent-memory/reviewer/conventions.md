---
name: repo-review-conventions
description: Accepted conventions + recurring seams to check when reviewing seazn.club engine/server/console changes
metadata:
  type: reference
---

Durable conventions inferred while reviewing (first recorded 2026-07-18, entrant-shapes PR #136).

## Accepted patterns — do NOT flag these
- **API-level rejections use `HttpError(status, msg, CODE)`, NOT the engine `EngineError` enum.** EngineError is a closed 3-touch enum reserved for engine core; API validation (422/409 etc.) stays HttpError. Team-intentional.
- **New per-division config rides the untyped `divisions.config` JSON channel (no migration).** e.g. `config.entrants`. The sport `configSchema` STRIPS unknown keys, so such overrides must be carried through the parse explicitly in `patchDivision` (see divisions.ts). This is the accepted no-migration pattern.
- **Engine pure functions imported into client components is established practice** (precedent: slideshow.tsx, entrants-panel.tsx). Don't flag `@seazn/engine/*` imports in "use client" files.
- **Config-override fields stored unvalidated** is acceptable when the engine resolver tolerates garbage field-by-field (filters/ignores bad values at read). Organiser-controlled untyped config = no new attack surface.

## Gates every branch must pass (flag if missing)
- New console copy → keys in `en/fr/es/nl` ui.json + `i18n:gen-keys` (updates i18n-keys.ts DictionaryKey union) + `i18n:check` parity. All four locales or it's a gap.
- Help pages under `apps/web/content/help/**` updated in the SAME branch (mandatory closing pass).
- Every code change ships a test that fails without it (team constraint). Defensive one-line invariants with no triggering data are the usual exception — note, don't block.

## smoke.ts idioms (scripts/smoke.ts)
- Helpers: `check(label, bool)`, `v1(session, path, method, body?)`, `v1data<T>(res)` → `res.json.data`. Suites gated on `process.env.DATABASE_URL` seed the REAL module catalog as a local-run fallback (CI runs `sync:sports`); use `on conflict do nothing` so it never poisons a shared DB. Never seed an empty-stub catalog.
- Member input shapes accepted by entrants POST: `{ person_id, is_captain, roles }` OR `{ new_person: { full_name } }` (NewPersonMemberInput).

## Recurring seam to check — sport module factory threading
- Adding an optional field to `SportModule` (e.g. `entrantModel?`, `playerStats?`) requires threading it through EACH factory kernel that builds modules, else factory-built sports silently miss it. Kernels: `nested/kernel.ts` (tennis), `period/kernel.ts` (hockey, icehockey), `setbased/kernel.ts` (badminton, tabletennis, volleyball).
- **Known gap (entrant-shapes PR #136):** nested + period were threaded; **setbased was NOT** — badminton/tabletennis/volleyball keep legacy all-kinds entrant behavior. Accepted as de-scoped follow-up, not a regression. Re-check setbased when a future branch claims to finish per-sport entrant shapes.
