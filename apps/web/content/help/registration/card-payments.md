---
title: How card entry fees flow
description: From connecting Stripe to money in your bank — holds, reminders, refunds and disputes, end to end.
order: 2
---

Card entry fees run on **Stripe Connect**: registrants pay at sign-up, the money settles into *your* Stripe account, and Seazn Club never holds your funds. Here's the whole journey.

## 1. Connect and verify (one-time)

Under **Settings → Payments**, press **Connect Stripe**. You're sent to Stripe's secure onboarding — Seazn Club never sees your details. Stripe verifies who receives the money (**KYC**): legal name, date of birth and bank account; clubs and companies may be asked for registration documents. Usually minutes; occasionally Stripe asks for more and it takes a day or two. You can leave and resume anytime.

When Stripe finishes, your Payments page shows **Live — charges enabled** and divisions can choose **Card at sign-up**. Until then, saving a card division is blocked — and if verification ever lapses later, card divisions close to new entries automatically rather than take money that can't be collected.

## 2. A registrant pays

Sign-up opens Stripe checkout. On payment the entry is **confirmed automatically** and the confirmation email goes out. If they close checkout without paying, their spot is **held for 48 hours** — a reminder with a fresh payment link lands at 24 hours, and if the window passes the entry expires and the first person on the [waitlist](/help/registration/waitlist) is promoted into it.

## 3. Money lands

Each payment settles to your connected Stripe account, minus Stripe's processing fee and the platform fee for your plan. Stripe pays out to your bank on its own schedule (typically every few days) — payout timing and bank details live in your Stripe dashboard, not on Seazn Club.

## 4. Refunds

Withdrawals refund automatically **in full** when they land before the division's **refund lock date**: the money returns to the card, the platform fee is returned too, and the registrant gets a receipt email. After the lock date nothing refunds by itself — it's your call, via the manual refund on the entry.

**No refund lock date set?** Then there is no cut-off: every paid withdrawal auto-refunds in full, right up to match day. If you don't want to refund late drop-outs, set the lock date in the division's registration settings.

Refunds you make directly in the Stripe dashboard sync back — the entry shows as refunded on your console either way.

## 5. Disputes (chargebacks)

If a cardholder disputes a payment, the registration is **flagged on your console** the moment Stripe tells us, and you get an alert email. Press **Evidence pack** on the flagged entry — it downloads one document with everything that proves the entry was genuine: the registration record, a reconstruction of the confirmation email, the full activity log and the entrant's fixtures, mapped to Stripe's evidence fields. Respond to the dispute in your Stripe dashboard using it. If the dispute is lost, the payment returns to the cardholder. When it closes, the flag updates automatically.

## Common questions

**Where do I change my bank account or see payouts?** In your Stripe dashboard — Seazn Club shows the entry-fee side; Stripe owns the banking side.

**Prefer cash or bank transfer?** Pick **Pay the organiser** instead — see [opening registration](/help/registration/open-registration) for how offline instructions and `{{reference}}` work.
