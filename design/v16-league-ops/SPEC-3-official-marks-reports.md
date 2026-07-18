# SPEC-3 — Official marks & match reports

## Problem

LeagueRepublic ships "referee marks entry and display" and "referee result
entry and match reports". We have the stronger officials spine — directory,
claim rail, per-assignment accept/decline (V284), rota PDF, cross-org
booked-elsewhere warnings — but zero feedback loop after the whistle: no way
for an organiser to record how an official performed, and no way for an
official to file what happened. Both are weekly rituals in real leagues (FA
clubs must mark referees; refs must report misconduct).

## Goal

Two small, adjacent features on the existing `fixture_officials` assignment
row:

1. **Marks** (organiser-side, Pro): rate an accepted assignment 1–5 with an
   optional comment after the fixture is decided. Org-private aggregate on
   the org's official profile; the official sees only their own running
   average (D4).
2. **Match reports** (official-side, free — V284 portal principle, D5): the
   official files a short report with structured incident rows; submitted
   reports notify the organiser and surface on the fixture console panel.
   Misconduct incidents feed SPEC-1 as suggested suspensions (soft bridge).

## Non-goals

- No public or cross-org display of marks (D4) — no directory stars, no
  referee league tables. Revisit only with an explicit later spec.
- No mark disputes/appeals; no official reply to a mark.
- No report PDF export in v16 (doc-render kind can come later).
- No entrant/club-side marking (organiser only in v16 — entrant captains
  have no auth surface for this yet).

## Data model — migration `V293__official_marks_reports.sql` (renumber, D9)

```sql
create table official_marks (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  fixture_official_id uuid not null unique references fixture_officials(id) on delete cascade,
  official_id         uuid not null references officials(id) on delete cascade,
  fixture_id          uuid not null references fixtures(id) on delete cascade,
  mark                int not null check (mark between 1 and 5),
  comment             text,
  created_by          uuid,             -- console user
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index official_marks_official_idx on official_marks(official_id);

create table match_reports (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id) on delete cascade,
  fixture_official_id uuid not null unique references fixture_officials(id) on delete cascade,
  official_id         uuid not null references officials(id) on delete cascade,
  fixture_id          uuid not null references fixtures(id) on delete cascade,
  status              text not null default 'draft'
                        check (status in ('draft','submitted')),
  body                text not null default '',
  incidents           jsonb not null default '[]',
  submitted_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index match_reports_fixture_idx on match_reports(fixture_id);
```

`official_id`/`fixture_id` are denormalized from the assignment row for
aggregate queries — stamped at insert, never user-supplied.

RLS: enable/force + tenant policy + `app_user` grants on both. Reports are
**written by the official cross-org through the superuser connection** —
exactly the `official_availability` V284 rail (an official is not an org
member); the tenant policy serves organiser-console reads. Marks are written
on the tenant rail.

### `incidents` JSONB shape

```jsonc
[
  { "kind": "red_card",   // red_card | misconduct | injury | other
    "person_id": null,     // optional — picker over both entrants' squads
    "entrant_id": "…",     // optional side attribution
    "note": "violent conduct, 88'" }
]
```

## Rules

- **Mark window**: only when the assignment `response = 'accepted'` AND the
  fixture status is `decided`/`finalized`. One mark per assignment (unique
  index); editable any time (updated_at tracks it) — leagues correct marks.
- **Aggregate shown to the org**: avg + count over that org's marks only.
- **Aggregate shown to the official** (`/me` officiating lane): avg + count
  across ALL orgs — never individual marks, comments, or org breakdown
  (D4: FA-style; protects small-sample deanonymization).
- **Report window**: assignment accepted + fixture decided/finalized (or
  `abandoned` — abandonments are exactly when reports matter). Draft →
  submitted; submitted is immutable (corrections = organiser asks, official
  files nothing further in v16; keep it simple).
- **Bridge to SPEC-1**: on submit, for each incident with `kind` in
  (`red_card`,`misconduct`) and a `person_id`, if the org has
  `discipline.enforced` AND the `suspensions` table exists (SPEC-1 merged),
  insert a `pending` suspension with `source = 'report'`,
  `reason = incident.note`, `matches_total = 1` (organiser adjusts on
  confirm). Guarded + idempotent per (fixture_official_id, incident index);
  ships dark when SPEC-1 is absent.

## Entitlement

New key `officials.marks` seeded in V293: community/event_pass **false**,
pro/pro_plus **true**. Reports have **no gate** (free portal principle, D5).
`requireFeature` at the marks usecases; report usecases check only the
claimed-official identity (person_claims → officials.person_id).

## API surface (OpenAPI regen mandatory)

- `PUT    /fixture-officials/{id}/mark` — upsert {mark, comment} (console).
- `DELETE /fixture-officials/{id}/mark`
- `GET    /officials/{id}/marks-summary` — org-scoped avg/count + recent
  comments (console).
- `GET/PUT /me/officiating/{fixtureOfficialId}/report` — draft body +
  incidents (official, cross-org rail).
- `POST   /me/officiating/{fixtureOfficialId}/report/submit`
- `GET    /fixtures/{id}/reports` — submitted reports (console).

## UI surfaces

1. **Fixture officials panel (console)** — after decided: "Rate official"
   inline on each accepted assignment row; submitted-report chip opens a
   drawer with body + incident rows.
2. **Org official profile (roster/directory detail, console)** — marks
   summary block: average badge, count, last 5 comments.
3. **`/me` officiating lane** — completed assignments (the #122
   `completed[]` disclosure) gain a "Match report" CTA (draft/submitted
   state chip); the lane header shows the official's own average badge once
   ≥3 marks exist (below 3, show "collecting marks" — small-sample noise).
4. **Suggested suspensions** land in SPEC-1's pending queue tagged
   `source: report` with a link back to the report drawer.

## Design direction

Console `.app-*`, portal/`/me` follows its existing lane idiom. Signature
element: **the mark entry is five scoreboard-digit tap targets** — large
Barlow Condensed numerals 1–5 in scorebug tiles, selected tile lit lime;
one tap sets the mark (comment optional below, `.input` default). No star
icons anywhere — stars are review-site vernacular, digits are scoreboard
vernacular.

- Average badge = scorebug chip: big numeral, small `avg · n` label.
- Report drawer: night panel, incidents as rows led by the SPEC-1 card
  glyph for `red_card`, a plain chip for other kinds; body in measure-limited
  text. Submitted state = timestamp eyebrow, no green success theatrics.
- Mobile-first: mark tiles are thumb-sized (min 44px), the report form works
  one-handed — refs file from the car park.
- Reduced motion + visible focus per the wave bar; screenshot-verify the
  mark tiles (mobile), the profile summary block, and the report drawer.

## Emails (compose.ts, 4-locale)

- `report_submitted` → org owner/admins: fixture line, official name,
  incident count, deep link to the fixture panel.
- No email for marks (org-internal bookkeeping; the official deliberately
  gets no per-mark signal, D4).

## Tests

- Unit: mark window enforcement (pending/declined/undecided → 403), one
  mark per assignment, aggregate math org-scoped vs official-global,
  report immutability after submit, bridge idempotency + darkness when
  SPEC-1 tables absent, entitlement split (marks Pro / reports free).
- DB-backed: RLS — org A cannot read org B's marks; official cross-org rail
  writes reports without org membership (V284 pattern test exists to copy).
- E2E: decide fixture → rate official → summary updates; official files
  report with red-card incident → organiser sees pending suspension
  (when SPEC-1 present).
- Smoke: pro path (mark + summary) + free path (marks PlusReveal; report
  still files).

## Gotchas / constraints for the builder

- `/me` surfaces read via the superuser connection with explicit
  person-claim checks — never `withTenant` (the official has no org).
- The officiating lane date-floor bug (#122) is the cautionary tale: the
  report CTA must key off the `completed[]` union, not a date window.
- Role keys on `fixture_officials` are JSONB (`role_keys`) — use `= any`
  not `IN` in union queries (v11 lesson).
- Marks on voided fixtures still count in aggregates — a mark binds to the
  assignment (the performance), not the result; voiding a result does not
  void the performance. State this in help copy.
- i18n en/fr/es/nl; help articles: one under the officials category for
  organisers (marking), one addition to the officiating portal help for
  reports; slug registry both ways.
