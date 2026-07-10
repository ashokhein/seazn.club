# 09 — Public Open Dashboard

The shareable, no-login microsite for a competition. This is the product's marketing
surface: every spectator link is an acquisition channel. Platform-level promotion of
these dashboards (homepage showcase, /discover directory, opt-in consent) is
[15-public-discovery.md](15-public-discovery.md).

## 1. URLs

```
/{orgSlug}                                     org landing: public competitions
/{orgSlug}/{competitionSlug}                   competition home
/{orgSlug}/{competitionSlug}/{divisionSlug}    division home (schedule/standings tabs)
/{orgSlug}/{competitionSlug}/{divisionSlug}/fixtures/{id}   live match page
/{orgSlug}/{competitionSlug}/players/{personId}             player card (consent-gated)
```
Reserved-slug guard (org slugs can't collide with app routes: `api`, `admin`,
`dashboard`, `login`, …). Visibility: `public` (indexed, sitemap), `unlisted` (link-only,
noindex), `private` (404). QR poster generator per competition (qrcode dep already present).

## 2. Pages & content

### Competition home
- Hero: name, org branding (Pro: logo/colors/banner/sponsors — doc 10), dates, venue,
  markdown **description** (schedule notes, rules summary, contact).
- Division cards: sport icon, variant badge ("T20", "U16"), status, entrant count.
- "Live now" strip: in-play fixtures across divisions with live summaries.

### Division home — three tabs
1. **Schedule** — fixtures by round/date; upcoming (time, venue/court) and decided
   (`ScoreSummary.headline`); filter by entrant; `.ics` calendar feed per division/entrant.
2. **Standings** — sport-correct table from `standings_snapshots`: football shows
   P W D L GF GA GD Pts; cricket shows P W L T/NR Pts NRR; volleyball shows sets/points
   ratio; chess shows Score, Buchholz Cut-1, SB. Column set comes from the sport module's
   `MetricSpec[]` (label, format, precision) — **no per-sport UI code**. Tie explanations:
   hover/tap on a rank shows which cascade rule separated the tie ("ahead on head-to-head").
   Bracket view for knockout stages; ladder view for stepladder.
3. **Entrants / Players** — team cards → roster (name-consent filtered: initials when
   consent absent, doc 06 §4.7); player card: photo (consented), squad number, position,
   per-sport profile attrs, competition stats (Pro: runs/wickets, goals, W-D-L).

### Live match page
- Sport-shaped scoreboard rendered from `summary(state)`: cricket over-by-over +
  current batters/bowler + DLS par (Pro); volleyball set boxes; football timeline of
  goal/card events; chess result list.
- Updates: Supabase Realtime `fixture:{id}` topic for Pro orgs; 15 s polling otherwise
  (existing entitlement split).

## 3. Rendering & performance

- Server Components reading **public views only** (doc 07 note 4) — the consent and
  visibility filters are structurally unavoidable.
- ISR: competition/division pages `revalidate: 30`, entrant/player pages 300;
  `revalidateTag('division:{id}')` fired by the same write hooks that publish realtime.
- Read `node_modules/next/dist/docs/` before implementing — caching/ISR APIs may differ
  in this Next.js version (per AGENTS.md).
- SEO: `sportsEvent` JSON-LD on fixtures, OG images per competition (dynamic OG route
  with standings snapshot), sitemap for `public` competitions.
- Zero auth = CDN-cacheable; CSP already handled by proxy.

## 3.1 Implementation notes (PROMPT-12, `apps/web/src/app/(public)/…`)

- **Tie explanations** come from a `tieBreak {key, with}` trace the ranking pass
  (`rankStandings`) now writes onto each snapshot row — the finest cascade rule
  that separated the row from the entrants it was tied with. Swiss cascade
  metrics (Buchholz/Cut-1/SB) are materialised into `row.metrics` at rank time
  so the table can render them from the snapshot alone.
- **Standings columns**: module `MetricSpec[]` (new optional `display: false`
  hides ledger-only operands like NRR inputs or card counts) + cascade-derived
  columns (NRR, set/point ratio, Buchholz…) whose labels/formulas live in
  `@seazn/engine/competition` `display.ts` — still zero per-sport UI code.
- **ISR**: `revalidate = 30` pages over `unstable_cache` loaders tagged
  `division:{id}` / `competition:{id}` (this Next version's pre-cacheComponents
  model); scoring writes and stage generate/complete fire `revalidateTag`
  alongside the realtime publish and Redis invalidation.
- **Description** renders as plain text (pre-line), not markdown — no md
  renderer shipped yet.
- **Live page depth**: the scoreboard renders the sport module's ScoreSummary
  (headline + per-side lines) generically; over-by-over / DLS / timeline
  widgets are doc 14 fidelity work, not built here.

## 4. Entitlement split (detail in doc 10)

| Capability | Community | Pro |
|-----------|-----------|-----|
| Public dashboard | 1 public competition at a time, platform-branded | unlimited, custom branding, sponsor row |
| Live updates | 15 s poll | realtime push |
| Player cards | name + results | photos, stats, profiles |
| Calendar feeds, QR posters | ✓ | ✓ |
| "Powered by seazn.club" footer | fixed | removable |
