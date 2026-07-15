# PROMPT-58 — Matchday documents: brand the PDFs, add rota + admit tickets

**Read first:**
- `apps/web/src/server/doc-render.ts` — the renderer that **ignores
  `model.branding`**. `docModelToPdf` opens with a plain
  `Helvetica-Bold 16` title and never touches `branding`; `drawSection` /
  `drawTable` are bare B/W. This file is the whole "improve existing PDF" lever.
- `packages/engine/src/exports/types.ts` — `DocModel` already carries
  `branding: DocBranding { colors, logos[], sponsors[] }` and the `DocKind`
  enum (`timetable | scoresheet | roster | standings | match_report |
  participants`). You add `officials_rota` + `admit_ticket` here.
- `packages/engine/src/exports/build.ts` — `buildTimetable`, `buildStandings`,
  `buildRoster`, `buildParticipants`. You add `buildOfficialsRota` +
  `buildAdmitTickets`. Pure + deterministic (`printedAt` is an input — goldens
  assert the model; keep it that way).
- `apps/web/src/server/usecases/exports.ts` — `buildDivisionDocModel` (wires
  builders to routes; sets `branding` — currently probably passing it through or
  nulling it). This is where branded chrome gets its data.
- `apps/web/src/app/api/v1/divisions/[id]/exports/[kind]/route.ts` — the export
  route (kind enum, `format=pdf|xlsx`, `blank`, `landscape`, `pageBreaks`). Add
  the new kinds + a rota/ticket route.
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/poster.pdf/route.ts`
  — existing branded-ish PDF; the sponsor data now comes from v10's
  `resolveSponsors`.
- `apps/web/src/components/v2/board/board-tray.tsx` + the schedule page shell +
  `apps/web/src/app/o/[orgSlug]/c/[compSlug]/**/schedule` — where the
  **Documents** control mounts.
- v10 `resolveSponsors` (sponsor rows + tiers) and v11 `fixture_officials
  .response` + `official_availability` — the data the new docs draw.
- `ticket-new.png` (repo root) — the admit-one visual target.
- `design/v12/README.md` (scope + non-goals).

**Depends (soft):** v10 (sponsor line data), v11 (rota data). The **branded
chrome half is fully independent** — land it first if v10/v11 aren't merged;
guard the sponsor line + rota builder behind "data present" so partial landing
degrades cleanly. **Migration:** none (docs read existing data). The one hard
change is the shared `DocKind` enum (engine package + any exhaustive switch).

## Context

Every export the product makes runs through one renderer, and that renderer
throws the brand away. `DocModel.branding` was designed in (Jul3/06) — colours,
logo storage paths, sponsor names — and `doc-render.ts` simply never reads it,
so the timetable, scoresheet, roster, standings, participants list, schedule
report, and v9 dispute-evidence PDF all come out as identical black tables.
Fixing the renderer once upgrades all of them. The `types.ts` comment already
anticipates the gate: *branding is Pro `exports.branded`, nulled server-side
otherwise* — so free orgs keep the plain doc, Pro orgs get the courtside look.

The two documents an organiser actually asks for on matchday don't exist yet: a
**per-official rota** (now that v11 gives officials real assignments + accept
state) and a **printable admit ticket** (the QR pass in `ticket-new.png`,
generated from confirmed registrations). Both are new `DocKind`s built the same
pure way as the existing ones.

## Task

### 1. Brand the renderer (the "improve existing" half)

In `doc-render.ts`, when `model.branding` is present:

- **Masthead band** at the top of page 1 (and repeated as a slim header on
  later pages): a coloured bar using `branding.colors.primary` (fallback to the
  SEAZN night `#150b36` / lime `#a3e635` from the email chrome), the **SEAZN
  wordmark**, the **org name** (from `model.title` or a new
  `branding.orgName`), and the **org logo** if `branding.logos[0]` resolves
  (storage path → bytes; embed with `doc.image`, fixed height, keep aspect). A
  1px brand-colour rule under the title replaces the current bare title.
- **Sponsor line** in the footer band (above the existing "printed …" line):
  tier-grouped sponsor **names** from `branding.sponsors` (title first, then
  gold/silver/partner), small caps, wrapped — logos on the ticket only, names
  in table docs to keep them readable. Skip silently if empty.
- Keep `docModelToXlsx` mostly as-is but add the org name + sponsor row to the
  header block so the spreadsheet isn't anonymous.
- **Gate:** `buildDivisionDocModel` (and the poster/report callers) set
  `branding` only when `requireFeature(orgId, "exports.branded")` passes; else
  `branding` stays undefined and the renderer draws the plain doc (existing
  behaviour byte-for-byte — pin it with a golden so free-tier output doesn't
  drift).
- Feed `branding.sponsors` from v10's `resolveSponsors(orgId, competitionId)`
  and `branding.logos`/`colors` from the org branding blob.

### 2. New `DocKind`s + builders (`@seazn/engine/exports`)

- Extend the `DocKind` enum: `officials_rota`, `admit_ticket`. Update every
  exhaustive switch/registry that consumes it (TypeScript will flag them —
  chase them all; the `types.ts` change plus `build.ts` index).
- `buildOfficialsRota(input, opts)` — one `DocSection` **per official**
  (`pageBreakBefore` when `pageBreaks='per_team'`-style scoping), a table of
  their assigned fixtures (date/time, court, competition·division, role,
  opponent labels, `response` state), driven by v11 `fixture_officials` joined
  to `officials`. Include a `signatures`/`formLines` block ("Official:
  ______  ·  Signed: ______") for a sign-on sheet. Pure — take rows in, no DB.
- `buildAdmitTickets(input, opts)` — one ticket per confirmed registration in
  the `ticket-new.png` layout: entrant name, competition + dates, reference
  code, **QR** (the check-in URL), "ADMIT ONE / SCAN AT THE DESK", org masthead.
  Two per A4 (`columnsHint: 2` already supported). The **QR is a data payload
  on the model** (the check-in URL string), rendered to an image in
  `doc-render.ts` using the existing QR lib (find the one PROMPT-53 used for
  player check-in / the current ticket surface — reuse, don't add a dep);
  keep the builder pure by putting the URL, not pixels, in the model.
- Add server assembly in `usecases/exports.ts`:
  `buildOfficialsRotaDoc(auth, divisionId|competitionId)` and
  `buildAdmitTicketsDoc(auth, competitionId, filter)`, pulling the rows and
  attaching branding as in §1.

### 3. Routes + the Documents panel on the board

- Routes: extend `exports/[kind]` kind enum with `officials_rota`; add
  `api/v1/competitions/[id]/exports/tickets` (admit tickets, `format=pdf`) and
  `api/v1/me/rota.pdf` (the v11-promised personal rota — the signed-in
  official's own assignments only, `requireResourceAuth` on self). Raw-file
  responses with `Content-Disposition`, matching the existing export route.
- **Documents panel**: a control on the schedule board (`board-tray.tsx` or the
  schedule page shell) and on the `o/[orgSlug]/.../schedule` slug route — a menu
  listing **Order of play** (timetable), **Match sheets** (scoresheet),
  **Officials rota**, **Admit tickets**, each offering PDF (and XLSX where the
  doc is tabular). Wire to the routes above. Match sheets + timetable already
  build — this surfaces them where the organiser is actually standing on
  matchday, not buried in a division export menu.

### 4. Cross-cutting (mandatory)

- **Help** (`content/help/**`): a "Matchday documents" page — what each document
  is, PDF vs XLSX, branded vs plain (Pro), tickets + QR check-in, rota.
- **Smoke** (`scripts/smoke.ts`): pro path generates a branded timetable +
  officials rota + admit tickets and asserts non-empty PDFs with the masthead;
  free path generates the plain timetable and asserts branding is absent.
- **Tests** (fail-without-it):
  - **Golden `DocModel`s** for `buildOfficialsRota` + `buildAdmitTickets`
    (deterministic with a fixed `printedAt`) — extend
    `packages/engine/src/exports/build.test.ts`.
  - Renderer: with branding → masthead/logo/sponsor draw calls happen; without
    branding → byte-identical to today's plain output (pin the free-tier
    golden so the brand work can't regress free exports).
  - `exports.branded` gate: Pro org gets branded chrome, community org gets
    plain, driven by a stubbed entitlement.
  - `/me/rota.pdf` returns only the caller's own assignments (authz test).

## Acceptance

- `npm run typecheck`, engine + web unit suites (incl. new goldens), smoke
  green; help registry green.
- Documented run: open a division's schedule board → Documents → **Order of
  play** downloads a **branded** PDF (masthead, org logo, tier-grouped sponsor
  line) for a Pro org and a **plain** PDF for a free org; **Officials rota**
  lists each official's assignments + response; **Admit tickets** produce
  scannable QR passes matching `ticket-new.png`; an official opens `/me` →
  **Download my rota** → their own schedule only.
- Every pre-existing export (timetable/scoresheet/roster/standings/
  participants/schedule-report/dispute-evidence) still generates — the branded
  chrome is additive, and the free-tier golden is unchanged.

## Gotchas (do not relearn)

- **Builders stay pure** — `printedAt` and the QR **URL** are inputs; no
  `Date.now()`, no image bytes in the model (goldens assert the model). Pixels
  live only in `doc-render.ts`.
- Logos/QR: storage paths and URLs resolve to bytes **in the renderer**; a
  missing/broken logo must degrade to no-logo, never throw (a broken export is
  worse than an unbranded one).
- Extending `DocKind` breaks exhaustive switches at compile time — that's the
  point; fix them all rather than defaulting, or a new kind silently renders
  blank.
- The free-tier plain output is a **contract** (some orgs print it today) — pin
  it with a golden before touching the renderer so "improve" never means
  "change what free users already rely on".
- Don't add a QR/PDF dependency — reuse whatever the current ticket/check-in
  surface (`ticket-new.png` flow, PROMPT-53 check-in) already imports.
