// Migration mapping tests (PROMPT-15 task 2). The critical property mirrors
// the acceptance bar: a decided v1 match, mapped to a synthetic generic.result
// and folded through the engine, reproduces the stored v1 winner/draw.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "@seazn/engine/core";
import { generic } from "@seazn/engine/sports/generic";
import {
  competitionStatusFor,
  consentFor,
  divisionStatusFor,
  genericConfigFor,
  genericVariantFor,
  resultEventFor,
  slugify,
  stagePlanFor,
  uniqueSlug,
  variantFromPreset,
  type V1Match,
  type V1Round,
} from "../v1-map";

const baseTournament = {
  result_mode: "win_loss",
  allow_draws: false,
  points_win: 1,
  points_draw: 0,
  points_loss: 0,
  use_progress_score: false,
};

function match(overrides: Partial<V1Match>): V1Match {
  return {
    id: "m1",
    round_id: "r1",
    board_number: 1,
    player1_id: "p1",
    player2_id: "p2",
    winner_id: null,
    player1_score: null,
    player2_score: null,
    is_draw: false,
    next_match_id: null,
    next_slot: null,
    is_bye: false,
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

const entrantOf = (pid: string) => `e-${pid}`;

// Fold the mapped event exactly like the migration script does.
function refold(m: V1Match, resultMode: string, cfgOverrides = {}) {
  const ev = resultEventFor(m, resultMode, entrantOf);
  if (!ev) return null;
  const cfg = generic.configSchema.parse({
    ...genericConfigFor({ ...baseTournament, result_mode: resultMode, ...cfgOverrides }),
  });
  const envelope: EventEnvelope = {
    id: "e1",
    fixtureId: "f1",
    seq: 1,
    type: ev.type,
    payload: ev.payload,
    recordedAt: "2025-01-01T00:00:00Z",
    recordedBy: null,
  };
  const lineups = {
    home: { entrantId: "e-p1", slots: [] },
    away: { entrantId: "e-p2", slots: [] },
  };
  return generic.outcome(foldMatch(generic, cfg, lineups, [envelope]));
}

describe("genericConfigFor", () => {
  it("maps v1 scoring settings onto the generic module config", () => {
    const cfg = genericConfigFor({
      ...baseTournament,
      result_mode: "score",
      allow_draws: true,
      points_win: 3,
      points_draw: 1,
    });
    expect(cfg).toEqual({
      resultMode: "score",
      allowDraws: true,
      points: { w: 3, d: 1, l: 0 },
      progressScore: false,
    });
    // The mapped config must satisfy the pinned module's own schema.
    expect(() => generic.configSchema.parse(cfg)).not.toThrow();
  });

  it("picks the matching system variant", () => {
    expect(genericVariantFor({ result_mode: "score" })).toBe("score");
    expect(genericVariantFor({ result_mode: "win_loss" })).toBe("win_loss");
  });
});

describe("resultEventFor → refold (acceptance: outcomes reproduce winners)", () => {
  it("win_loss winner refolds to the same winner", () => {
    const outcome = refold(match({ winner_id: "p2" }), "win_loss");
    expect(outcome).toMatchObject({ kind: "win", winner: "e-p2", loser: "e-p1" });
  });

  it("score mode refolds the score and derives the winner", () => {
    const outcome = refold(
      match({ player1_score: 21, player2_score: 15, winner_id: "p1" }),
      "score",
    );
    expect(outcome).toMatchObject({ kind: "win", winner: "e-p1" });
  });

  it("draws refold to draws", () => {
    const outcome = refold(match({ is_draw: true }), "win_loss", { allow_draws: true });
    expect(outcome).toEqual({ kind: "draw" });
    const scored = refold(
      match({ player1_score: 2, player2_score: 2, is_draw: true }),
      "score",
      { allow_draws: true },
    );
    expect(scored).toEqual({ kind: "draw" });
  });

  it("byes and undecided matches produce no event", () => {
    expect(resultEventFor(match({ is_bye: true, player2_id: null }), "win_loss", entrantOf)).toBeNull();
    expect(resultEventFor(match({}), "win_loss", entrantOf)).toBeNull();
  });

  it("scores recorded under win_loss mode fall back to the score shape", () => {
    const ev = resultEventFor(
      match({ player1_score: 3, player2_score: 1, winner_id: null }),
      "win_loss",
      entrantOf,
    );
    expect(ev?.payload).toEqual({ p1Score: 3, p2Score: 1 });
  });
});

describe("stagePlanFor", () => {
  const rounds: V1Round[] = [
    { id: "r1", round_number: 1, stage: "group", name: "Round 1" },
    { id: "r2", round_number: 2, stage: "group", name: "Round 2" },
    { id: "r3", round_number: 3, stage: "knockout", name: "Semifinals" },
    { id: "r4", round_number: 4, stage: "final", name: "Final" },
  ];

  it("splits swiss_knockout into a swiss stage + a knockout stage, renumbered", () => {
    const plans = stagePlanFor("swiss_knockout", rounds);
    expect(plans.map((p) => [p.seq, p.kind])).toEqual([
      [1, "swiss"],
      [2, "knockout"],
    ]);
    expect(plans[0].config).toEqual({ rounds: 2 });
    expect(plans[0].roundNo.get("r2")).toBe(2);
    // knockout + final rounds merge into one stage, rounds renumbered from 1
    expect(plans[1].roundNo.get("r3")).toBe(1);
    expect(plans[1].roundNo.get("r4")).toBe(2);
  });

  it("round_robin group rounds become a league stage", () => {
    const plans = stagePlanFor("round_robin", [
      { id: "r1", round_number: 1, stage: "group", name: "Round 1" },
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0].kind).toBe("league");
  });

  it("progress_stepladder playoff rounds become a stepladder stage", () => {
    const plans = stagePlanFor("progress_stepladder", [
      { id: "r1", round_number: 1, stage: "group", name: "Round 1" },
      { id: "r2", round_number: 2, stage: "playoff", name: "Stepladder 1" },
      { id: "r3", round_number: 3, stage: "playoff", name: "Stepladder 2" },
    ]);
    expect(plans.map((p) => p.kind)).toEqual(["swiss", "stepladder"]);
  });
});

describe("statuses, consent, slugs, variants", () => {
  it("maps tournament → division status", () => {
    expect(divisionStatusFor("setup")).toBe("setup");
    expect(divisionStatusFor("group")).toBe("active");
    expect(divisionStatusFor("completed")).toBe("completed");
  });

  it("aggregates competition status over members", () => {
    expect(competitionStatusFor([])).toBe("draft");
    expect(competitionStatusFor(["setup", "setup"])).toBe("draft");
    expect(competitionStatusFor(["completed", "completed"])).toBe("completed");
    expect(competitionStatusFor(["completed", "group"])).toBe("live");
  });

  it("kids tournaments never get public consent (doc 07: minors default false)", () => {
    expect(consentFor({ is_public: true, category: "kids" })).toEqual({
      public_name: false,
      public_photo: false,
    });
    expect(consentFor({ is_public: true, category: "adult" })).toEqual({
      public_name: true,
      public_photo: true,
    });
    expect(consentFor({ is_public: false, category: "open" }).public_name).toBe(false);
  });

  it("uniqueSlug suffixes collisions", () => {
    const taken = new Set(["summer", "summer-2"]);
    expect(uniqueSlug("summer", taken)).toBe("summer-3");
    expect(slugify("Ünïcode Cup!")).toBe("unicode-cup");
  });

  it("maps a sport preset to an org generic variant that validates", () => {
    const v = variantFromPreset({
      sport_key: "Carrom",
      sport_name: "Carrom",
      result_mode: "score",
      points_win: 2,
      points_draw: 1,
      points_loss: 0,
      allow_draws: true,
      use_progress_score: false,
      is_system: false,
    });
    expect(v.sport_key).toBe("generic");
    expect(v.key).toBe("carrom");
    expect(() => generic.configSchema.parse(v.config)).not.toThrow();
  });
});
