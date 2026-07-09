# v3/10 — Additional ROI Features & New Suggestions (ranked)

Out-of-the-box additions beyond the intake list, informed by the Jul3 intake history,
competitor scan (Jul 2026: Tournify's free-≤8-teams + €40/€120 single-use upgrades and
yearly-unlimited for 10+ events; LeagueApps/Playpass/TourneyMachine selling registration
+ payments + live scoring + branded apps as the core bundle), and the shape of our own
funnel (public dashboard = the viral surface; organiser = the buyer; participants = the
audience that becomes next year's organisers).

Scoring: **Impact** on revenue/retention/acquisition, **Effort** in engineering weeks.

## Wave 1 — build with v3 (PROMPT-39): compounding distribution, small effort

| # | Feature | Why it pays | Effort |
|---|---|---|---|
| 1 | **OG/share images** — server-rendered share card (og:image) for every public division/fixture/standings URL: logos, score, brand hue. WhatsApp/iMessage/X previews become mini-scoreboards. | Every shared link becomes an ad. Zero behaviour change needed from users — they already share links. | ~1w (one satori/resvg renderer, 3 templates; reused by v3/05 ticket PNG) |
| 2 | **"Share to WhatsApp" actions** — on fixture decided + standings, one-tap share with pre-written message + link (organiser console and public site). | WhatsApp is where amateur sport lives (intake history is full of it). Cuts organiser comms toil; drives link circulation. | days |
| 3 | **QR poster generator** — A4 PDF: comp name, org logo, big QR → public dashboard, "follow live". Print at the venue. | Bridges the physical venue to the digital surface; the dashboard finally gets its audience. Uses Jul3/06 DocModel. | days |
| 4 | **Embeddable widgets** — `/embed/divisions/[id]/standings|schedule|bracket` iframes (read-only, brandable, Pro). | Clubs paste into their own sites → backlinks + lock-in. Asked ×3 in intake history (16 Sep). | ~1w |
| 5 | **Sponsor slots on public pages** — org uploads sponsor logos/links; renders on dashboard footer + slideshow rotation + registration masthead (Pro / Event Pass). | Organisers monetise *their* sponsors → the sub pays for itself → churn drops. Heavily asked (intake history 23 May, 2 Jul). | ~1w |

## Wave 2 — revenue mechanics

| # | Feature | Why | Effort |
|---|---|---|---|
| 6 | **Entry-fee platform take as pricing lever** (v3/07 §2: 5% free-pass / 2% pro) — usage-based revenue that scales with organiser success; the Jackpot in every registration-software comparison. Stripe Connect plumbing exists (PROMPT-20a). | Aligns our revenue with theirs; funds the free tier. | days (fee config) |
| 7 | **Referral credit** — "Give a month, get a month" org-to-org referral code at checkout + in-app share. | Organisers know other organisers (leagues cluster). CAC ≈ 0. | ~1w |
| 8 | **Season duplication + yearly editions** — "Run it again": clone comp structure (divisions, formats, custom fields, branding) with fresh entrants; editions grouped on the public org page. From Jul3 not-yet-designed "org ops" (asked ×6). | The single strongest retention feature for annual events; also re-arms the Event Pass purchase yearly. | ~2w |
| 9 | **Win-back + lifecycle emails** — post-event summary email to organiser (stats, share links, "run it again" CTA), pre-season reminder at +11 months. | Annual-cadence product needs annual-cadence memory. Resend exists. | ~1w |

## Wave 3 — product depth (existing designs, sequenced here for ROI)

| # | Feature | Where designed | ROI note |
|---|---|---|---|
| 10 | Offline scoring PWA + install prompt | engine/16 §1.2 / PROMPT-20b (next per memory) | venue wifi is the #1 live-scoring blocker |
| 11 | Player accounts, claimed profiles, favourites | engine/16 §1.3 / PROMPT-20c | participants → returning users → future organisers |
| 12 | Comms hub: announcements, email-all, push | engine/16 Tier 2–3 | top-5 intake cluster; needs job infra |
| 13 | i18n (pt-BR first, then es/de/fr) + per-org label overrides | Jul3/00 not-yet-designed | Portuguese was the highest-frequency intake language; whole markets unlocked |
| 14 | Certificates & awards PDFs (winner/participation, auto-filled) | engine/16 Tier 3 + Jul3/06 DocModel | delightful, printable, shared on socials → distribution |
| 15 | AI format planner — prose → recommended format + schedule constraints ("45 players, 2 courts, 6 hours") building on Jul3/04's prose→constraints | new | the "wow" demo for the marketing funnel (v3/07 §6 step 2) |

## New suggestions (not in any list — flagging deliberately)

- **Result-entry by participants with organiser confirmation** (self-reported scores,
  two-tap confirm) — halves the organiser's scoring load for social leagues; pairs with
  device links (PROMPT-21).
- **Public org profile as a mini-site** (`/shared/[org]` with editions, upcoming comps,
  registration CTAs) — organisers get a permanent home to link from socials; SEO
  compounding. Mostly exists as data; needs the page.
- **Calendar feeds (ICS)** per division/team — "subscribe to your matches" in any
  calendar app; tiny effort, daily-touch retention.
- **Status-quo guardrail:** resist native mobile apps (competitors' branded-app offering)
  — the PWA + share-card + ICS trio covers 90% of the value at 5% of the cost. Revisit
  only if player accounts (11) hit scale.

## Suggested sequencing with v3

Wave 1 = PROMPT-39 (ships with this corpus). Wave 2 #6 lands inside PROMPT-36 (fee
config); #8/#9 are strong candidates for the next design wave (v4) alongside 20b/20c.
This doc is the standing ROI backlog — re-rank quarterly against actual funnel data.

### Sources (competitor scan, Jul 2026)
- Tournify pricing & single-use upgrades: tournifyapp.com/en/pricing, help.tournifyapp.com (articles 8909534, 9159084)
- Feature-set comparisons: jerseywatch.com/blog/tournament-registration-software, sportsfirst.net 2026 scheduling guide, gitnux.org/zipdo 2026 tournament-software roundups
