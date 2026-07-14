# PROMPT-55 — Dispute loss recovery: reverse the transfer, tell the club

**Read first:** `apps/web/src/server/usecases/registrations.ts` —
`handleRegistrationDispute` (the created/won/lost branches; lost currently only
writes `refunded_cents = amount_cents` + audits `registration.dispute_lost`),
`stripeRefund` just above the withdraw core (the existing
`reverse_transfer: true, refund_application_fee: true` precedent — refunds
already claw the transfer back; disputes are the one path that doesn't),
`apps/web/src/server/usecases/billing-events.ts` (webhook dispatch — note
`charge.dispute.created/closed` cases and that **/admin/billing-events can
REPLAY events**, so every handler must be idempotent),
`apps/web/src/lib/email-templates/dispute-alert.ts` (the "opened" alert this
prompt adds a sibling to), `content/help/registration/card-payments.md` §5,
`design/v9/README.md` (scope + non-goals).
**Depends:** PR #89 merged. **No migrations.**

## Context

Entry fees are **destination charges**: platform account is merchant of
record, `transfer_data` moves the net to the club's Express account, platform
takes `application_fee_amount`. On `charge.dispute.created` Stripe debits the
**platform** balance (amount + dispute fee, held). On a **lost** close the
debit becomes final; on **won** it's returned (fee included, per Stripe's
current policy).

What the code does today on lost: marks the registration
`refunded_cents = amount_cents, refunded_at`, audits
`registration.dispute_lost`, chip shows "dispute lost · refunded". What it
does NOT do: recover anything — the club's payout stands, the platform ate
amount + fee.

Decision (2026-07-14): recover the **amount** from the club via transfer
reversal; platform absorbs the **fee**. Rationale: platform owns the dispute
response (Express accounts have no dispute surface), clubs own the economic
risk of their own registrants — matches the refund path's economics
(`reverse_transfer` there returns the platform's application fee too).

Key Stripe mechanics to respect:

- The dispute object carries `charge` (id or expanded). The transfer to
  reverse hangs off the charge: `charge.transfer`. Retrieve the charge with
  `expand: ["transfer"]` if needed.
- Reverse with `stripe.transfers.createReversal(transferId, { amount })`.
  `amount` = the disputed amount **minus the platform's application fee share
  already returned**: for a full-amount dispute the platform got its
  application fee back? NO — on disputes Stripe debits the platform the FULL
  charge amount; the application fee is NOT auto-refunded (unlike
  `refund_application_fee` on refunds). So reverse the full transfer amount
  (the net the club received), and the platform's loss shrinks to
  `dispute fee + (its own application fee, already earned and kept)`. State
  the final arithmetic in a comment with a worked example
  (fee 2000, app fee 100 → transfer 1900; dispute lost: platform debited
  2000 + 1500 fee; reversal recovers 1900; net platform cost = 1600 − 100).
  Verify the app-fee behaviour against the live API in test mode before
  hardcoding assumptions — Stripe has changed dispute/app-fee interactions
  across API versions; encode whatever the test shows, with the test output
  quoted in the PR description.
- **Partial disputes exist** (`dispute.amount` can be < charge amount, and
  currency is the charge currency): reverse
  `min(dispute.amount_net_share, remaining unreversed transfer)`.
- Reversals can push the club's Express balance **negative**; Stripe then
  recovers from the club's future payouts / bank debit per Connect settings.
  That is the intended liability chain (platform `losses_collector` with
  dispute-time reversals) — say so in the code comment.

## Task

1. **Reversal in the lost branch** (`handleRegistrationDispute`, same tx
   boundaries as today — Stripe call OUTSIDE any sql tx, mirroring
   `stripeRefund` usage):
   - Resolve the charge → `transfer` id. No transfer (e.g. charge predates
     Connect wiring, or already fully reversed) → skip with an audit note.
   - `transfers.createReversal(transferId, { amount, ... })` with an
     **idempotency key derived from the dispute id**
     (`{ idempotencyKey: `dispute-reversal-${dispute.id}` }`) so webhook
     retries AND /admin/billing-events replays cannot double-reverse. Belt +
     braces: before calling, list existing reversals on the transfer and skip
     if one already carries this dispute id in `metadata.dispute_id` (set it
     on create).
   - Audit `registration.dispute_recovered` with
     `{ registration_id, dispute_id, transfer_id, reversed_cents }`; on
     failure audit `registration.dispute_recovery_failed` with the error
     message and DO NOT throw — the write-off (`refunded_cents`) must land
     regardless, exactly like refund failure never undoes a withdrawal.
2. **"Dispute lost" organiser email** — new template
   `email-templates/dispute-lost.ts` on the existing chrome (mirror
   dispute-alert's args + eyebrow conventions): amount lost, reference,
   competition, and the plain sentence that the amount was recovered from
   their Stripe balance while the platform covered Stripe's dispute fee; CTA
   to the registrations console. Send to the **current owner via org_members**
   (NOT `organizations.created_by` — PR #89 fixed the created-by trap in the
   opened-alert; don't reintroduce it). Register in `email.ts` +
   `email-templates/index.ts`, extend `email-builders.test.ts` (chrome pins:
   `bgcolor="#150b36"`, `#a3e635`, `&#9679;`) and the render-preview
   inventory if the gallery harness is regenerated.
3. **Console visibility**: the lost chip already reads
   "dispute lost · refunded". Add the recovered state to the row title
   (`title=` tooltip: "amount recovered from your Stripe balance") driven off
   the audit trail? NO — keep it stateless: the tooltip text is static copy
   on the "dispute lost · refunded" chip; deep history lives in
   /admin/billing-events and the audit log. One-line change in
   `registration-list.tsx`.
4. **ToS clause**: add a "Entry-fee chargebacks" clause to
   `apps/web/src/app/legal/terms/*` (wherever the terms body lives) stating
   organisations bear the cost of chargebacks on their entry fees and that
   lost-dispute amounts are recovered from their connected Stripe balance,
   platform covers Stripe's dispute fees. Mark the PR description for the
   owner to review the wording before merge — this is a legal surface, the
   prompt supplies a draft, not counsel.
5. **Docs**: `content/help/registration/card-payments.md` §5 — replace "If
   the dispute is lost, the payment returns to the cardholder." with the
   full outcome (cardholder repaid by Stripe; amount recovered from the
   club's Stripe balance; platform pays the dispute fee; balance can go
   negative and Stripe recovers per its schedule). Add a short "Simulating
   disputes" note to `docs/` or the help doc: test card `4000 0000 0000 0259`
   (auto-dispute), `4000 0000 0000 2685` (unwinnable), CLI
   `stripe listen --forward-to localhost:3000/api/webhooks/stripe`, close
   with `winning_evidence` / `losing_evidence`.
6. **Tests** (DB-backed, pattern of `dispute-evidence.test.ts` /
   `registrations.test.ts` — they stub `getStripe()` already; follow the
   existing stub seam):
   - lost dispute with a transfer → `createReversal` called once with the
     idempotency key + metadata; audit `dispute_recovered` written;
     `refunded_cents` written even when the reversal throws
     (`dispute_recovery_failed` audited instead).
   - replayed lost event (call handler twice) → exactly one reversal
     (metadata/list guard short-circuits without a second Stripe call).
   - partial dispute (`dispute.amount` 500 of 2000) → reversal amount is the
     transfer's proportional share, never more than the unreversed remainder.
   - won dispute → no reversal, flag cleared (existing behaviour pinned).
   - dispute-lost email: current owner after a transfer-owner flip receives
     it (regression for the created_by trap).

## Acceptance

- Full simulation in test mode (documented run in the PR): pay with
  `4000 0000 0000 0259` → alert email + flag; close with `losing_evidence` →
  chip "dispute lost · refunded", reversal visible on the transfer in the
  platform Dashboard, club balance debited, dispute-lost email received,
  audit shows `dispute_lost` + `dispute_recovered`.
- Replaying the closed event from /admin/billing-events changes nothing
  (idempotent), and the audit shows no duplicate `dispute_recovered`.
- `npm run typecheck`, unit suites (incl. new email + reversal tests), smoke
  green; help-content registry test green if help slugs changed.
- ToS diff explicitly called out in the PR for owner review.

## Gotchas from the 2026-07-14 audit (do not relearn)

- `organizations.created_by` ≠ current owner after transfer-owner — resolve
  owners via `org_members.role = 'owner'`.
- /admin/billing-events replays events at will; every webhook side effect
  needs an idempotency story (Stripe idempotency keys expire ~24h — that's
  why the metadata/list check is required, not optional).
- `handleRegistrationDispute` looks the registration up by
  `payment_intent_id` — disputes on non-entry-fee charges fall through
  silently by design; keep it that way.
- Keep Stripe calls outside sql transactions (established rule in the
  withdraw/refund core).
- The registrations vitest suite runs against a real Postgres
  (`DATABASE_URL` on :54329, fresh `createdb` per run — ref codes are
  globally unique, use random refs in seeds).
