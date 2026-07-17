# HANDOFF

## Status
DONE — v10 sponsor CRM (PROMPT-56) MERGED: PR #112, squash 6f38f65 on main (2026-07-17). This worktree's branch is fully merged; safe to remove.

## Current task
None. Follow-ups live below.

## Done
Everything: V283 model, tiered manager (own settings tab, single form w/ logo upload), perimeter-board public placement (Pro-only; free = quiet chips), tracked /s clicks (new tab), monetization (packages/invoices/orders console, Connect checkout, webhook activation, console refund + confirms, invoice/receipt/refund emails), help, smoke, i18n 1707×4 ui + 203×4 emails. Live Stripe test sim passed (£250 paid → activated → refund rail).

## In progress
(none)

## Next steps
1. Deploy: stg/prod `npm run db:apply` (V283), then add `payment_intent.succeeded` + `payment_intent.payment_failed` to the Stripe webhook endpoint subscriptions.
2. Merge v11 (#111) — V284 numbering now clean against main.
3. Optional revert of dev-DB demo flips: demo1 user is_staff/superadmin, Riverside org pro (localhost:5432/seazn).

## Key decisions
- 2026-07-16: free = public flat chip strip; board/tiers/monetize = Pro (sponsors.tiers/sponsors.monetize).
- 2026-07-16: checkout mirrors registrations (order-first, destination charge, fee helper, idem keys); webhook guards = order-status AND sponsor_id.
- 2026-07-17: refunds reuse charge.refunded flip (console + dashboard one path), entry-fee refund shape.

## Gotchas
- v1() AND handler() wrap responses in {ok,data} — client fetches must unwrap.
- vitest from apps/web cwd only; fresh test DB per run (shared DB poisons sport_variants).
- File pickers: ref'd hidden input + button, never label-wrap.

## Verify
cd apps/web && npx tsc --noEmit && DATABASE_URL=<testdb> npx vitest run src/server/usecases/__tests__/sponsor-checkout.test.ts
