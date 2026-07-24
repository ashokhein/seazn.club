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

A new organisation starts on its **own** bill — its own plan and invoice. You choose to share a bill deliberately, never automatically: either when you create the organisation (pick "Add to an existing bill") or later from **Settings → Billing → Billing group**. You can also **leave** a bill later and go back to your own — see [Leaving a group](#leaving-a-group).

Adding is done by someone who owns **both** the organisation being added and the group it's joining — admins run the competition, not the money.

- The bill goes up by half the plan rate straight away, prorated to the rest of the period.
- The organisation is on the group's plan **immediately** — limits, features and the entry-fee rate all change the same second. The lower rate applies to competitions that haven't taken a payment yet; one that already has an entrant paid keeps the rate it locked (see [below](#the-entry-fee-rate-locks-when-sales-start)).
- Added during the group's free trial, it rides the same trial to the same end date and costs nothing now.
- An organisation that already has its own live subscription can't be added yet. Cancel it, or wait for it to lapse.
- A group can't take on a new organisation while its own payment is overdue or while it's set to cancel at the end of the period. Settle the invoice, or resume the subscription, and then add.

If the extra charge fails, the organisation stays in the group — it doesn't get thrown back out. The group enters the normal 14-day [dunning](/help/billing/downgrade) window instead, and if it runs out, every organisation in the group drops to Community limits together.

### What an added organisation costs

The added organisation becomes an extra **seat on the bill you already have** — never a new, separate subscription. So it inherits your bill's shape:

- **On a monthly bill** it's the half rate per month (Pro **+$9/mo**, Pro Plus **+$19/mo**), prorated for the rest of the current month and charged now.
- **On an annual bill** it's the half rate per **year** (Pro **+$79/yr**, Pro Plus **+$163/yr**), prorated for the rest of the current year and charged now — it renews on your existing annual date, not a new one. Mid-year, "now" is only the slice of the year that's left; the full half-rate lands at your next renewal.

You never guess the figure: the "Add to an existing bill" step shows the **exact amount you'll be charged now**, taken live from Stripe, before you confirm.

**With a discount on the bill**, what the added organisation gets depends on the coupon's *type*:

- A **percentage** discount that's still running (a *forever* code, or a *repeating* one inside its window) comes off the added organisation too — both the amount charged now and its share of every future renewal. A 60%-off Pro bill adds an extra org at 60% off.
- A **one-time** code (applies *once*, already spent on your first invoice) does **not** discount a mid-cycle add — that charge is separate from the invoice the code was used on.
- A **fixed-amount** code (e.g. £20 off) comes off the *invoice total*, not each seat, so on a mid-cycle add it may cover little or none of the extra. Percentage, longer-duration codes are the ones that follow the whole group — which is why they're usually the right choice for a group that will grow.

Whatever the code, the amount shown before you confirm is the real, post-discount figure.

## Leaving a group

Either side can end it. The payer can push an organisation out; the organisation's owner can pull it out. Nobody needs the payer's permission to leave, and no payer is stuck funding an organisation that won't cooperate.

**Leaving costs nothing** — no payment, no card, no settling up. What you decide is what happens to the seat the group already paid for, because that seat can go one of two ways and never both:

- **Keep its plan until the period ends.** The organisation keeps the plan it had — and the entry-fee rate that came with it — until the end of the period the group already paid for, then falls back to Community. The seat **goes with it**: the group's next invoice is one seat smaller, and adding a replacement organisation now costs a new seat.
- **Free up the seat now.** The organisation drops to Community straight away and loses the plan immediately. The seat stays with the payer as a **freed slot**, which another organisation can fill at no extra charge until the period renews — on an annual plan that can be worth eleven months.

You can't have both from one seat — keep the plan on the way out *and* reuse the slot for free — because that would be two organisations entitled by a single paid seat. So the only question is which of the two is worth more to you. An organisation leaving a group that isn't currently billing (Community, or a cancelled subscription) has no period to ride out, so it simply moves to its own Community plan. Nothing is deleted either way, exactly as in a [downgrade](/help/billing/downgrade).

Competitions that have **already taken a payment keep their locked entry-fee rate** whatever happens to the plan — leaving a group never raises the fee on a competition whose entrants have started paying. Only competitions that haven't sold a place yet move to the new rate.

Two details worth knowing:

- The organisation's owner becomes the owner of its new, standalone billing — there's no role to grant.
- A free trial doesn't reset on the way out. If the group has used its trial, the departing organisation has used it too.

## No refunds, and the freed slot

Removing never refunds, and adding always charges immediately — we don't call Stripe to move money mid-period either way. The two removal choices differ only in **who keeps the value of the seat you already paid for**: the departing organisation, which rides out the period on its plan, or you, as a freed slot to reuse.

If you chose **Free up the seat now**, that slot can be filled by another organisation **at no extra charge** until renewal, and nothing changes at all if you add an organisation back into it. If you chose **Keep its plan until the period ends**, the seat left with the organisation, so the next organisation you add is a fresh seat and is charged as one. Either way the count is trued up at renewal.

## Handing the group to a new payer

Treasurers change. When they do, the group itself can change hands — you don't have to pull eight clubs out and re-group them, which would lose the group and charge full rate for each one again.

**The card doesn't travel with the group.** Someone who has stopped running a federation should stop funding it, so the incoming payer supplies their own card. That's why a group with a live subscription hands over in two steps rather than one:

1. The current payer offers the group to a named person.
2. That person adds a card, and only then does the group change hands.

Between those two steps nothing has moved: the group still belongs to the current payer, still bills their card, and the offer can be withdrawn at any point. The old card is removed last of all, after the new one is attached, so the subscription is never left without a way to pay — the failure this two-step exists to prevent is a September handover on an annual plan silently failing its renewal in March and dunning every club in the group down to Community.

Details worth knowing:

- **An offer is for one named person and can only be used once.** It lapses on its own after seven days.
- **The payer can withdraw an offer** at any time before it's accepted.
- **Send them the link.** There's no inbox for pending offers yet, so the offer has to reach the recipient the way you'd send anything else. If they lose it, withdraw it and make a new one.
- **A group with nothing to bill** — Community, or a subscription that has already been cancelled — moves in a single step, because there's no invoice to fail. It can only be handed to someone who already owns an organisation in the group, since there's no acceptance step to serve as their consent.
- **Nothing about the organisations changes.** Same plan, same limits, same entry-fee rate, same Stripe Connect accounts, same payouts. The only things that move are who is billed and where the invoices and receipts go.

## The entry-fee rate locks when sales start

Because a group's plan can be changed by the payer — who might not be the person running a competition — the platform fee on entries is **fixed the moment a competition takes its first paid entry**. From then on every entrant in that competition is charged the same rate, whatever happens to the plan afterwards: a group detach, a downgrade, or a switch between Pro and Pro Plus none of it re-rates a competition whose entrants have already started paying.

Before the first paid entry the rate is still live, so if you set a competition up on the wrong plan you can fix the plan and see the new rate apply — right up until someone pays. Free and offline entries don't lock anything; the rate is set by the first entry that actually pays through the platform.

This protects the organiser, not the platform: it means the fee you were quoted when your first entrant paid is the fee you keep for the whole competition.

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

**What if the payer deletes their account?** The group passes to the longest-standing owner of an organisation inside it, so nobody is left paying for organisations they can no longer manage — and nobody loses their plan because someone else closed an account. If there's nobody left who could ever manage it, the subscription is cancelled rather than orphaned. If you're deliberately handing over, do it properly with an offer first: that way the incoming payer's own card is on file before you go.
