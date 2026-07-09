# v3/05 — Public Registration v2: Redesign + Reference Numbers

Extends engine/16 §1.1 / PROMPT-20a (registration & fees — shipped 2026-07-06 per memory).
Intake #19 (redesign + ref number) and #20 (custom fields render *below* the save button —
form-order bug). This is the highest-traffic page non-members ever see: it is marketing.

## 1. Diagnosis

The current page is a utilitarian form: fields in implementation order (custom fields
appended after the submit button — #20), no event context (who/where/when), no visual
identity, and after submitting the participant gets… nothing quotable. Organisers then
field "did my registration go through?" messages all day.

## 2. Page redesign

**Design direction (the one aesthetic risk): the page is a ticket, not a form.** Sports
registration's native artifact is the entry ticket/receipt — lean into it.

```
┌──────────────────────────────────────────┐
│ [org logo]  SUMMER SMASH 2026            │  ← event masthead: org logo (v3/03 §5),
│ U16 Boys Singles · Knockout              │    comp name, division, dates, venue,
│ 12–14 Aug · Riverside Courts             │    entry fee if any, spots left
│ ▓ 11 of 16 spots taken                   │  ← capacity meter = urgency, honest
├──────────────────────────────────────────┤
│ 1 Who's entering        [fields]         │
│ 2 Event questions       [custom fields]  │  ← correct order (#20)
│ 3 Consent               [checkbox]       │
├──────────────────────────────────────────┤
│        [ Enter the competition ]         │  ← sticky on mobile (v3/02 pattern 2)
└──────────────────────────────────────────┘
```

- **Form order fixed structurally:** one ordered section list rendered from a single
  config array — identity → custom fields → consent → submit. The bug class (append-after-
  button) becomes impossible, not just fixed.
- Field types per PROMPT-20a schema unchanged; custom fields get proper labels, help text
  (Tips, v3/03 §4) and validation messages in plain language.
- Entrant-kind aware: `pair` shows partner block; `team` shows team name + optional roster
  (self-roster rules per engine/16).
- Fee line (if Stripe Connect fees enabled) shown in the masthead *and* on the button
  ("Enter — £12.50"): no surprise at step 3.
- Closed/full states are directions, not dead ends: full → "Join the waitlist" (if on) or
  "Follow the live dashboard"; closed → dashboard link.

## 3. Reference number (intake #19)

Every accepted registration gets a human-quotable reference:

- **Format:** `SZ-XXXX-XX` — crockford-base32 alphabet (no 0/O/1/I), 6 random chars +
  2-char checksum; unique per environment. Generated server-side at insert;
  `registrations.ref_code` unique column. ~1B space at 6 chars: collision-retry loop.
- **Shown:** success screen renders the **tear-off ticket** — ref code huge (Geist Mono),
  event masthead, QR encoding the status URL; "Add to calendar" + "Save ticket" (PNG via
  the same OG-image renderer as v3/10 wave 1).
- **Status URL:** `/r/[ref]` — public, unguessable-enough, shows status
  (pending review / confirmed / waitlisted / withdrawn), division link, and (if enabled)
  self-withdraw. Doubles as day-of check-in lookup for the organiser (search by ref in
  registrations panel).
- Confirmation email includes ref + status link (Resend template update).
- Organiser side: registrations panel gains ref column + search; moderation flow
  (approve/decline per PROMPT-20a) unchanged.

## 4. Trust & abuse

- Rate-limit by IP+division; honeypot field (no CAPTCHA at current scale).
- Ref codes are lookups, not auth: `/r/[ref]` exposes only what the success screen showed;
  self-withdraw requires the email-confirmation token, not just the ref.

## 5. Acceptance sketch

E2E: register individual + pair + team on a fee-free division → ticket renders, ref
resolves at `/r/[ref]`, email contains ref (Resend test mode); custom fields render
between identity and consent (DOM-order assertion — the regression test for #20);
full-capacity division shows waitlist state. Smoke: extend `scripts/smoke.ts` free +
pro registration paths (house rule).

Related: [[v3/03]] visibility picker + Tips, [[v3/02]] sticky action bar, engine/16 §1.1
fees/waitlist/moderation (unchanged), [[v3/10]] OG-image renderer reuse.
