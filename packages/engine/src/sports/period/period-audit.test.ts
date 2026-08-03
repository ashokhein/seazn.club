// W4 Layer-1 audit — the period family's additive extensions (#407 programme).
//
// Every test here pins a fact the FIH / IIHF scoresheet records that the
// kernel could not represent before this wave: per-goal attribution (scorer,
// assists, clock, empty net), the infraction and the serving player behind a
// suspension, the shoot-out taker and the goalkeeper facing him, and the
// awarded-vs-converted set piece (FIH penalty corner / penalty stroke, IIHF
// penalty shot).
//
// The additive contract is asserted here too: a payload that carries none of
// the new fields must leave state byte-identical to the pre-W4 shape, which is
// what keeps hockey.golden.json / icehockey.golden.json replaying green.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { icehockey } from "../icehockey/icehockey.ts";
import { hockey } from "../hockey/hockey.ts";
import {
  PeriodAdvance,
  PeriodEv,
  PeriodGoal,
  PeriodSetPiece,
  PeriodShootoutAttempt,
  PeriodSuspensionEnd,
  PeriodSuspensionStart,
  type PeriodState,
} from "./kernel.ts";

const iceLineups = defaultLineupPair(icehockey.positions);
const fihLineups = defaultLineupPair(hockey.positions);
const IH = iceLineups.home.entrantId;
const IA = iceLineups.away.entrantId;
const FH = fihLineups.home.entrantId;
const FA = fihLineups.away.entrantId;

const start: ModuleEvent = { type: "core.start", payload: {} };

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

function foldIce(events: ModuleEvent[], variant?: string): PeriodState {
  const cfg = icehockey.configSchema.parse(
    variant === undefined ? {} : icehockey.variants[variant],
  );
  return foldMatch(icehockey, cfg, iceLineups, envelopes(events)) as PeriodState;
}

function foldFih(events: ModuleEvent[], variant?: string): PeriodState {
  const cfg = hockey.configSchema.parse(variant === undefined ? {} : hockey.variants[variant]);
  return foldMatch(hockey, cfg, fihLineups, envelopes(events)) as PeriodState;
}

const iceGoal = (by: string, extra?: Record<string, unknown>): ModuleEvent => ({
  type: "icehockey.goal",
  payload: { by, ...(extra ?? {}) },
});
const fihGoal = (by: string, extra?: Record<string, unknown>): ModuleEvent => ({
  type: "hockey.goal",
  payload: { by, ...(extra ?? {}) },
});

// ---------------------------------------------------------------------------
// Goal attribution — IIHF game sheet: scorer, A1, A2, period, time, situation.
// ---------------------------------------------------------------------------

describe("W4 audit — per-goal attribution log", () => {
  const scorer = iceLineups.home.slots[1]!.personId;
  const a1 = iceLineups.home.slots[2]!.personId;
  const a2 = iceLineups.home.slots[3]!.personId;

  it("records scorer, assists, kind and clock time in state.goalLog", () => {
    const state = foldIce([
      start,
      iceGoal(IH, { person: scorer, assists: [a1, a2], kind: "pp", clockRef: "12:41" }),
    ]);
    expect(state.goalLog).toEqual([
      {
        phase: "P1",
        by: "home",
        credited: "home",
        person: scorer,
        assists: [a1, a2],
        kind: "pp",
        clockRef: "12:41",
      },
    ]);
  });

  it("uses the payload's own period label when the scorer back-dates a goal", () => {
    const state = foldIce([start, iceGoal(IH, { person: scorer, period: "P1" })]);
    expect(state.goalLog?.[0]?.phase).toBe("P1");
    const late = foldIce([
      start,
      { type: "icehockey.period.advance", payload: { to: "P2" } },
      iceGoal(IH, { person: scorer, period: "P1" }),
    ]);
    // The fold still credits the CURRENT period bucket; the log keeps the
    // scorer's stated period so a match report can place the goal.
    expect(late.goalLog?.[0]?.phase).toBe("P1");
    expect(late.periods.map((p) => p.home)).toEqual([0, 1]);
  });

  it("credits the opponent for an own goal but records the striking side", () => {
    const state = foldFih([start, fihGoal(FA, { person: "fa-2", kind: "og" })]);
    expect(state.goalLog).toEqual([
      { phase: "Q1", by: "away", credited: "home", person: "fa-2", kind: "og" },
    ]);
    expect(state.goals).toEqual({ home: 1, away: 0 });
  });

  it("records an empty-net goal and feeds the goals_en player metric", () => {
    const events = [start, iceGoal(IH, { person: scorer, emptyNet: true })];
    const state = foldIce(events);
    expect(state.goalLog?.[0]?.emptyNet).toBe(true);
    const rows = aggregatePlayerStats(envelopes(events), icehockey.playerStats!);
    expect(rows.find((r) => r.personId === scorer)?.stats.goals_en).toBe(1);
  });

  it("a coarse goal carrying no attribution leaves goalLog absent (golden guard)", () => {
    const state = foldIce([start, iceGoal(IH, { kind: "pp", assists: [a1] })]);
    expect(state.goalLog).toBeUndefined();
    expect(Object.keys(JSON.parse(JSON.stringify(state)))).not.toContain("goalLog");
  });

  it("surfaces the goal log in summary.detail only once it exists", () => {
    const coarse = icehockey.summary(foldIce([start, iceGoal(IH)])).detail as Record<string, unknown>;
    expect("goalLog" in coarse).toBe(false);
    const fine = icehockey.summary(foldIce([start, iceGoal(IH, { person: scorer })])).detail as {
      goalLog: { person: string }[];
    };
    expect(fine.goalLog[0]?.person).toBe(scorer);
  });
});

// ---------------------------------------------------------------------------
// Suspensions — IIHF penalty section: player, infraction, duration, who serves.
// ---------------------------------------------------------------------------

describe("W4 audit — suspension infraction, server and awarded duration", () => {
  it("carries the infraction reason onto the running suspension and the card log", () => {
    const state = foldIce([
      start,
      {
        type: "icehockey.suspension.start",
        payload: { by: IA, person: "ia-4", class: "minor", reason: "tripping" },
      },
    ]);
    expect(state.suspensions[0]).toMatchObject({ side: "away", person: "ia-4", reason: "tripping" });
    expect(state.cardLog[0]).toMatchObject({ classKey: "minor", reason: "tripping" });
  });

  it("names the player serving a bench minor separately from the offence", () => {
    const events = [
      start,
      {
        type: "icehockey.suspension.start",
        payload: { by: IA, class: "bench_minor", reason: "too many men", servedBy: "ia-9" },
      },
    ] as ModuleEvent[];
    const state = foldIce(events);
    expect(state.suspensions[0]?.servedBy).toBe("ia-9");
    expect(state.cardLog[0]?.servedBy).toBe("ia-9");
    const rows = aggregatePlayerStats(envelopes(events), icehockey.playerStats!);
    expect(rows.find((r) => r.personId === "ia-9")?.stats.pen_served).toBe(1);
  });

  it("records the duration an umpire actually awarded (FIH yellow is a minimum)", () => {
    const state = foldFih([
      start,
      {
        type: "hockey.suspension.start",
        payload: { by: FA, person: "fa-3", class: "yellow", minutes: 10, reason: "dangerous play" },
      },
    ]);
    expect(state.suspensions[0]?.minutes).toBe(10);
    expect(state.cardLog[0]?.minutes).toBe(10);
  });

  it("leaves the new keys absent when the scorer records none (golden guard)", () => {
    const state = foldIce([
      start,
      { type: "icehockey.suspension.start", payload: { by: IA, class: "minor" } },
    ]);
    expect(JSON.stringify(state.suspensions)).toBe(
      '[{"side":"away","classKey":"minor","teamShort":true,"permanent":false}]',
    );
    expect(JSON.stringify(state.cardLog)).toBe('[{"side":"away","classKey":"minor"}]');
  });
});

// ---------------------------------------------------------------------------
// Shoot-out — IIHF GWS sheet and FIH App 12 both name shooter AND goalkeeper.
// ---------------------------------------------------------------------------

describe("W4 audit — shoot-out taker and defending goalkeeper", () => {
  const toSo: ModuleEvent[] = [
    start,
    { type: "icehockey.period.advance", payload: { to: "P2" } },
    { type: "icehockey.period.advance", payload: { to: "P3" } },
    { type: "icehockey.period.advance", payload: { to: "FT" } },
    { type: "icehockey.period.advance", payload: { to: "FT" } },
  ];

  it("keeps the shooter and the goalkeeper on the recorded kick", () => {
    const events = [
      ...toSo,
      {
        type: "icehockey.shootout.attempt",
        payload: { by: IH, person: "ih-7", goalkeeper: "ia-1", scored: true },
      },
      {
        type: "icehockey.shootout.attempt",
        payload: { by: IA, person: "ia-5", goalkeeper: "ih-1", scored: false },
      },
    ] as ModuleEvent[];
    const state = foldIce(events);
    expect(state.shootout?.kicks).toEqual([
      { side: "home", scored: true, person: "ih-7", goalkeeper: "ia-1" },
      { side: "away", scored: false, person: "ia-5", goalkeeper: "ih-1" },
    ]);
    const rows = aggregatePlayerStats(envelopes(events), icehockey.playerStats!);
    expect(rows.find((r) => r.personId === "ih-7")?.stats.so_goals).toBe(1);
    expect(rows.find((r) => r.personId === "ih-1")?.stats.so_saves).toBe(1);
    expect(rows.find((r) => r.personId === "ia-5")?.stats.so_attempts).toBe(1);
  });

  it("an anonymous attempt records exactly the pre-W4 kick shape (golden guard)", () => {
    const state = foldIce([
      ...toSo,
      { type: "icehockey.shootout.attempt", payload: { by: IH, scored: true } },
    ]);
    expect(JSON.stringify(state.shootout)).toBe('{"kicks":[{"side":"home","scored":true}]}');
  });
});

// ---------------------------------------------------------------------------
// Set pieces — FIH records penalty corners / strokes AWARDED, not only scored;
// IIHF records an awarded penalty shot whether or not it beat the goalkeeper.
// ---------------------------------------------------------------------------

describe("W4 audit — awarded vs converted set pieces", () => {
  it("tallies FIH penalty corners awarded and converted per side", () => {
    const state = foldFih([
      start,
      { type: "hockey.set_piece", payload: { by: FH, kind: "pc" } },
      { type: "hockey.set_piece", payload: { by: FH, kind: "pc", converted: true } },
      { type: "hockey.set_piece", payload: { by: FH, kind: "pc" } },
      { type: "hockey.set_piece", payload: { by: FA, kind: "stroke", person: "fa-8" } },
    ]);
    expect(state.setPieces).toEqual({
      home: { pc: { awarded: 3, converted: 1 } },
      away: { stroke: { awarded: 1, converted: 0 } },
    });
    const detail = hockey.summary(state).detail as { setPieces: unknown };
    expect(detail.setPieces).toEqual(state.setPieces);
  });

  it("credits the stroke taker and the goalkeeper who faced it", () => {
    const events = [
      start,
      {
        type: "hockey.set_piece",
        payload: { by: FA, kind: "stroke", person: "fa-8", goalkeeper: "fh-1", converted: false },
      },
    ] as ModuleEvent[];
    const rows = aggregatePlayerStats(envelopes(events), hockey.playerStats!);
    expect(rows.find((r) => r.personId === "fa-8")?.stats.strokes_taken).toBe(1);
  });

  it("accepts the penalty shot on ice and rejects a FIH kind there", () => {
    const events = [
      start,
      { type: "icehockey.set_piece", payload: { by: IH, kind: "ps", person: "ih-7" } },
    ] as ModuleEvent[];
    const state = foldIce(events);
    expect(state.setPieces?.home?.ps).toEqual({ awarded: 1, converted: 0 });
    const rows = aggregatePlayerStats(envelopes(events), icehockey.playerStats!);
    expect(rows.find((r) => r.personId === "ih-7")?.stats.ps_taken).toBe(1);
    expect(() =>
      foldIce([start, { type: "icehockey.set_piece", payload: { by: IH, kind: "pc" } }]),
    ).toThrowError(EngineError);
  });

  it("refuses a set piece outside a play phase", () => {
    expect(() =>
      foldFih([{ type: "hockey.set_piece", payload: { by: FH, kind: "pc" } }]),
    ).toThrowError(EngineError);
  });

  it("leaves setPieces absent when no set piece is recorded (golden guard)", () => {
    expect(foldFih([start, fihGoal(FH)]).setPieces).toBeUndefined();
    const detail = hockey.summary(foldFih([start])).detail as Record<string, unknown>;
    expect("setPieces" in detail).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Union disambiguation — widening a strict branch must not let it swallow a
// sibling's canonical payload (AGENTS: z.union takes the first branch that
// parses; `apply` dispatches on the ENVELOPE type, so the union only has to
// stay a superset — but each branch must still accept its own payload).
// ---------------------------------------------------------------------------

describe("W4 audit — event union stays disambiguated", () => {
  const canonical = [
    { name: "goal", schema: PeriodGoal, payload: { by: IH, person: "ih-7", kind: "pp", emptyNet: true, clockRef: "01:02" } },
    { name: "advance", schema: PeriodAdvance, payload: { to: "P2" } },
    {
      name: "suspension.start",
      schema: PeriodSuspensionStart,
      payload: { by: IA, person: "ia-4", class: "minor", reason: "hooking", servedBy: "ia-9", minutes: 2 },
    },
    { name: "suspension.end", schema: PeriodSuspensionEnd, payload: { by: IA, class: "minor" } },
    {
      name: "shootout.attempt",
      schema: PeriodShootoutAttempt,
      payload: { by: IH, person: "ih-7", goalkeeper: "ia-1", scored: true },
    },
    {
      name: "set_piece",
      schema: PeriodSetPiece,
      payload: { by: FH, kind: "pc", person: "fh-3", goalkeeper: "fa-1", converted: true },
    },
  ] as const;

  it("every branch accepts its own canonical payload, and the union accepts all", () => {
    for (const entry of canonical) {
      expect(entry.schema.safeParse(entry.payload).success, entry.name).toBe(true);
      expect(PeriodEv.safeParse(entry.payload).success, `union: ${entry.name}`).toBe(true);
    }
  });

  it("the widened goal branch still refuses every sibling's discriminating key", () => {
    // `class`, `to`, `scored` and a required `kind`-only payload are what tell
    // the branches apart structurally; PeriodGoal is strict and must reject
    // the first three outright.
    expect(PeriodGoal.safeParse({ by: IA, class: "minor" }).success).toBe(false);
    expect(PeriodGoal.safeParse({ to: "P2" }).success).toBe(false);
    expect(PeriodGoal.safeParse({ by: IH, scored: true }).success).toBe(false);
    expect(PeriodGoal.safeParse({ by: IH, converted: true }).success).toBe(false);
  });

  it("each canonical payload folds under its own event type to the expected state", () => {
    const soPrefix: ModuleEvent[] = [
      start,
      { type: "icehockey.period.advance", payload: { to: "P2" } },
      { type: "icehockey.period.advance", payload: { to: "P3" } },
      { type: "icehockey.period.advance", payload: { to: "FT" } },
      { type: "icehockey.period.advance", payload: { to: "FT" } },
    ];
    expect(foldIce([start, iceGoal(IH, { person: "ih-7" })]).goals).toEqual({ home: 1, away: 0 });
    expect(foldIce([start, { type: "icehockey.period.advance", payload: { to: "P2" } }]).phase).toBe("P2");
    const susp = foldIce([
      start,
      { type: "icehockey.suspension.start", payload: { by: IA, class: "minor", reason: "hooking" } },
    ]);
    expect(susp.suspensions).toHaveLength(1);
    expect(
      foldIce([
        start,
        { type: "icehockey.suspension.start", payload: { by: IA, class: "minor" } },
        { type: "icehockey.suspension.end", payload: { by: IA, class: "minor" } },
      ]).suspensions,
    ).toHaveLength(0);
    expect(
      foldIce([
        ...soPrefix,
        { type: "icehockey.shootout.attempt", payload: { by: IH, person: "ih-7", scored: true } },
      ]).shootout?.kicks,
    ).toHaveLength(1);
    expect(
      foldIce([start, { type: "icehockey.set_piece", payload: { by: IH, kind: "ps" } }]).setPieces
        ?.home?.ps?.awarded,
    ).toBe(1);
  });
});

describe("W4 audit — module identity is unchanged", () => {
  it("both modules stay at 1.0.0 and keep every declared variant", () => {
    expect(hockey.version).toBe("1.0.0");
    expect(icehockey.version).toBe("1.0.0");
    expect(Object.keys(hockey.variants).sort()).toEqual(["fih-outdoor", "fih-shootout", "youth"]);
    expect(Object.keys(icehockey.variants).sort()).toEqual(["iihf", "recreational"]);
  });

  it("the set-piece type is reachable at the attributed-scoring tiers", () => {
    for (const module of [hockey, icehockey]) {
      const tier3 = module.fidelityTiers.find((t) => t.tier === 3);
      expect(tier3?.eventTypes, module.key).toContain(`${module.key}.set_piece`);
      const tier0 = module.fidelityTiers.find((t) => t.tier === 0);
      expect(tier0?.eventTypes, module.key).not.toContain(`${module.key}.set_piece`);
    }
  });
});
