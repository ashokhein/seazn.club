# v10 — Sponsor CRM & Monetization

> **Status (2026-07-14):** design only. PROMPT-56 not yet implemented.
> Target branch (build time): `feat/v10-sponsor-crm` (own worktree off `main`).
> **Heaviest of the v10→v12 wave** — flagged during brainstorming as
> plausibly its own multi-prompt wave; kept as one prompt with clearly
> separable commits (model → manager UI → monetization → placement).
> **Migrations:** one new delta, **use the next free `V###`** (V280 is the last
> on `main`; v5-i18n carries V281 unmerged — check contention before numbering,
> per the V-number-contention gotcha).

## Theme

Sponsors exist today as a **shallow branding array**, not a feature. The whole
implementation is `apps/web/src/lib/org-branding.ts`: a `Sponsor` is
`{ name, url?, logo? }`, stored inside the `branding` jsonb on both
`organizations` and `competitions` (`mergeSponsors` / `brandingSponsors`, blob
merge so a colour write never clobbers the sponsor list). It renders in exactly
three places — the org settings editor (`components/org-sponsors.tsx`), the
public competition page (`(public)/shared/[orgSlug]/[competitionSlug]/page.tsx`,
competition-level then org-level, deduped by name), and the register-page
masthead line — and is Pro-gated by the public org read (v3/10 #5). No tiers, no
per-competition management surface, no placement on the poster/embed/slideshow,
no money, no analytics.

**v10 turns sponsorship into a product an organiser can sell.** Three layers:

1. **Real model.** Promote sponsors out of the branding blob into first-class
   `sponsors` rows (org- or competition-scoped) carrying a **tier**
   (`title | gold | silver | partner`), display order, logo, and status.
   `brandingSponsors()` becomes a back-compat read shim while existing blobs are
   migrated; the public renderers switch to the table.
2. **Placement everywhere.** Tier-grouped sponsor strips on the public
   competition and division pages, the poster PDF, the embed widgets, the
   slideshow, and (via v12) the admit-one ticket. Click-through goes through a
   tracked redirect so organisers can prove value to a sponsor.
3. **Monetization.** An organiser publishes **sponsor packages** (price /
   currency / what's included) and takes payment through the **same Stripe
   Connect destination-charge rail as entry fees** (`usecases/registrations.ts`
   is the precedent: `transfer_data` to the club's connected account, platform
   `application_fee_amount`). A paid order activates the sponsor automatically.

## Prompts

- `prompts/PROMPT-56-sponsor-crm.md` — `sponsors` / `sponsor_packages` /
  `sponsor_orders` tables + RLS + entitlement seed; org & per-competition
  sponsor manager; tiered public placement + tracked click redirect; Connect
  checkout for packages reusing the entry-fee rail and `billing-events`
  webhook dispatch; invoice/receipt emails; help, smoke, tests.

## Non-goals (explicit)

- **Sponsor self-serve signup portal** (a sponsor logging in to buy a slot
  unprompted) — organiser-initiated only for v10; a public "become a sponsor"
  funnel is a later wave.
- **Programmatic ad serving / rotation / CPM billing** — placement is
  deterministic by tier + order, billed per package, not per impression.
- **Recovering Stripe fees or handling sponsor-side disputes** beyond what the
  entry-fee rail already does (v9 dispute recovery applies unchanged).
- **Removing the branding-blob path outright** — it stays as a read shim for
  one release so no existing public page loses its sponsor strip mid-migration.
