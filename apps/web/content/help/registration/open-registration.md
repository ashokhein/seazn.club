---
title: Open registration
description: Let players sign themselves up from your public page — fees, questions, capacity, moderation.
order: 1
---

Instead of typing entrants yourself, open a division for **self-registration**: a *Register now* button appears on the competition's public page.

The console's **Public registration link** card gives you the URL to share — **Copy** it, **Open** it, or press **QR** for a printable code (with a PNG download) that opens the register form from a club noticeboard.

## Set it up

The division's **registration settings** are grouped by what matters when — **Open & close** (the enable switch, entrant type and window), **Capacity**, **Money**, and **Sign-up form**:

- **Capacity** — cap entries; beyond it, new entries join the [waitlist](/help/registration/waitlist). The group shows a live meter of spots taken and people waiting.
- **Entry fees** (in **Money**) — pick how each division collects. Fee changes apply to new sign-ups only; current entries keep their price.
  - **Pay the organiser** (any plan) — cash or bank transfer. Set instructions once under *Settings → Payments* (a rich-text editor — bold your account details, add links), or override them per division. Write `{{reference}}` anywhere in the instructions and every registrant sees their own generated reference in its place — "quote {{reference}} on your transfer" personalises itself in the confirmation email and on the status page. Entries stay pending until you press **Mark paid**.
  - **Card at sign-up** (Pro / Event Pass) — Stripe checkout during registration, settling straight to your connected Stripe account. Connect Stripe first under *Settings → Payments* (a short one-time onboarding). Paid entries are **confirmed automatically**; unpaid ones hold their spot for **48 hours** (reminder at 24h) and then expire, promoting the waitlist. The full journey — KYC, payouts, refunds and disputes — is in [how card entry fees flow](/help/registration/card-payments).
- **Custom questions** (in **Sign-up form**) — shirt size, dietary needs, emergency contact; answers export with the entrant list.

## After someone registers

They get a **reference number** like `SZ-7F3K-Q2ND` and a tear-off ticket — their key to checking status, paying and withdrawing without an account ([how references work](/help/registration/reference-numbers)).

The **Registrations** console opens on a **pulse strip** — confirmed / holding / waitlisted counts against capacity, money collected and due, and the next payment deadline — with the list below split into **Confirmed / Pending / Waitlist / All** tabs. Row actions are grouped so the split is unmistakable: **Spot** actions change who's in (Approve, Waitlist, **Withdraw** — frees the place and auto-refunds before your *refund lock* date), while **Money** actions only move money (**Mark paid** for cash/bank fees, **Waive fee** for comped entries — both logged — and **Refund**, which returns the fee while the entry keeps its spot). Entries sharing a contact email with another active entry carry a small *duplicate contact* hint — often legitimate, like a parent entering two kids.

## Under-18 divisions

Youth divisions automatically add a guardian-consent step and shorten player names on public pages ([details](/help/registration/youth)).
