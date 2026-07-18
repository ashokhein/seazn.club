# PROMPT-83 — Org news: console tab, public pages, OG & story cards

**Goal:** SPEC-2's surfaces — console News tab (drafts queue ⚡/stale badges,
composer, publish), public `/shared/[org]/news` feed + post page with
scorebug hero, post OG image + 1080×1350 story PNG download, share-bar +
analytics events, landing-page strip — plus closing passes (i18n, help,
smoke, mobile screenshots).

**Read first:**
- `design/v16-league-ops/SPEC-2-news-social.md` — "Public surfaces",
  "Console surfaces", "Design direction", "Analytics / PLG", "Gotchas".
- `design/v16-league-ops/README.md` — mobile acceptance criterion (binding).
- PROMPT-82 interfaces — consume exactly `listPosts`/`createPost`/
  `updatePost`/`deletePost`/`publicPosts`/`publicPost`.
- `apps/web/src/app/(public)/shared/[orgSlug]/page.tsx` + `layout.tsx` — 
  public org shell, `--ps-*` theming, `public-theme.ts` Pro-branding split.
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/opengraph-image.tsx`
  — the OG idiom to clone (**hashed routes — link via generated metadata,
  never hardcode paths**, v3 lesson).
- `apps/web/src/app/(public)/r/[ref]/ticket.png/route.tsx` — the
  server-rendered PNG rail for the story card.
- `apps/web/src/components/share-bar.tsx` — reuse, don't fork
  (`canShare` hydration gate lesson).
- `apps/web/src/components/attribution-link.tsx` (PLG L1) — free-tier badge
  + UTM on public news surfaces.
- `apps/web/src/lib/analytics-events.ts` — event naming + snake_case props
  (PLG L4).
- Help-content markdown pipeline (sanitizing renderer) — find via the help
  page renderer; **posts must use this exact pipeline** (org-authored
  content on public pages — no new renderer, no dangerouslySetInnerHTML).
- Hero upload: entrant badge upload rail (#130) + public supabase
  `publicStorageUrl` pattern (v12 logos lesson).

**Depends:** PROMPT-82 merged. **No migrations.**

## Design contract (from SPEC-2 "Design direction" — binding)

- Night-mode **matchday programme**, not a blog. `--ps-*` tokens, Barlow
  Condensed display, scorebug vernacular.
- Signature: **a result post IS a scorebug** — feed card + post hero render
  scoreline in huge condensed tabular numerals + crests when no hero image
  is uploaded. An empty hero is NEVER a grey placeholder. Component:
  `components/news/post-scorebug.tsx` (feeds both sizes).
- Kind eyebrows: `RESULT` lime / `RECAP` white / `ANNOUNCEMENT` red /
  `CLUB NEWS` muted. Dates set like fixture timestamps (venue-tz).
- Post body: measure-limited ~68ch; share-bar after the fold on mobile.
- Landing strip = three compact rows, not cards.
- OG 1200×630 + story PNG 1080×1350: night bg, crest pair, kind accent bar,
  scoreline dominant; free tier = seazn badge, Pro = org branding via
  `public-theme.ts`.
- Motion: ONE moment — score digits settle on post-page load, CSS only,
  `prefers-reduced-motion` honored. Nothing else animates.
- Console: `.app-*` panel/table idiom, composer on `.input`/`.label`,
  ⚡ auto and stale as chips, not banners.

## Files

- **Create** `apps/web/src/components/news/post-scorebug.tsx`
- **Create** `apps/web/src/components/news/post-card.tsx` (feed card)
- **Create** `apps/web/src/components/news/composer.tsx`
- **Create** `apps/web/src/components/news/news-tab.tsx` (console: drafts
  queue + published list + composer modal/panel)
- **Modify** org console navigation — mount News tab (manual posts every
  plan; the division `auto_posts` toggle rides the existing division
  Settings tab with PlusReveal on 403 — small addition here)
- **Create** `apps/web/src/app/(public)/shared/[orgSlug]/news/page.tsx`
  (feed, paginated 20)
- **Create** `apps/web/src/app/(public)/shared/[orgSlug]/news/[postSlug]/page.tsx`
- **Create** `…/news/[postSlug]/opengraph-image.tsx`
- **Create** `…/news/[postSlug]/story.png/route.tsx` (1080×1350; "Download
  image card" button on published result posts links here)
- **Modify** `apps/web/src/app/(public)/shared/[orgSlug]/page.tsx` — latest-
  news strip (3 rows, only when posts exist)
- **Modify** `analytics-events.ts` — `post_created`, `post_published`
  (props: `kind`, `auto` boolean), `post_shared`, `post_card_downloaded`;
  fire at the natural seams (created/published server-side next to the
  usecase, shared/downloaded client-side)
- **Modify** i18n keys + 4 dictionaries (console strings; public chrome
  strings ride the existing public dict rail — note the /o DictProvider
  serialization gotcha: keep new public strings in the right namespace)
- **Create** `apps/web/content/help/sharing/news.md` + slug registry
- **Modify** `scripts/smoke.ts` — pro path: decide fixture in opted-in
  division → draft listed → publish via API → public feed 200 + post page
  200 + story.png 200 (seed data FIRST); free path: manual post create +
  publish → public page 200; auto toggle PUT → 403
- **Create** `apps/web/e2e/news.spec.ts`

## Build steps

- [ ] **Step 1 — post-scorebug, test first.** Renders scoreline + crests
  from props; falls back cleanly when a crest is missing; digits use
  tabular-nums. FAIL → implement → PASS.
- [ ] **Step 2 — Feed + post pages.** Server components over
  `publicPosts`/`publicPost`; kind eyebrows; markdown body through the help
  sanitizer pipeline; share-bar + attribution-link mounted; pagination
  ("Older posts" link, `?page=`). generateMetadata wires the OG image.
  e2e asserts markup targets (public pages test against markup, not
  labels — v5 lesson).
- [ ] **Step 3 — OG + story PNG.** Clone the OG idiom for the post card;
  story route reuses the same layout component at 1080×1350. Branding
  split: free = seazn badge (attribution rail), Pro = `public-theme.ts`
  org colors + crest. Snapshot-ish test: route 200 + content-type +
  free-vs-pro pixel-independent assertion (e.g., rendered tree includes
  badge element only for free org).
- [ ] **Step 4 — Console News tab + composer.** Drafts queue (⚡ chip when
  `autoSource`, stale chip when `autoSource.stale`), published list,
  composer (title/body/hero upload via badge rail/scope pickers), publish
  action with the frozen-slug rule surfaced in copy ("URL locks on first
  publish"). Division Settings gains the auto_posts toggle (PlusReveal).
- [ ] **Step 5 — Analytics.** Four events wired; unit test the two
  server-side fires (created/published) — mirror how L6
  `competition_made_public` is tested.
- [ ] **Step 6 — Motion.** Digit-settle CSS animation on the post hero
  behind `@media (prefers-reduced-motion: no-preference)`.
- [ ] **Step 7 — i18n + help closing pass** (parity + slug registry green).
- [ ] **Step 8 — e2e** (`news.spec.ts`): full loop — decide fixture →
  draft in console → edit → publish → public feed shows card → post page
  scorebug + share-bar → download button hits story.png 200. Mobile
  project: feed + post page + composer.
- [ ] **Step 9 — Smoke** per Files; run locally.
- [ ] **Step 10 — Screenshots** both viewports: feed, result post (scorebug
  hero), news-tab drafts queue, composer, story PNG output opened as image.
  Fix what reads cramped.
- [ ] **Step 11 — Verify + commit.** `tsc` + unit + parity + e2e + smoke.
  Commit: `feat(news): console tab, public feed/post, OG + story cards, analytics`.
