# Jul3/01 — Clubs & Bulk Import

Promotes the one-line "Imports" backlog item ([16-future-features.md](../16-future-features.md)
§Tier 3) to a designed feature, and adds the **Club** parent entity that docs 06 §4.4
(`stats.club_championship`) and 10 (`stats.club_championship`) already assume but 07 never
tabled. Sits on top of the greenfield model — extends [07-greenfield-schema.md](../07-greenfield-schema.md),
[08-api-design.md](../08-api-design.md), [10-pro-entitlements.md](../10-pro-entitlements.md).
Nothing here is implemented (design only, same status as the rest of `engine/`).

## 1. Motivation & scope

Organiser demand, direct from the idea list:

- **Single full import** (3 Jul 2026) — "teams + players together, an extra column for
  parent club, select clubs and add logos in bulk." The headline ask.
- **Import all players for all teams in one go** (10 Jan) — "setting up a 100-team
  tournament shouldn't take an age."
- **Bulk logo upload** (25 Nov) — "96 logos one-by-one; multi drag-and-drop, even if just
  randomized, saves a lot of time."
- **Reuse club logos** (29 May) — same badge across all a club's age-group teams without
  re-uploading.
- **Club → subcategories hierarchy** (4 Jun) — "17 clubs × 8 categories = 136 teams; group
  by club, filter/toggle by club just like by division."

One coherent feature: a persistent **Club** (parent of `teams`), a **spreadsheet import
pipeline** that materialises clubs + teams + players (+ optional entrant/roster placement)
in one pass, and **bulk logo** assignment that every child team inherits.

**Non-goals** (each is a different, already-tracked line):
- Federation / CRM sync over a live API — that's the "own webapp via Tournify API" idea
  (doc 08 §2 API keys already covers third-party access; not this doc).
- Public self-registration & entry fees — that's PROMPT-20a (doc 16 §1.1). Import is the
  **organiser-side** bulk path, not participant self-serve.
- Importing *formats/fixtures/results* from Challonge/chess-results — a later importer
  variant; this pass is participants only (clubs/teams/players/entrants).

## 2. Club entity (schema delta on doc 07)

New tenant table, following doc 07 conventions exactly (uuid pk, denormalized `org_id`
trigger-filled per the 010 pattern, direct RLS `org_id = current_org_id()`, CHECK-enum
text, `timestamptz`):

```sql
create table clubs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  name         text not null,
  short_name   text,
  logo_path    text,                 -- Supabase Storage path; inherited by child teams
  colors       jsonb,                -- default kit colours; teams inherit unless overridden
  external_ref text,                 -- FA / affiliation number (idea 29 Jun) — upsert key
  created_at   timestamptz not null default now(),
  -- idempotent upsert key: prefer external_ref, else fold(name)
  unique (org_id, coalesce(external_ref, lower(btrim(name))))
);
create index clubs_org_idx on clubs(org_id);
```

Extend the existing `teams` table:

```sql
alter table teams add column club_id uuid references clubs(id) on delete set null;
create index teams_club_idx on teams(club_id);
```

**Logo/colour resolver (one place):** effective team badge = `teams.logo_path` when set,
else `clubs.logo_path`; effective colours likewise. Ship as a SQL view `team_display_v`
(joined into the public read views of doc 07 note 4) so app + dashboard + export read
identical resolution and the fallback lives in exactly one query. This is what makes
"upload once per club, all teams show it" true without copying bytes.

**Club is org-scoped and persistent across competitions** — same lifecycle as `teams` and
`persons` (doc 02 §1). It is *not* a division; the hierarchy is `Club → Team → Entrant(per
division)`, orthogonal to `Competition → Division`. "Group/toggle by club" (idea 4 Jun) is
a read-side grouping over `entrants ⋈ teams.club_id`, not a structural stage.

## 3. Import domain model — the pure planner

The engine imports nothing effectful (README ground rule 1; PROMPT-00 §3). So the pipeline
splits:

```
apps/web/src/server/       parse file → ImportRow[] (server-only), Storage writes,
                           DB upserts under withTenant       ← the ONLY I/O
packages/engine/import/    planImport(rows, snapshot, config) → ImportPlan   ← pure
```

The engine half is a **deterministic diff**: given the parsed rows, a read-only snapshot of
what already exists, and a config, it returns the exact list of create/update/link
operations plus typed issues — and *writes nothing*. The app half parses the upload into
rows, calls the planner for a dry-run preview, then (on commit) executes the plan's ops
transactionally.

Types-first (Zod schema → inferred type, per PROMPT-00 §3):

```ts
// One spreadsheet row, already header-mapped by the app. A row may carry a club, a team,
// a player, or all three — sparse fields are how "clubs + teams + players together" works.
ImportRow = z.object({
  rowNo:             z.number().int(),          // 1-based source line, for issue anchoring
  clubName:          z.string().optional(),
  clubShortName:     z.string().optional(),
  clubExternalRef:   z.string().optional(),
  teamName:          z.string().optional(),
  teamShortName:     z.string().optional(),
  playerFullName:    z.string().optional(),
  dob:               z.string().date().optional(),
  gender:            z.enum(['m','f','x']).optional(),
  squadNumber:       z.number().int().optional(),
  position:          z.string().optional(),     // validated vs division sport position_catalog
  isCaptain:         z.boolean().optional(),
  divisionSlug:      z.string().optional(),      // where to place the team as an entrant
  entrantDisplayName:z.string().optional(),
});

// Read-only view of current org state the planner matches against (app fetches, passes in).
ImportSnapshot = z.object({
  clubs:    z.array(z.object({ id, name, externalRef: z.string().nullable() })),
  teams:    z.array(z.object({ id, name, clubId: z.string().nullable() })),
  persons:  z.array(z.object({ id, fullName, dob: z.string().nullable(), externalRef: z.string().nullable() })),
  divisions:z.array(z.object({ id, slug, sportKey, positionKeys: z.array(z.string()) })),
  entrants: z.array(z.object({ id, divisionId, teamId: z.string().nullable() })),
});

ImportConfig = z.object({
  personMatch:   z.enum(['strict','lenient']).default('lenient'),
  createDivisions: z.literal(false).default(false),   // import never creates divisions (§4)
  minorConsentDefault: z.boolean().default(false),     // doc 06 §4.7
});

ImportOp = z.discriminatedUnion('kind', [
  // kind ∈ club.create | club.update | team.create | team.link |
  //        person.create | roster.add | entrant.create | entrant.member.add
  //   each: { kind, ref (stable synthetic key), before?, after, sourceRows: number[] }
]);

ImportIssue = z.object({
  rowNo:    z.number().int(),
  column:   z.string().optional(),
  severity: z.enum(['error','warn']),
  code:     z.string(),          // 'DIVISION_NOT_FOUND','AMBIGUOUS_PERSON','BAD_POSITION',…
  message:  z.string(),
});

ImportPlan = z.object({
  ops:    z.array(ImportOp),
  stats:  z.object({ clubs, teams, persons, entrants, rosters }),  // counts by effect
  issues: z.array(ImportIssue),
});
```

`planImport` is `(rows, snapshot, config) → ImportPlan`, pure and total: no throw, all
problems surface as `issues`. `error`-severity issues block commit for their rows; `warn`
lets them through. Refs inside ops are stable synthetic keys (e.g. `club:acme`,
`team:acme/u12`) so a later op can depend on an earlier op's not-yet-existent id — the app
resolves refs → real uuids as it executes the plan in dependency order.

## 4. Matching / dedupe / idempotence rules (normative)

Re-uploading the same file must be a **no-op**. Rules (every rule cites this section in
code, per PROMPT-00 §3):

- **Club** — match by `external_ref`; else by folded `name` (`lower(btrim(...))`). Miss ⇒
  `club.create`. Hit with differing `short_name`/`colors` ⇒ `club.update` (only supplied
  fields; blanks never overwrite). `logo_path` is **not** set by row import — only by the
  bulk-logo path (§5).
- **Team** — identity `(club_id, folded name)`; clubless teams keyed on `(org_id, folded
  name)`. Miss ⇒ `team.create` (+ `team.link` to its club). Existing team with no club and
  a club now supplied ⇒ `team.link`.
- **Person** — match within org by `external_ref`; else `(folded full_name + dob)`.
  Ambiguous (same folded name, no dob, ≥2 candidates): `lenient` ⇒ `warn AMBIGUOUS_PERSON`
  + `person.create` (default); `strict` ⇒ `error` (organiser resolves via the persons
  merge endpoint, doc 08 §3). Match hit ⇒ no create; still `roster.add` if not on the
  team's roster.
- **Entrant / roster** — a row with `divisionSlug` places the team into that division:
  find-or-create `entrant(kind='team', team_id)` in the division (`entrant.create`), then
  `roster.add` / `entrant.member.add` the player with `squad_number`, `position` (validated
  vs the division's `position_catalog`, doc 02 §3 — bad ⇒ `error BAD_POSITION`), `is_captain`.
  **Import never creates divisions** (`config.createDivisions=false`); unknown
  `divisionSlug` ⇒ `error DIVISION_NOT_FOUND` (organiser sets up divisions/formats first —
  that stays a deliberate structural act).
- **Idempotence** — `planImport(rows, snapshotAfterCommit, config).ops == []`. This is the
  property test in the prompt: apply a plan, rebuild the snapshot, re-plan the same rows ⇒
  zero ops.

## 5. Bulk logo upload

Separate multipart endpoint (logos are bytes, not spreadsheet cells — kept off the row
path so a file import and a logo drop compose independently). N image files →
club matching:

1. **filename-stem match** — `logo` file stem, folded, == club `short_name` or `name`.
2. **manual re-map** — the preview UI lets the organiser fix any unmatched/mismatched file
   against a club dropdown before assigning.
3. **any-order / randomized** mode (idea 25 Nov) — assign the N files to N unlogo'd clubs
   in order for the "even if it's just randomized" case; still shown for confirmation.

Each accepted file → Storage write → set `clubs.logo_path`; child teams inherit via the §2
resolver (no per-team copy). Validation: MIME + size caps; **content-hash dedupe** — two
uploads of identical bytes reuse one stored object (the "don't re-upload" ask). Assignment
is idempotent: re-dropping the same file for the same club is a no-op.

## 6. API surface (extends doc 08)

Under `/api/v1`, `handler()` wrapper (≤~20 lines: parse Zod → auth → use-case → shape),
`{ ok, data|error, requestId }` envelope, typed `EngineError` codes → HTTP (doc 08 §1).

```
# Import (org-scoped; session or API key with write scope)
POST   /api/v1/imports                     multipart file → { importId, plan }  (dry-run; writes nothing)
POST   /api/v1/imports/{id}/commit         apply plan; Idempotency-Key header (doc 08 §4);
                                           transactional under withTenant; emits audit rows
GET    /api/v1/imports/{id}                stored parse + last plan (re-preview without re-upload)

# Clubs
GET/POST         /api/v1/clubs             list / create   (?cursor=&limit= per doc 08 §1)
GET/PATCH/DELETE /api/v1/clubs/{id}
POST             /api/v1/clubs/logos       multipart, bulk → match + assign (§5)

# Filter + export (satisfies "filter/toggle by club" + "unified participant overview")
GET  /api/v1/divisions/{id}/entrants?club_id=…            # club filter on existing list
GET  /api/v1/participants/export?format=csv|xlsx&club_id=…&division_id=…
                                            # one sheet, club + division columns; empty-spot
                                            # placeholders preserved (idea 30 Jan)
```

The entrants **CSV bulk import** hook doc 08 §3 already reserved
(`POST /divisions/{id}/entrants # + bulk import (CSV)`) becomes a thin division-scoped alias
that funnels into the same planner with `divisionSlug` pinned. The persons **merge** hook
(doc 08 §3) is the resolution path for `strict` ambiguous-person errors.

**Commit audit:** commit writes a `division_events` row (`type: 'participants_imported'`,
payload = plan stats + importId) for each touched division and an org-level audit entry;
hash-chained per the 011 pattern (doc 07 note 2). Nothing in the ledger is scoring data —
this is structural, same family as `fixtures_generated`.

## 7. Entitlements (extends doc 10)

New `feature_key`s, same machinery (`plan_entitlements` → overrides → `requireFeature`/
`withinLimit` at the service layer, 402 `PaymentRequiredError` with `feature_key` for the
contextual paywall, doc 10 §2–3):

| feature_key | Community | Pro | Business |
|---|---|---|---|
| `import.bulk` (spreadsheet import > small cap) | ≤ 20 rows/file | ✓ | ✓ |
| `logos.bulk` (multi-file logo assign) | ✗ (one at a time) | ✓ | ✓ |
| `clubs.hierarchy` (Club parent + group/filter-by-club) | ✗ | ✓ | ✓ |

Rationale: a small club can hand-add 16 entrants free (matches `entrants.per_division.max`
= 16 Community); the 100+-team / 17-club pain that motivates this is squarely Pro. Aligns
with the existing `exports` (Pro) and `stats.club_championship` (Pro) keys — `clubs.hierarchy`
is the structural prerequisite the club-championship stat already assumed. Downgrade
behaviour per doc 10 §2.4: existing clubs/imported data never deleted; over-cap import
simply rejected going forward.

## 8. UI notes (`apps/web`, non-normative)

- **Import wizard:** upload → **column mapper** (auto-detect headers, remember the mapping
  per org) → **preview table grouped by club** with create/update/skip/link badges per row
  and the `ImportIssue[]` list (errors block, warns are acknowledgeable) → **Commit**.
  The preview *is* the `ImportPlan` rendered — no surprise writes.
- **Logo grid:** drag-drop many files; each card shows matched club + a re-map dropdown +
  an "assign remaining in order" toggle; assign is one action.
- **Club filter/toggle** on the participants and schedule pages (a `club_id` facet beside
  the existing division facet). Club detail view lists its teams across divisions.

## 9. Edge cases checklist

- **Placeholder / empty-spot rows** — a team with no players imports fine; export keeps
  "Empty Spot N" labels (idea 30 Jan explicitly wants these in the Excel export, not blank).
- **Duplicate player across teams/divisions** — one `person`, multiple `roster`/
  `entrant_member` rows; never a duplicate person (the whole point of §4 person matching).
- **Minors** — `person.create` sets `consent` defaults false (`minorConsentDefault`, doc 06
  §4.7); DOB collected but never exposed publicly (doc 07 `persons.dob` note).
- **Partial failure** — commit is a single transaction; any op failure rolls the whole
  commit back (no half-imported state). The Idempotency-Key makes the retry safe.
- **Large files** — 10k-row upload streamed/chunked on parse, not buffered whole; the
  planner runs on the resulting rows in memory (pure, fast); commit batches inserts.
- **Mixed create + update** — one file can create some clubs/teams and update others; the
  plan diff handles both, ordered by ref dependency (clubs → teams → persons → entrants →
  rosters).
