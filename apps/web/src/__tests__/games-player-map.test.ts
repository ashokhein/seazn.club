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
