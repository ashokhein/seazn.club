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

  it("leaves shared assets and non-page trees alone (found in browser demo)", () => {
    // Public files: layout links /site.webmanifest on every page.
    expect(gamesHostRewrite(req("/site.webmanifest", GAMES_HOST))).toBeNull();
    expect(gamesHostRewrite(req("/brand/logo-wide.png", GAMES_HOST))).toBeNull();
    // PostHog reverse proxy (next.config rewrites /ingest/* upstream).
    expect(gamesHostRewrite(req("/ingest/array/phc_x/config.js", GAMES_HOST))).toBeNull();
    // Multi-segment paths have no games route — pass through to 404 as-is.
    expect(gamesHostRewrite(req("/chess-quest/deep/path", GAMES_HOST))).toBeNull();
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
    // /dashboard is neither a games host nor a marketing-rewritten path.
    const res = proxy(req("/dashboard", { host: "seazn.club" }));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});
