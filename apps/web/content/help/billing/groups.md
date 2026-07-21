---
title: One subscription, several organisations
description: A billing group pays for more than one organisation on a single card and a single invoice — extra organisations are half price, and every one of them runs on the group's plan.
order: 4
---

A subscription isn't tied to one organisation. It's a **billing group**: one plan, one card, one invoice, covering as many organisations as the plan allows. A county association can fund eight clubs; a management company can fund the events it runs for other people. Nobody has to be a member of the organisations they pay for.

## What the group buys

Two things, and the second is usually the bigger one.

**A cheaper bill.** The first organisation pays the plan's normal rate. Every organisation after that is **half** — Pro is $19/month plus $9/month each, Pro Plus is $39/month plus $19/month each. Annually that's $159 plus $79, and $327 plus $163. Eight clubs on Pro Plus annually come to $1,468 for the group, against eight separate Pro subscriptions at $1,272 — and the group buys the 1% entry-fee rate for all eight.

**A cheaper entry-fee rate.** Every organisation in the group runs on the *group's* plan, so the platform fee on entry fees follows it:

| The group's plan | Platform fee on entries |
| --- | --- |
| Community | 8% |
| Pro | 2% |
| Pro Plus | 1% |

So adding a free club to a Pro Plus group takes that club from 8% to 1% the moment it joins. For those eight clubs, the seven points saved cover the $1,468 subscription at about **$21,000 of entries across the group** — roughly $2,600 per club per year. Above that, grouping wins; below it, staying free and paying 8% is genuinely cheaper. It's worth doing the arithmetic for your own volume rather than assuming either way.

**How many organisations fit:** Community holds 1, Pro holds 5, Pro Plus holds 10. Beyond ten, [talk to us](mailto:hello@seazn.club).

## Who pays, and who can't

A group has exactly **one payer** — one card, one invoice, one billing address, one VAT number. The payer manages the plan, the card and cancellation for the whole group.

An organisation inside a group **cannot pay for itself, or pay a share.** There is no way to split a single invoice between several people; that's a payments product, not a setting. An organisation that wants its own bill has to leave the group first — see below. That's also the answer for two clubs that are two separate registered charities: two legal entities need two VAT numbers and two invoices, so they need two groups.

Ownership of an organisation and payment for it are separate things. If an organisation changes owner, its billing stays with the group; the new owner sees who is paying for them, and can leave.

## Adding an organisation

Adding is done by someone who owns **both** the organisation being added and the group it's joining — admins run the competition, not the money.

- The bill goes up by half the plan rate straight away, prorated to the rest of the period.
- The organisation is on the group's plan **immediately** — limits, features and the entry-fee rate all change the same second.
- Added during the group's free trial, it rides the same trial to the same end date and costs nothing now.
- An organisation that already has its own live subscription can't be added yet. Cancel it, or wait for it to lapse.
- A group can't take on a new organisation while its own payment is overdue or while it's set to cancel at the end of the period. Settle the invoice, or resume the subscription, and then add.

If the extra charge fails, the organisation stays in the group — it doesn't get thrown back out. The group enters the normal 14-day [dunning](/help/billing/downgrade) window instead, and if it runs out, every organisation in the group drops to Community limits together.

## Leaving a group

Either side can end it. The payer can push an organisation out; the organisation's owner can pull it out. Nobody needs the payer's permission to leave, and no payer is stuck funding an organisation that won't cooperate.

**Leaving costs nothing.** No payment, no card, no settling up. The organisation keeps the plan it had — and the entry-fee rate that came with it — until the end of the period the group already paid for. After that it falls back to Community limits unless it takes out its own subscription. Nothing is deleted, exactly as in a [downgrade](/help/billing/downgrade).

Two details worth knowing:

- The organisation's owner becomes the owner of its new, standalone billing — there's no role to grant.
- A free trial doesn't reset on the way out. If the group has used its trial, the departing organisation has used it too.

## The slot stays paid until renewal

When an organisation leaves, we don't call Stripe to reduce the bill mid-period — you've already paid for that slot, so you keep it. The count is trued up at renewal, and until then the freed slot can be filled by another organisation **at no extra charge**. On an annual plan that can be worth eleven months.

Adding always charges immediately; removing never refunds. Nothing changes at all if you add an organisation back into a slot you're still paying for.

## Payouts never move

This is the part people worry about, so plainly: **Stripe Connect is per organisation and grouping never touches it.**

Each organisation keeps its own Stripe account, its own verification, its own bank details and its own payouts. Entry fees still settle into that club's account, not the payer's. Regrouping who pays for the software moves no money into or out of anybody's bank account — the only thing that changes is the percentage we take, and it changes in the club's favour. See [how card entry fees flow](/help/registration/card-payments).

## Common questions

**Do the group's organisations share limits?** No. Quotas — team members, clubs, active competitions, public dashboards — are per organisation. Three organisations on Pro get three organisations' worth of everything, and that headroom is what the extra half-price rate buys.

**Are team members shared?** No. Membership is per organisation; someone who works on two of them is invited to both. Paying for an organisation doesn't put you inside it, and being inside it doesn't let you see the group's card or invoices. See [inviting your team](/help/getting-started/invite-your-team).

**Can staff comp a single organisation?** Yes — a comp or a raised limit can be applied to one organisation without touching the group's plan or its bill.

**Does a promo code apply to organisations added later?** Yes. A discount applies to the whole group, including organisations that join afterwards, so duration-limited codes are usually the right choice.

**What currency does the group bill in?** One, fixed at the group's first checkout — organisations that join later are billed in it too, whatever their own entry fees are charged in.

**One organisation was suspended by our team. Do we stop paying for it?** No. Suspension is a moderation action, not a billing one — the slot stays yours and the other organisations in the group are unaffected.
