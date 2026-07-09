# PROMPT-34 — Public Registration v2 + Reference Numbers

**Read first:** `v3/05-registration-v2.md` (normative); `engine/16-future-features.md`
§1.1 + PROMPT-20a (existing registration model — extend, don't fork). Preamble: PROMPT-00.
**Depends:** PROMPT-32 (Tips, chips).

## Task
1. **Page rebuild** (v3/05 §2): event masthead (org logo, comp/division, dates, venue,
   fee, capacity meter); ordered-section renderer (identity → custom fields → consent →
   submit) from a single config array — the #20 bug class is structurally impossible;
   sticky submit on mobile with fee on the button; entrant-kind aware blocks
   (individual/pair/team+roster); full/closed states with waitlist / dashboard CTAs.
2. **Ref numbers** (v3/05 §3): `registrations.ref_code` unique, crockford-base32
   `SZ-XXXX-XX` + checksum, server-generated with collision retry; success screen =
   tear-off ticket (huge mono ref, QR → status URL, add-to-calendar, save-as-PNG);
   confirmation email (Resend) includes ref + status link.
3. **Status page** `/r/[ref]`: public status (pending/confirmed/waitlisted/withdrawn) +
   division link; self-withdraw only with email token; exposes nothing beyond the
   success screen.
4. **Organiser side:** registrations panel ref column + search-by-ref.
5. **Abuse** (v3/05 §4): IP+division rate limit, honeypot field.

## Acceptance
- Regression test for #20: DOM-order assertion custom fields ∈ (identity, consent).
- Unit: ref generator (alphabet excludes 0/O/1/I, checksum validates, collision retry).
- E2E: individual + pair + team registration → ticket, `/r/[ref]` resolves, email in
  Resend test mode carries ref; full division → waitlist state; ref search finds the row;
  self-withdraw without token rejected.
- smoke.ts: registration + ref lookup on free and pro (house rule); `npm test` + `tsc`
  green; update v3/README status.
