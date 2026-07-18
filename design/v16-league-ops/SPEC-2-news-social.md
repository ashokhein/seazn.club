# SPEC-2 — Org news, auto-drafted posts & share cards

## Problem

LeagueRepublic ships "social media news and results posts" on its free tier.
We have world-class share *plumbing* — per-level OG images, poster/PDF render,
`share-bar.tsx` (native/WhatsApp/copy), attribution links with UTM — but no
*content*: an org cannot publish a sentence on its own public pages. Result:
their public page is a scoreboard, not a destination, and every match weekend
generates zero shareable artifacts unless someone manually screenshots.

## Goal

An org news feed: composer in the console, public News tab, one OG share card
per post — plus the system **auto-drafting** a post when a result lands or a
round completes, so the Monday-morning job is "review 3 drafts, tap publish"
(D3). Publishing a post produces a share-ready image card and fires the PLG
loop (public posts carry the free-tier badge + UTM like every public surface).

## Non-goals

- No social-platform APIs (Facebook/X/Instagram) — rejected in D3.
- No email digest (later spec; `standingsTable` email block already waits).
- No RSS, no comments, no reactions, no scheduling of future publishes.
- No rich block editor: markdown body, one hero image. That's it.

## Data model — migration `V292__org_news.sql` (renumber at build, D9)

```sql
create table org_posts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  competition_id  uuid references competitions(id) on delete set null,
  division_id     uuid references divisions(id) on delete set null,
  author_user_id  uuid,             -- console user; null for auto-drafts
  kind            text not null default 'news'
                    check (kind in ('news','result','round_recap','announcement')),
  status          text not null default 'draft'
                    check (status in ('draft','published','archived')),
  slug            text not null,    -- unique per org, from title (slugify util)
  title           text not null,
  body_md         text not null default '',
  hero_image_path text,             -- supabase public storage (logo upload rail)
  auto_source     jsonb,            -- {"trigger":"fixture_decided","fixture_id":...,
                                    --  "stale":false} — null for human posts
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, slug)
);
create index org_posts_public_idx on org_posts(org_id, status, published_at desc);
```

RLS: enable/force, tenant policy, `app_user` grants (V284 mirror). Public
reads via the superuser `sql` connection filtered `status = 'published'` and
org/competition visibility in `('public','unlisted')` — same guard chain as
`publicDivisionStats`.

## Auto-drafts

Division-level opt-in flag: add `auto_posts boolean not null default false`
to `divisions` in the same migration (a plain division column, not a
SPEC-1-style rules table — this is presentation, not rules). Console exposes it as a toggle
in the division Settings tab ("Draft a news post when results land").

Triggers (same decided-write seam `scoring.ts` uses for discovery refresh,
and SPEC-1 uses for detection):

1. **Fixture decided** → draft `kind: result`. Title `"{home} {score}–{score}
   {away}"`; body template: competition/division line, venue + date (venue-tz
   format — v12 `fixtureWhen` helper), scorers list when the sport has
   `playerStats` and events are attributed, standings movement line ("{team}
   moves to 2nd").
2. **Round complete** (all fixtures in a round_no decided) → draft
   `kind: round_recap`: results grid table + top of standings. Round numbers
   are 1-based (v13 lesson).

Rules:

- Drafts are cheap and disposable: if the fixture is voided/re-decided,
  stamp `auto_source.stale = true`; the console shows a "result changed"
  badge. Never auto-edit, never auto-publish, never auto-delete.
- Idempotent per trigger: skip when a post with the same
  `auto_source.trigger + fixture_id` (or `round_no`) already exists.
- Auto-drafting is Pro: new entitlement key `news.auto` (community/event_pass
  false, pro/pro_plus true), seeded in V292. **Manual posts are free on every
  plan** — free orgs publishing news is the PLG ad network working as
  designed.

## Public surfaces

- `/shared/[orgSlug]/news` — list (title, date, kind chip, hero thumb),
  courtside `--ps-*` theme, paginated 20.
- `/shared/[orgSlug]/news/[postSlug]` — post page: hero, markdown body
  (existing markdown render used by help content), share-bar, "related
  competition" card when scoped.
- `opengraph-image.tsx` for the post page: headline card in the courtside
  system — org crest, title, kind-colored accent bar, scoreline big-type for
  `result` posts. Free tier: seazn badge on the card (attribution rail);
  Pro: org branding via `public-theme.ts` — exactly the existing
  `dashboard.branding` split.
- **Download image card** button on published result posts → PNG at
  1080×1350 (portrait, IG/WhatsApp-story friendly) — same server-render rail
  as `r/[ref]/ticket.png`. This is the "auto-post to social" replacement:
  the organiser gets the asset, the platform gets no OAuth liability.
- Org landing page (`/shared/[orgSlug]`): "Latest news" strip, newest 3
  published posts.

## Design direction

The public news feed is a **night-mode matchday programme**, not a blog:
`--ps-*` courtside tokens, Barlow Condensed display, scorebug vernacular.
Signature element: **a result post IS a scorebug** — the card and the post
hero render the scoreline in huge condensed tabular numerals with the two
crests, exactly the visual grammar the live wall already taught users.

- Feed cards: kind-colored eyebrow caps (`RESULT` lime pitch-line, `RECAP`
  white, `ANNOUNCEMENT` red-ball red, `CLUB NEWS` muted), title in display
  face, date set like a fixture timestamp (venue-tz). Result cards swap the
  hero image for the scorebug block when no hero is uploaded — an empty
  hero is never a grey placeholder.
- Post page: hero (image or scorebug), measure-limited markdown body
  (~68ch), share-bar pinned after the fold on mobile; related-competition
  card in the existing public card idiom.
- The latest-news strip on the org landing page is three compact rows, not
  cards — the landing hero stays the org's identity, news stays quiet.
- OG card (1200×630) + story PNG (1080×1350): night background, crest pair,
  kind accent bar, scoreline dominant; free tier carries the seazn badge
  (attribution rail), Pro carries org branding via `public-theme.ts`.
- Motion: one orchestrated moment only — score digits settle on post-page
  load (CSS, `prefers-reduced-motion` honored). Nothing else animates.
- Console News tab uses `.app-*` tokens and the standard panel/table idiom;
  composer fields are `.input`/`.label` defaults; ⚡ auto-draft badge and
  stale badge are chips, not banners.
- Screenshot-verify: feed (mobile + desktop), post page, OG route output,
  story PNG.

## Console surfaces

- **News tab** on the org console (sibling of existing settings sections):
  drafts queue (auto-drafts badged ⚡, stale badge when
  `auto_source.stale`), published list, composer (title, markdown textarea,
  hero upload via the badge/logo upload rail from #130, scope pickers).
- Publish action = status flip + `published_at` stamp + slug freeze (slug
  never changes after first publish; edits keep the URL).

## API surface (OpenAPI regen mandatory)

- `GET/POST /orgs/{id}/posts` (console; filter `status=`)
- `GET/PATCH/DELETE /posts/{id}` — PATCH covers edit + `action: publish |
  archive`.
- Public data flows through page-level server components (no public JSON API
  in v16).

## Analytics / PLG

Fire via `analytics-events.ts` (snake_case props, PLG conventions):
`post_created`, `post_published` (kind, auto boolean), `post_shared`
(share-bar already fires generic share events — add post context),
`post_card_downloaded`. Public post pages join the L1 attribution-link rail
(badge + UTM → /start).

## Tests

- Unit: draft idempotency per trigger, stale flip on void, slug collision
  (`-2` suffix), entitlement split (auto Pro / manual free), publish
  immutability of slug.
- DB-backed: RLS isolation; public query never returns drafts or
  private-org posts.
- E2E: decide fixture → draft appears → publish → public news tab + OG image
  route 200 + share-bar present.
- Smoke: pro path (auto-draft → publish → PNG download) + free path (manual
  post publishes; auto toggle shows PlusReveal).
- share-bar hydration: `canShare` gate lesson from PLG wave — reuse the
  component, don't fork it.

## Gotchas / constraints for the builder

- Markdown render must sanitize — body is org-authored, lands on public
  pages (use the exact pipeline help content uses; no new renderer).
- OG/PNG routes are hashed by Next (v3 lesson: hashed `opengraph-image`
  paths) — link via generated metadata, never hardcode.
- `pdfkit` is NOT involved here — image cards use the OG/ImageResponse rail;
  don't reach for doc-render.
- Hero uploads reuse the public supabase `publicStorageUrl` + fetch pattern
  (v12 logos lesson).
- i18n: console strings typed keys en/fr/es/nl. Post *content* is
  org-authored and never machine-translated; auto-draft templates render in
  the org's locale at draft time.
- Help: `content/help/sharing/news.md` + slug registry, same PR.
