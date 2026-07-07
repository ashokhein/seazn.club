// Custom competition points (Jul3/05 §2), carry-over openings (§3), and
// manual rank locks (§4). Pure: rules are config, evaluated per decided
// fixture over the pair a SportModule.standingsDelta already returns — no
// sport-module changes. Fractional/negative points are legal (Jul3/09).
import { z } from "zod";
import type { EntrantId, MatchOutcome, MetricSpec, StandingsDelta } from "../core/types.ts";
import { EngineError } from "../core/errors.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";

// Jul3/05 §2 — declarative points rule (stages.config.points).
export const PointsRule = z.object({
  base: z.object({ win: z.number(), draw: z.number(), loss: z.number() }),
  bonuses: z
    .array(
      z.object({
        when: z.enum([
          "loss_margin_lte",
          "win_margin_gte",
          "score_ratio_gte",
          "draw",
          "forfeit_win",
          "forfeit_loss",
          "no_result",
        ]),
        param: z.number().optional(),
        points: z.number(),
      }),
    )
    .default([]),
  forfeit: z
    .object({
      winnerPoints: z.number(),
      loserPoints: z.number(),
      awardScore: z.tuple([z.number(), z.number()]).optional(), // 20 Jan
    })
    .optional(),
});
export type PointsRule = z.infer<typeof PointsRule>;

const MARGIN_KINDS = new Set(["loss_margin_lte", "win_margin_gte", "score_ratio_gte"]);

/** Jul3/05 §8: a rule referencing metrics the sport doesn't emit fails at
 *  stage-config time (fail closed — bad configs never reach play). */
export function validatePointsRule(rule: PointsRule, metrics: readonly MetricSpec[]): void {
  const keys = new Set(metrics.map((m) => m.key));
  const needsScores = rule.bonuses.some((b) => MARGIN_KINDS.has(b.when));
  if (needsScores && !(keys.has("for") && keys.has("against")) && !keys.has("diff")) {
    throw new EngineError(
      "CONFIG_INVALID",
      "points rule uses margin/ratio bonuses but the sport emits no for/against metrics",
      { metrics: [...keys] },
    );
  }
}

const isForfeit = (outcome: MatchOutcome): boolean =>
  outcome.kind === "award" ||
  (outcome.kind === "win" && (outcome.method === "walkover" || outcome.method === "forfeit"));

function marginOf(delta: StandingsDelta): number {
  const m = delta.metrics;
  if (m.diff !== undefined) return m.diff;
  if (m.for !== undefined && m.against !== undefined) return m.for - m.against;
  return 0;
}

function bonusesFor(
  delta: StandingsDelta,
  outcome: MatchOutcome,
  rule: PointsRule,
): number {
  let extra = 0;
  const margin = marginOf(delta);
  const forfeit = isForfeit(outcome);
  for (const b of rule.bonuses) {
    switch (b.when) {
      case "loss_margin_lte":
        if (delta.lost === 1 && !forfeit && -margin <= (b.param ?? 0)) extra += b.points;
        break;
      case "win_margin_gte":
        if (delta.won === 1 && !forfeit && margin >= (b.param ?? 0)) extra += b.points;
        break;
      case "score_ratio_gte": {
        // netball 26 Jan: losing side that scored ≥ param × the winner's score.
        // Cross-multiplied — never divide (spec 05 §4.3).
        const f = delta.metrics.for;
        const a = delta.metrics.against;
        if (
          delta.lost === 1 &&
          !forfeit &&
          f !== undefined &&
          a !== undefined &&
          f >= (b.param ?? 0) * a
        ) {
          extra += b.points;
        }
        break;
      }
      case "draw":
        if (delta.drawn === 1) extra += b.points;
        break;
      case "forfeit_win":
        if (forfeit && delta.won === 1) extra += b.points;
        break;
      case "forfeit_loss":
        if (forfeit && delta.lost === 1) extra += b.points;
        break;
      case "no_result":
        if (outcome.kind === "no_result") extra += b.points;
        break;
    }
  }
  return extra;
}

/**
 * Re-derive both sides' competition points from the rule (Jul3/05 §2). The
 * sport's metrics ledger is untouched; only `points` changes — plus the
 * optional configured award score on a forfeit (never a fake score unless the
 * organiser configured one, 20 Jan / 8 Dec).
 */
export function applyPointsRule(
  outcome: MatchOutcome,
  pair: FixtureResult,
  rule: PointsRule,
): FixtureResult {
  const forfeit = isForfeit(outcome);
  const mapped = pair.map((delta) => {
    let points: number;
    if (outcome.kind === "no_result") {
      points = 0;
    } else if (forfeit && rule.forfeit !== undefined) {
      points = delta.won === 1 ? rule.forfeit.winnerPoints : rule.forfeit.loserPoints;
    } else if (delta.won === 1) {
      points = rule.base.win;
    } else if (delta.drawn === 1) {
      points = rule.base.draw;
    } else if (delta.lost === 1) {
      points = rule.base.loss;
    } else {
      points = 0;
    }
    points += bonusesFor(delta, outcome, rule);
    const metrics = { ...delta.metrics };
    if (forfeit && rule.forfeit?.awardScore !== undefined) {
      const [w, l] = rule.forfeit.awardScore;
      const [mine, theirs] = delta.won === 1 ? [w, l] : [l, w];
      metrics.for = (metrics.for ?? 0) + mine;
      metrics.against = (metrics.against ?? 0) + theirs;
      metrics.diff = (metrics.diff ?? 0) + mine - theirs;
    }
    return { ...delta, points, metrics };
  }) as unknown as FixtureResult;
  return mapped;
}

// ---------------------------------------------------------------------------
// Carry-over (Jul3/05 §3): a synthetic opening delta folded before new
// fixtures — carry-over is data, not new fold logic.
// ---------------------------------------------------------------------------

export type CarryMode = "none" | "points" | "full";

export function carryDeltas(
  rows: readonly StandingsRow[],
  mode: CarryMode,
): StandingsDelta[] {
  if (mode === "none") return [];
  return rows.map((row) =>
    mode === "points"
      ? {
          entrantId: row.entrantId,
          played: 0,
          won: 0,
          drawn: 0,
          lost: 0,
          points: row.points,
          metrics: {},
        }
      : {
          entrantId: row.entrantId,
          played: row.played,
          won: row.won,
          drawn: row.drawn,
          lost: row.lost,
          points: row.points,
          metrics: { ...row.metrics },
        },
  );
}

// ---------------------------------------------------------------------------
// Manual rank override (Jul3/05 §4): locked ranks are pinned; the cascade
// ranks only the unlocked remainder around them.
// ---------------------------------------------------------------------------

export interface RankLock {
  entrantId: EntrantId;
  rank: number;
}

export function applyRankLocks(
  ranked: readonly StandingsRow[],
  locks: readonly RankLock[],
): StandingsRow[] {
  if (locks.length === 0) return [...ranked];
  const lockByEntrant = new Map(locks.map((l) => [l.entrantId, l.rank]));
  const lockedRanks = new Set(locks.map((l) => l.rank));
  const n = ranked.length;
  const out: (StandingsRow | null)[] = Array.from({ length: n }, () => null);
  // pin the locked rows first
  for (const row of ranked) {
    const rank = lockByEntrant.get(row.entrantId);
    if (rank === undefined) continue;
    if (rank < 1 || rank > n || out[rank - 1] !== null) {
      throw new EngineError("CONFIG_INVALID", `rank override ${rank} is out of range or duplicated`, {
        entrantId: row.entrantId,
      });
    }
    out[rank - 1] = { ...row, rank, rankLocked: true };
  }
  // fill everyone else, cascade order preserved, into the free positions
  const free = Array.from({ length: n }, (_, i) => i + 1).filter((r) => !lockedRanks.has(r));
  let fi = 0;
  for (const row of ranked) {
    if (lockByEntrant.has(row.entrantId)) continue;
    const rank = free[fi++]!;
    out[rank - 1] = { ...row, rank };
  }
  return out as StandingsRow[];
}
