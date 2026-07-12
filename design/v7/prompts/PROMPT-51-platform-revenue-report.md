# PROMPT-51 — Platform revenue report: application fees by month and org

**Read first:** `docs/superpowers/specs/2026-07-12-registration-payments-design.md` §1/§5
(fee chain + admin surfaces — normative for where the % comes from),
`apps/web/src/lib/platform-settings.ts` (cache-aside pattern to mirror),
`apps/web/src/app/admin/settings/page.tsx` + `api/admin/settings/route.ts` (admin page +
route conventions, `requireSuperadmin`/`logStaffAction`), `apps/web/src/lib/stripe.ts`
(client), `organizations.stripe_account_id` (org ↔ connected account join key).
**Depends:** PR #72 (dual payments) merged. No migrations.

## Context

Card entry fees are destination charges: the platform keeps
`application_fee_amount` per payment (Pro 2% / Event Pass 5% / admin default — see fee
chain). Stripe's `GET /v1/application_fees` on the platform account is the authoritative
record of every fee collected and refunded, each row carrying `account` (the connected
account), `amount`, `amount_refunded`, `currency`, `created`. There is deliberately no
in-app fee ledger; this report READS Stripe, joins accounts back to orgs, and caches.

## Task

1. **Usecase** `apps/web/src/server/usecases/platform-revenue.ts`:
   - `platformRevenue(range: { from: Date; to: Date })` → paginate
     `stripe.applicationFees.list({ created: { gte, lt }, limit: 100 })` to exhaustion
     (auto-pagination iterator); map each fee to `{ account, amount, amount_refunded,
     currency, created }`.
   - Join accounts → orgs in ONE query
     (`select id, name, slug, stripe_account_id from organizations where
     stripe_account_id in (…)`); unknown accounts group under "(disconnected org)" —
     orgs can disconnect/be deleted after fees were collected.
   - Rollups (all in minor units, per currency — do NOT sum across currencies):
     `byMonth[currency][yyyy-mm] = { gross, refunded, net, count }` and
     `byOrg[currency][orgId] = { name, slug, gross, refunded, net, count }`.
   - Cache the assembled result 300s via `cacheGet/cacheSet`
     (key `platform:revenue:<from>:<to>`), fail-open like `platform-settings.ts`.
   - Guard: no `STRIPE_SECRET_KEY` → HttpError 503 "Stripe is not configured".
2. **Route** `apps/web/src/app/api/admin/revenue/route.ts`:
   - `GET ?from=YYYY-MM-DD&to=YYYY-MM-DD` (zod; default = last 12 whole months;
     reject ranges > 24 months). `requireSuperadmin()`. Returns the usecase result.
   - `GET ?format=csv` → CSV with columns
     `month,org,org_slug,currency,gross_minor,refunded_minor,net_minor,fee_count`
     (one row per org×month×currency), `Content-Disposition: attachment`.
     Reuse the CSV escaping approach from `exportRegistrationsCsv`.
3. **Page** `apps/web/src/app/admin/revenue/page.tsx` (+ client component if needed),
   admin dark-console styling (slate cards like `/admin/settings`):
   - Header stat row per currency: net collected (range), gross, refunded, fee count.
   - Monthly table (rows = months desc; per currency columns gross/refunded/net/count).
   - Per-org table (rows = orgs by net desc; name links to `/admin/orgs/[id]`).
   - Range picker: presets "Last 12 months / This year / All time (24m cap)" + custom
     from/to date inputs; CSV download button hits the route with the same range.
   - Amounts render via `Intl.NumberFormat` with the row currency, minor→major.
   - Empty state: "No card entry fees collected yet — fees appear once organisers take
     card registrations."
4. **Wiring**: nav link "Revenue" in `apps/web/src/app/admin/layout.tsx` (between
   Coupons and Settings); on `/admin/settings`, a one-line pointer under the fee card
   ("See what the cut has earned → Revenue"). `logStaffAction(staff.id,
   "revenue_report_viewed", "platform", "revenue", { from, to })` on GET (page load
   only, not CSV).

## Acceptance

- Unit (`platform-revenue.test.ts`, Stripe client mocked like `registrations.test.ts`):
  - pagination exhausts `has_more` pages; fees map to the right `yyyy-mm` buckets (UTC);
  - refunded fees reduce `net` but keep `gross`; multi-currency fees never sum together;
  - fee on an unknown `account` lands in "(disconnected org)";
  - cache hit skips the Stripe client on the second call (assert mock call count);
  - range > 24 months → 422; missing key → 503.
- Route: non-staff 403 (mirror existing admin-route guard behavior); CSV has the exact
  header above and one line per org×month×currency.
- `npx tsc --noEmit` + lint clean; admin page renders with seeded mock data
  (screenshot desktop + 390px per frontend-design mirror rule).
- Docs: PR body notes the report is Stripe-read-only (no ledger), 5-min cache, and that
  live numbers need the RAK to keep `application_fees` read access.

## Out of scope

Payout tracking, Stripe balance/transfer reconciliation, org-facing earnings pages,
invoicing/tax documents, charts (tables + stat tiles only in this prompt).
