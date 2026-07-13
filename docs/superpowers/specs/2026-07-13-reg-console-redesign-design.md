# Organiser registration console redesign (design/v7 PROMPT-52)

**Status:** approved shape 2026-07-13 (pulse + status tabs; waitlist count + position exposed; grouped SPOT/MONEY actions).
**Branch:** `feat/v7-platform-revenue` (continues PR #75 — user decision 2026-07-13; the prompt's separate-branch note is superseded).
**Normative constraints:** spec `2026-07-12-registration-payments-design.md` §2 (status machine) and §4 (issue matrix) are held fixed. This redesign changes presentation and adds derived reads only — no status-machine, payment, or endpoint semantic changes. PR #72's 44-case vitest suite must pass unmodified; any needed test edit is a red flag that behavior moved.

## Goal

The organiser side of registrations grew features faster than hierarchy. Five observed gaps (2026-07-12 session): waitlist has no numbers, refund-vs-withdraw reads ambiguous, capacity is a bare input with no meter, duplicate entries get no hint, settings are one long column. Fix all five by restructuring the console around "what matters when", without moving any semantics.

## Decisions (user-approved via brainstorm)

1. **Console shape — pulse + status tabs.** Pulse strip on top; list becomes status tabs; settings collapse into a staged accordion. (Alternatives considered: minimal reshuffle of the current two-column layout; needs-attention console with settings in a drawer.)
2. **Waitlist exposure — count + position.** Public division card shows the waitlist size; the registrant's token-gated status page shows "You're #N in line". Position = `created_at` order among waitlisted rows; no names exposed. (Alternatives: count-only public; organiser-only.)
3. **Action clarity — grouped clusters.** Per-row actions split into labeled SPOT (Withdraw) and MONEY (Refund / Waive / Mark paid) clusters with confirm copy stating exactly what changes. No composite remove-and-refund endpoint chaining. (Alternatives: composite primary action; clusters + composite.)

## Console layout

```
┌ PULSE ─────────────────────────────────────────────┐
│ 18/24 confirmed · 3 holding (next expiry 41h) · 5 waitlisted │
│ £340 paid · £57 due · 1 refund needs retry · 1 disputed      │
└─────────────────────────────────────────────────────┘
[Confirmed 18] [Pending 3] [Waitlist 5] [All]
  … rows for the active tab …
Settings accordion: ▸ Open & close ▸ Capacity ▸ Money ▸ Sign-up form
```

- **Pulse strip:** confirmed / pending-holding / waitlisted counts against capacity; card-money rollups (paid · due-with-countdown · refund-incomplete · disputed); next `expires_at`. Every number is a link that activates the matching tab/filter. Empty division renders the strip with zeros (it doubles as the capacity meter).
- **Tabs:** Confirmed, Pending (holding spots; stripe rows show the expiry countdown, offline pendings have none — cash on the day is legitimate), Waitlist (the queue), All (includes withdrawn/expired terminal rows). Counts in the tab labels come from the same rollup as the pulse.
- **Waitlist tab as queue:** ordered rows showing position (#1, #2…), display name, joined-at; a Promote affordance consistent with auto-promotion (promotion snapshots live fee/method + fresh 48h window — existing semantics, untouched).
- **Settings accordion:** four staged-disclosure groups — Open & close (enable, kind, window) → Capacity (input + inline meter reading taken/held/waitlisted) → Money (fee, method picker, instructions, refund lock; fee edits surface the snapshot rule "applies to new sign-ups; current entries keep their price"; Connect state only LINKED to Settings → Payments, never duplicated) → Sign-up form (FormBuilder, unchanged).
- **Duplicate hint:** non-blocking marker on rows sharing a contact email with another ACTIVE (pending/paid/confirmed/waitlisted) row in the same division.
- **Action clusters:** SPOT [Withdraw…] — confirm copy: frees the spot, states the auto-refund behavior under the current refund-lock state. MONEY [Refund…] [Waive] [Mark paid] — Refund confirm copy: money only, entrant stays confirmed and keeps the spot. Mark paid / Waive keep their logged one-click nature.

## Data (derived reads only, no migrations)

- **Organiser list response** (existing registrations list endpoint) gains derived fields computed alongside the rows it already returns: the pulse rollup, per-row waitlist `position`, per-row `duplicate_contact` flag. One response feeds strip, tabs, and queue — no second round trip.
- **`PublicDivisionInfo`** gains `waitlisted: number` for the public division card.
- **`publicRegistrationStatus`** (token-gated) gains `position: number | null` (set only while waitlisted).

## Components

`registrations-panel.tsx` (763 lines) is doing too much; it becomes a composition shell over:

- `registration-pulse.tsx` — strip; pure render of the rollup.
- `registration-list.tsx` — tabs + rows + SPOT/MONEY action clusters + duplicate marker.
- `waitlist-queue.tsx` — ordered queue + Promote.
- `registration-settings.tsx` — the four-group accordion (method picker stays; Connect linked only).
- `FormBuilder` — existing, moves file if convenient, behavior untouched.

Styling follows the v3 UI system + existing `.card`/console conventions; frontend-design pass on the pulse strip as the page's one signature element.

## Testing

- PR #72's 44-case registration vitest suite passes **unmodified**.
- New unit tests: waitlist position ordering (created_at order, only waitlisted rows), pulse rollups (counts + money states incl. refund-incomplete and disputed), duplicate-email detection scoped to active rows in one division.
- e2e: seeded division (confirmed/pending/waitlisted mix) — pulse numbers match seed; queue order rendered; tab counts match; token status page shows "#N in line"; public card shows waitlist count.
- Mobile 390px: pulse + tabs + settings usable without horizontal scroll (screenshots desktop + 390px).
- `tsc --noEmit`, lint, smoke extension per standing rules.
- Help pages (mandatory closing pass): `content/help/registration/*.md` — waitlist article gains queue-position + count behavior; open-registration article gains the settings-group layout; grep registration nouns for stale copy.

## Out of scope

Payment semantics/status-machine changes, org-level Payments page internals, platform revenue reporting (PROMPT-51, already shipped in this branch), public register form redesign beyond the waitlist count on the division card, emails.
