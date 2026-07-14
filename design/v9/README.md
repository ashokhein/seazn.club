# v9 — Dispute Loss Recovery

> **Status (2026-07-14):** not started. PROMPT-55 ⏳.
> Branch (planned): `feat/v9-dispute-loss-recovery` (worktree).
> Migrations: none expected (all state already exists: `disputed_at`,
> `dispute_id`, `refunded_cents`; Stripe holds the reversal state).
> **Prereq:** PR #89 merged — it ships the dispute UX this builds on
> (evidence pack, Disputed tab, lost-dispute chip, current-owner alerts).

## Theme

One gap left from the 2026-07-14 payment-flow audit, deliberately parked as a
product decision because it moves money *away from clubs*:

**When a card entry-fee dispute is LOST, the platform eats the disputed amount
plus Stripe's dispute fee, and the club keeps its payout.** Entry fees are
destination charges — the platform is the merchant of record, so Stripe debits
the *platform* balance on a loss. `handleRegistrationDispute`'s lost branch
(`apps/web/src/server/usecases/registrations.ts`) writes the money off on the
registration (`refunded_cents = amount_cents`) and audits it, but never calls
`transfers.createReversal` — so the transfer to the connected account stands.

Product decision taken (2026-07-14, owner): the platform keeps *responsibility*
for disputes (clubs can't fight chargebacks; responses happen in the platform
Dashboard), but recovers the *disputed amount* from the club's connected
balance on a loss. The platform continues to absorb Stripe's dispute fee —
that's the cost of owning the flow. Terms get a matching clause.

## Prompts

- `prompts/PROMPT-55-dispute-loss-recovery.md` — transfer reversal on
  `charge.dispute.closed(lost)`, idempotent under admin replay; organiser
  "dispute lost" email stating the balance debit; console/admin visibility;
  ToS clause draft; help + simulation docs; DB tests with a stubbed Stripe.

## Non-goals (explicit)

- Recovering **Stripe's dispute fee** from the club (Stripe doesn't move it
  with the reversal; billing it separately = invoicing machinery — out).
- Changing the charge pattern (direct charges would shift merchant-of-record
  to clubs; standing decision is destination charges on the platform).
- Auto-withdrawing the entry on a lost dispute (organiser's call — the entry
  stays whatever it is, flagged `dispute lost · refunded`).
