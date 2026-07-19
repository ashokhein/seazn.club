---
title: How card entry fees flow
description: From connecting Stripe to money in your bank — holds, reminders, refunds and disputes, end to end.
order: 2
---

Card entry fees run on **Stripe Connect**: registrants pay at sign-up, the money settles into *your* Stripe account, and Seazn Club never holds your funds. Once your account is live, your public pages carry a **"Payments secured by Stripe"** line in the footer, so registrants see it too. Here's the whole journey.

## 1. Connect and verify (one-time)

Under **Settings → Connect**, agree to the Terms of Service — connecting means your organisation bears the cost of chargebacks on its entry fees (see [§5 below](#5-disputes-chargebacks)) — then press **Connect Stripe**. You're sent to Stripe's secure onboarding — Seazn Club never sees your details. Stripe verifies who receives the money (**KYC**): legal name, date of birth and bank account; clubs and companies may be asked for registration documents. Usually minutes; occasionally Stripe asks for more and it takes a day or two. You can leave and resume anytime.

When Stripe finishes, your Payments page shows **Live — charges enabled** and divisions can choose **Card at sign-up**. Until then, saving a card division is blocked — and if verification ever lapses later, card divisions close to new entries automatically rather than take money that can't be collected.

**If Stripe asks for more information later** — even while you're live — an amber notice appears on the Payments page with a **Finish Stripe verification** button that takes you straight to whatever Stripe still needs. And once connected, **Open Stripe dashboard** on the same page signs you into your Stripe Express dashboard for payouts, charge history and bank details — no separate Stripe login to remember.

## 2. A registrant pays

Sign-up opens Stripe checkout. On payment the entry is **confirmed automatically** and the confirmation email goes out. If they close checkout without paying, their spot is **held for 48 hours** — a reminder with a fresh payment link lands at 24 hours, and if the window passes the entry expires and the first person on the [waitlist](/help/registration/waitlist) is promoted into it.

## 3. Money lands

Each payment settles to your connected Stripe account, minus Stripe's processing fee and the platform fee for your plan. Stripe pays out to your bank on its own schedule (typically every few days) — payout timing and bank details live in your Stripe dashboard, not on Seazn Club.

## 4. Refunds

Withdrawals refund automatically **in full** when they land before the division's **refund lock date**: the money returns to the card, the platform fee is returned too, and the registrant gets a receipt email. After the lock date nothing refunds by itself — it's your call, via the manual refund on the entry.

**No refund lock date set?** Then there is no cut-off: every paid withdrawal auto-refunds in full, right up to match day. If you don't want to refund late drop-outs, set the lock date in the division's registration settings.

Refunds you make directly in the Stripe dashboard sync back — the entry shows as refunded on your console either way.

## 5. Disputes (chargebacks)

If a cardholder disputes a payment, the registration is **flagged on your console** the moment Stripe tells us, and you get an alert email. Press **Evidence pack** on the flagged entry — it downloads one document with everything that proves the entry was genuine: the registration record, a reconstruction of the confirmation email, the full activity log and the entrant's fixtures, mapped to Stripe's evidence fields. Seazn Club submits the response to Stripe. When the dispute closes, the flag updates automatically.

**If the dispute is won**, the flag clears and nothing changes — the money stays yours.

**If the dispute is lost**, Stripe repays the cardholder and the entry shows **dispute lost · refunded**. The disputed amount is then **recovered from your Stripe balance** — if the balance can't cover it, Stripe takes the difference from your upcoming payouts or your linked bank account on its own schedule. Seazn Club covers Stripe's dispute fee, and you get an email stating exactly what moved. Whether the entrant stays in the competition is your call — the entry is flagged, not withdrawn.

### Sponsorship chargebacks work the same way

A card sponsorship payment runs on the same Connect rail, so a disputed sponsorship charge follows the same path. The moment Stripe tells us, the sponsor's order is flagged **Disputed** in your monetization console, its **placement comes down** — boards and public pages stop showing it, the sponsor list marks it **Disputed — parked** — and you get an alert. You can't switch a parked placement back to active yourself: win the dispute and it goes back up automatically — the badge clears and you get a confirmation email, nothing else changes. Lose it and the order shows **Dispute lost**, the placement stays down (marked the same way in your sponsor list), and the amount is **recovered from your Stripe balance**. Seazn Club absorbs Stripe's dispute fee here too, and you're emailed what moved either way.

Just like a disputed entry, a disputed order carries an **Evidence pack** button — one document with the order record, a reconstruction of the sponsor's receipt email, proof the placement was delivered (live period, public page, logo clicks) and the activity log, mapped to Stripe's evidence fields and ready to paste into the dispute response.

While an order is disputed you can't refund it — the card networks freeze a charged-back payment, so the money moves with the dispute's outcome instead. The Refund button reappears only if the dispute is won. Payment records themselves are permanent: paid, refunded or disputed sponsorship orders survive even if the package or organisation that produced them is later removed.

### Event Pass chargebacks are different

An **Event Pass** is paid to Seazn Club, not into your Connect account — there is no transfer to reverse. A refunded or lost-dispute pass instead **revokes the pass**, and the competition drops back to your plan's normal limits (nothing you've built is deleted). See [the Event Pass](/help/billing/event-pass).

The same holds for a chargeback on a **Pro or Pro Plus subscription** payment: it's a platform charge, so there's nothing to reclaim from your Connect account. The subscription is flagged, and if the dispute is lost your org drops to **Community** limits — nothing is deleted, exactly like a [downgrade](/help/billing/downgrade). Subscribing again clears the flag and restores Pro.

## Common questions

**Where do I change my bank account or see payouts?** In your Stripe dashboard — the **Open Stripe dashboard** button on your Payments page signs you in. Seazn Club shows the entry-fee side; Stripe owns the banking side.

**Prefer cash or bank transfer?** Pick **Pay the organiser** instead — see [opening registration](/help/registration/open-registration) for how offline instructions and `{{reference}}` work.
