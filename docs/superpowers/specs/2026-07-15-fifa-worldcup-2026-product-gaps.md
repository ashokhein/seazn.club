# Product gaps found while building the FIFA WC 2026 demo

Running log of limitations discovered in the product while seeding a real, large,
multi-stage tournament. Each entry: what I hit, why it matters, rough fix.

## 1. Knockout bracket generator only does standard seeding

**Hit:** Wanted FIFA's real R32 pairings (12 winners + 12 runners-up + 8 best thirds
slotted by a fixed lookup table). The knockout stage generator seeds the bracket by
standard 1-v-N seeding off the qualification order — there's no way to pass an explicit
slot map / bespoke bracket.

**Why it matters:** Any real-world cup with a published fixed bracket (World Cup, Euros)
can't be reproduced exactly. Demo brackets are structurally plausible but not the real
pairings.

**Rough fix:** allow a stage to accept an explicit seed→slot mapping (or a named bracket
template) instead of only derived standard seeding.

## 2. Qualification can't combine tiers (winners + runners-up + best thirds)

**Hit:** FIFA advances 12 group winners + 12 runners-up + 8 best third-placed = 32.
`QualificationSpec` is one of TakePicks | TopN | BestOfRank — a single shape. There's no
way to union "all rank-1 + all rank-2 + best-8-of-rank-3" in one qualification.

**Why it matters:** the most common real multi-group→knockout format (World Cup, Euros,
AFCON with best-thirds) can't be expressed directly.

**Workaround used:** enumerate all 32 as explicit `TakePicks` `{pool,rank}` entries, computing
the 8 best-third pools myself from the real standings. Works, but the engine's own best-third
logic (`BestOfRank.normaliseUnequalPools`) is bypassed.

**Rough fix:** allow `qualification.take` to accept a `bestOfRank` sub-clause, or accept an
array of specs that concatenate into the seed list.

## 3. Entrants have no crest / flag / badge field

**Hit:** wanted a country flag on each of the 48 national-team entrants. `entrants` has no
image column. The only team imagery path is `teams.logo` via a club (clubs.hierarchy, a Pro
feature) uploaded through the multipart bulk-logo endpoint — i.e. 48 image uploads plus a club
tree, just to show a flag.

**Why it matters:** any "teams with logos" demo (leagues, cups) is disproportionately hard;
there's no lightweight per-entrant badge, and no way to point at an external image URL.

**Rough fix:** an optional `entrants.badge_url` (or `crest_ref`) settable at create time,
rendered on board/bracket/public — no club hierarchy required.

## 4. Pool `name` vs `key` is a silent footgun when authoring qualification

**Hit:** generated pools are `name = "Pool A"` but `key = "A"`; `qualification.take[].pool`
matches the **key**. Referencing "Pool A" would silently resolve nothing. Nothing in the API
surfaces which one `take.pool` expects.

**Rough fix:** document it on the schema, and/or accept either name or key in `take.pool`.

## 5. No bulk person-create — 1248 individual POSTs for full squads

**Hit:** seeding 48×26 players = 1248 sequential `POST /api/v1/persons`. There's no batch
person endpoint; entrants accept inline `members` only by pre-existing `person_id`.

**Rough fix:** accept inline new-person members (name + number + position) on entrant create,
or a `POST /api/v1/persons` batch body.

