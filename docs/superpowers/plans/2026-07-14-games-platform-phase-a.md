# Seazn Games Platform — Phase A (Platform Shell) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the games surface end-to-end: `/games` listing, `/games/[slug]` player page, `games.seazn.club` host rewrite, sitemap entries — with Chess Quest registered as `coming-soon`.

**Architecture:** A pure-data games registry (`src/games/registry.ts`) drives a server-rendered listing page and a dynamic player route. Game components load client-side via a separate `player-map.tsx` (keeps the registry importable from server code like `sitemap.ts`). The existing `src/proxy.ts` gains a host rewrite so any `games.*` host maps into the `/games` route tree.

**Tech Stack:** Next.js 16.2.9 App Router (repo warning: differs from training data — `params` is a `Promise`, copy repo patterns, e.g. `src/app/discover/[sport]/page.tsx`), React 19, Tailwind CSS v4, Vitest (node env, `@` → `src` alias), Playwright.

**Spec:** `docs/superpowers/specs/2026-07-14-seazn-games-chess-quest-design.md` (this plan = Phase A only; Phases B–E get their own plans later).

## Global Constraints

- Branch: `games-platform` (already exists, spec committed on it). Work from `~/GitHub/seazn.club`.
- All app code under `apps/web`. Run commands from `apps/web` unless the command shows another cwd.
- No database access for games — the registry is static data.
- Registry slugs: `^[a-z0-9-]+$`, descriptive (`chess-quest`), never numbered.
- Canonical URLs always point at `https://seazn.club/games/...` (never the subdomain).
- `src/games/registry.ts` must stay free of client-component imports (server code imports it).
- Follow existing public-page styling: `MarketingShell`, `mk-display` display face, purple/slate palette, `btn btn-primary` / `btn btn-ghost` (see `src/app/discover/[sport]/page.tsx`).
- Conventional commits, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- One deviation from spec locked here: no `generateStaticParams` — the CSP nonce in `src/proxy.ts` forces per-request rendering anyway, and no existing dynamic public route uses it.

---

### Task 1: Games registry

**Files:**
- Create: `apps/web/src/games/registry.ts`
- Test: `apps/web/src/__tests__/games-registry.test.ts`

**Interfaces:**
- Produces: `type GameMeta = { slug: string; title: string; tagline: string; description: string; thumbnail: string; status: "live" | "coming-soon" }`; `const GAMES: GameMeta[]`; `function getGame(slug: string): GameMeta | undefined`; `function liveGames(): GameMeta[]`. Consumed by Tasks 2–6.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/__tests__/games-registry.test.ts
import { describe, expect, it } from "vitest";
import { GAMES, getGame, liveGames } from "@/games/registry";

describe("games registry", () => {
  it("has at least chess-quest", () => {
    expect(getGame("chess-quest")).toMatchObject({ title: "Chess Quest" });
  });

  it("slugs are unique, url-safe, descriptive", () => {
    const slugs = GAMES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug).not.toMatch(/^game-\d+$/); // spec: descriptive, never numbered
    }
  });

  it("every entry has complete card copy", () => {
    for (const g of GAMES) {
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.tagline.length).toBeGreaterThan(0);
      expect(g.description.length).toBeGreaterThan(20);
      expect(g.thumbnail.length).toBeGreaterThan(0);
      expect(["live", "coming-soon"]).toContain(g.status);
    }
  });

  it("getGame misses return undefined", () => {
    expect(getGame("not-a-game")).toBeUndefined();
  });

  it("liveGames filters by status", () => {
    for (const g of liveGames()) expect(g.status).toBe("live");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/web`): `npx vitest run src/__tests__/games-registry.test.ts`
Expected: FAIL — `Cannot find module '@/games/registry'` (or equivalent resolve error).

- [ ] **Step 3: Write the registry**

```ts
// apps/web/src/games/registry.ts
// Seazn Games registry — the single source of truth for what games exist.
// Pure data: server code (sitemap, pages) imports this, so no client
// components here. Game React components are wired in player-map.tsx.
// Adding a game = new src/games/<slug>/ folder + one entry here
// (+ a player-map entry once it is playable).

export type GameMeta = {
  slug: string; // URL segment: /games/<slug>
  title: string;
  tagline: string; // one-liner for the listing card
  description: string; // longer copy for SEO/meta
  thumbnail: string; // emoji for the card art
  status: "live" | "coming-soon";
};

export const GAMES: GameMeta[] = [
  {
    slug: "chess-quest",
    title: "Chess Quest",
    tagline: "Learn chess from first move to checkmate — one quest at a time.",
    description:
      "A free chess learning adventure: 48 bite-size lessons across two tracks, from how the pieces move to mate-in-two tactics. Play mini-games, earn stars, and track your streak — right in the browser.",
    thumbnail: "♟️",
    status: "coming-soon",
  },
];

export function getGame(slug: string): GameMeta | undefined {
  return GAMES.find((g) => g.slug === slug);
}

export function liveGames(): GameMeta[] {
  return GAMES.filter((g) => g.status === "live");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/games-registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/games/registry.ts apps/web/src/__tests__/games-registry.test.ts
git commit -m "feat(games): games registry with chess-quest entry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Player map + Chess Quest placeholder component

**Files:**
- Create: `apps/web/src/games/player-map.tsx`
- Create: `apps/web/src/games/chess-quest/index.tsx`
- Test: `apps/web/src/__tests__/games-player-map.test.ts`

**Interfaces:**
- Consumes: `liveGames()` from `@/games/registry` (Task 1).
- Produces: `PLAYER_MAP: Record<string, ComponentType>` (client module) — Task 4's `GamePlayer` reads it. `src/games/chess-quest/index.tsx` default-exports the game's root client component (Phase C replaces its body).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/__tests__/games-player-map.test.ts
import { describe, expect, it } from "vitest";
import { liveGames } from "@/games/registry";
import { PLAYER_MAP } from "@/games/player-map";

describe("games player map", () => {
  it("every live game has a playable component", () => {
    for (const g of liveGames()) {
      expect(PLAYER_MAP[g.slug], `missing PLAYER_MAP entry for ${g.slug}`).toBeDefined();
    }
  });

  it("chess-quest is wired (ready for the Phase C status flip)", () => {
    expect(PLAYER_MAP["chess-quest"]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/games-player-map.test.ts`
Expected: FAIL — cannot resolve `@/games/player-map`.

- [ ] **Step 3: Write placeholder component and player map**

```tsx
// apps/web/src/games/chess-quest/index.tsx
"use client";

// Phase A placeholder — proves the registry → player-map → lazy-load path.
// Phase C replaces this with the real Chess Quest root component.
export default function ChessQuest() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="text-6xl">♟️</div>
      <h2 className="mk-display text-2xl font-bold text-purple-950">Chess Quest</h2>
      <p className="max-w-sm text-sm text-slate-500">
        The quest is being prepared. Check back soon!
      </p>
    </div>
  );
}
```

```tsx
// apps/web/src/games/player-map.tsx
"use client";

// slug → lazily loaded game component. Lives apart from registry.ts so the
// registry stays pure data that server code (sitemap, metadata) can import;
// next/dynamic keeps each game's bundle out of every other page.
import dynamic from "next/dynamic";
import type { ComponentType } from "react";

const loading = () => (
  <div className="flex h-full items-center justify-center text-sm text-slate-400">
    Loading game…
  </div>
);

export const PLAYER_MAP: Record<string, ComponentType> = {
  "chess-quest": dynamic(() => import("./chess-quest"), { ssr: false, loading }),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/games-player-map.test.ts`
Expected: PASS (2 tests). If vitest chokes on the `"use client"` directive or `next/dynamic`, it is a transform config issue — check that the file extension is `.tsx` and rerun; do not move the map into the registry.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/games/player-map.tsx apps/web/src/games/chess-quest/index.tsx apps/web/src/__tests__/games-player-map.test.ts
git commit -m "feat(games): player map + chess-quest placeholder component

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: /games listing page

**Files:**
- Create: `apps/web/src/app/games/page.tsx`

**Interfaces:**
- Consumes: `GAMES` from `@/games/registry`; `MarketingShell` from `@/components/marketing/marketing-shell`.
- Produces: the `/games` route (later rewritten-to by the subdomain, Task 5).

- [ ] **Step 1: Write the page**

```tsx
// apps/web/src/app/games/page.tsx
// /games — Seazn Games listing. Cards come straight from the registry;
// coming-soon games render as non-clickable cards with a badge.
import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { GAMES } from "@/games/registry";

export const metadata: Metadata = {
  title: "Games — free browser games | Seazn Club",
  description:
    "Play free browser games by Seazn Club. Learn-to-play quests and quick challenges — no install, no sign-up.",
  alternates: { canonical: "https://seazn.club/games" },
};

export default function GamesPage() {
  return (
    <MarketingShell>
      <main className="mx-auto max-w-5xl px-4 py-12">
        <h1 className="mk-display text-4xl font-bold text-purple-950">Games</h1>
        <p className="mt-3 max-w-2xl text-lg text-slate-600">
          Free games in your browser — pick one and play. No install, no sign-up.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GAMES.map((g) =>
            g.status === "live" ? (
              <Link
                key={g.slug}
                href={`/games/${g.slug}`}
                className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-purple-300 hover:shadow-md"
              >
                <div className="text-5xl">{g.thumbnail}</div>
                <h2 className="mk-display mt-3 text-xl font-bold text-purple-950 group-hover:text-purple-700">
                  {g.title}
                </h2>
                <p className="mt-1 text-sm text-slate-500">{g.tagline}</p>
                <span className="mt-3 inline-block text-sm font-medium text-purple-600">
                  Play →
                </span>
              </Link>
            ) : (
              <div
                key={g.slug}
                className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5"
              >
                <div className="text-5xl opacity-60">{g.thumbnail}</div>
                <h2 className="mk-display mt-3 text-xl font-bold text-slate-500">{g.title}</h2>
                <p className="mt-1 text-sm text-slate-400">{g.tagline}</p>
                <span className="mt-3 inline-block rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  Coming soon
                </span>
              </div>
            ),
          )}
        </div>
      </main>
    </MarketingShell>
  );
}
```

- [ ] **Step 2: Verify in the dev server**

Run (from `apps/web`): `npm run dev` (background), then:

```bash
curl -s http://localhost:3000/games | grep -o "Chess Quest" | head -1
curl -s http://localhost:3000/games | grep -o "Coming soon" | head -1
```

Expected: both grep hits. (Page-level e2e assertion lands in Task 7.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/games/page.tsx
git commit -m "feat(games): /games listing page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: /games/[slug] player page

**Files:**
- Create: `apps/web/src/app/games/[slug]/page.tsx`
- Create: `apps/web/src/app/games/[slug]/game-player.tsx`

**Interfaces:**
- Consumes: `getGame` from `@/games/registry`; `PLAYER_MAP` from `@/games/player-map`.
- Produces: the `/games/<slug>` route. `GamePlayer` (client) is internal to this route.

- [ ] **Step 1: Write the client player wrapper**

```tsx
// apps/web/src/app/games/[slug]/game-player.tsx
"use client";

import { PLAYER_MAP } from "@/games/player-map";

export function GamePlayer({ slug }: { slug: string }) {
  const Game = PLAYER_MAP[slug];
  // A live registry entry without a PLAYER_MAP entry is a wiring bug —
  // the games-player-map unit test guards it; render nothing rather than crash.
  if (!Game) return null;
  return <Game />;
}
```

- [ ] **Step 2: Write the server page**

Note Next 16 convention: `params` is a `Promise` — `await` it (pattern: `src/app/discover/[sport]/page.tsx`).

```tsx
// apps/web/src/app/games/[slug]/page.tsx
// /games/<slug> — game player page. Slim chrome (no marketing footer):
// header bar + full-height game area. Coming-soon games get a teaser panel.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getGame } from "@/games/registry";
import { GamePlayer } from "./game-player";

type Params = { slug: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const game = getGame(slug);
  if (!game) return {};
  return {
    title: `${game.title} — play free | Seazn Club`,
    description: game.description,
    // Canonical always on the apex domain so games.seazn.club doesn't split SEO.
    alternates: { canonical: `https://seazn.club/games/${slug}` },
  };
}

export default async function GamePage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const game = getGame(slug);
  if (!game) notFound();

  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-2">
        <Link href="/games" className="text-sm font-medium text-purple-600 hover:text-purple-800">
          ← Games
        </Link>
        <span className="text-sm text-slate-300">|</span>
        <h1 className="mk-display text-base font-bold text-purple-950">{game.title}</h1>
      </header>
      <main className="min-h-0 flex-1">
        {game.status === "live" ? (
          <GamePlayer slug={game.slug} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-16 text-center">
            <div className="text-6xl">{game.thumbnail}</div>
            <h2 className="mk-display text-2xl font-bold text-purple-950">
              {game.title} is coming soon
            </h2>
            <p className="max-w-md text-sm text-slate-500">{game.description}</p>
            <Link href="/games" className="btn btn-ghost mt-2">
              Browse other games
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Verify in the dev server**

```bash
curl -s http://localhost:3000/games/chess-quest | grep -o "coming soon" | head -1
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/games/not-a-game
```

Expected: `coming soon` and `404`.

Then flip the wiring check (do NOT commit this change): in `registry.ts` set chess-quest `status: "live"`, reload `http://localhost:3000/games/chess-quest` in the browser — the ♟️ placeholder from Task 2 must render (proves registry → player-map → dynamic import). Revert to `"coming-soon"` and confirm `git diff apps/web/src/games/registry.ts` is clean before committing.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/games/[slug]/page.tsx" "apps/web/src/app/games/[slug]/game-player.tsx"
git commit -m "feat(games): /games/[slug] player page with coming-soon teaser

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: games.* host rewrite in the proxy

**Files:**
- Modify: `apps/web/src/proxy.ts` (CSRF host block ~lines 84–108; page branch ~lines 114–129)
- Test: `apps/web/src/__tests__/proxy-games-host.test.ts`

**Interfaces:**
- Consumes: existing `proxy(request)` in `src/proxy.ts`.
- Produces: exported `gamesHostRewrite(request: NextRequest): URL | null` (exported for tests) and `requestHostname(request: NextRequest): string` (extracted helper reused by the CSRF block).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/__tests__/proxy-games-host.test.ts
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy, gamesHostRewrite } from "@/proxy";

const req = (path: string, headers: Record<string, string>) =>
  new NextRequest(`http://localhost:3000${path}`, { headers });

const GAMES_HOST = { host: "games.seazn.club" };

describe("games subdomain host rewrite", () => {
  it("rewrites / to /games", () => {
    expect(gamesHostRewrite(req("/", GAMES_HOST))?.pathname).toBe("/games");
  });

  it("rewrites /chess-quest to /games/chess-quest", () => {
    expect(gamesHostRewrite(req("/chess-quest", GAMES_HOST))?.pathname).toBe(
      "/games/chess-quest",
    );
  });

  it("never double-prefixes /games paths", () => {
    expect(gamesHostRewrite(req("/games", GAMES_HOST))).toBeNull();
    expect(gamesHostRewrite(req("/games/chess-quest", GAMES_HOST))).toBeNull();
  });

  it("does not rewrite API calls", () => {
    expect(gamesHostRewrite(req("/api/v1/public/discovery", GAMES_HOST))).toBeNull();
  });

  it("ignores non-games hosts (incl. lookalike paths)", () => {
    expect(gamesHostRewrite(req("/", { host: "seazn.club" }))).toBeNull();
    expect(gamesHostRewrite(req("/gamesfoo", GAMES_HOST))?.pathname).toBe("/games/gamesfoo");
  });

  it("prefers x-forwarded-host (Fly) over host", () => {
    const r = req("/", { host: "internal:3000", "x-forwarded-host": "games.seazn.club" });
    expect(gamesHostRewrite(r)?.pathname).toBe("/games");
  });

  it("strips ports before matching", () => {
    expect(gamesHostRewrite(req("/", { host: "games.localhost:3000" }))?.pathname).toBe("/games");
  });

  it("proxy() rewrites and still stamps CSP", () => {
    const res = proxy(req("/chess-quest", GAMES_HOST));
    const rewrite = res.headers.get("x-middleware-rewrite");
    expect(rewrite).toContain("/games/chess-quest");
    expect(
      res.headers.get("Content-Security-Policy-Report-Only") ??
        res.headers.get("Content-Security-Policy"),
    ).toContain("default-src 'self'");
  });

  it("proxy() leaves normal hosts alone", () => {
    const res = proxy(req("/pricing", { host: "seazn.club" }));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/proxy-games-host.test.ts`
Expected: FAIL — `gamesHostRewrite` is not exported.

- [ ] **Step 3: Implement in proxy.ts**

Three edits.

**(a)** Add the hostname helper + rewrite function above `proxy()` (after `cspHeader`):

```ts
/**
 * Bare hostname for the request: prefer X-Forwarded-Host (Fly.io / reverse
 * proxy; Next dev also sets it — WITH a port), fall back to Host. Ports are
 * stripped; URL parsing handles IPv6 hosts like "[::1]:3000" correctly.
 */
export function requestHostname(request: NextRequest): string {
  const rawHost =
    request.headers.get("x-forwarded-host")?.split(",")[0].trim() ??
    request.headers.get("host") ??
    request.nextUrl.hostname;
  try {
    return new URL(`http://${rawHost}`).hostname;
  } catch {
    return rawHost.split(":")[0];
  }
}

/**
 * games.* hosts serve the /games route tree: games.seazn.club/ is the games
 * listing, games.seazn.club/<slug> plays a game. Any `games.`-prefixed host
 * matches so staging (games.stg…) and local (games.localhost) work unchanged.
 * Returns the rewritten URL, or null when no rewrite applies (wrong host,
 * API call, or already inside /games — never double-prefix).
 */
export function gamesHostRewrite(request: NextRequest): URL | null {
  if (!requestHostname(request).startsWith("games.")) return null;
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/")) return null;
  if (pathname === "/games" || pathname.startsWith("/games/")) return null;
  const url = request.nextUrl.clone();
  url.pathname = pathname === "/" ? "/games" : `/games${pathname}`;
  return url;
}
```

**(b)** In the CSRF block inside `proxy()`, replace the inline host derivation with the helper. Replace:

```ts
        // Prefer X-Forwarded-Host (Fly.io / reverse proxy; Next dev also sets
        // it — WITH a port, e.g. "localhost:3000"). Fall back to Host. Strip
        // the port from either so we compare bare hostnames.
        const rawHost =
          request.headers.get("x-forwarded-host")?.split(",")[0].trim() ??
          request.headers.get("host") ??
          request.nextUrl.hostname;
        // URL parsing handles IPv6 hosts like "[::1]:3000" correctly.
        const appHost = (() => {
          try {
            return new URL(`http://${rawHost}`).hostname;
          } catch {
            return rawHost.split(":")[0];
          }
        })();
```

with:

```ts
        const appHost = requestHostname(request);
```

**(c)** In the page branch at the bottom of `proxy()`, route through the rewrite when it applies. Replace:

```ts
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(csp.name, csp.value);
  return response;
```

with:

```ts
  const rewriteUrl = gamesHostRewrite(request);
  const response = rewriteUrl
    ? NextResponse.rewrite(rewriteUrl, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(csp.name, csp.value);
  return response;
```

- [ ] **Step 4: Run tests to verify pass (new + existing proxy suite)**

Run: `npx vitest run src/__tests__/proxy-games-host.test.ts src/__tests__/proxy-csp.test.ts`
Expected: PASS, both files (9 + 5 tests). The CSP suite guards the refactor of the CSRF block.

- [ ] **Step 5: Verify against the dev server**

```bash
curl -s -H "Host: games.localhost" http://localhost:3000/ | grep -o "Chess Quest" | head -1
curl -s -H "Host: games.localhost" http://localhost:3000/chess-quest | grep -o "coming soon" | head -1
```

Expected: both grep hits (dev server forwards Host as x-forwarded-host).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/proxy.ts apps/web/src/__tests__/proxy-games-host.test.ts
git commit -m "feat(games): games.* host rewrite into /games tree

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Sitemap entries

**Files:**
- Modify: `apps/web/src/app/sitemap.ts` (staticEntries array, ~line 9)

**Interfaces:**
- Consumes: `liveGames()` from `@/games/registry`.

- [ ] **Step 1: Add /games + live games to the sitemap**

Add the import at the top of `src/app/sitemap.ts`:

```ts
import { liveGames } from "@/games/registry";
```

Add to the `staticEntries` array (after the `/pricing` entry):

```ts
    { url: `${BASE}/games`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    ...liveGames().map((g) => ({
      url: `${BASE}/games/${g.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
```

(Coming-soon games stay out — nothing playable to index yet; entries appear automatically at the Phase C status flip.)

- [ ] **Step 2: Verify**

```bash
curl -s http://localhost:3000/sitemap.xml | grep -o "seazn.club/games" | head -1
```

Expected: `seazn.club/games`. Also confirm no `/games/chess-quest` entry yet (status is coming-soon):

```bash
curl -s http://localhost:3000/sitemap.xml | grep -c "games/chess-quest"
```

Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/sitemap.ts
git commit -m "feat(games): sitemap entries for /games and live games

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: E2E smoke + full verification

**Files:**
- Create: `apps/web/e2e/games.spec.ts`

**Interfaces:**
- Consumes: routes from Tasks 3–5.

- [ ] **Step 1: Write the e2e spec**

```ts
// apps/web/e2e/games.spec.ts
import { test, expect } from "@playwright/test";

// Seazn Games surface (Phase A): listing, player page, 404s, subdomain
// rewrite. No fixtures needed — the registry is static data.

test("games listing renders registry cards", async ({ page }) => {
  await page.goto("/games");
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  await expect(page.getByText("Chess Quest")).toBeVisible();
  await expect(page.getByText("Coming soon")).toBeVisible();
});

test("coming-soon game shows teaser, not a dead page", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await expect(page.getByText("Chess Quest is coming soon")).toBeVisible();
  await expect(page.getByRole("link", { name: "← Games" })).toBeVisible();
});

test("unknown game slug 404s", async ({ page }) => {
  const res = await page.goto("/games/not-a-game");
  expect(res?.status()).toBe(404);
});

test("games.* host serves the games tree", async ({ browser }) => {
  // The proxy prefers x-forwarded-host, which is what Fly sets in production.
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-host": "games.seazn.club" },
  });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  await page.goto("/chess-quest");
  await expect(page.getByText("Chess Quest is coming soon")).toBeVisible();
  await ctx.close();
});
```

- [ ] **Step 2: Run the spec**

Run (from `apps/web`, dev server up on :3000): `npx playwright test e2e/games.spec.ts`
Expected: 4 passed. If the auth setup project runs first and fails on a cold DB, run with `--project=parallel` (public pages need no auth) or per the repo's e2e README.

- [ ] **Step 3: Full verification**

Run from repo root:

```bash
npm run lint --workspace apps/web
npm run test --workspace apps/web
npm run build --workspace apps/web
```

Expected: lint clean, all vitest suites pass (incl. the 3 new files), build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/games.spec.ts
git commit -m "test(games): e2e smoke for listing, player page, subdomain rewrite

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Post-plan (user actions, not tasks)

- DNS: CNAME `games.seazn.club` → the Fly app hostname.
- Certs: `fly certs add games.seazn.club` (repeat on staging app for `games.stg…` if wanted).
- PR: branch `games-platform` → main through the normal PR flow.
- Phase B plan (engine + content) is the next planning session.
