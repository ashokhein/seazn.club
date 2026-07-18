# Product-Led Growth (PLG) — GTM design

**Date:** 2026-07-17
**Scope:** Product-led growth engine only, sport/area-agnostic.
**Status:** Approved design. Next step: implementation plan (writing-plans).

## Context

Seazn Club is pre-launch (app live, demo orgs seeded, no real external
customers). Founder is solo, near-full-time, small budget (a few hundred
£/mo), with warm access to a few local clubs/schools and cold beyond.

The agreed GTM frame is **A + C blend**: a hyperlocal beachhead as the spine,
with product-led viral surfaces switched on from day 1, holding national
sport-vertical SEO/content for phase 2. **This document covers the
product-led (C) half only.** The hyperlocal playbook, content calendar, email
campaigns, sport-tech events, and the local→county→national→international
ladder are deliberately parked (available on request) and out of scope here.

## Thesis

The free tier is not charity — it is the **ad network**. Every free org's
public pages, embeds, and emails recruit the next org. The Pro upgrade trigger
is already the correct one: **removing the "Powered by Seazn" badge**
(white-label). The flywheel: *more (tasteful) free-tier attribution → more
inbound orgs AND stronger Pro pull.* Therefore we sharpen free-tier
attribution, never weaken it.

## Surface audit (grounded in the codebase)

Most distribution surfaces already exist. The work is to **activate the loops
on top of them** and **instrument** them.

| Surface | State | Location |
|---|---|---|
| No-account draw (TOFU hook) | ✓ built | home hero / `/formats` |
| `/start` 60s onboarding | ✓ built | `app/[lang]/(marketing)/start` |
| "Powered by Seazn" badge — free-only, Pro removes | ✓ built | `app/(public)/shared/[orgSlug]/layout.tsx:111` |
| Embed + `seazn.club` backlink | ✓ built (passive) | `app/embed/layout.tsx:29-34` |
| Discover directory + per-sport SEO, no empty shells | ✓ built | `/discover`, `/discover/[sport]`, `app/sitemap.ts` |
| OG unfurl cards (WhatsApp/iMessage/X) | ✓ built | `/join`, `(public)/shared/.../opengraph-image.tsx` |
| Registration copy-link + QR (organiser-side) | ✓ built | `.../registrations/page.tsx` (`CopyLink`) |
| PostHog analytics pipe | ✓ built | `lib/posthog-server.ts` |
| Entitlements / white-label engine | ✓ built | `lib/entitlements.ts`, `dashboard.branding` |
| Player→organiser "Run your own" CTA | △ MISSING | `/me`, `/my-matches`, email footers |
| One-tap share on fan/live pages | △ MISSING | share is organiser-side only |
| Attribution as a CTA (not passive brand) | △ passive | badge + embed copy |
| Growth funnel instrumented in PostHog | △ likely absent | no named taxonomy/north-star |
| Fan→organiser convert on Discover/public | △ SEO-only | `/discover` has no "start yours" CTA |

## Activation model + north-star

- **TOFU:** no-account draw / `/start`.
- **★ North-star (activation):** org created → **made public** → **≥1 result
  scored**. Everything is measured against the % of new orgs reaching this.
- **Habit:** repeat events, matchday board usage.
- **Expand:** players onboarded per org.
- **Refer:** embeds live, shares fired, player→org conversions.

## The three growth loops

1. **Organiser → Player → Organiser.** Club runs comp → players get accounts,
   live pages, emails → some run their own thing. Fuel: player-facing
   "Run your own →" (L2).
2. **Club → Club (local density).** Neighbouring clubs see each other via
   Discover + shared players + embeds. This is what makes the hyperlocal
   beachhead compound — density beats reach.
3. **Embed / public page → web visitor → organiser.** Live scores on a club's
   own site → attribution click → `/start`. Fuel: CTA-ify attribution (L1) +
   share (L3).

## Roadmap — six levers (ICE-sequenced)

| # | Lever | What | Effort | Loop | Metric |
|---|---|---|---|---|---|
| L4 | Instrument first | PostHog growth-event taxonomy + north-star + k-factor dashboard, shipped before launch | Med | all | the metrics |
| L1 | CTA-ify attribution | "Powered by Seazn"/"live on seazn.club" → "Run your own free →" + UTM | Tiny | 3 | attrib CTR→`/start` |
| L2 | Player→organiser nudge | "Run your own tournament →" in `/me`, `/my-matches`, email footers | Low | 1 | player→new-org |
| L3 | One-tap share on fan pages | native `navigator.share` + WhatsApp + copy on public live/standings/fixture | Low-Med | 3 | shares→views→`/start` |
| L6 | Activation guardrail | guided create→public→first-result path; measure & kill drop-off | Med | activation | % orgs hit north-star |
| L5 | Fan→organiser on Discover | "Start your own free" + live social proof ("N clubs live now") on Discover/public | Low-Med | 2/3 | discover→`/start` |

### Per-lever detail

**L4 — Instrument first.** Define the event taxonomy below in PostHog; build
one activation funnel and one k-factor panel. Ship before telling anyone, so
launch data lands from day 1. Reuse `lib/posthog-server.ts`; entitlements stay
the source of truth for plan state.

**L1 — CTA-ify attribution.** The impressions already exist (badge + embed
backlink). Change passive brand copy to an action + UTM: badge in
`(public)/shared/[orgSlug]/layout.tsx`, embed link in `embed/layout.tsx`.
Keep it tasteful; free-only gating via `dashboard.branding` is unchanged (Pro
still removes). Decide during planning whether the embed backlink stays on for
Pro (external-site distribution argument) or follows the badge entitlement.

**L2 — Player→organiser nudge.** Add "Run your own tournament →" to `/me`,
`/my-matches`, and transactional email footers. Verify exact `/me` layout in
planning. This turns loop #1 on — the single cheapest high-leverage lever.

**L3 — One-tap share on fan pages.** Add native `navigator.share` + WhatsApp
deep-link + copy on the public live/standings/fixture pages that players and
parents actually open (organiser-side `CopyLink` already exists; this is the
fan-facing equivalent). Grassroots sport runs on WhatsApp — highest-ROI share
surface for the segment.

**L6 — Activation guardrail.** Ensure a guided create→make-public→first-result
path exists; instrument each step; remove the biggest drop-off. Verify whether
an onboarding path already exists (`/onboarding`, `/start`) during planning.

**L5 — Fan→organiser on Discover.** The directory earns SEO/fan traffic today
but does not convert fans into organisers. Add a "Start your own free" CTA and
live social-proof counters to Discover + public pages.

## Instrumentation (PostHog)

Named events:
`draw_played`, `start_initiated`, `org_created`, `comp_made_public`,
`first_result_scored` (★ activation), `embed_rendered`, `attribution_clicked`,
`share_fired`, `player_account_created`, `player_started_own_org`.

Two dashboards:
- **Activation funnel:** draw_played → start_initiated → org_created →
  comp_made_public → first_result_scored.
- **K-factor panel:** attribution_clicked / share_fired / player→org
  conversions per active org.

This is the entire GTM dashboard. Watch these, not vanity signups.

## Monetization flywheel

`dashboard.branding` (remove badge) is already the Pro trigger. Every
attribution surface sharpened by L1/L3 makes "remove it" more valuable AND
recruits more free orgs. Free tier is simultaneously the ad network and the
upgrade funnel. Corollary: never weaken free-tier attribution; only make it
more tasteful and more action-oriented.

## Pre-launch sequencing

`L4 (instrument) → L1 (cheap conversion) → L2 + L3 (loops) → L6 (activation)
→ L5 (discover)`. L4 lands before a single person is told.

## Open questions (verify during planning, not blocking)

1. Exact `/me` and `/my-matches` layout for the L2 nudge placement.
2. Whether an activation onboarding path already exists for L6
   (`/onboarding`, `/start`).
3. Whether the embed backlink should follow the `dashboard.branding`
   entitlement or stay always-on (external-site distribution argument).
4. Which transactional email templates are player-facing (candidates for the
   L2 footer CTA) vs. account/operator-facing.

## Out of scope (parked)

Hyperlocal beachhead playbook, content calendar, email marketing campaigns,
sport-tech events/PR, and the local→county→national→international acquisition
ladder. Each is a separate GTM workstream, available on request.

## Success criteria

- L4 dashboards live and capturing before launch.
- Every free-tier public/embed/email surface carries an action-oriented,
  UTM-tagged path back to `/start`.
- Loops #1 and #3 are instrumented and firing (non-zero player→org and
  share→start conversions).
- A named activation north-star (% orgs reaching first_result_scored) is
  tracked and improving.
