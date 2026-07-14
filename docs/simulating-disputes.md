# Simulating entry-fee disputes (test mode)

Dev/ops runbook for the chargeback flow (PROMPT-55). Everything here is
Stripe **test mode** — nothing moves real money.

## Test cards

| Card | Behaviour |
| --- | --- |
| `4000 0000 0000 0259` | Payment succeeds, then is disputed automatically (`charge.dispute.created` fires right after the charge). |
| `4000 0000 0000 2685` | Disputed like above, but the dispute is **unwinnable** — closing evidence always loses. |

Any future expiry + CVC. In API-driven tests, `pm_card_createDispute` is the
payment-method token equivalent of `0259`.

## Local webhook loop

```sh
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Copy the printed signing secret into `STRIPE_WEBHOOK_SECRET`. Register with a
card division, pay with `0259`, and the dispute lands: entry flagged
`⚠ disputed`, organiser alert email sent.

## Closing the dispute

Submit evidence whose text controls the outcome (test mode only):

```sh
stripe disputes update dp_... -d "evidence[uncategorized_text]=losing_evidence" -d submit=true
stripe disputes update dp_... -d "evidence[uncategorized_text]=winning_evidence" -d submit=true
```

The dispute passes through `under_review` and closes a few seconds later
(`charge.dispute.closed`). On **lost**: chip flips to
`dispute lost · refunded`, the club's transfer is reversed
(`registration.dispute_recovered` in the activity log, reversal visible on
the transfer in the platform Dashboard) and the dispute-lost email goes to
the current org owner. On **won**: flag clears, nothing moves.

## Verified mechanics (live test-mode run, 2026-07-14)

- Destination charges transfer the **full** charge amount; the application
  fee is collected from the connected account separately. The club's net is
  `transfer.amount − application_fee_amount`.
- A lost dispute debits the platform `dispute.amount` **plus** Stripe's
  dispute fee (£20.00 in test-mode GBP) and auto-reverses **nothing** — no
  transfer reversal, no application-fee refund. The reversal in
  `recoverDisputedTransfer` is what makes the club bear the loss.
- Replaying `charge.dispute.closed` from /admin/billing-events is safe: the
  reversal carries `metadata.dispute_id` and the handler skips when one
  already exists (Stripe idempotency keys alone expire after ~24h).

## Key permissions

`transfers.createReversal` needs **Transfers Write** on restricted keys. If
the environment's `STRIPE_SECRET_KEY` is an `rk_` key, enable it in the
Stripe dashboard (Developers → API keys → edit key), or the recovery path
audits `registration.dispute_recovery_failed` with a permission error while
the write-off still lands.
