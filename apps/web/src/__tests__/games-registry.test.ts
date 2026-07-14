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
