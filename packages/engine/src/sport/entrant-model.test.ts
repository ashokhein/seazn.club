import { describe, expect, it } from "vitest";
import { effectiveEntrantModel, entrantKindCap } from "./entrant-model.ts";
import { football } from "../sports/football/index.ts";
import { boardgame } from "../sports/boardgame/index.ts";

describe("effectiveEntrantModel", () => {
  it("legacy fallback without a model: all kinds, individual default, team affordances on", () => {
    const eff = effectiveEntrantModel(null, undefined);
    expect(eff.kinds).toEqual(["team", "individual", "pair"]);
    expect(eff.defaultKind).toBe("individual");
    expect(eff.squadNumbers).toBe(true);
    expect(eff.captain).toBe(true);
    expect(eff.maxTeamMembers).toBeNull();
  });
  it("module defaults: football is team-only with numbers+captain", () => {
    const eff = effectiveEntrantModel(football.entrantModel);
    expect(eff.kinds).toEqual(["team"]);
    expect(eff.defaultKind).toBe("team");
    expect(eff.squadNumbers).toBe(true);
  });
  it("module defaults: boardgame is individual-only", () => {
    const eff = effectiveEntrantModel(boardgame.entrantModel);
    expect(eff.kinds).toEqual(["individual"]);
  });
  it("division override widens kinds and flips affordances", () => {
    const eff = effectiveEntrantModel(boardgame.entrantModel, {
      entrants: { kinds: ["individual", "team"], captain: false, squadNumbers: false },
    });
    expect(eff.kinds).toEqual(["individual", "team"]);
    expect(eff.captain).toBe(false);
  });
  it("garbage config is ignored field-by-field", () => {
    const eff = effectiveEntrantModel(football.entrantModel, { entrants: { kinds: "nope", defaultKind: 7 } });
    expect(eff.kinds).toEqual(["team"]);
    expect(eff.defaultKind).toBe("team");
  });
  it("caps are structural", () => {
    expect(entrantKindCap("individual")).toBe(1);
    expect(entrantKindCap("pair")).toBe(2);
    expect(entrantKindCap("team")).toBe(Number.POSITIVE_INFINITY);
    expect(entrantKindCap("team", { maxTeamMembers: 26 })).toBe(26);
  });
});
