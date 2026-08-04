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
  - **Pay the organiser** (any plan) — cash or bank transfer. Set instructions once under *Settings → Connect* (a rich-text editor — bold your account details, add links), or override them per division. Write `{{reference}}` anywhere in the instructions and every registrant sees their own generated reference in its place — "quote {{reference}} on your transfer" personalises itself in the confirmation email and on the status page. Entries stay pending until you press **Mark paid**.
  - **Card at sign-up** (any plan) — Stripe checkout during registration, settling straight to your connected Stripe account. Connect Stripe first under *Settings → Connect* (a short one-time onboarding). Paid entries are **confirmed automatically**; unpaid ones hold their spot for **48 hours** (reminder at 24h) and then expire, promoting the waitlist. Your plan sets the platform fee, not whether you can charge — 8% on Community, 5% with an Event Pass, 2% on Pro, 1% on Pro Plus. The full journey — KYC, payouts, refunds and disputes — is in [how card entry fees flow](/help/registration/card-payments).
- **Custom questions** (in **Sign-up form**) — shirt size, dietary needs, emergency contact; answers export with the entrant list.

## Privacy consent

Every registrant ticks a consent box before submitting: they agree that your organisation and Seazn Club store and process the details on the form (name, email address, date of birth) to run the competition. The form won't submit without it, and the acceptance — with its time and policy version — is stored on the entry, so you can demonstrate consent later if a registrant asks. The [Privacy Policy](/legal/privacy) is linked right on the checkbox.

## After someone registers

They get a **reference number** like `SZ-7F3K-Q2ND` and a tear-off ticket — their key to checking status, paying and withdrawing without an account ([how references work](/help/registration/reference-numbers)).

The **Registrations** console opens on a **pulse strip** — confirmed / holding / waitlisted counts against capacity, money collected and due, and the next payment deadline — with the list below split into **Confirmed / Pending / Waitlist / All** tabs. Row actions are grouped so the split is unmistakable: **Spot** actions change who's in (Approve, Waitlist, **Withdraw** — frees the place and auto-refunds before your *refund lock* date), while **Money** actions only move money (**Mark paid** for cash/bank fees, **Waive fee** for comped entries — both logged — and **Refund**, which returns the fee while the entry keeps its spot). Entries sharing a contact email with another active entry carry a small *duplicate contact* hint — often legitimate, like a parent entering two kids.

## Linking an entry to an account

Registration never requires an account — anyone can enter with just an email address, and that stays true.

A registrant who happens to be signed in sees one extra tick box: **I'm registering myself**. It names the account it would link to, so nobody on a shared device links an entry to whoever used the browser last. When they tick it, every division they enter attaches to the same player record, so their results, discipline history and profile photo stay together instead of splitting across a separate record per entry. Team entries add a follow-up: **Which player are you?**, so the roster row that is actually them gets the link and their team-mates are unaffected.

Left unticked — or signed out — the entry behaves exactly as it always has.

The tick box disappears whenever guardian details are in play, and the entry is never linked in that case even if the box was ticked first. A parent entering two children is signed in as one person for both, so linking there would fuse the two children into a single player record and merge their results. Matching names or dates of birth are only ever flagged for you to review; nothing is ever merged automatically.

## Under-18 divisions

Youth divisions automatically add a guardian-consent step and shorten player names on public pages ([details](/help/registration/youth)).
