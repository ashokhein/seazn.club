# PROMPT-21 — Clubs & Bulk Participant Import

**Read first:** `engine/Jul3/01-clubs-and-bulk-import.md` (normative); `engine/07-greenfield-schema.md`
§conventions + §notes 1–4; `engine/08-api-design.md` §1, §3, §4; `engine/10-pro-entitlements.md`
§2–3; `engine/06-divisions-and-eligibility.md` §4.4 (club championship), §4.7 (consent).
Preamble: PROMPT-00. **Depends:** PROMPT-10 (schema), PROMPT-11 (api-v1). Promotes the
doc 16 §Tier-3 "Imports" backlog line; keep the old-engine rule (PROMPT-00 §5) — this is
additive, deletes nothing.

## Task

1. **Schema migration** (per Jul3/01 §2): `clubs` table + `teams.club_id` FK + indexes;
   generic `set_org_from_parent()` trigger + direct RLS policy per the 010 pattern;
   `team_display_v` view resolving effective logo/colour (team → club fallback) and folded
   into the doc 07 note-4 public read views. Extend `check:rls` coverage to `clubs`.

2. **Engine planner** `packages/engine/import/` — **pure, no I/O** (README rule 1,
   PROMPT-00 §3): Zod schemas + inferred types `ImportRow`, `ImportSnapshot`, `ImportConfig`,
   `ImportOp`, `ImportIssue`, `ImportPlan` (Jul3/01 §3); `planImport(rows, snapshot, config)
   → ImportPlan`, total (never throws — all problems become `issues`), deterministic. Match/
   dedupe/idempotence exactly per Jul3/01 §4; every rule comments its spec section
   (`// Jul3/01 §4 person match`). Ops carry stable synthetic refs so cross-op dependencies
   resolve at execute time.

3. **App server layer** (`apps/web/src/server/`, server-only — the only writer):
   - CSV/XLSX parser → header-mapped `ImportRow[]` (streamed for large files, Jul3/01 §9).
   - `POST /api/v1/imports` (multipart) → parse + fetch `ImportSnapshot` + `planImport` →
     `{ importId, plan }`; **dry-run, writes nothing**. Persist the parse + plan for re-preview.
   - `POST /api/v1/imports/{id}/commit` → execute plan ops in ref-dependency order inside one
     `withTenant` transaction (rollback-all on any failure); `Idempotency-Key` header
     (doc 08 §4, Redis 24 h); emit `division_events: participants_imported` + org audit
     (011 hash chain). `GET /api/v1/imports/{id}` re-previews.
   - `POST /api/v1/clubs/logos` (multipart, bulk) — match per Jul3/01 §5 (filename-stem →
     manual re-map → any-order), content-hash dedupe, set `clubs.logo_path`, idempotent.
   - `clubs` CRUD; `?club_id=` filter on `divisions/{id}/entrants`; `GET
     /participants/export?format=csv|xlsx` (club + division columns, empty-spot placeholders
     preserved). Wire the doc 08 §3 `divisions/{id}/entrants` CSV hook as a division-pinned
     alias into the same planner.

4. **Entitlements** (Jul3/01 §7): seed `import.bulk`, `logos.bulk`, `clubs.hierarchy` in
   `plan_entitlements`; enforce with `requireFeature`/`withinLimit` at the use-cases (402
   `PaymentRequiredError` carrying `feature_key`); Community capped at 20 rows/file.

5. **UI** (`apps/web`): import wizard (upload → column mapper with remembered mapping →
   preview table grouped by club with per-row create/update/skip/link badges + issue list →
   Commit); bulk-logo grid (drag-drop, per-club re-map dropdown, assign-remaining toggle);
   club filter facet + club detail (teams across divisions) on participants/schedule pages.
   Keyboard-accessible (a11y required, matches PROMPT-17 bar).

## Acceptance

- **Property (fast-check):** `planImport` idempotent — apply a plan, rebuild the snapshot,
  re-plan the same rows ⇒ `ops == []`; dedupe never emits a second `club.create`/
  `person.create` for a matching entity; unknown `divisionSlug` always yields
  `error DIVISION_NOT_FOUND` and never an op.
- **Golden:** a sample 3-club × 4-team × 11-player XLSX → expected `ImportPlan` (stats +
  op kinds); committing it then re-committing the same file = no-op (zero new rows).
- **E2E (Playwright):** upload → preview shows a seeded issue (bad position) → fix →
  commit → clubs/teams/persons/entrants/rosters present with club parentage; bulk-logo drop
  → every child team renders the club badge via `team_display_v`; participants export has a
  club column with empty-spot rows intact; Community org blocked at row 21 with a 402
  carrying `import.bulk`.
- `npm test` + `npm run lint` green. Update `engine/README.md` (doc index + prompt index)
  and, if any rule here refined Jul3/01, update Jul3/01 in the same PR (PROMPT-00 §4 — docs
  and code may not drift).
