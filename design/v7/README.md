# v7 — Payments Follow-ups: Revenue Report · Registration Console Redesign

> **Status (2026-07-12):** not started. PROMPT-51 ⏳ · PROMPT-52 ⏳.
> Branches (planned): `feat/v7-platform-revenue`, `feat/v7-reg-console`. Migrations: none
> expected in either — Stripe stays the source of truth for fees; console counts derive
> from existing rows.

## Theme

Two follow-ups to the dual-payments wave (PR #72):

1. **Platform revenue** — one admin surface answering "what has the platform actually
   earned from entry fees?": Stripe **application fees** rolled up by month and by
   organisation, straight from the API. Deliberately NOT a general ledger — no
   bookkeeping tables, no reconciliation jobs; `application_fees` already carries every
   collected/refunded fee with its connected account. Read, group, cache.
2. **Registration console redesign** — the organiser side of registrations grew features
   faster than hierarchy: waitlist has no numbers, refund-vs-withdraw reads ambiguous,
   capacity is a bare input, settings are one long column. Brainstorm-first redesign of
   presentation with the PR #72 status machine held fixed.

## Prompts

- `prompts/PROMPT-51-platform-revenue-report.md` — `/admin/revenue`: monthly + per-org
  fee rollups from the Stripe API, cached, CSV export, linked from `/admin/settings`.
- `prompts/PROMPT-52-registration-settings-redesign.md` — registration pulse strip,
  waitlist-as-queue (counts + position), withdraw/refund action clarity, settings
  hierarchy, duplicate-entry hints; superpowers:brainstorming → frontend-design.
