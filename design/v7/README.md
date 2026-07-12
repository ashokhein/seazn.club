# v7 — Platform Revenue Report

> **Status (2026-07-12):** not started. PROMPT-51 ⏳.
> Branch (planned): `feat/v7-platform-revenue`. Migrations: none expected — Stripe is the
> source of truth for collected fees; the app only caches.

## Theme

One admin surface answering "what has the platform actually earned from entry fees?" —
the sum of Stripe **application fees** (the platform cut of card registrations shipped in
PR #72), rolled up by month and by organisation, straight from the Stripe API.

Deliberately NOT a general ledger: no per-payment bookkeeping tables, no double-entry,
no reconciliation jobs. `application_fees` on the platform Stripe account already carries
every collected/refunded fee with its connected account; the report reads, groups and
caches it.

## Prompts

- `prompts/PROMPT-51-platform-revenue-report.md` — `/admin/revenue`: monthly + per-org
  fee rollups from the Stripe API, cached, CSV export, linked from `/admin/settings`.
