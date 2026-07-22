# Billing-group transfer: make the offer reach the recipient

**Reported:** staging — b002 offered the Test002 group to b003; b003 saw nothing, no email.
**Branch:** `feat/transfer-offer-notify` (off main, which has #212+#223 merged)
**Date:** 2026-07-22

## Confirmed root cause (staging data + code)

The offer is valid: `billing_group_transfers` row `status=pending, from=b002, to=b003`, not expired. b003 cannot see or accept it for two independent reasons:

1. **No accept surface for a non-payer recipient.** The incoming-offer accept UI lives inside `BillingGroupPanel`, which the billing page renders only when `isPayer` (`app/o/[orgSlug]/settings/billing/page.tsx:362`). b003 is a non-payer member of Test002 (b002 is the group's payer), so the panel never renders. The panel's own comment claims the offer is "shown wherever this panel renders so an incoming offer is never missed" — but it only renders for payers, so a recipient who isn't already a payer somewhere misses it entirely.
2. **No notification.** `offerGroupTransfer` sends no email; there is no transfer-offer email template. Help copy admits it ("no inbox for pending offers yet").

## Fix (v1)

### A. Surface incoming offers to the recipient regardless of `isPayer`
- New client component `IncomingTransferOffers` (`apps/web/src/components/incoming-transfer-offers.tsx`): fetches `GET /api/billing/group/transfer` (already returns offers involving the caller, `client_secret` populated for offers TO them), and renders the "a bill is being handed to you → Accept" block, reusing `TransferOfferAccept` — the exact markup currently inside `BillingGroupPanel`.
- Render it on the billing page **unconditionally** (not gated on `isPayer`), near the top of the billing section, so both non-payers (b003) and payers see it.
- **Remove** the incoming-offer block from `BillingGroupPanel` so payers don't see it twice. `BillingGroupPanel` keeps outgoing offers / transfer-to-someone-else.

### B. Email the recipient on offer
- `sendTransferOfferEmail(to, payerName, orgName, link, locale)` in `apps/web/src/lib/email.ts` + a template in the `emails` dictionary (mirror `sendInviteEmail`/`inviteTemplate`).
- Call it best-effort from `offerGroupTransfer` after the offer row is committed (never throw — the offer must succeed even if email fails), for BOTH the live-sub (2-step) and community (single-step) paths.
- `link` = the recipient's billing settings for an org they can reach in the group (use `primaryOrgForGroup(subscriptionId)` → its slug → `${BASE}/o/{slug}/settings/billing`), base from `OAUTH_BASE_URL || NEXT_PUBLIC_BASE_URL`. `transferRecipient` already returns `email` + `display_name`.

### C. Cost summary before the card step (recipient sees what they're taking on)
Today `listGroupTransferOffers` returns only `setup_intent_id`/`client_secret`/`expires_at` — the recipient enters a card with no idea what they're committing to. Add an **offer-scoped billing summary**, gated to the offer's recipient (they are NOT the payer, so payer-gated overviews don't apply):
- New `GET /api/billing/group/transfer/summary?subscription_id=` (or fold into the offers payload): returns `{ plan_key, interval, org_count, currency, charge_now_minor: 0, renewal_amount_minor, renewal_date }`. Gate: caller has a `pending` offer `to_user_id = caller` for that subscription.
- `renewal_amount_minor`: for a live-sub group, the next-invoice total (Stripe upcoming invoice, or computed base + (qty−1)·half from plan pricing); a community/no-live group has nothing to bill → summary says "no ongoing charge".
- `IncomingTransferOffers` renders the summary ABOVE the Accept button: "Taking over {payer}'s bill — {N} organisation(s) on {Plan} ({interval}). **No charge today.** Your card is billed {renewal_amount} on {renewal_date}, then each {interval}." A community group shows "No ongoing charge — this group has no paid subscription."
- **Accept charges nothing now** (confirmed: `handOverGroup` only sets the incoming card as default; the current period is already paid) — the summary must state that plainly so the recipient isn't surprised into expecting an immediate charge.
- Test: the summary endpoint refuses a non-recipient (403/404) and returns the right shape for the recipient; component shows the amount + "no charge today".

## Out of scope (follow-up)
- Dashboard-wide banner / notification-centre entry.
- Emails on withdraw / accept / expiry.

## Tests
- Component: `IncomingTransferOffers` renders an accept button when the fetch returns an incoming offer; renders nothing when none (mirror the repo's decision/SSR test convention — no jsdom).
- Unit: `offerGroupTransfer` calls `sendTransferOfferEmail` with the recipient's email on both paths (mock email; assert best-effort — an email throw does not fail the offer). DB-backed, mirrors `billing-group-move`/`billing-group-accept-transfer` seeding.
- Email: `sendTransferOfferEmail` returns true and posts to Resend with the recipient + link (mirror existing email tests if present).
- Every change ships a failing-without-it test.

## Verify
`cd apps/web && npx tsc --noEmit && npx vitest run` (email + offer + component). e2e optional (the accept flow needs Stripe SetupIntent — keep to unit/component).
