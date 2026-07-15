# v12 — Matchday Documents (improve the PDFs, add the missing ones)

> **Status (2026-07-14):** design only. PROMPT-58 not yet implemented.
> Target branch (build time): `feat/v12-scheduling-docs` (own worktree off
> `main`). **Soft-depends on v10 + v11:** the branded-render half is fully
> independent and can land first; the sponsor footer needs v10's model and the
> officials rota needs v11's assignments/response data. Build v12 last.
> **Migrations:** likely **none** (documents read existing data). The one hard
> change is the shared `DocKind` enum in `@seazn/engine`.

## Theme

The document pipeline is mature but **the PDF renderer throws the design away.**
`packages/engine/src/exports/types.ts` defines a `DocModel` that already carries
`branding: { colors, logos, sponsors }` and a `DocKind` enum
(`timetable | scoresheet | roster | standings | match_report | participants`).
`build.ts` assembles those models (`buildTimetable`, `buildStandings`,
`buildRoster`, `buildParticipants`); `usecases/exports.ts::buildDivisionDocModel`
wires them to routes (`exports/[kind]`, `competitions/[id]/exports/timetable`,
`schedule/report`, `poster.pdf`). Then `apps/web/src/server/doc-render.ts`
renders it as **bare black Helvetica tables and ignores `model.branding`
entirely** — no masthead, no org name, no logo, no brand colour, no sponsor
line. Every export the product produces looks like a 2004 mail-merge, while the
email templates and the admit-one ticket (see `ticket-new.png`) show the actual
SEAZN "courtside" look the org expects.

**v12 is two halves:**

1. **Improve every existing PDF at once** by making `doc-render.ts` honour
   `DocBranding`: a branded masthead bar (SEAZN wordmark + org name, brand
   colour rule, optional org logo), a footer that already exists but restyled,
   and a **tier-grouped sponsor line** fed from v10. Because all exports share
   one renderer, this single change upgrades the timetable, scoresheet, roster,
   standings, participants, poster, schedule report, and v9 dispute-evidence
   PDFs simultaneously. Gate the branded chrome on the existing
   `exports.branded` Pro entitlement (the `types.ts` comment already anticipates
   it: *"Pro `exports.branded` — nulled server-side otherwise"*).

2. **Add the documents that don't exist yet**, surfaced from a **Documents**
   control on the organiser schedule board (`components/v2/board/board-tray.tsx`
   / the schedule page shell, plus the `o/[orgSlug]/.../schedule` slug route):
   - **Order of play** — the timetable, already built, now branded.
   - **Match sheets** — per-fixture score-entry sheets (the `scoresheet` kind +
     `DocSection.signatures`/`formLines`/`swatches`, which already exist but
     aren't surfaced from the board).
   - **Officials rota** — new `officials_rota` kind, per-official schedule from
     v11's `fixture_officials` + response state.
   - **Admit-one tickets** — new `admit_ticket` kind, per-entrant pass with QR
     in the `ticket-new.png` style, generated from confirmed registrations.

## Prompts

- `prompts/PROMPT-58-scheduling-docs.md` — teach `doc-render.ts` the branded
  masthead/logo/sponsor chrome (colour + logo + tier-grouped sponsor line),
  gated on `exports.branded`; add `officials_rota` + `admit_ticket` `DocKind`s
  and their builders in `@seazn/engine/exports`; a Documents panel on the
  schedule board wiring PDF+XLSX per doc; QR for tickets reusing existing infra;
  golden `DocModel` tests, help, smoke.

## Non-goals (explicit)

- **A WYSIWYG document designer** — chrome is derived from org branding + tier
  rules, not hand-laid.
- **Per-fixture custom scoresheet templates per sport** — the existing
  sport-neutral `scoresheet` section shape is reused as-is.
- **Emailing tickets/sheets** — v12 produces downloadable/printable files;
  delivery stays the organiser's job (registration emails already carry the
  reference + lookup link).
- **Re-theming the public web schedule** — this wave is print/PDF only; the
  public HTML schedule is untouched.
