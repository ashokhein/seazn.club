# PROMPT-26 — Rich Exports & Print Templates

**Read first:** `engine/Jul3/06-exports-and-print.md` (normative); `engine/09-public-dashboard.md`
(read models); `engine/07-greenfield-schema.md` note 4 (public views); `engine/03-engine-architecture.md`
(module plugin points). Preamble: PROMPT-00. **Depends:** PROMPT-08 (standings), PROMPT-12
(read models). Sport-fragment hooks depend on the sport modules (PROMPT-04..07, 16).

## Task
1. **Engine** `packages/engine/exports/` — **pure**: `DocModel` Zod schema (Jul3/06 §2) +
   `buildDocModel(kind, data, opts) → DocModel` for the sport-neutral kinds (timetable,
   standings, roster, participants). `printedAt` is an input, not `Date.now()` (PROMPT-00
   §3). Scope + `pageBreaks` (`per_pitch|per_team|per_division`) per Jul3/06 §4. Cite
   `// Jul3/06 §2`.
2. **Sport fragments** (Jul3/06 §3): optional `SportModule.exportTemplates` (scoresheet,
   matchReport) → `DocSection`; implement the **volleyball point-by-point scoresheet** with
   signature lines + two-per-page (12 Jun exact ask) in the set-based module.
3. **Renderers** (`apps/web`, server-only — the I/O half): `DocModel → PDF` and `→ XLSX`;
   branding (club colours via `team_display_v` from Jul3/01 §2, sponsor logos, tournament
   title, prelim/KO headings, printed-date footer — 1 Sep asks). Empty-spot labels never
   blank (30 Jan). Stream large exports.
4. **API** (Jul3/06 §5): `divisions/{id}/exports/{kind}`, `competitions/{id}/exports/
   timetable?pretty=true`; cache on read watermark; branding nulled for non-Pro at the model
   layer.
5. **Entitlements** (Jul3/06 §6): `exports` (Pro) for CSV/XLSX; `exports.branded` (Pro) for
   templated/branded PDF; layout flags (landscape, page-break scope) all export plans.

## Acceptance
- Golden: `buildDocModel` output for a timetable, a landscape standings, a roster, and a
  volleyball scoresheet asserted as stable `DocModel` JSON (not pixels).
- E2E: export pretty timetable PDF (tournament name + prelim/KO headings + footer date);
  scoresheets `pageBreaks=per_pitch` → each court starts a new page; participants XLSX has
  club + division columns with Empty-Spot rows intact; non-Pro gets unbranded output.
- `npm test` + `npm run lint` green; update `engine/README.md` indexes.
