# SPEC-4 — Team-scale pricing dimension

## Problem

LeagueRepublic prices by league size: £13.60/mo for 25 teams up to £68.30/mo
past 300 (≈$17→$87). We charge Pro a flat $20/mo with unlimited competitions,
unlimited divisions, 256 entrants per division — a 300-team league pays us
the same as a 10-team club while consuming 30× the support, storage, and
officiating surface. The per-division caps
(`entrants.per_division.max` 16/32/256) never bind org-wide: nothing counts
teams across a season the way LR does.

## Goal (D6)

Make **org-wide active-team scale the Pro→Pro Plus differentiator** with one
new quota key — no new SKUs, no Stripe changes, no band pickers:

| plan | `teams.active.max` |
|---|---|
| community | 32 |
| event_pass | 32 |
| pro | 100 |
| pro_plus | unlimited (null) |

Pricing story vs LR at a glance (GBP→USD ≈1.27):

| league size | LR | us |
|---|---|---|
| 25 teams | $17/mo | Pro $20 (bundles live scoring, officials, sponsors, payments) |
| 100 teams | $29/mo | Pro $20 |
| 300 teams | $59/mo | Pro Plus $39 |
| 300+ teams | $87/mo | Pro Plus $39 |

We stay cheaper at every size that matters while finally giving big leagues
a reason Pro Plus exists. Community 32 = today's theoretical free maximum
(1 comp × 2 divisions × 16 entrants) — **no free-tier tightening**.

## The metric — what is an "active team"?

> **Active teams = entrants with `kind = 'team'` in divisions of
> competitions whose status is `published` or `live`.**

Decisions inside that sentence:

- **Team-kind only.** Individuals and pairs are excluded (LR precedent:
  "we do not count singles / doubles / triples teams"). A 200-player tennis
  ladder is one court community, not 200 billable teams; team-sport leagues
  are where scale cost lives. The builder must verify the exact `entrants.
  kind` enum (`select distinct kind from entrants`) and count only the
  team-shaped kind(s) — ladder/americano formats and pair kinds are out.
- **All stages count** (league AND knockout). LR excludes knockout-only
  teams; we deliberately don't — our stages are per-division and a
  season-long knockout consumes the same resources. Simpler to explain:
  "teams in active competitions".
- **Draft competitions don't count.** Orgs can build next season freely;
  the check bites at publish time.
- **Entrant rows, not distinct clubs.** The same club in two divisions = 2
  active teams (they consume two fixtures streams). When the clubs & teams
  redesign (spec 59060b1) lands durable team identity, revisit whether to
  dedupe — note it there, not here.

Counting query lives in one place: `activeTeamCount(orgId)` in
`apps/web/src/lib/entitlements.ts` territory (or a sibling), used by every
enforcement point and the meter. Never inline the SQL twice.

## Enforcement — soft ceiling, never mid-season freeze

Three creation-time gates via the existing `checkLimit` rail
(`checkLimit(orgId, 'teams.active.max', wouldBe)`):

1. **Entrant create** (console + API) into a division of a
   published/live competition, when `kind` is team-shaped.
2. **Registration approval** that would materialize such an entrant.
3. **Competition publish** — the whole comp's team entrants join the count
   at once; block publish with the upsell if it would exceed.

On block: 402-style error + **PlusReveal** disclosure (the Pro Plus
upsell component from #125) showing current count, cap, and the Plus card.
Existing data is NEVER frozen or hidden — an org already over cap keeps
operating; only *adding* is gated (grandfather makes this near-impossible
anyway, below).

## Migration `V294__team_scale_quota.sql` (renumber at build, D9)

1. Seed `teams.active.max` for all four plans (`on conflict do update`).
2. **Grandfather** (V270 precedent): for every org whose current active-team
   count exceeds its plan cap, insert an `org_entitlement_overrides` row at
   its current count with reason `'v16 team-scale grandfather (2026-07)'`,
   `on conflict do nothing` (hand-set overrides stay authoritative).
3. No table DDL — this is pure matrix + overrides.

Resolver chain (override → pass → plan) already handles the rest; the
event_pass row means a community org holding a pass on a big one-off
tournament gets 32 within that competition's scope, consistent with the
pass's existing per-division caps.

## Surfaces

- **Billing page (`/o/[org]/settings/billing`)** — "Active teams: 47 / 100"
  usage meter with a one-line definition and a "What counts?" help link.
  Pro Plus shows count with no cap ("Active teams: 312").
- **Pricing page (marketing)** — Pro card gains "Up to 100 active teams";
  Pro Plus "Unlimited teams". FAQ entry defining the metric (mirror LR's
  own FAQ transparency — it's good practice). 4-locale.
- **/admin/entitlements** — the key appears automatically (existing admin
  matrix); add the live count to the org drill-down.
- **Upsell moments** — the three enforcement points above; no nag banners
  below 80% of cap, a quiet "approaching your plan's team limit" inline
  note on the billing meter at ≥80%.

## Design direction

Signature element: the **stadium-capacity gauge** on the billing page — a
horizontal terrace-section bar (segmented like stand blocks, not a smooth
progress bar) that fills lime and shifts to the brand red only in the last
segment (≥90%). Big Barlow Condensed count, small utility label. It reads
as "how full is your stadium", which is literally the metric.

- The gauge is one component, used on billing and the admin drill-down.
- PlusReveal on block: unchanged component, fed `current`/`cap` numbers —
  no bespoke modal.
- Pricing-page copy in the existing card idiom; no layout change.
- Mobile: the gauge and the block states must work at 390px (wave-wide
  mobile acceptance criterion); the meter stacks above the plan card, touch
  target on "What counts?" ≥44px. Screenshot-verify billing page both
  viewports + the block dialog on mobile.

## Tests

- Unit: `activeTeamCount` — kind filter, draft exclusion, published/live
  inclusion, pair/individual exclusion; `checkLimit` integration at all
  three gates; grandfather override respected (over-cap org can still edit
  but not add); pass-holder resolution.
- DB-backed: migration idempotency (re-run seeds cleanly); grandfather
  query against a seeded over-cap org.
- E2E: pro org at 100 → adding entrant 101 shows PlusReveal; upgrade path
  (SQL pro_plus flip, test-infra pattern) → same action succeeds.
- Smoke: free path (community under 32 unaffected) + pro path (meter renders
  with real count).
- Marketing dictionary parity (en/fr/es/nl) — the parity gate will catch it,
  but the FAQ answer is copy that needs real translation care, not
  placeholder.

## Gotchas / constraints for the builder

- **Do not** count via `entrants.per_division.max` machinery — that key
  stays untouched (it's the anti-abuse per-division bound; this is the
  org-wide commercial bound; they bind independently).
- Ent-cache: entitlement resolution is Redis-cached (stg lesson) — the
  *cap* can cache, the *count* must not; always compute the count live at
  enforcement points.
- Publish-time check must count the publishing comp's teams atomically with
  the status flip (same transaction) or two concurrent publishes race past
  the cap.
- The pricing-page meta description
  (`pricing.meta.description`) currently says "go Pro at $20/month for
  unlimited competitions" — competitions stay unlimited so the copy stands,
  but review every "unlimited" claim on the page against the new matrix in
  the same PR.
- `stripe:sync` needs NO changes (no price objects touched) — resist
  inventing per-size prices; that was explicitly rejected (band/metered
  options lost the brainstorm).
- Help: billing category article update defining active teams + the
  grandfather promise; slug registry.
