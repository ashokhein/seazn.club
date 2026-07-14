# PROMPT-56 — Sponsor CRM & monetization: real model, tiers, placement, paid packages

**Read first:**
- `apps/web/src/lib/org-branding.ts` — the entire current sponsor
  implementation: `Sponsor { name, url?, logo? }`, `OrgBranding`,
  `mergeSponsors` / `brandingSponsors` (blob-merge so a colour write never
  clobbers sponsors). This becomes a **read shim**, not the source of truth.
- `apps/web/src/components/org-sponsors.tsx` — the existing org-settings editor
  you replace with the tiered manager.
- `apps/web/src/app/o/[orgSlug]/settings/page.tsx` (~L282) — the `OrgSponsors`
  mount point + `msg("sponsors.title")` + the "Sponsor slots require Pro" copy.
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx`
  (~L58–L263) — public render: competition-level then org-level, deduped by
  name. Switch to the table + tier grouping.
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/register/page.tsx`
  (~L28–L56) — the register-page masthead sponsor line (same switch).
- `apps/web/src/app/api/orgs/[id]/route.ts` — `mergeSponsors` / `mergeBrandColor`
  write path; the entitlement-gated public org read that nulls sponsors today.
- `apps/web/src/server/usecases/registrations.ts` — **the Connect precedent**:
  destination charge with `transfer_data` → connected account,
  `application_fee_amount` → platform, PaymentIntent creation, and the
  idempotency conventions. Sponsor-package checkout mirrors this exactly.
- `apps/web/src/server/usecases/billing-events.ts` — webhook dispatch;
  `payment_intent.succeeded` handling + **`/admin/billing-events` can REPLAY**,
  so every handler is idempotent.
- `apps/web/src/lib/entitlements.ts` — `requireFeature(orgId, key)` resolves
  `plan_entitlements`; new keys are **seeded by migration**, not code.
- `design/v10/README.md` (scope + non-goals).

**Depends:** none (parallel-safe with v11). **Migration:** one delta, next free
`V###` after V280 (verify contention vs the unmerged v5-i18n V281).

## Context

Sponsorship today is a `Sponsor[]` living inside two `branding` jsonb columns
(`organizations.branding`, `competitions.branding`). That was fine for "put five
logos on the public page" (v3/10 #5) and is wrong for a sellable product: no
tier, no ordering guarantees beyond array position, no per-competition editing
surface, no revenue, no proof-of-delivery for the sponsor. This prompt makes
sponsorship first-class **without a flag-day**: existing blobs keep rendering
via a shim until migrated, and the public pages read the new table.

Money reuses the **entry-fee rail unchanged**. An org sells a *sponsor package*
(a priced offer) and the buyer pays by card; funds settle to the org's
**connected account** via a destination charge, platform takes an application
fee, exactly like a registration entry fee. No new Stripe primitives — same
`getStripe()`, same connected-account resolution, same `billing-events`
dispatch, same v9 dispute economics.

## Task

Commit the work in the four separable slices below (each independently
reviewable / revertable).

### 1. Model + migration (`V###`)

Add three tables (schema `seazn_club`, tenant `org_id`, RLS mirroring
`officials` / registration tables — copy the grant pattern from the newest
`db/migration/deltas` file, and add public-read grants where the public renderer
needs them, mirroring how public competition reads already reach branding):

- `sponsors` — `id, org_id, competition_id (nullable ⇒ org-wide), name, url,
  logo_path, tier ('title'|'gold'|'silver'|'partner'), display_order int,
  status ('active'|'pending'|'inactive') default 'active', click_count int
  default 0, created_at`.
- `sponsor_packages` — `id, org_id, competition_id (nullable), name,
  description, price_cents, currency, tier, active bool, created_at`.
- `sponsor_orders` — `id, org_id, package_id, sponsor_name, sponsor_email,
  payment_intent_id, amount_cents, currency, status
  ('pending'|'paid'|'failed'|'refunded'), sponsor_id (nullable, set on
  activation), created_at, paid_at`.

Seed **entitlement keys** into `plan_entitlements` in the same migration
(mirror how `officials.auto` / `exports.branded` are seeded — find them in the
existing seed migration): `sponsors.tiers` (Pro — tiers + per-competition
manager) and `sponsors.monetize` (Pro — packages + Connect checkout). The
un-tiered single-logo strip stays free (community) so no existing free org
loses its current sponsor line.

**Backfill:** copy every `branding.sponsors[]` entry (org and competition) into
`sponsors` rows (`tier='partner'`, `display_order` = array index,
`competition_id` set for competition blobs, else null). Leave the blob in place
(the shim reads it if the table is empty for that scope — belt-and-braces during
rollout).

### 2. Sponsor manager (`usecases/sponsors.ts` + API + UI)

- New `apps/web/src/server/usecases/sponsors.ts`: `listSponsors`,
  `createSponsor`, `patchSponsor`, `deleteSponsor`, `reorderSponsors`, all
  `withTenant`; `assertTierAllowed` calls `requireFeature(orgId,
  "sponsors.tiers")` when `tier !== 'partner'` **or** when
  `competition_id !== null` (per-competition management is the Pro line). Zod
  inputs like `officials.ts`.
- API under `api/v1/orgs/[id]/sponsors` (+ `[sponsorId]` for patch/delete/
  reorder), following the `officials` route shape (`v1`, `requireResourceAuth`,
  `parseBody`).
- Replace `components/org-sponsors.tsx` with a tiered manager: rows grouped by
  tier, drag-or-arrow reorder, logo upload via the existing content-upload path
  (the current editor already uploads to storage — reuse it; **logo_path is a
  storage path, resolved to a URL at render**, as the current public code notes),
  a competition selector (Pro) to scope a sponsor to one competition, and the
  Pro upsell where `sponsors.tiers` is denied.

### 3. Public placement (tier-grouped + tracked clicks)

- `brandingSponsors()` stays but gains a DB-backed sibling
  `resolveSponsors(orgId, competitionId?)` that returns table rows
  (competition-scoped first, then org-wide, deduped by name, ordered by
  `tier` rank then `display_order`), falling back to the blob shim only when the
  table has no rows for that org. Public pages call the resolver.
- Update the public competition page + register masthead to render **tier
  groups** (title row large, then gold/silver/partner in descending prominence)
  — keep it inside the existing Pro-gated public read.
- Add a tracked redirect route `apps/web/src/app/s/[sponsorId]/route.ts`:
  `GET` → increment `sponsors.click_count` (fire-and-forget, never block the
  redirect) → `302` to the sponsor `url`. Public sponsor links point here.
- Placement reaches the **poster PDF, embeds, and slideshow** by feeding
  `resolveSponsors` into their existing branding inputs — **but the PDF/embed
  *rendering* of sponsors is v12's job**; here, just make the data available
  (the poster route + embed loaders already read branding — point them at the
  resolver so v12 has real rows to draw).

### 4. Monetization (Connect checkout for packages)

- `usecases/sponsors.ts`: `createSponsorPackage` / `listPackages` /
  `deactivatePackage` (Pro `sponsors.monetize`), and `startSponsorCheckout`:
  - Resolve the org's connected account exactly as `registrations.ts` does;
    refuse (`PaymentRequiredError` / 409) if the org isn't Connect-onboarded,
    reusing the same guard/ToS-gate v9 added before Connect actions.
  - Create the PaymentIntent as a **destination charge**: `amount` =
    package `price_cents`, `currency`, `transfer_data.destination` = connected
    account, `application_fee_amount` = the platform fee (reuse the entry-fee
    fee helper — do **not** re-derive the fee formula), `metadata` =
    `{ kind: 'sponsor', order_id, package_id, org_id }`, idempotency key
    `sponsor-order-${order_id}`. Insert the `sponsor_orders` row `pending`
    first, then create the intent (same order as registrations).
- Webhook: extend `billing-events.ts` dispatch — on
  `payment_intent.succeeded` with `metadata.kind === 'sponsor'`, mark the order
  `paid`/`paid_at`, **create the activated `sponsor` row** (tier from the
  package, `status='active'`) and link `sponsor_orders.sponsor_id`, all
  idempotent (short-circuit if the order is already `paid` OR a sponsor already
  carries this `order_id` — mirror the v9 metadata/list belt-and-braces so an
  `/admin/billing-events` replay can't double-activate). On
  `payment_intent.payment_failed` mark `failed`. Dispute/refund flow through the
  **existing** v9 handlers unchanged (sponsor orders are just another charge).
- **Emails** (`email-templates/`, register in `email.ts` + `index.ts`, pin
  chrome in `email-builders.test.ts`: `bgcolor="#150b36"`, `#a3e635`,
  `&#9679;`): `sponsor-invoice` (pay-now CTA, mirrors `payment-reminder.ts`) to
  the sponsor email at checkout start, `sponsor-receipt` on `paid`.

### 5. Cross-cutting (mandatory — do not skip)

- **Help** (`content/help/**`): a "Sponsors" page under the org/branding
  section — tiers, per-competition scoping, selling packages, where logos
  appear, click stats. (House rule: every branch updates help in the same PR.)
- **Smoke** (`scripts/smoke.ts`): extend both pro + free paths — free org adds a
  `partner` logo and sees it publicly; pro org creates a tiered sponsor + a
  package, runs a test-mode Connect checkout to `paid`, asserts the sponsor
  activated and the click redirect increments.
- **Tests** (every change ships a failing-without-it test):
  - `org-branding` shim: table rows win over blob; blob fallback when table
    empty; backfill idempotent.
  - `sponsors` usecase: tier/competition gating denies without `sponsors.tiers`;
    reorder + dedup + tier-rank ordering in `resolveSponsors`.
  - checkout: destination charge shape (fee, transfer destination, metadata,
    idempotency key) with a stubbed `getStripe()` (follow
    `registrations.test.ts` / `dispute-evidence.test.ts` stub seam).
  - webhook: `paid` activates exactly once under replay; `failed` path; a
    stray non-sponsor intent is ignored.
  - click redirect: increments once, 302s to the url, never blocks on the
    increment.

## Acceptance

- `npm run typecheck`, unit suites (incl. new sponsor + email tests), smoke
  green; help-content registry test green.
- Test-mode simulation documented in the PR: create package → checkout with
  `4242 4242 4242 4242` → webhook `paid` → sponsor appears tier-grouped on the
  public competition page → click logo → redirect + `click_count` +1 → replay
  the succeeded event from `/admin/billing-events` → no duplicate sponsor.
- An existing org with blob sponsors still renders its strip before AND after
  backfill (no public regression).
- Connect-not-onboarded org is refused package checkout with the same gate as
  entry fees.

## Gotchas (do not relearn)

- **Never replace the branding blob** — `mergeSponsors`/`mergeBrandColor` exist
  because colour and sponsors share one column. During migration you read the
  blob; you don't rewrite it.
- **`logo` is a storage path, not a URL** — resolve at render (the current
  public code comments this on every use).
- Keep Stripe calls **outside** `sql` transactions (established withdraw/refund
  rule).
- `/admin/billing-events` replays at will → the `paid`→activate handler needs
  the same idempotency story v9 uses (order-status check *and* sponsor-exists
  check; Stripe idempotency keys expire ~24h so the DB guard is mandatory, not
  optional).
- Resolve the org owner via `org_members.role='owner'`, **not**
  `organizations.created_by`, for any owner-addressed email (the created-by trap
  PR #89 fixed).
- V-number contention: v5-i18n holds V281 unmerged — number the delta against
  what's actually on `main` at build time and re-check before pushing.
