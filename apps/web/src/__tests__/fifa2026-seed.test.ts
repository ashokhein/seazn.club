import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { snakeDistribute } from "@/server/usecases/stages";
import {
  groupStandings,
  bestThirdGroups,
  seedForGroup,
  knockoutPicks,
  goalEvents,
  type StandRow,
} from "../../../../scripts/seed-fifa2026.ts";

// Repo-root scripts/data/fifa2026.json (built by build-fifa2026-data.ts).
const DATA = JSON.parse(
  readFileSync(join(__dirname, "../../../../scripts/data/fifa2026.json"), "utf8"),
) as {
  teams: Record<string, { code: string; iso2: string; group: string }>;
  groupMatches: { group: string; date: string; home: string; away: string; hs: number; as: number }[];
  squads: Record<string, { n: number; pos: string; name: string }[]>;
};
const GROUPS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

describe("fifa2026 data file", () => {
  it("has 48 teams, 72 group matches, and full 26-man squads with flags", () => {
    expect(Object.keys(DATA.teams)).toHaveLength(48);
    expect(DATA.groupMatches).toHaveLength(72);
    for (const code of Object.keys(DATA.teams)) {
      expect(DATA.squads[code]?.length, `${code} squad`).toBe(26);
      expect(DATA.teams[code].iso2, `${code} flag`).toBeTruthy();
    }
  });

  it("has exactly 6 matches and 4 teams per group", () => {
    for (const g of GROUPS) {
      const ms = DATA.groupMatches.filter((m) => m.group === g);
      expect(ms, `group ${g} matches`).toHaveLength(6);
      const teams = new Set(ms.flatMap((m) => [m.home, m.away]));
      expect(teams.size, `group ${g} teams`).toBe(4);
    }
  });
});

describe("seedForGroup ↔ engine snakeDistribute", () => {
  // The seed we assign each team must snake it back into its own real group.
  it("reproduces the real 12 groups through the engine's snake", () => {
    // Build 48 (seed, group) entrants exactly as the seeder would.
    const entrants: { seed: number; group: string }[] = [];
    for (let gi = 0; gi < GROUPS.length; gi++) {
      const codes = Object.values(DATA.teams).filter((t) => t.group === GROUPS[gi]).map((t) => t.code);
      codes.forEach((_c, slot) => entrants.push({ seed: seedForGroup(gi, slot), group: GROUPS[gi] }));
    }
    // Seeds must be the unique set 1..48.
    expect(new Set(entrants.map((e) => e.seed)).size).toBe(48);
    // The engine orders by seed asc, then snakes into 12 pools.
    const ordered = [...entrants].sort((a, b) => a.seed - b.seed);
    const pools = snakeDistribute(ordered, 12);
    pools.forEach((pool, pi) => {
      expect(pool).toHaveLength(4);
      for (const e of pool) expect(e.group, `pool ${GROUPS[pi]}`).toBe(GROUPS[pi]);
    });
  });
});

describe("knockout qualification", () => {
  it("produces 32 picks: 12 winners + 12 runners-up + 8 best thirds", () => {
    const picks = knockoutPicks(DATA);
    expect(picks).toHaveLength(32);
    expect(picks.filter((p) => p.rank === 1)).toHaveLength(12);
    expect(picks.filter((p) => p.rank === 2)).toHaveLength(12);
    expect(picks.filter((p) => p.rank === 3)).toHaveLength(8);
  });

  it("best thirds are the 8 highest-scoring third-placed teams", () => {
    const chosen = bestThirdGroups(DATA);
    expect(chosen).toHaveLength(8);
    // Every chosen third must be >= every non-chosen third on (pts, gd, gf).
    const thirdOf = (g: string): StandRow => {
      const codes = Object.values(DATA.teams).filter((t) => t.group === g).map((t) => t.code);
      return groupStandings(codes, DATA.groupMatches.filter((m) => m.group === g))[2];
    };
    const rank = (r: StandRow) => r.pts * 1000 + r.gd * 10 + r.gf;
    const worstChosen = Math.min(...chosen.map((g) => rank(thirdOf(g))));
    const bestExcluded = Math.max(
      ...GROUPS.filter((g) => !chosen.includes(g)).map((g) => rank(thirdOf(g))),
    );
    expect(worstChosen).toBeGreaterThanOrEqual(bestExcluded);
  });
});

describe("goalEvents", () => {
  it("emits the exact scoreline attributed by entrant id", () => {
    const ev = goalEvents("home-id", "away-id", 2, 1);
    const homeGoals = ev.filter((e) => e.type === "football.goal" && (e.payload as any).by === "home-id");
    const awayGoals = ev.filter((e) => e.type === "football.goal" && (e.payload as any).by === "away-id");
    expect(homeGoals).toHaveLength(2);
    expect(awayGoals).toHaveLength(1);
    expect(ev[0]).toEqual({ type: "core.start", payload: {} });
    expect(ev.at(-1)).toEqual({ type: "football.period", payload: { phase: "FT" } });
  });
});
