# Jul3/06 — Rich Exports & Print Templates

Turns the `exports` entitlement ([10-pro-entitlements.md](../10-pro-entitlements.md) §Platform)
into a real templated document system: timetables, scoresheets, roster forms, standings,
match reports — PDF and spreadsheet. Reads the public/read models (doc 07 note 4, doc 09).
Design only.

## 1. Motivation & scope

Heavily-voted "old-school paper" cluster:

- **Pretty timetable PDF** (2 Jul ×2) — the online layout is well-structured; the PDF isn't;
  referees/teams want a nice printable overview.
- **Volleyball scoresheet** (12 Jun ×3) — point-by-point columns per set, signature lines,
  final result, two matches per A4.
- **Club colours / team names on scoresheets** (10 Jun; 8 Jun) — refs identify teams + kit
  clashes before KO.
- **Roster form** (13 May) — team name + player list (name/DOB/number) to sign at start.
- **Landscape standings** (29 May) — names/rankings stay readable.
- **Match report sheet** (18 Mar ×3; 30 Sep ×5; 20 Oct ×2) — per-pitch, one pitch per page.
- **Results export group+KO** (7 Jul ×3), **by team** (4 Jul), **tables+fixtures like the
  slideshow** (20 Oct ×2), **Excel with Empty-Spot names** (30 Jan), **participant overview
  with club/division column** (17 Mar ×1) — the last two overlap Jul3/01 §6 export.

**In scope:** a template registry (per document type × sport), deterministic render inputs,
PDF + XLSX renderers, per-pitch/per-team/per-division scoping, branding (club colours,
sponsor logos, tournament name). **Out:** the presentation/slideshow big-screen slides (doc
09 / Jul3/07-presentation-adjacent — different surface); live rendering.

## 2. Architecture — pure view-models, effectful renderers

Engine stays I/O-free (README rule 1). The split:

```
packages/engine/exports/   buildDocModel(kind, data, opts) → DocModel   ← pure, deterministic
apps/web/src/server/       DocModel → PDF (renderer) / XLSX (writer)     ← the I/O half
```

`DocModel` is a serialisable, layout-agnostic description (sections, tables, rows, cells,
signature blocks, colour swatches) — *what* to print, not pixels. The renderer (a server-only
lib, e.g. React-PDF/Playwright-print for PDF, a sheet writer for XLSX) turns it into bytes.
Because the model is pure, a golden test asserts the model, not the PDF (stable, diffable).

```ts
DocModel = z.object({
  kind: z.enum(['timetable','scoresheet','roster','standings','match_report','participants']),
  title: z.string(),                 // tournament + division name (1 Sep ask: show it)
  meta: z.object({ printedAt: z.string(), footerNote: z.string().optional() }),
  branding: z.object({ colors, logos, sponsors }).optional(),   // Pro
  sections: z.array(DocSection),     // headings (prelim vs KO separation, 1 Sep), tables, forms
  pageBreaks: z.enum(['auto','per_pitch','per_team','per_division']).default('auto'),
});
```

## 3. Template registry (per kind, sport-aware)

Each `SportModule` may contribute template fragments (a volleyball scoresheet needs
set-columns; a football report needs goal/card lines) — same plugin principle as position
catalogs (doc 02 §3):

```ts
SportModule.exportTemplates?: {
  scoresheet?: (fixture, lineups) => DocSection,   // volleyball: per-set point columns + signatures
  matchReport?: (fixture, state) => DocSection,
}
```

Sport-neutral kinds (timetable, standings, roster, participants) live in the engine core.
Volleyball scoresheet (12 Jun) = the set-based module's `scoresheet` fragment with point-by-
point columns, two-per-page via `pageBreaks` + a `columns:2` section hint.

## 4. Scoping (per-pitch / per-team / per-division)

The recurring "one pitch per page," "by team," "export just my group" asks are one knob:
`buildDocModel(kind, data, { scope, pageBreaks })` where `scope` filters fixtures/entrants
(court / entrant / pool / division) using the same filter vocabulary as scoped-clear
(Jul3/03 §5) and the `?club_id=`/`?division_id=` API params (Jul3/01 §6). `pageBreaks:
'per_pitch'` starts each court on a fresh page (30 Sep, 20 Oct exact ask). Empty-spot
placeholder entrants render their label, never blank (30 Jan) — both PDF and XLSX.

## 5. API (extends doc 08)

```
GET /api/v1/divisions/{id}/exports/{kind}?format=pdf|xlsx&scope=…&pageBreaks=…
GET /api/v1/competitions/{id}/exports/timetable?format=pdf&pretty=true
GET /api/v1/participants/export?format=csv|xlsx&club_id=…&division_id=…   (defined in Jul3/01 §6)
```

Cacheable like public reads (doc 08 §6) keyed on the read watermark; regenerated on data
change. Large exports stream. Branding fields nulled for non-Pro at the model layer (doc 10
§2.3 — server-side, not client-hidden).

## 6. Entitlements (extends doc 10)

`exports` (Pro) already gates CSV/PDF. Split for fairness:
- Basic CSV/XLSX participant + results export = Pro (as today).
- **Branded / templated PDF** (club colours, sponsor logos, pretty timetable, custom
  scoresheet layouts) = Pro `exports.branded`. Landscape/portrait + page-break scoping = all
  export-enabled plans (it's a layout flag, not a feature).

## 7. Edge cases

- Unfinished tournament: timetable/roster export before results exist (fixtures with TBD
  feeds render "Winner of QF1" labels, matching the bracket display).
- Signature/blank scoresheets: a "blank" flag renders the form with no scores (for manual
  filling when no printer for data-entry, 7 Apr awards ask analog).
- Very wide standings (volleyball 10 metrics, 22 Feb) → landscape + horizontal fit; never
  clip names (29 May).
- Deterministic `printedAt` supplied via the export request time (kept out of the pure model
  as a `meta` input, so goldens stay stable — no `Date.now()` in engine, PROMPT-00 §3).
