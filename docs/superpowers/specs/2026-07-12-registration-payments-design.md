# Registration v3 — dual payments (offline + Stripe Connect) + modernized pages

Date: 2026-07-12 · Branch: `feat/registration-payments` (off origin/main) · Status: approved

## Goal

Upgrade the registration system so an organiser chooses, per division, how entry
fees are collected — **offline** (cash/bank; organiser tracks and confirms) or
**Stripe Connect** (card; auto-confirm on payment) — and modernize every
registration surface (public register page, status page, organiser console
panel, settings editor, org payments card). The platform's cut of card fees
becomes admin-configurable (global default + per-org override).

Decisions locked with the user:
- Payment method: **per-division setting with an org-level default**; payment
  instructions live on the org with a per-division override.
- Post-payment: **auto-confirm**. Capacity is claimed at submit; overflow
  waitlists *before* money. Payment success = confirmed entrant instantly.
  Waitlisted registrants never pay while waiting.
- Abandoned card checkouts: **48h pay window** — reminder at T-24h, expire +
  promote at deadline, via an hourly cron sweep.
- Platform fee: **global default in admin settings + per-org override**,
  replacing the env-var-only default.

## What already exists (PROMPT-20a/34, kept)

- `registration_settings` (window, capacity, fee_cents, currency,
  refund_lock_at, bounded form builder) and `registrations` (status machine,
  ref codes SZ-XXXX-XXXX, access tokens, roster).
- Stripe Connect Express onboarding (`usecases/stripe-connect.ts`),
  `organizations.stripe_charges_enabled`, account.updated sync.
- Destination charges with `application_fee_amount`; fee % via
  `registration.fee_percent` entitlement (pro 2, event_pass 5) → env fallback.
- Withdraw core: auto-refund before `refund_lock_at`
  (`reverse_transfer` + `refund_application_fee`), manual/partial refund after,
  oldest-first waitlist promotion, `competition_events` audit ledger.
- Webhook + reconcile-on-return idempotency (`billing_events`).
- Offline `organizations.payment_instructions`, confirmation/reminder emails.
- Admin panel with `org_entitlement_overrides` UI.

Submit currently hardcodes the offline path (`checkout_url` always null);
checkout is only reachable via the status-page resume path.

## 1. Data model (migration V273)

```sql
-- registration_settings
payment_method       text NOT NULL DEFAULT 'offline' CHECK (payment_method IN ('offline','stripe'))
payment_instructions text                -- NULL → fall back to org text

-- organizations
default_payment_method text NOT NULL DEFAULT 'offline'  -- settings-UI preselect only

-- registrations
payment_method          text CHECK (payment_method IN ('offline','stripe'))  -- snapshot at submit
expires_at              timestamptz     -- stripe pendings: pay deadline
reminded_at             timestamptz     -- T-24h reminder sent
offline_marked_paid_at  timestamptz
offline_marked_paid_by  uuid REFERENCES users(id)
disputed_at             timestamptz
dispute_id              text
-- status CHECK gains 'expired' (new terminal state)

-- new table
platform_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
)
-- seed: ('platform_fee_percent', '5')
```

Also in V273: align `registration_settings.currency` column default to `'gbp'`
(schema said `'usd'`, code default said `'gbp'`).

**Fee resolution chain** (new `feePercentFor`): org override
(`org_entitlement_overrides.registration.fee_percent`) → plan entitlement
(pro 2, event_pass 5) → `platform_settings.platform_fee_percent` → env
`PLATFORM_FEE_PERCENT` → 5. Cached 300s alongside entitlements; invalidated on
admin write.

## 2. Status machine

States: `pending`, `waitlisted`, `paid` (transient), `confirmed`, `withdrawn`,
**`expired`** (new). Spot-holders unchanged: pending/paid/confirmed.

```
submit ─► pending (holds spot; stripe → expires_at = now()+48h)
   └─ over capacity ─► waitlisted (no payment, no expiry)
pending ─ pay (webhook/reconcile) ─► paid ─► confirmed        (same tx, auto)
pending ─ organiser "mark paid" (offline) ─► paid ─► confirmed (same tx)
pending ─ organiser confirm (free division or explicit waive) ─► confirmed
pending ─ sweep past expires_at ─► expired ─► promote oldest waitlisted
pending|confirmed ─ withdraw (registrant or organiser) ─► withdrawn ─► promote
withdrawn|expired + late payment arrives ─► auto-refund, state unchanged
waitlisted ─ spot frees ─► pending (amount_cents snapshotted from settings at
                            promotion — waitlisted rows hold 0 until then;
                            stripe: fresh 48h window + pay email)
pending ─ organiser waitlist action ─► waitlisted (exists, kept)
```

Payment never gates approval; approval never gates payment. Offline pendings
have no auto-expiry (cash on the day is legitimate).

## 3. Flows

### Offline
Submit → pending → confirmation email with resolved instructions
(`settings.payment_instructions ?? org.payment_instructions`). Console:
- **Mark paid** — one click: sets `offline_marked_paid_at/by`, status → paid →
  materialise → confirmed. Audited `registration.offline_paid`.
- **Confirm without payment** — waives the fee (overflow menu), audited
  `registration.fee_waived`.
- Payment reminder email (exists, kept).

### Stripe
Submit → pending with `expires_at` → **checkout session created at submit**
(destination charge on org's Express account, `application_fee_amount` from the
fee chain) → `checkout_url` returned, client redirects. Webhook
`checkout.session.completed` or reconcile-on-return → paid → confirmed, clear
`expires_at`.

- Resume from status page mints a fresh session (Stripe sessions die in 24h;
  our window is 48h). Every session charges the **snapshotted
  `reg.amount_cents`**, never live `settings.fee_cents`.
- Settings save validates: `payment_method='stripe'` requires
  `charges_enabled` + `registration.paid` entitlement, and fee 0 or ≥ 100 minor
  units (Stripe min-charge floor).
- Submit re-validates `charges_enabled`; if Connect broke since setup, submit
  returns a clear 503, the register page shows "card payments temporarily
  unavailable", and the console shows a warning banner.

## 4. Issue matrix (B2B payment edge cases → mitigations)

| # | Issue | Mitigation |
|---|-------|------------|
| 1 | Payment completes after withdraw/expire | Webhook handler auto-refunds (reverse transfer + return app fee); state stays terminal; audit `mode: late_payment` |
| 2 | Double payment (two checkout tabs) | Second completed session for an already-paid reg → refund the duplicate intent, audit `mode: duplicate` |
| 3 | Abandoned checkout blocks a spot | 48h expiry + hourly sweep; counts stay strict between sweeps (no queue jumping) |
| 4 | Promoted registrant never pays | Promotion grants fresh 48h window → re-expires → next in line |
| 5 | Disputes: destination charges = platform liable | `charge.dispute.created/closed` webhooks → `disputed_at/dispute_id` flag, organiser email, console badge. No auto state change in v1 |
| 6 | Refund fails (connected balance empty) | Existing audit + console badge + retry button (manual refund endpoint) |
| 7 | Organiser can't confirm an offline payer (existing bug) | Mark-paid action; confirm keeps blocking only when neither paid nor waived |
| 8 | Fee edited mid-flight | Charges use snapshot `amount_cents`; fee % resolves per checkout attempt |
| 9 | Connect disabled with live stripe divisions | Submit blocked with clear message + console banner + settings validation |
| 10 | Division/competition delete cascades away payment records | Block delete while any registration has `payment_intent_id` (refund first); archive unaffected |
| 11 | Webhook replay / out-of-order | `billing_events` idempotency + status short-circuits (kept) |
| 12 | Missed webhook (local dev) | Reconcile-on-return (kept) |
| 13 | Stripe min-charge rejection | Settings validation fee = 0 or ≥ 100 minor units |
| 14 | Currency vs Connect-account country mismatch | Stripe checkout error surfaced verbatim on status page; documented |
| 15 | Capacity above plan quota | Existing `min(capacity, plan limit)` hard cap kept |
| 16 | Two submits race for last spot | Existing settings-row lock kept |
| 17 | Refund after entrant already played | Organiser-discretion manual refund; entrant → withdrawn rules already handle fixtures/standings |
| 18 | Partial-refund overdraw | Existing remaining-cents math kept; exposed in UI |
| 19 | Schema/code currency default mismatch (usd vs gbp) | Align to gbp in V273 |
| 20 | Platform keeping its cut on refunds | `refund_application_fee: true` always — never keep the fee on refunded entries |

## 5. Admin panel

- **New `/admin/settings`**: platform fee default % (validated 0–100, writes
  `platform_settings.platform_fee_percent`, invalidates cache), with the
  resolution chain displayed.
- **Admin org page**: labeled "Entry-fee cut %" field writing the
  `registration.fee_percent` org override (rides existing AdminPlanPanel
  override machinery).

## 6. Cron sweep

`POST /api/cron/registrations`, guarded by `x-cron-secret` (CRON_SECRET), same
shape as `/api/funnel/remind`:
1. **Reminders**: stripe pendings with `expires_at` within 24h and
   `reminded_at IS NULL` → payment-reminder email with pay link + deadline; set
   `reminded_at`.
2. **Expiry**: stripe pendings past `expires_at` → status `expired`, promote
   oldest waitlisted (fresh window + email), audit. Row-locked per registration
   (`FOR UPDATE`) so a racing webhook serializes: webhook first → paid wins;
   sweep first → late payment auto-refunds (issue #1).

Deploy checklist: wire hourly via Vercel Cron (or any scheduler).

## 7. Emails (compose.ts / courtside templates)

New: **promoted-pay-now** (deadline + link), **refund-issued** (amount,
reference), **organiser-dispute-alert**. Extended: registration confirmation
gains a stripe variant (pay link + 48h deadline); payment reminder gains a pay
link for stripe pendings. Smoke demo (`scripts/smoke.ts`) extended per the
standing rule.

## 8. UI modernization

Visual pass runs under the frontend-design skill at implementation; scope:

- **Public register page** (`/shared/[org]/[comp]/register`): courtside
  `--ps-*` public theme, ticket-stub visual language (matches the existing
  `/r/[ref]` tear-off ticket), division cards with capacity meter, fee chip,
  method badge (card / pay the organiser), single-column form.
- **Status page**: ticket-first — big ref code, submitted → payment → confirmed
  timeline, pay CTA with deadline countdown, offline instructions block,
  withdraw.
- **Console registrations panel** (stadium-night `.app-*` system): payment
  column (method icon + paid/due/refunded/disputed badges), actions — mark
  paid, confirm, waitlist, withdraw, refund (partial), retry refund, remind,
  export; warning banners for refund-failed / disputed / Connect-broken.
- **Registration settings editor**: method picker (org default preselected),
  instructions override, fee + currency, window, capacity, refund lock, expiry
  copy preview; validations from §3.
- **Org settings payments card**: Connect status + onboarding CTA + default
  method + org instructions (restyle of existing pieces).

## 9. Testing

- **Unit**: fee chain resolution, expiry candidate selection, transition
  guards (mark-paid, waive, expire), snapshot amount, settings validations.
- **DB-backed vitest** (ephemeral :54329 recipe): submit offline/stripe,
  mark-paid → confirmed, expire + promote, late-payment refund, duplicate
  payment refund (Stripe client mocked).
- **e2e Playwright**: offline journey (register → instructions → mark paid →
  confirmed ticket); stripe journey against test-mode hosted checkout (4242)
  where CI allows.
- Every change ships with a test that fails without it (standing rule);
  `scripts/smoke.ts` extended for both payment paths.

## 10. Non-goals (v1)

Payment ledger table (revisit if reconciliation pain), per-registrant
currency, entry-fee coupons/discounts, installments, dispute evidence
automation.
