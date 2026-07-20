import { describe, expect, it } from "vitest";
import { effectiveEntrantModel, entrantKindCap } from "./entrant-model.ts";
import { football } from "../sports/football/index.ts";
import { boardgame } from "../sports/boardgame/index.ts";
import { badminton } from "../sports/setbased/badminton.ts";
import { volleyball } from "../sports/setbased/volleyball.ts";
import { tabletennis } from "../sports/setbased/tabletennis.ts";
import { tennis } from "../sports/tennis/index.ts";
import { hockey } from "../sports/hockey/index.ts";
import { cricket } from "../sports/cricket/index.ts";
import { carrom } from "../sports/carrom/index.ts";

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
  it("factory-threaded + literal modules declare their entrant shapes", () => {
    expect(tennis.entrantModel?.kinds).toEqual(["individual", "pair"]);
    expect(hockey.entrantModel?.kinds).toEqual(["team"]);
    expect(hockey.entrantModel?.team?.captain).toBe(true);
    expect(cricket.entrantModel?.kinds).toEqual(["team"]);
    expect(carrom.entrantModel?.kinds).toEqual(["individual", "pair"]);
  });
  it("caps are structural", () => {
    expect(entrantKindCap("individual")).toBe(1);
    expect(entrantKindCap("pair")).toBe(2);
    expect(entrantKindCap("team")).toBe(Number.POSITIVE_INFINITY);
    expect(entrantKindCap("team", { maxTeamMembers: 26 })).toBe(26);
  });

  it("setbased kernel threads entrantModel (badminton pair, volleyball team+pair)", () => {
    expect(badminton.entrantModel?.kinds).toEqual(["individual", "pair"]);
    expect(volleyball.entrantModel?.kinds).toEqual(["team", "pair"]);
    expect(volleyball.entrantModel?.team?.captain).toBe(true);
    expect(tabletennis.entrantModel?.kinds).toEqual(["individual", "pair"]);
  });

  // The entrant model is declared per sport, not per variant, so volleyball has
  // to admit both shapes: indoor 6v6 teams and the `beach` variant's 2v2 pairs.
  // Default stays `team` — indoor is the module default (spec 04 §3.1).
  it("volleyball takes beach pairs without a division override", () => {
    const eff = effectiveEntrantModel(volleyball.entrantModel);
    expect(eff.kinds).toContain("pair");
    expect(eff.defaultKind).toBe("team");
  });
});
