/**
 * Smoke tests — fast, no DB, no network.
 * Validates critical pure-logic paths and schema contracts.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  createTournamentSchema,
  loginSchema,
  signupSchema,
  createOrgSchema,
  createInviteSchema,
  recordResultSchema,
  setCheckInSchema,
  addPlayersSchema,
  checkoutSchema,
} from "@/lib/types";
import { computeStandings } from "@/lib/standings";
import { swissPairings, pairKey } from "@/lib/pairing";

// ── Schema smoke tests ─────────────────────────────────────────────────────

describe("loginSchema", () => {
  it("accepts valid credentials", () => {
    expect(() =>
      loginSchema.parse({ email: "a@b.com", password: "secret123" }),
    ).not.toThrow();
  });

  it("rejects missing email", () => {
    expect(() =>
      loginSchema.parse({ password: "secret123" }),
    ).toThrow();
  });

  it("rejects short password", () => {
    expect(() =>
      loginSchema.parse({ email: "a@b.com", password: "abc" }),
    ).toThrow();
  });
});

describe("createTournamentSchema", () => {
  const base = {
    sport: "Chess",
    name: "Test Cup",
    category: "adult" as const,
    format: "swiss_knockout" as const,
    num_group_rounds: 3,
    knockout_size: 4,
    players: ["Alice", "Bob", "Carol", "Dave"],
    result_mode: "win_loss" as const,
    score_label: "Score",
    points_win: 1,
    points_draw: 0,
    points_loss: 0,
    allow_draws: false,
    use_progress_score: false,
    round_minutes: 30,
    clock_minutes: 0,
  };

  it("accepts valid tournament", () => {
    expect(() => createTournamentSchema.parse(base)).not.toThrow();
  });

  it("accepts optional venue", () => {
    const result = createTournamentSchema.parse({ ...base, venue: "City Hall" });
    expect(result.venue).toBe("City Hall");
  });

  it("coerces null venue", () => {
    const result = createTournamentSchema.parse({ ...base, venue: null });
    expect(result.venue).toBeNull();
  });

  it("rejects venue over 120 chars", () => {
    expect(() =>
      createTournamentSchema.parse({ ...base, venue: "x".repeat(121) }),
    ).toThrow();
  });

  it("rejects fewer than 2 players", () => {
    expect(() =>
      createTournamentSchema.parse({ ...base, players: ["Solo"] }),
    ).toThrow();
  });

  it("rejects invalid format", () => {
    expect(() =>
      createTournamentSchema.parse({ ...base, format: "ffa" }),
    ).toThrow();
  });
});

const MATCH_ID  = "550e8400-e29b-41d4-a716-446655440001";
const PLAYER_ID = "550e8400-e29b-41d4-a716-446655440002";

describe("recordResultSchema", () => {
  it("accepts winner_id", () => {
    expect(() =>
      recordResultSchema.parse({ match_id: MATCH_ID, winner_id: PLAYER_ID }),
    ).not.toThrow();
  });

  it("accepts scores", () => {
    expect(() =>
      recordResultSchema.parse({ match_id: MATCH_ID, player1_score: 3, player2_score: 1 }),
    ).not.toThrow();
  });

  it("accepts draw", () => {
    expect(() =>
      recordResultSchema.parse({ match_id: MATCH_ID, is_draw: true }),
    ).not.toThrow();
  });

  it("rejects no result info", () => {
    expect(() =>
      recordResultSchema.parse({ match_id: MATCH_ID }),
    ).toThrow();
  });
});

describe("checkoutSchema", () => {
  it("accepts pro monthly", () => {
    expect(() =>
      checkoutSchema.parse({ plan_key: "pro", interval: "monthly" }),
    ).not.toThrow();
  });

  it("rejects unknown plan", () => {
    expect(() =>
      checkoutSchema.parse({ plan_key: "enterprise", interval: "monthly" }),
    ).toThrow();
  });
});

describe("createOrgSchema", () => {
  it("rejects empty name", () => {
    expect(() => createOrgSchema.parse({ name: "" })).toThrow();
  });
  it("rejects name over 60 chars", () => {
    expect(() => createOrgSchema.parse({ name: "x".repeat(61) })).toThrow();
  });
});

describe("createInviteSchema", () => {
  it("accepts valid invite", () => {
    expect(() =>
      createInviteSchema.parse({ role: "admin", max_uses: 5 }),
    ).not.toThrow();
  });
  it("rejects owner role", () => {
    expect(() =>
      createInviteSchema.parse({ role: "owner", max_uses: 1 }),
    ).toThrow();
  });
});

// ── Engine smoke tests ──────────────────────────────────────────────────────

function mkPlayer(id: string, seed: number) {
  return {
    id,
    tournament_id: "t1",
    name: `Player ${id}`,
    seed,
    checked_in: true,
    image_url: null,
    image_storage_path: null,
  };
}

describe("computeStandings smoke", () => {
  it("returns one row per player", () => {
    const players = [mkPlayer("p1", 1), mkPlayer("p2", 2), mkPlayer("p3", 3)];
    const standings = computeStandings(players, [], [], {
      points_win: 1,
      points_draw: 0,
      points_loss: 0,
      use_progress_score: false,
    });
    expect(standings).toHaveLength(3);
  });

  it("all ranks are unique and sequential", () => {
    const players = [mkPlayer("p1", 1), mkPlayer("p2", 2), mkPlayer("p3", 3)];
    const standings = computeStandings(players, [], [], {
      points_win: 1,
      points_draw: 0,
      points_loss: 0,
      use_progress_score: false,
    });
    const ranks = standings.map((s) => s.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3]);
  });

  it("winner gets 1 point", () => {
    const players = [mkPlayer("p1", 1), mkPlayer("p2", 2)];
    const round = { id: "r1", tournament_id: "t1", round_number: 1, stage: "group" as const, name: "Round 1", status: "completed" as const };
    const match = {
      id: "m1", tournament_id: "t1", round_id: "r1", board_number: 1,
      player1_id: "p1", player2_id: "p2" as string | null,
      winner_id: "p1" as string | null, loser_id: "p2" as string | null,
      player1_score: null, player2_score: null,
      is_draw: false, next_match_id: null, next_slot: null, is_bye: false,
      status: "completed" as const, label: null,
    };
    const standings = computeStandings(players, [round], [match], {
      points_win: 1, points_draw: 0, points_loss: 0, use_progress_score: false,
    });
    const winner = standings.find((s) => s.player.id === "p1")!;
    const loser  = standings.find((s) => s.player.id === "p2")!;
    expect(winner.points).toBe(1);
    expect(loser.points).toBe(0);
    expect(winner.rank).toBe(1);
  });
});

describe("swissPairings smoke", () => {
  it("returns n/2 pairings for n players", () => {
    const players = ["p1", "p2", "p3", "p4"];
    const pairs = swissPairings(players, new Set(), new Set());
    // Each pairing is one match (bye slot = null opponent)
    expect(pairs.length).toBe(2);
  });

  it("no player appears twice in one round", () => {
    const players = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const pairs = swissPairings(players, new Set(), new Set());
    const seen = new Set<string>();
    for (const { player1, player2 } of pairs) {
      if (player1) { expect(seen.has(player1)).toBe(false); seen.add(player1); }
      if (player2) { expect(seen.has(player2)).toBe(false); seen.add(player2); }
    }
  });

  it("avoids repeat pairings when played set provided", () => {
    const players = ["p1", "p2", "p3", "p4"];
    // p1 already played p2
    const played = new Set([pairKey("p1", "p2")]);
    const pairs = swissPairings(players, played, new Set());
    const rematch = pairs.some(
      ({ player1, player2 }) =>
        pairKey(player1, player2 ?? "") === pairKey("p1", "p2"),
    );
    expect(rematch).toBe(false);
  });
});
