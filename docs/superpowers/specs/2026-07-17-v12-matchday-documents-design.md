# v12 — Matchday Documents: designed PDFs, officials rota, admit tickets

**Date:** 2026-07-17
**Status:** design approved; plan pending
**Branch (build):** `feat/v12-matchday-documents` (own worktree off `main`)
**Deps:** v10 (#112) + v11 (#111) both **merged** — sponsor + officials data are live.
**Migration:** none expected (documents read existing data). The one hard change
is the shared `DocKind` enum in `@seazn/engine`.

---

## 1. Goal

Every PDF the product exports today runs through one renderer
(`apps/web/src/server/doc-render.ts`) that opens with a plain
`Helvetica-Bold 16` title and **ignores `DocModel.branding` entirely** — bare
black tables, no masthead, no logo, no brand colour, no sponsor line. Meanwhile
the email templates and `r/[ref]/ticket.png` already show the real SEAZN
"courtside" look the org expects. The exports look like a 2004 mail-merge.

v12 does two things:

1. **Give every export a real, designed document** — a courtside masthead,
   proper type, zebra tables, kit swatches, a sponsor footer, and a live-page
   QR — by teaching the shared renderer the brand. One renderer change upgrades
   timetable, scoresheet, roster, standings, participants, poster,
   schedule-report, and dispute-evidence PDFs at once. Gated on the existing
   `exports.branded` Pro entitlement.
2. **Add the two documents an organiser actually asks for on matchday** — a
   per-official **rota** (v11 assignments + response state) and a printable
   **admit-ticket** run (the `ticket.png` pass, batched) — surfaced from a
   **Documents** control on the schedule board.

**This is not "print the rows prettier."** The user directive is explicit:
clean documents with real tables, imagery, and plain-language description — a
designed artifact, not a text dump. §3 is the design system that delivers it.

## 2. Non-goals

- A WYSIWYG document designer (chrome is derived from brand + tier rules).
- Per-sport bespoke scoresheet templates (reuse the sport-neutral `scoresheet`
  section shape as-is).
- Emailing tickets/sheets (v12 produces downloadable/printable files; delivery
  stays the organiser's job — reg emails already carry ref + lookup link).
- Re-theming the public HTML schedule (print/PDF only).
- HTML→PDF via headless browser (rejected — see §4 renderer decision).

---

## 3. PDF design language (the "clean document" system)

This extends the **existing** courtside identity to print. It is not a new
brand — it is `r/[ref]/ticket.png` and the email templates, made native to
paged PDF. Consistency with those surfaces is the whole point; a printed doc
and a ticket must read as the same product.

### 3.1 Palette (courtside, already in `ticket.png`)

| Token      | Hex        | Use                                            |
|------------|------------|------------------------------------------------|
| night      | `#150b36`  | masthead band, display headings                |
| lime       | `#a3e635`  | pitch-line rule (the signature), accents       |
| ball       | `#ef4444`  | status/emphasis dot, "live" markers            |
| cream      | `#f5f0e8`  | zebra alt-row tint, page footer band           |
| ink        | `#18181b`  | body text                                      |
| slate      | `#52525b`  | secondary text                                 |
| mute       | `#71717a`  | eyebrows, captions, tracked labels             |
| hairline   | `#e4e4e7`  | table rules                                    |

Brand colour override: when `branding.colors.primary` is set, it replaces
`night` on the masthead band (org's own colour); lime pitch-line and ink text
stay constant so the system holds. Fallbacks are the courtside constants above.

### 3.2 Type

pdfkit ships only the 14 base PostScript fonts — Helvetica has none of the
courtside character. **Bundle two TTFs** into the web package
(`apps/web/assets/fonts/`) and `doc.registerFont` them in `doc-render.ts`:

- **Display — Barlow Condensed** (SemiBold/Bold): masthead wordmark, doc title,
  section headings, big numerals. This is the exact face the public tree and
  slideshow already use (`Barlow_Condensed` via `next/font`), so print matches
  screen.
- **Body/Data — Inter** (Regular/Medium, tabular figures): table cells,
  descriptions, labels. Clean, open-licence, near-identical metrics to the
  app's Geist.

Type scale (pt): masthead wordmark 18 / doc title 26 (Barlow, uppercase, tight
tracking) / section heading 14 / eyebrow label 8 (uppercase, +2 tracking, mute)
/ table header 8.5 (Inter Medium) / body 9 / footer 7. Numbers use Inter
tabular figures, right-aligned in numeric columns.

Missing-font safety: if a TTF fails to load, fall back to Helvetica and log —
never throw. A plain-font doc beats a broken export.

### 3.3 Page architecture

Every branded page is built from four bands, top to bottom:

```
┌─────────────────────────────────────────────────────────┐
│  ███ NIGHT MASTHEAD ███   SEAZN CLUB          ORG NAME   │  band 1
│  ▏lime pitch-line rule ──────────────────────────────── │
├─────────────────────────────────────────────────────────┤
│  ORDER OF PLAY                              ← eyebrow    │  band 2
│  Summer League — Division 1                ← doc title   │
│  Sat 19 Jul · Riverside Courts 1–4         ← subhead     │
│  All fixtures across every court, in play order. ← desc  │
│  ┌──────┬────────┬───────────┬──────────┬────────────┐  │
│  │ Time │ Court  │ Home      │ Away     │ Result     │  │  band 3
│  ├──────┼────────┼───────────┼──────────┼────────────┤  │  (zebra table)
│  │ 09:00│ 1      │ ▪ Falcons │ ▪ Hawks  │ —          │  │
│  │ 09:00│ 2      │ …         │ …        │            │  │
│  └──────┴────────┴───────────┴──────────┴────────────┘  │
├─────────────────────────────────────────────────────────┤
│  ▏SPONSORS  Riverside Sports (title) · Acme · …  [QR]    │  band 4
│  Summer League — printed 2026-07-19 · page 1 of 3       │  (footer)
└─────────────────────────────────────────────────────────┘
```

- **Band 1 — masthead** (page 1 full, later pages slim): night bar,
  `SEAZN CLUB` wordmark (Barlow, lime "CLUB"), org name right (uppercase,
  tracked), org logo if `branding.logos[0]` resolves (aspect-locked, fixed
  height). Underlined by the **lime pitch-line rule** — the signature element
  that ties every page to every ticket.
- **Band 2 — title block:** a tracked-caps **eyebrow** naming the doc kind
  (ORDER OF PLAY / OFFICIALS ROTA / SCORESHEET / STANDINGS / ADMIT ONE) — a
  structural device that encodes what the sheet is; the doc title (Barlow
  uppercase); a subhead (dates · venue); and a one-line **plain-language
  description** of the document. Description is required on every kind — it is
  the "words as design material" that turns a table dump into a document.
- **Band 3 — content:** zebra tables (cream tint alt rows, hairline separators,
  night header row with cream text), type-aware column alignment (numbers
  right, tabular figures; labels left), roomier 18pt rows (not the cramped 16),
  ellipsis + landscape hint so names never clip. Kit-colour swatches render as
  rounded chips beside team names. Signature/formLines render as labelled
  underline blocks.
- **Band 4 — footer:** tier-grouped **sponsor line** (title sponsor first and
  slightly larger, then gold/silver/partner, small-caps, wraps, skips silently
  if empty); a small **live-page QR** (see §7 improvement); `printed <date> ·
  page N of M`. Sits on a cream band with a hairline top rule.

### 3.4 Per-document treatment

- **Order of play (timetable):** the table above. `per_pitch`/`per_division`
  page breaks respected. A summary strip under the description — *N fixtures ·
  M courts · first serve 09:00* — for quick scanning.
- **Scoresheet:** one match per block (two per A4 via `columnsHint`), kit
  swatches, score grid + signature lines, generous whitespace to write in.
- **Standings:** rank column with subtle top-3 emphasis (weight, not medals),
  tabular metric columns, zebra rows.
- **Roster / participants:** grouped by team/club with a team sub-masthead;
  squad numbers right-aligned tabular.
- **Officials rota (new):** one page (or block) per official — their name as a
  card header with a role badge, a table of their duties (date/time in **venue
  timezone + label**, court, competition·division, role, opponents, response
  state as a coloured chip: accepted/pending/declined), and a sign-on signature
  line. Empty official → a designed "No duties assigned" state, not a blank.
- **Admit ticket (new):** the `ticket.png` layout native in pdfkit — night
  masthead card, big competition title, entrant (masked) name, monospace ref,
  rotated status stamp, dashed perforation, QR to `/r/[ref]`, "SCAN AT THE DESK
  / ADMIT ONE", sequence number. **Two per A4** with crop guides for cutting.

Design self-critique applied: the **one bold move** is the lime pitch-line rule
as connective tissue across every page and ticket; everything else stays quiet
and disciplined (one display face, one body face, hairline tables, restrained
colour). Removed the "accessory": no per-doc accent colours, no gradients, no
decorative iconography — the eyebrow + pitch-line carry identity alone.

---

## 4. Architecture

Two PRs. PR1 is fully independent and lands first; PR2 depends on PR1's chrome.

### PR1 — Brand the renderer

**Model / types (`packages/engine/src/exports/types.ts`):**
- `DocBranding.sponsors: string[]` → `sponsors: { name: string; tier: string }[]`
  (flat strings cannot tier-group). Add `orgName?: string`.
- Keep `branding` optional and nullable server-side — the gate is unchanged.

**Server assembly (`apps/web/src/server/usecases/exports.ts`):**
- `divisionMeta` joins organizations → org name + branding blob.
- `brandingFor(auth, meta)`: add `orgName`, and populate `sponsors` from
  `resolveSponsors(orgId, competitionId)` (v10) mapped to `{name, tier}`.
  Still returns `undefined` unless `hasFeature('exports.branded')`.
- **Wire branding into every caller, not just `buildDivisionDocModel`.** Today
  `buildCompetitionTimetable` (exports.ts:269) passes only `printedAt` +
  `pageBreaks` — it must call `brandingFor`. Same audit for `poster.pdf/route`
  and the schedule report. This is the spec's overstated "one change": the
  renderer is one lever, but each caller must actually hand it branding.

**Renderer (`apps/web/src/server/doc-render.ts`):**
- Register bundled TTFs once; guard with try/fallback to Helvetica.
- **Async asset pre-pass:** before the synchronous pdfkit draw loop, resolve the
  org logo path → bytes (and, in PR2, all QR payloads → PNG buffers) via
  `Promise.all`. pdfkit `doc.image` needs a Buffer in hand; you cannot await
  mid-stream. Missing/broken asset → skip that image, never throw.
- Draw bands 1–4 (§3.3) when `model.branding` is present. When absent, draw the
  existing plain document **byte-for-byte** (free-tier contract).
- `docModelToXlsx`: add org name + a sponsor row to the header block so the
  spreadsheet is not anonymous.

**Renderer decision — pdfkit stays; tickets go pdfkit-native too.**
Options weighed:
- **(A) pdfkit for all, enriched (chosen).** Vector, selectable text, clean
  multi-page tables, one design system for every doc including tickets. Cost:
  re-lay the ticket once in pdfkit — but we build the masthead/font/QR
  primitives for the other docs anyway, so the marginal cost is small and the
  result is one coherent system. `r/[ref]/ticket.png` stays as the single-ticket
  web/PNG surface (unchanged).
- **(B) tickets via `ticket.png`'s `ImageResponse` → PNG → embed in pdfkit.**
  Pixel-identical to the existing ticket, zero drift. But raster (not
  selectable), and satori is ~50–100 ms/ticket → a 200-entrant run stalls.
  **Kept as documented fallback** if pdfkit ticket fidelity disappoints.
- **(C) HTML→PDF via Playwright.** Best CSS fidelity, reuses web tokens, but a
  headless-Chrome dependency in the Fly serverless path is heavy and fragile.
  **Rejected.**

Note: this flips the earlier lean toward (B). The user's "clean designed PDF"
directive makes one unified pdfkit design system the more coherent call — every
document, tickets included, shares the same masthead, fonts, and pitch-line.

**Gate & free-tier contract:** community orgs get `branding: undefined` → the
existing plain doc. Pin that with a **draw-call spy test** (mock `PDFDocument`,
assert zero masthead/image calls when unbranded) rather than a byte-diff —
pdfkit font subsetting makes byte goldens flake.

### PR2 — New DocKinds + Documents panel

**Engine (`packages/engine/src/exports/`):**
- `DocKind` += `officials_rota`, `admit_ticket`. Extending the enum breaks every
  exhaustive switch at compile time — that is the point; chase them all (a
  silent `default` would render blank).
- `buildOfficialsRota(input, opts)` — pure. One `DocSection` per official
  (`pageBreakBefore` when scoped), a table of their fixtures (time in venue tz,
  court, comp·division, role, opponents, `response`), plus a signature block.
  Rows in, no DB, no clock.
- `buildAdmitTickets(input, opts)` — pure. One entry per confirmed registration:
  `{ maskedName, competition, dates, ref, status, qrUrl }`. **The QR is the URL
  string on the model, never pixels** — the renderer rasterises it. `qrUrl` =
  `${origin}/r/${ref}` (the public status page), **not** the check-in JWT.
- Golden `DocModel` tests for both (fixed `printedAt`).

**Server (`usecases/exports.ts`):**
- `buildOfficialsRotaDoc(auth, divisionId|competitionId)` — org-scoped read of
  `fixture_officials` joined to `officials` (the `getMyOfficiating` shape,
  scoped to the org), attaches branding as PR1.
- `buildAdmitTicketsDoc(auth, competitionId, filter)` — confirmed registrations
  via the existing status read; attaches branding.

**Routes:**
- `divisions/[id]/exports/[kind]` — add `officials_rota` to the kind enum.
- `api/v1/competitions/[id]/exports/tickets` (`format=pdf`).
- `api/v1/me/rota.pdf` — the v11-promised personal rota: the signed-in
  official's own assignments only (`requireResourceAuth` on self). **Cross-org
  and therefore SEAZN-neutral — no org masthead**, since one official's rota
  spans multiple orgs.
- All raw-file responses with `Content-Disposition`, matching the existing
  export route's shape and error envelope.

**Documents panel:**
- A control on the schedule board (`components/v2/board/board-tray.tsx` or the
  schedule page shell) and the `o/[orgSlug]/.../schedule` slug route — a menu:
  **Order of play** (timetable), **Match sheets** (scoresheet), **Officials
  rota**, **Admit tickets**. Each row carries per-format flags: tabular docs
  offer PDF + XLSX; **tickets offer PDF only** (QR is visual). This surfaces the
  already-built timetable + scoresheet where the organiser actually stands on
  matchday, not buried in a division export menu.
- `/me` gains **Download my rota** → `/me/rota.pdf` (fulfils the v11 promise).

---

## 5. Data sources (all live post-merge)

- **Sponsors:** `resolveSponsors(orgId, competitionId)` → tiered rows (v10).
- **Officials:** `fixture_officials.response` + `officials` join; personal shape
  already exists in `getMyOfficiating(userId)` (me-officiating.ts:60) — reuse
  its select for `/me/rota.pdf`.
- **Tickets:** `publicRegistrationStatusByRef` shape (masked name, ref, status,
  org name, competition, dates) — already what `ticket.png` consumes; needs a
  batch variant `confirmed registrations for a competition`.
- **Org branding blob:** `competitions.branding` / `organizations.branding`
  (colours, logo path) as `brandingFor` reads today.
- **Timezone:** venue tz already selected in the officiating read (`ss.tz`);
  format print times in venue tz + label per V280.

---

## 6. Product improvements (beyond the prompt)

Folded into the design above; called out so they are not lost:

1. **Plain-language description on every doc** — a one-line intro under the
   title saying what the sheet is and how to read it. Turns a table into a
   document (design skill: words are design material).
2. **Doc-kind eyebrow** — tracked-caps label encoding the sheet type; structural
   identity without decoration.
3. **Live-page QR in the branded footer** — printed docs go stale the moment a
   fixture moves; a small QR to the live public schedule/standings bridges
   print → live. Reuses the `qrcode` lib already in the tree. On-brand, genuinely
   useful, near-zero cost.
4. **Summary strip** — *N fixtures · M courts · first serve 09:00* under the
   description; quick-scan context an organiser reads before the table.
5. **Designed empty states** — a rota with no assignments or a ticket run with
   zero confirmed regs renders a directed "nothing here yet" page, never a blank
   or a crash.
6. **Ticket crop guides + sequence numbers** — makes the 2-up sheet actually
   cuttable and countable at the desk.

None add a migration or a dependency. Each is on the existing courtside rail.

---

## 7. Cross-cutting (mandatory — house rules)

- **i18n gate (#108):** print-document *body* text stays English (acceptable for
  print), but every new **UI string** — the Documents panel labels, the `/me`
  rota button, help copy — needs `en/fr/es/nl` parity or CI fails. Add to the
  `ui` namespace + `translate` pass. This is the biggest silent blocker; the
  original prompt never mentions it.
- **Help (`content/help/**`):** a "Matchday documents" page — what each document
  is, PDF vs XLSX, branded (Pro) vs plain, tickets + QR check-in, rota, the
  personal `/me` rota. Register the slug.
- **Smoke (`scripts/smoke.ts`):** pro path generates a branded timetable +
  officials rota + admit tickets, asserts non-empty PDFs with a masthead; free
  path generates the plain timetable, asserts branding absent.
- **Regression tests (fail-without-it, per house rule):**
  - Golden `DocModel`s for `buildOfficialsRota` + `buildAdmitTickets`.
  - Renderer: branded → masthead/logo/sponsor/QR draw calls fire (spy);
    unbranded → plain output unchanged (pinned free-tier contract).
  - `exports.branded` gate: Pro branded, community plain (stubbed entitlement).
  - `/me/rota.pdf` returns only the caller's own assignments (authz test).
  - Font-load failure falls back to Helvetica, does not throw.

---

## 8. Testing / acceptance

- `npm run typecheck`, engine + web unit suites (incl. new goldens), smoke,
  help registry — all green.
- **Documented run:** open a division's schedule board → Documents →
  **Order of play** downloads a *branded* PDF (masthead, org logo, lime
  pitch-line, tier-grouped sponsor footer, live-page QR) for a Pro org and a
  *plain* PDF for a free org; **Officials rota** lists each official's duties +
  response chips; **Admit tickets** produce scannable 2-up QR passes matching
  `ticket.png`; an official opens `/me` → **Download my rota** → their own
  cross-org schedule, SEAZN-neutral.
- Every pre-existing export still generates — branded chrome is additive; the
  free-tier draw-call contract is unchanged.
- **Live visual verify (main thread, Playwright snapshot):** render each doc,
  eyeball masthead/table/QR against `ticket.png` and the email templates for
  parity, at desktop + print widths.

---

## 9. Decisions log (append-only)

- **2026-07-17** — Ticket QR points to public `/r/[ref]`, not the check-in JWT.
  Kills the "bundle of secrets" risk; the ref is already on reg emails.
- **2026-07-17** — Tickets render **pdfkit-native** (option A), not
  ImageResponse-embed. One unified design system across every doc; vector +
  selectable + no satori perf cliff. ImageResponse-embed kept as fallback.
- **2026-07-17** — `DocBranding.sponsors` becomes `{name, tier}[]`; `orgName`
  added. Required for tier-grouping and the masthead.
- **2026-07-17** — `/me/rota.pdf` is SEAZN-neutral (cross-org, no org brand).
- **2026-07-17** — Free-tier contract pinned with a draw-call spy, not a byte
  golden (pdfkit subsetting flakes byte diffs).
- **2026-07-17** — Branding wired into **all** callers (division, competition
  timetable, poster, schedule report), not only `buildDivisionDocModel`.
- **2026-07-17** — Bundle Barlow Condensed + Inter TTFs for pdfkit; the app's
  Geist/Barlow are `next/font` (web-only), unusable in the PDF pipeline.

## 10. Risks / open questions

- **Font licensing/size:** Barlow Condensed + Inter are OFL — fine to bundle;
  adds ~few hundred KB to the web package. Acceptable.
- **pdfkit ticket fidelity vs `ticket.png`:** if the native re-lay drifts
  noticeably, fall back to ImageResponse-embed (documented). Verify visually.
- **`/me/rota.pdf` authz:** must scope strictly to the caller's official rows
  across orgs; test explicitly.
- **Large ticket runs:** even pdfkit-native, a 1000-entrant run is a big PDF —
  acceptable as a download; revisit pagination only if it bites.

## 11. Build shape (for the plan)

Subagent dispatch per repo convention ([[feedback_subagent_model]]):
`.claude/agents/implementer` (claude-sonnet-5, effort high) builds each scoped
task with product/flow/task context passed **inline** in the brief;
`.claude/agents/reviewer` (claude-sonnet-5, high) reviews the diff before push;
the **main thread** live-verifies with Playwright (implementer has no browser)
and pushes. PR1 (branded renderer) before PR2 (new docs + panel). Every task
ships its fail-without-it test; help + smoke updated in the same PR.
