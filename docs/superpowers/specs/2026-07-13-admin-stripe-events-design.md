# Admin Stripe Events — Design (2026-07-13)

**Request:** staff console list of pending Stripe events, with the ability to process them (user-picked scope: live diff + ledger + retry button).

## Problem

`billing_events` is a write-only idempotency ledger. Two failure classes are invisible today: events Stripe sent that the webhook never received (the deleted-endpoint incident class — `reconcileCheckout` exists because of one), and events received whose handler threw (row inserted, `processed_at` never stamped; Stripe's retry is refused by the idempotency fast-path, so they stay stuck forever).

## Design

**`/admin/billing-events`** ("Stripe" in the staff nav, staff-gated by the admin layout + `requireStaff()` on the page, view audited via `logStaffAction`).

- **Live diff:** `stripe.events.list({ limit: 50, types: HANDLED_EVENT_TYPES })` matched against the ledger. Status per event: `processed` (row + `processed_at`) / `received` (row, no stamp — handler died) / `missing` (no row — webhook never got it).
- **Stuck ledger section:** unprocessed rows older than the live window.
- **Keyless degrade:** no `STRIPE_SECRET_KEY` (or API failure) → ledger-only view + banner.
- **Process now** on non-processed rows → `POST /api/admin/billing-events/{id}/process`: re-fetches the event from Stripe by id (API is the trust anchor, replacing the webhook signature — the stored payload is never replayed), runs the shared dispatch, stamps `processed_at`, audited. `replayEvent` refuses already-processed events; all handlers are idempotent.

**Extraction:** the webhook route's dispatch switch and handlers move verbatim to `server/usecases/billing-events.ts` (`processStripeEvent`, `runEvent`, `HANDLED_EVENT_TYPES`); the route keeps signature verification and the already-recorded fast path. No behavior change, proven by the existing webhook suite.

## Non-goals

Automatic background sweeping (cron) of missed events; org-facing surfaces; replaying from stored payloads; pagination beyond the last 50 + stuck rows.

## Tests

Pure `eventStatus`; DB-backed ledger mechanics (runEvent stamps, replayEvent skips processed / heals stuck, exclusion-list dedupe); existing webhook FK suite stays green.
