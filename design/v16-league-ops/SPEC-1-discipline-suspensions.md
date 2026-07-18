# SPEC-1 — Player discipline & suspensions

## Problem

Cards are recorded in the `score_events` ledger (football `CardRecord
{side, person?, color: yellow|second_yellow|red}`; hockey/ice-hockey have
penalty/card analogues) and even drive the FIFA fair-play tiebreaker — but
nothing accumulates them across fixtures. A league secretary tracking "5
yellows = 1-match ban" does it in a spreadsheet. LeagueRepublic ships a
"player suspension system" on its free tier; we have nothing.

## Goal

Fold person-attributed card events into a per-division disciplinary ledger.
Configurable thresholds (sport defaults prefilled) auto-raise **pending**
suspensions the organiser confirms, edits, or waives. Manual bans can be
recorded at any time. Suspended players are flagged on every surface that
shows the entrant — softly (D8: no hard block; there is no lineup entity).

## Non-goals

- No engine state-machine changes (D2). No hard blocking of scoring events.
- No cross-division or cross-competition carryover of bans (a ban lives in
  the division that raised it; carryover is a later spec if leagues ask).
- No appeal workflow (waive + note covers it).
- No fine/fee tracking.
- Community tier: nothing (D7 — cards are already Pro).

## Data model — migration `V291__discipline.sql` (renumber at build, D9)

```sql
create table discipline_rules (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  division_id  uuid not null unique references divisions(id) on delete cascade,
  enabled      boolean not null default true,
  rules        jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table suspensions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  division_id    uuid not null references divisions(id) on delete cascade,
  person_id      uuid not null references persons(id) on delete cascade,
  entrant_id     uuid references entrants(id) on delete set null,
  status         text not null default 'pending'
                   check (status in ('pending','active','served','waived')),
  source         text not null
                   check (source in ('auto_accumulation','auto_dismissal','manual','report')),
  rule_key       text,          -- which rule fired (accumulation bucket id), null for manual
  bucket         int,           -- Nth accumulation window (5th yellow = 1, 10th = 2)
  reason         text not null, -- human string: "5th yellow card", "violent conduct"
  matches_total  int not null check (matches_total >= 1),
  matches_served int not null default 0,
  trigger_event_ids uuid[],     -- score_events audit trail
  fixture_id     uuid references fixtures(id) on delete set null,
  created_by     uuid,          -- console user (manual), null for auto
  decided_by     uuid,          -- who confirmed/waived
  decided_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Idempotency: one auto suspension per rule window per person per division.
create unique index suspensions_auto_once
  on suspensions(division_id, person_id, rule_key, bucket)
  where source in ('auto_accumulation','auto_dismissal');
create index suspensions_person_idx on suspensions(division_id, person_id, status);
```

RLS: both tables `enable`/`force`, tenant policy `org_id = current_org_id()`,
grants to `app_user` — mirrors V284. Public reads go through the superuser
`sql` connection like `publicDivisionStats` (no extra policy).

### `rules` JSONB shape

```jsonc
{
  "accumulation": [            // repeating windows over the division's fixtures
    { "key": "yellow_5",  "color": "yellow", "count": 5,  "ban_matches": 1 },
    { "key": "yellow_10", "color": "yellow", "count": 10, "ban_matches": 2 }
  ],
  "dismissal": [               // per-incident, fire on the fixture they occur in
    { "key": "second_yellow", "color": "second_yellow", "ban_matches": 1 },
    { "key": "red",           "color": "red",           "ban_matches": 1 }
  ]
}
```

Accumulation windows are cumulative buckets: `count: 5` fires at the 5th,
`count: 10` at the 10th (bucket = which entry matched). Colors come from the
sport module's discipline descriptor (below) — the rules editor only offers
colors the sport emits. Sport defaults (prefilled on first open, editable):

- football: the shape above (FA standard).
- hockey / ice hockey: red/match-penalty → 1 match; no accumulation default.
- other sports with a discipline descriptor: dismissal-only defaults.
- sports without a descriptor: Discipline tab hidden entirely.

## Engine touch (additive only, D2)

Sport-module interface gains an **optional** field:

```ts
discipline?: {
  /** Extract person-attributed cards from a fixture ledger. Anonymous/coarse
   *  cards (person undefined) are returned but never accumulate. */
  extractCards(ledger: EventEnvelope[]): DisciplineCard[];
  colors: { key: string; label: string }[];  // what the rules editor offers
}
// DisciplineCard = { personId?: string; entrantSide: Side; color: string; eventId: string }
```

Implemented for football + hockey + ice hockey in v16 (they emit cards
today). Zero change to reducers, replay, or golden files — this is a read-only
projection, same layer as `playerStats`. Conformance test: every module with
card-emitting event types must expose `discipline` (mirrors the
conformance-40 suite pattern).

## Fold & detection (web tier)

`apps/web/src/server/usecases/discipline.ts`:

- `recomputeDiscipline(tx, divisionId)` — pull the division's `score_events`
  (exactly the `recomputePlayerStats` query), run `extractCards` per fixture,
  respect `voids_event_id` (a voided card un-counts), and compare totals per
  person against `discipline_rules.rules`:
  - each satisfied accumulation bucket / dismissal without a matching
    `suspensions` row → insert `pending` (the partial unique index makes this
    idempotent under races; `on conflict do nothing`).
  - an existing **pending** auto row whose trigger events are now voided →
    delete it. Confirmed (`active`/`served`) rows are never auto-deleted —
    the organiser owns them once decided; the console shows a "trigger card
    was voided" hint instead.
- Hook: called after any write that lands a `core.finalize` / decided
  transition for a fixture in a division with `enabled = true` rules — same
  seam `scoring.ts` uses for discovery refresh on decided/void writes. Also
  invoked lazily by every discipline read (recompute-on-read; the table IS
  the snapshot, unlike player stats there is no separate cache).

### Serving — matches_served is derived, stored, and monotonic

No lineup entity exists, so "served" = decided fixtures elapsed:

> a suspension with `decided_at` T serves one match for each of that
> entrant's fixtures in the division that reaches `decided`/`finalized`
> **after** T (`abandoned`/`cancelled`/`forfeited` do not count — except a
> forfeit BY the suspended player's entrant, which does count, FA-style).

`recomputeDiscipline` updates `matches_served` on `active` rows and flips
`status → served` when `matches_served >= matches_total`. If the person has
no entrant in the division (`entrant_id` null), serving is counted against
the person's `entrant_members` entrant, resolved at confirm time and stamped
into `entrant_id`.

## Entitlement

New key `discipline.enforced` — seeded in V291:

| plan | value |
|---|---|
| community | false |
| event_pass | false |
| pro | true |
| pro_plus | true |

Gate at the usecase layer via `requireFeature` (both rules CRUD and
suspension writes). Reads on public pages are ungated (a published ban is
public information) — but public rows only ever exist for orgs that could
write them.

## API surface (`/api/v1`, OpenAPI regen mandatory)

- `GET/PUT  /divisions/{id}/discipline-rules` — rules doc + enabled flag.
- `GET      /divisions/{id}/suspensions?status=` — list w/ person + entrant.
- `POST     /divisions/{id}/suspensions` — manual ban (person_id,
  matches_total, reason).
- `PATCH    /suspensions/{id}` — `action: confirm | waive | adjust`
  (adjust = matches_total/reason edit; confirm stamps decided_by/decided_at,
  status → active).

## UI surfaces

1. **Division Settings → Discipline tab** (pattern: v8 division Settings tab)
   — enable toggle + rules editor (rows of color/count/ban_matches with the
   sport defaults prefilled). Hidden when the sport module lacks
   `discipline`. Free orgs see the PlusReveal disclosure.
2. **Division console → Discipline panel** (sibling of the entrants panel) —
   pending queue (confirm/waive), active list w/ "N of M served", served
   history, "Record suspension" manual form (person picker from division
   squads).
3. **Entrants panel + board fixture cards** — red chip `⛔ 1` (count of
   active suspensions among the entrant's members) with a popover naming
   names; consent-gated names on anything public.
4. **Score pad** — soft warning banner when an event is attributed to a
   person with an `active` suspension in this division ("J. Smith is
   suspended (1 of 2 served) — recording anyway"). Never blocks (D8).
5. **Public division page** — "Suspensions" strip under standings: name (via
   `public_person_name` consent helper, exactly the stats pattern),
   matches remaining. Only `active` rows.
6. **`/me`** — claimed players see their own suspensions (any org) in a new
   card in the existing lane layout.

## Design direction

Console surfaces use `.app-*` stadium-night tokens; public strip uses
`--ps-*`. The signature element is the **card glyph**: a small rounded-rect
swatch tilted ~8°, filled `#FBBF24` (yellow) or the brand red `#ef4444`, as
if held up by the referee — it leads every suspension row, the entrant chip,
and the pad warning banner. Rules:

- **Served progress = match pips**, one pip per match (`● ● ○`), never a
  percent bar — a two-match ban is two discrete events, and the pip form
  says so. Pips reuse the scorebug dot idiom.
- Pending rows: amber left border + "Pending review" eyebrow in Barlow
  Condensed caps; confirm/waive as paired quiet buttons (confirm primary).
- Pad warning banner: night background, card glyph, one sentence, no icon
  soup — it must read in one glance mid-match on mobile.
- Public strip: single dense line per suspension under standings, zebra
  rhythm matching the standings table; no cards-glyph color on public free
  tier beyond the token palette (consent-gated names, muted treatment).
- Rules editor rows follow the division-wizard `.input`/`.label` defaults —
  no bespoke form controls.
- Reduced motion: the glyph never animates; focus rings visible on
  confirm/waive. Screenshot-verify the panel, the chip popover, and the pad
  banner (mobile viewport) before calling the UI done.

## Emails (compose.ts, courtside templates, 4-locale)

- `suspension_confirmed` → claimed player (via person_claims → user): reason,
  matches, division. Sent on confirm only — never for pending/auto rows.
- `suspension_served` → same recipient when status flips to served.
Unclaimed persons: no email (no address rail exists for them).

## Tests

- Unit: fold idempotency (re-run creates no dupes), void un-counts a card and
  deletes only pending rows, bucket math (5th + 10th yellow = two rows),
  serving counter across decided/forfeit/abandoned mix, entitlement denial.
- DB-backed: RLS tenant isolation on both tables.
- E2E: record 5 yellows across fixtures → pending appears → confirm → chip on
  entrant + public strip + pad warning.
- Smoke: pro path (rules on, auto ban, confirm) + free path (tab shows
  PlusReveal, API 403s).
- Golden/conformance: `discipline` descriptor exists for every card-emitting
  module.

## Gotchas / constraints for the builder

- Anonymous (coarse) cards accumulate **nothing** — only person-attributed
  cards count. Community orgs can't attribute (ball-by-ball is Pro), which is
  consistent with D7.
- `recomputeDiscipline` must be strictly idempotent: it runs on every read
  AND after every decided write; the partial unique index is the final
  arbiter, not application logic.
- Person picker for manual bans must respect consent display rules in any
  public rendering (reuse `public_person_name`).
- Backticks inside SQL comments inside `sql\`\`` template literals break the
  literal (v12 lesson) — don't.
- i18n: all chip/panel/pad strings via typed keys, en/fr/es/nl.
- Help: new article `content/help/divisions/discipline.md` (divisions
  category — the rules live in division Settings) + slug registry.
