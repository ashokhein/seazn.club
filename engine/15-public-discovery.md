# 15 — Public Discovery: Tournaments on the Home / Marketing Page

Doc 09 gives each org a public dashboard at its own URL. This doc adds the platform
layer: showcasing live and upcoming tournaments on **seazn.club's own home/marketing
pages** — with explicit org consent. Every featured tournament is social proof and an
acquisition loop (spectator → "run your own" CTA).

## 1. Consent model — public ≠ discoverable

`visibility='public'` (doc 07) means "anyone with the link can view". Being promoted on
our homepage is a **separate, explicit opt-in**:

```sql
alter table competitions add column
  discoverable boolean not null default false,     -- org opted in to platform listing
  discovery jsonb not null default '{}';           -- {city?, country?, tagline?, hero_image_path?}
```

- Toggle in competition settings: **"Showcase on seazn.club"** — copy states exactly
  what it implies: name, org name, sport(s), dates, location (if given), live scores and
  standings may appear on seazn.club's home, discovery and sport pages, and in
  marketing/social material. Requires `visibility='public'` (auto-unchecks if visibility
  drops — never leak a private competition to discovery).
- Consent is **org-level content consent**, not personal-data consent: everything
  rendered on discovery surfaces comes from the same consent-filtered `public_*_v` views
  (doc 07 note 4) — minors/no-consent persons already show as initials or not at all.
  Discovery adds zero new personal-data exposure paths.
- Toggle-off is immediate: discovery caches keyed on `discoverable`, invalidated on
  change; ISR tag `discovery` revalidated. Marketing screenshots/social posts are
  covered by the consent wording (past use permitted, no new use after opt-out).
- Recorded as a division-independent competition event (audited who/when opted in/out).

## 2. Surfaces

### Home page (marketing)
- **"Live right now" strip** — up to ~6 in-play fixtures across all discoverable
  competitions: sport icon, competition name, live `ScoreSummary.headline`, links to the
  org's public dashboard. Realtime-ish (30 s ISR is enough for marketing).
- **"Happening this week"** — upcoming discoverable competitions: card = hero image /
  sport icon, name, org, dates, city, entrant count.
- Both sections render nothing (collapse) when empty — no fake content.

### `/discover` directory
- Filter by sport, date range, country/city (from `discovery` jsonb — organiser-entered,
  optional). Search by name. Paginated cards → org public dashboards.
- Per-sport landing pages (`/discover/cricket`) double as SEO pages: intro copy + live
  directory. These become the "tournament software for cricket" landing pages doc 06
  (marketing) wanted, now with real live content.

### Sitemap/SEO
Discoverable competitions join the sitemap with priority; JSON-LD `SportsEvent` series
markup on directory entries. Unlisted/non-discoverable stay out (doc 09 rules unchanged).

## 3. Ranking & curation

Default ordering: in-play first, then by start date proximity; ties by entrant count.
- **Pro perk (doc 10 addition):** `discovery.featured` — Pro competitions eligible for
  the curated "featured" slot row (staff-curated flag in admin console; Pro is eligible,
  not guaranteed).
- Abuse control: staff `discovery_blocked` flag on org/competition (admin console
  action, audited) — spam/inappropriate names never reach the homepage. New-org
  competitions enter discovery only after the org is email-verified + has ≥1 decided
  fixture or a published schedule (quality floor, no empty shells).

## 4. Read model & API

```
GET /api/v1/public/discovery?sport=&country=&status=live|upcoming&cursor=
```
Backed by `public_discovery_v`: competitions where `discoverable AND visibility='public'
AND NOT discovery_blocked AND org.status='active'`, joined to minimal live info
(next/last fixtures, in-play count). Cached hard (Redis 30 s + CDN s-maxage 60): this
endpoint takes anonymous homepage traffic — it must never touch hot tenant paths.
Homepage/discover pages are Server Components on this view only.

## 5. Entitlement summary (doc 10 delta)

| feature_key | Community | Pro |
|---|---|---|
| `discovery.listed` (opt-in to directory + home strips) | ✓ (it markets us) | ✓ |
| `discovery.featured` (eligible for curated featured row) | ✗ | ✓ |
| `discovery.branding` (hero image, tagline on cards) | ✗ | ✓ |

Listing stays free deliberately — every Community tournament on the homepage sells the
platform. Depth of presentation is the paid layer, consistent with doc 01 §2.5.
