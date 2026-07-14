# Seazn Games platform + Chess Quest — design

**Date:** 2026-07-14
**Status:** Approved (design review 2026-07-14)

## Goal

Add a games surface to seazn.club: a branded listing of playable browser games at
`seazn.club/games` (also served as `games.seazn.club`), each game playable at
`seazn.club/games/<slug>`. First game: **Chess Quest**, a ground-up TypeScript/React
rewrite of the standalone chess-learning PWA (`~/GitHub/chess-quest`), re-skinned to
the Seazn design language. The platform must make adding future games cheap: one
folder + one registry entry.

Decisions locked during design review:

| Decision | Choice |
|----------|--------|
| Integration approach | Ground-up React rewrite inside `apps/web` (no iframe, no vendored static bundle) |
| URL slugs | Descriptive (`/games/chess-quest`), not numbered |
| Progress storage | localStorage v1 (account/Postgres sync is a later phase) |
| Visual identity | Seazn design language (Tailwind v4, existing tokens), not the original Chess Quest theme |
| Content | Code is new; curriculum/puzzle **content** (48 lessons, 2 tracks, 9 lands, puzzle FENs, Story/Classic copy) is carried over from chess-quest data files, re-typed in TS |
| PWA | None for games v1 — no service worker, no separate manifest (SW staleness burned us in chess-quest dev) |
| Original repo | `~/GitHub/chess-quest` and the kid's play copy stay untouched; this is a fork-by-rewrite |

## Architecture

### 1. Games platform (`apps/web/src/games/`)

New top-level folder inside the web app. Everything game-related lives here except
the two route files.

- **`src/games/registry.ts`** — the single source of truth for what games exist.
  ```ts
  type GameMeta = {
    slug: string;          // URL segment: /games/<slug>
    title: string;
    tagline: string;       // one-liner for the listing card
    description: string;   // longer copy for SEO/meta
    thumbnail: string;     // emoji or /public path for the card art
    status: "live" | "coming-soon";
  };
  ```
  Each entry pairs `GameMeta` with a lazy component loader
  (`() => import("./chess-quest")`) so game code is code-split per game and the
  listing page ships none of it. Adding a game later = new `src/games/<slug>/`
  folder + one registry entry.

- **`app/(public)/games/page.tsx`** — listing page. Seazn-branded card grid from the
  registry (server component; metadata for SEO). `coming-soon` games render as
  non-clickable cards.

- **`app/(public)/games/[slug]/page.tsx`** — player page. Server shell resolves the
  slug against the registry (404 on miss via `notFound()`), renders a slim header
  bar ("← Games", game title) above a full-viewport client component loaded via the
  registry's lazy loader. `generateStaticParams` from the registry;
  `generateMetadata` from `GameMeta`.

- **Note:** repo `AGENTS.md` warns this Next.js version differs from training data —
  read `node_modules/next/dist/docs/` for routing/metadata conventions before
  writing the route files.

### 2. Subdomain wiring (`src/proxy.ts`)

Host-based rewrite added to the existing proxy:

- Requests with host `games.seazn.club` (and `games.` + staging host) rewrite into
  the `/games` tree: `/` → `/games`, `/<slug>` → `/games/<slug>`. Static/_next asset
  requests pass through untouched (matcher already excludes them).
- Guard against double-prefixing (`games.seazn.club/games/x` must not become
  `/games/games/x`).
- Canonical URLs on both routes point at `https://seazn.club/games/...` so the
  subdomain doesn't split SEO.
- CSRF check in the proxy compares Origin host to app host — verify a
  `games.seazn.club` page never posts to `/api/*`; games v1 makes no API calls, so
  no change needed, but the e2e smoke should confirm pages render on the subdomain.
- `sitemap.ts` gains `/games` + one entry per live game.
- **Manual infra (user action, not code):** DNS CNAME `games.seazn.club` → Fly app;
  `fly certs add games.seazn.club` (staging likewise if desired).

CSP needs no carve-out: these are normal React pages and get the per-request nonce
like every other route.

### 3. Chess Quest (`src/games/chess-quest/`)

Ground-up rewrite, organized so each unit is independently testable:

- **`engine/`** — pure TS, zero DOM. Board representation (64-array, same square
  indexing as the original for content compatibility), move generation per piece,
  legality (own-king safety), check/checkmate/stalemate detection, and the puzzle
  verifiers: `hasMateIn1`, `isMateIn2After` (move → every reply → mate-in-1),
  `bestDefense` (reply minimizing mating continuations). Castling/en passant/
  promotion to the extent the curriculum needs them (original engine scope).
- **`content/`** — typed data modules: `lands.ts` (9 lands incl. Track 2: ♗
  Combination Canyon, ♞ Opening Harbor, ♜ Endgame Glacier, ♛ Strategy Summit),
  `lessons.ts` (48 lessons, Track 1 = 1–24, Track 2 = 25–48, each with `game` id +
  `gameOpts`), `puzzles.ts` (MATE1, MATE2 — 12 puzzles, TACTICS fork/pin/skewer/
  discovered incl. the 2-move variants), `copy.ts` (Story vs Classic register — the
  kid voice and adult coaching voice — with a `t()`-style lookup). Content is
  transcribed from the chess-quest data files, not re-authored.
- **`components/`** — React, Tailwind v4 with Seazn tokens (reference
  `app/globals.css` + existing public pages for palette/spacing/typography):
  - `Board` — interactive chessboard (tap-tap move selection like the original;
    drag optional later), legal-move hints, last-move + check highlights.
  - Eight mini-games, one component each, sharing a `GameShell` (status line,
    coach messages, star award, next/retry): `SquareRace`, `CoinHop`, `PawnWars`,
    `MateInOne`, `MateInTwo` (two-phase: forcing move → auto black best-defense →
    finish mate; accepts any verified forcing move), `HangingHunt`,
    `TacticTrainer`, `RookMaze`.
  - `QuestMap` — lesson map with Track 1/Track 2 section headers, land groupings,
    stars, lock/unlock state.
  - `ProgressPanel` — streak (activity-date chain, gaps ≤ 2 days), stat tiles,
    track progress bars, 14-day dot strip, stars/packs table.
  - `ProfileSwitcher` — create/select/rename profiles; per-profile copy register
    (Story/Classic).
  - `Certificate` — printable; print CSS swaps the page for a light-palette cert
    sheet; title varies by tracks completed.
- **`store/`** — localStorage persistence under key `seazn-games:chess-quest:v1`
  (fresh key — no migration from the standalone app; different origin anyway).
  Profiles, per-profile progress (stars, completed lessons, activity dates),
  settings. Exposed to React through a context + `useQuestStore()` hook; writes are
  synchronous on state change; boot hydration guarded for SSR (`typeof window`).
- **Timers:** all game timers (solve-advance delays, black-reply delays, coach
  resets) live inside components via `useEffect` cleanup — the original's leaked-
  setTimeout bug class is structurally prevented; no shared timer registry needed.
- **Audio/voice:** small `useSfx` (WebAudio beeps) + `useVoice`
  (speechSynthesis) hooks, both no-op when unavailable. CSP-safe (no external
  fetches).

### 4. Error handling

- Unknown slug → `notFound()`.
- Corrupt/unparseable localStorage → discard and start fresh (v1 key only; log to
  console, no Sentry noise).
- Engine verifier failures on content are build-time concerns caught by tests, not
  runtime paths.

### 5. Testing

- **Vitest (apps/web already configured):**
  - `engine` unit tests — move gen per piece, legality, check/mate/stalemate,
    mate-in-1/2 verifiers (port the *intent* of `chess-quest/test/engine.test.mjs`).
  - **Content verification suite** — every MATE1 puzzle has ≥1 mate-in-1; every
    MATE2/TACTICS2 puzzle passes `isMateIn2After` with **no hidden mate-in-1**
    (this check caught two bad promotion puzzles before); curriculum shape (48
    lessons, ids unique, every `game` id exists in the mini-game set).
  - `store` tests — profiles, streak chain (≤2-day gaps), corrupt-state recovery
    (localStorage shim like the original store tests).
  - Registry/route tests — every registry slug resolves a component; metadata
    complete.
- **Playwright e2e (repo already has a suite):** smoke — `/games` lists Chess
  Quest; `/games/chess-quest` boots to profile/map; host-rewrite check for the
  subdomain (Playwright `extraHTTPHeaders` Host or local hosts mapping, matching
  however existing e2e handles hosts).

### 6. Phased delivery

| Phase | Scope | Ships |
|-------|-------|-------|
| A | Platform shell: registry, `/games` listing, `/games/[slug]` player chrome, proxy host rewrite, sitemap; Chess Quest registered as `coming-soon` | Listing live end-to-end incl. subdomain |
| B | Engine + content + verification tests | Pure logic, fully green |
| C | Board + the 8 mini-games (free-play entry from a simple menu) | Chess Quest flips to `live` |
| D | Quest map, profiles, store, progress panel, certificate | Full quest experience |
| E | Sfx/voice, SEO polish, e2e smoke, listing card art | Launch quality |

Each phase lands as a normal PR through the repo's usual checks.

## Out of scope (v1)

- Account-linked progress in Postgres (explicitly deferred; localStorage key is
  namespaced so a later sync layer can migrate it).
- PWA/offline for games.
- Minimax play-vs-computer opponent (was "next candidate" in chess-quest; still
  future).
- Any change to the standalone chess-quest repo.
