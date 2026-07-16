# PROMPT-65 — Per-player stats on the player profile + self-service photo

**Sport-agnostic.** Player stats come from the module's `playerStats` model
(football goals/cards/MOTM, cricket runs/wickets, …); the profile renders
whatever metrics the sport declares. Photo upload is sport-neutral. No per-sport
code.

**Read first:**
- `apps/web/src/server/public-site/data.ts` — `getPublicPlayer` (~line 376):
  today it selects only `id, org_id, name, photo` + division memberships. **No
  stats.** This is where the per-player stat block is added.
- `apps/web/src/server/usecases/player-stats.ts` — `player_stat_snapshots`
  (person_id, division_id, sport_key, stats jsonb, computed_through_seq) and
  `recomputePlayerStats`; `divisionPlayerStats` (the leaderboard, gated by
  `stats.player`). The profile reads the same snapshots.
- `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx`
  — the public player card that renders name/photo/memberships; add the stat block.
- `apps/web/src/components/v2/stats-panel.tsx` — the console leaderboard; its rows
  should link to the player profile.
- Photo (already built, organiser-only): `apps/web/src/app/api/v1/persons/[id]/photo/route.ts`
  (multipart → `uploadPersonPhoto` in `usecases/persons.ts`, `assets` bucket,
  display gated by `public_photo` consent) and `components/v2/persons-panel.tsx`
  (the console upload UI). The gap is **self-service**: `api/v1/me/persons/[id]/`
  has only `consent/`, and `app/(app)/me` has no photo upload.

**Depends:** none. **Migration:** none (stats snapshots + photo storage exist).

## Context

Two things a player expects to see about themselves are missing:

1. **Stats never appear on the player profile.** The leaderboard exists (console
   Stats tab, Pro `stats.player`), but the public player card shows only
   name/photo/divisions — a player's own goals/cards/MOTM are nowhere on their
   profile, and leaderboard rows don't link anywhere.

2. **Players can't upload their own photo.** Only an organiser can, via
   PersonsPanel. A claimed player on `/me` has no photo control.

## Task

### 1. Per-player stats on the profile

- Extend `getPublicPlayer` to also read this person's `player_stat_snapshots`
  across their (consent-visible) divisions, plus the sport module's metric
  labels/order (`playerStats` model) for display.
- Render a **stat block** on the player card: per-division totals (goals,
  assists, cards, MOTM — whatever the sport declares), sport-neutral (labels come
  from the module, not hardcoded). Respect the same consent gate as the card
  (`public_players_v`); show nothing sensitive for non-consented players.
- **Free vs Pro:** the public leaderboard is Pro (`stats.player`); decide and
  document whether the profile stat block follows the same gate or is always
  shown for consented players. (Recommend: show basic totals on the profile even
  when the org isn't Pro — the org already entered the events; the leaderboard
  *table* stays the Pro surface.)
- Link `stats-panel.tsx` leaderboard rows → the player profile.

### 2. Self-service player photo (`/me`)

- New `POST /api/v1/me/persons/[id]/photo` (+ `DELETE` to remove): auth = the
  signed-in user **owns/claims** this person (same ownership check the existing
  `me/persons/[id]/consent` route uses). Reuse `uploadPersonPhoto` — do **not**
  duplicate storage logic.
- Add a photo upload + preview control on the `/me` claimed-player screen
  (mirrors PersonsPanel's uploader), alongside the existing consent card, so a
  player manages their own photo and its `public_photo` visibility.
- Organiser path (PersonsPanel) is unchanged.

## Tests (regression — each fails without its change)

- `getPublicPlayer` returns a stat block for a player with snapshot rows;
  a non-consented player exposes no stats; labels come from the sport module
  (test two sports).
- Profile page renders the stat block when present, nothing when absent (no
  layout shift), and leaderboard rows link to the profile.
- `POST /me/persons/{id}/photo`: the owning user succeeds and `photo_path` is
  set; a non-owner is 403; the organiser route still works.

## Non-goals

- No new stats computation — reads existing `player_stat_snapshots`.
- No new storage pipeline — reuse `uploadPersonPhoto`/`assets` bucket.
- No cross-competition career aggregation (per-division totals on the profile is
  the scope; a career view can be a later prompt).

## Help / docs pass (mandatory)

`content/help/*`: player stats on profiles (what shows, consent), and how a
claimed player uploads their own photo. Same PR.
