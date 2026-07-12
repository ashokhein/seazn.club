# PROMPT-52 — Organiser registration console redesign: settings + money at a glance

**Read first:** `docs/superpowers/specs/2026-07-12-registration-payments-design.md`
(§2 status machine + §4 issue matrix are NORMATIVE — the redesign changes presentation,
never semantics), `apps/web/src/components/v2/registrations-panel.tsx` (current panel:
settings column + list + FormBuilder), `apps/web/src/app/o/[orgSlug]/settings/payments/page.tsx`
(org-level payments home — division settings LINK here, never duplicate Connect UI),
`design/v3/` UI-system conventions + `.app-*` stadium-night classes (PR #70).
**Process:** `superpowers:brainstorming` first (present options before building), then
`frontend-design` for the visual pass — this prompt lists required outcomes, not the layout.
**Depends:** PR #72 merged. New worktree, own branch (`feat/v7-reg-console`). No migrations
expected; new read fields OK (counts derive from existing rows).

## Why (observed gaps, 2026-07-12 session)

- Waitlist is invisible as a NUMBER: registrants see "full — joins the waitlist",
  organisers count badges by eye. Nobody sees queue position.
- Refund vs Withdraw confusion: refund is money-only (entrant stays confirmed);
  freeing the spot is Withdraw (which auto-refunds pre-lock). The two buttons sit side
  by side with no hint of that split.
- Capacity exists as a bare input; no organiser-side meter of taken/held/waitlisted,
  no view of how many held card spots are ticking toward expiry.
- Duplicate entries (same contact email active twice — legal, e.g. re-registration
  after withdrawal or a parent entering two kids) get no organiser hint.
- Settings column is a long form: enable, kind, window, capacity, fee, method,
  instructions, refund lock, form builder — no hierarchy of "what matters when".

## Task (outcomes, not layouts — brainstorm the shape)

1. **Registration pulse** (organiser header): one glanceable strip per division —
   confirmed / pending-holding / waitlisted counts against capacity, card money state
   (paid · due-with-countdown · refund-incomplete · disputed rollups), next expiry.
   Numbers link to the filtered list.
2. **Waitlist as a queue**: ordered view (position, joined-at, promote-next affordance
   consistent with auto-promotion), waitlist count on the public division card
   (`PublicDivisionInfo` may gain `waitlisted: number`), and the registrant status page
   may show "you're #N in line" (position = created_at order among waitlisted — confirm
   exposure is acceptable publicly during brainstorm; token-gated page only).
3. **Action clarity**: withdraw-vs-refund presented so the money/spot split is
   unmistakable (grouping, confirm copy, or a single "Remove & refund" composite that
   calls the existing endpoints in order — semantics unchanged). Mark paid / Waive fee
   keep their logged one-click nature.
4. **Settings hierarchy**: brainstormed restructure of the settings column (e.g.
   staged disclosure: open/close → capacity → money → form), method picker stays,
   Connect state only LINKED (Settings → Payments owns it). Fee edits surface the
   snapshot rule ("applies to new sign-ups; current entries keep their price").
5. **Duplicate hint**: non-blocking marker on rows sharing a contact email with
   another ACTIVE (pending/paid/confirmed/waitlisted) row in the division.
6. **Help pages updated** with whatever ships (standing rule): registration articles +
   screenshots-of-copy consistency (`content/help/registration/*.md`).

## Acceptance

- Semantics untouched: the PR #72 vitest suite passes unmodified (44 cases) — any test
  change is a red flag that behavior moved.
- New derived counts covered by unit tests (waitlist position ordering, pulse rollups,
  duplicate-email detection scoped to active rows in one division).
- e2e: pulse numbers match a seeded division (confirmed/pending/waitlisted mix);
  waitlist queue order shown; composite remove-and-refund path (if chosen) leaves the
  same audit rows as manual withdraw+refund.
- Mobile 390px: pulse + list + settings usable without horizontal scroll
  (screenshots desktop + mobile per frontend-design mirror rule).
- `npx tsc --noEmit`, lint, smoke extension per standing rules.

## Out of scope

Payment semantics/status machine changes, org-level Payments page internals (PR #72),
platform revenue reporting (PROMPT-51), public register form redesign (only the
waitlist-count addition to the division card), emails.
