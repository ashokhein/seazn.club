# PROMPT-20 — Tier-1 Features: Registration & Fees, Offline Scoring, Player Accounts

**Read first:** `engine/16-future-features.md` §Tier 1 (normative); doc 08 §4
(idempotency), doc 06 §4.7 (consent), doc 13 (roles). Preamble: PROMPT-00.
Depends: PROMPT-15 (cutover complete — these build on live v2). **Three features — run
as three separate sessions in this order; they are bundled here only so the roadmap has
one entry point. Split into PROMPT-20a/b/c files at kickoff if preferred.**

## 20a — Online registration & entry fees (16 §1.1)
1. Schema: `registrations`, `registration_settings` per doc 16; RLS/org_id per house
   pattern; registration→entrant materialisation on confirm (idempotent).
2. Stripe Connect: org onboarding (Express), entry-fee checkout with
   `application_fee_percent` (platform %, config), webhook handling reusing
   `billing_events` idempotency; refund flows (auto pre-lock, manual post-lock, audited).
3. Public register flow on the competition page: division picker → eligibility-aware
   form (DOB + guardian consent for minors) → pay → confirmation + .ics; capacity +
   waitlist with auto-promotion on withdrawal.
4. Organiser console: registration list, approve/waitlist/refund, form-field builder
   (bounded: text/select/checkbox), export.
5. Entitlements: free-event registration all plans; paid registration requires Pro +
   Connect onboarding. Acceptance: full paid registration E2E in Stripe test mode incl.
   refund + waitlist promotion; fee math asserted.

## 20b — Offline-first scoring PWA (16 §1.2)
1. Make `@seazn/engine` run in-browser for the scorer console: local fold of queued +
   server events = optimistic scoreboard.
2. IndexedDB event queue: client-generated event ids (uuid), `expected_seq` chain,
   background sync on reconnect; `SEQ_CONFLICT` → fetch-rebase-revalidate loop per doc
   16; queued events failing revalidation surface as a manual-resolve list, never
   silently dropped.
3. Service worker: precache scorer console shell + assigned fixtures; installable
   manifest; offline indicator + queued-count badge in the pad.
4. Acceptance: Playwright offline simulation — score a full set-based match airplane-mode,
   reconnect, ledger matches server refold exactly; two-scorer conflict during offline
   window resolves via rebase with zero lost valid events.

## 20c — Player accounts (16 §1.3)
1. Claim flow: org-sent invite + QR-on-player-card path → email verify → link
   `persons.user_id` (one active claim; staff unlink, audited).
2. Player home: cross-org schedule (`GET /api/v1/me/fixtures`), results/stats, teams;
   availability RSVP (`fixture_availability` table) + organiser availability grid in
   lineup picker; QR self check-in (fixture-scoped, marks lineup presence).
3. Consent handover: claimed player edits own consent flags (overrides org defaults);
   guardian link for minors (guardian user controls consent until 16+ per policy —
   confirm age with owner).
4. Acceptance: claim → RSVP → organiser sees grid → self check-in E2E; consent flip by
   player immediately affects public card (tag revalidation); unclaimed persons
   unaffected everywhere.

## Tier 2–4 note
Do NOT implement Tier 2–4 items from doc 16 under this prompt. Each gets its own
doc+prompt when scheduled — this prompt ends the current corpus.
