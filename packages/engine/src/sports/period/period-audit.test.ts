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
import { AttemptOutcome } from "../../core/types.ts";
import { PenaltyOutcome } from "../football/football.ts";
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

// W4a (#425) §3.3 — every fold below is PAD-SHAPED: it is building a stream
// event by event, which is the write path. `strictFromSeq: 0` marks the whole
// stream new and is therefore exactly the pre-seam behaviour. Only a real READ
// path (apps/web fold.ts) and the cfg-replay property pass no options.
const STRICT_ALL = { strictFromSeq: 0 } as const;

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
  return foldMatch(icehockey, cfg, iceLineups, envelopes(events), STRICT_ALL);
}

function foldFih(events: ModuleEvent[], variant?: string): PeriodState {
  const cfg = hockey.configSchema.parse(variant === undefined ? {} : hockey.variants[variant]);
  return foldMatch(hockey, cfg, fihLineups, envelopes(events), STRICT_ALL);
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
    const state = foldIce([start, iceGoal(IH, { kind: "pp" })]);
    expect(state.goalLog).toBeUndefined();
    expect(Object.keys(JSON.parse(JSON.stringify(state)))).not.toContain("goalLog");
  });

  // W4 review item 7 — the log's trigger was `person || clockRef || emptyNet`,
  // so an unattributed goal that named its ASSISTS produced no entry at all
  // and the assists vanished from the state-side scoresheet. They still fed
  // the player metrics off the ledger, which is what hid it. An assist is
  // attribution; if it is recorded, the goal is a logged goal.
  it("logs a goal attributed only by its assists", () => {
    const state = foldIce([start, iceGoal(IH, { assists: [a1] })]);
    expect(state.goalLog).toEqual([
      { phase: "P1", by: "home", credited: "home", assists: [a1] },
    ]);
  });

  it("keeps the assists on the log when the scorer is named too", () => {
    const state = foldIce([start, iceGoal(IH, { person: scorer, assists: [a1] })]);
    expect(state.goalLog?.[0]?.assists).toEqual([a1]);
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
      { type: "hockey.set_piece", payload: { by: FH, kind: "pc", outcome: "scored" } },
      { type: "hockey.set_piece", payload: { by: FH, kind: "pc" } },
      { type: "hockey.set_piece", payload: { by: FA, kind: "stroke", person: "fa-8" } },
    ]);
    expect(state.setPieces).toEqual({
      home: { pc: { awarded: 3, scored: 1, resolved: 1 } },
      away: { stroke: { awarded: 1, scored: 0, resolved: 0 } },
    });
    const detail = hockey.summary(state).detail as { setPieces: unknown };
    expect(detail.setPieces).toEqual(state.setPieces);
  });

  it("credits the stroke taker and the goalkeeper who faced it", () => {
    const events = [
      start,
      {
        type: "hockey.set_piece",
        payload: { by: FA, kind: "stroke", person: "fa-8", goalkeeper: "fh-1", outcome: "saved" },
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
    expect(state.setPieces?.home?.ps).toEqual({ awarded: 1, scored: 0, resolved: 0 });
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

  // W4 review item 2 — an attempt's RESULT had two shapes in one wave: the
  // period kernel's `converted: boolean` and football's `outcome: saved |
  // missed | post`. A boolean cannot say "hit the post", so `outcome` wins and
  // the boolean's true case becomes the token `scored`. The vocabulary is
  // shared (core/types.ts) so W5 renders ONE result control; each sport still
  // declares which tokens its own branch accepts.
  describe("one name and one vocabulary for an attempt's result", () => {
    it("counts a set piece as scored from `outcome`, football's key", () => {
      const state = foldFih([
        start,
        { type: "hockey.set_piece", payload: { by: FH, kind: "pc" } },
        { type: "hockey.set_piece", payload: { by: FH, kind: "pc", outcome: "scored" } },
        { type: "hockey.set_piece", payload: { by: FH, kind: "pc", outcome: "saved" } },
      ]);
      expect(state.setPieces).toEqual({
        home: { pc: { awarded: 3, scored: 1, resolved: 2 } },
        away: {},
      });
    });

    it("rejects the pre-unification `converted` boolean outright", () => {
      expect(() =>
        foldFih([
          start,
          { type: "hockey.set_piece", payload: { by: FH, kind: "pc", converted: true } },
        ]),
      ).toThrowError(EngineError);
    });

    it("keeps an unrecorded result absent — awarded still counts, scored does not", () => {
      // Absence is the honest reading of "the scorer did not say": the goal, if
      // there was one, arrives as a goal event, so nothing is lost.
      const state = foldFih([start, { type: "hockey.set_piece", payload: { by: FA, kind: "stroke" } }]);
      expect(state.setPieces?.away?.stroke).toEqual({ awarded: 1, scored: 0, resolved: 0 });
    });

    // `outcome` is OPTIONAL and stays that way — requiring it is a schema
    // narrowing that would stop every already-recorded event without one from
    // parsing. But two counters cannot express three states, so an attempt the
    // scorer never resolved folded to exactly the same numbers as a recorded
    // MISS. `resolved` is the third: `awarded − resolved` is the visible
    // unknown, and a conversion rate is `scored / resolved`, never
    // `scored / awarded`.
    describe("an unresolved set piece is not a miss (#429 silent-0, one level down)", () => {
      const pc = (outcome?: string): ModuleEvent => ({
        type: "hockey.set_piece",
        payload: { by: FH, kind: "pc", ...(outcome === undefined ? {} : { outcome }) },
      });

      it("counts an attempt with no recorded result as UNRESOLVED, not as a miss", () => {
        const state = foldFih([start, pc("scored"), pc("saved"), pc()]);
        // 3 awarded, 2 resolved, 1 scored ⇒ conversion 1/2 and one unknown.
        // Before this the same stream read {awarded: 3, scored: 1} and every
        // consumer computing a rate got 1/3.
        expect(state.setPieces?.home?.pc).toEqual({ awarded: 3, scored: 1, resolved: 2 });
      });

      it("a recorded MISS and an unrecorded result are no longer the same tally", () => {
        // The crux. These two states were byte-identical before, which is what
        // made the drag toward zero silent rather than visible.
        const missed = foldFih([start, pc("missed")]);
        const silent = foldFih([start, pc()]);
        expect(missed.setPieces?.home?.pc).toEqual({ awarded: 1, scored: 0, resolved: 1 });
        expect(silent.setPieces?.home?.pc).toEqual({ awarded: 1, scored: 0, resolved: 0 });
        expect(missed.setPieces).not.toEqual(silent.setPieces);
      });

      it("every non-scoring token still resolves — `post` and `saved` are results", () => {
        // `resolved` must key on the PRESENCE of an outcome, not on a list of
        // tokens: keying on tokens would silently unresolve any member added to
        // `AttemptOutcome` later.
        const state = foldFih([start, pc("post"), pc("saved"), pc("missed")]);
        expect(state.setPieces?.home?.pc).toEqual({ awarded: 3, scored: 0, resolved: 3 });
      });

      it("the summary detail carries the same three counters, not a derived rate", () => {
        // Integers only. A float here would fix the precision and the rounding
        // for every consumer, and `compareRatio` already cross-multiplies.
        const state = foldFih([start, pc("scored"), pc()]);
        const detail = hockey.summary(state).detail as { setPieces: unknown };
        expect(detail.setPieces).toEqual(state.setPieces);
        expect(JSON.stringify(detail.setPieces)).not.toMatch(/\./);
      });
    });

    it("shares the vocabulary with football's penalty, which cannot say `scored`", () => {
      expect(AttemptOutcome.options).toEqual(["scored", "saved", "missed", "post"]);
      // A converted football penalty is already `football.goal { penalty: true }`,
      // so its branch takes the same tokens MINUS the one that would double-count.
      expect(PenaltyOutcome.options.every((o) => AttemptOutcome.options.includes(o))).toBe(true);
      expect(PenaltyOutcome.options).not.toContain("scored");
    });
  });

  // W4 review item 4 — the allowed kinds were read off a compile-time PRESET
  // field, justified in the code by "a new cfg key would break replay for
  // every recorded stream". That stopped being true when the golden started
  // comparing `cfg` as a SUBSET: a defaulted knob is additive and reds nothing
  // (proved by dropping `probeKnob: z.string().default("PROBE")` into this
  // schema — golden stayed 45/45). A preset is a source file; a competition
  // that records a different awarded restart had no way to say so.
  describe("the allowed kinds are configuration, not a compile-time constant", () => {
    const foldWith = (cfgRaw: unknown, events: ModuleEvent[]): PeriodState =>
      foldMatch(
        hockey,
        hockey.configSchema.parse(cfgRaw),
        fihLineups,
        envelopes(events),
        STRICT_ALL,
      );

    it("defaults to the kinds the preset declares", () => {
      expect(hockey.configSchema.parse({}).setPieceKinds).toEqual(["pc", "stroke"]);
      expect(icehockey.configSchema.parse({}).setPieceKinds).toEqual(["ps"]);
    });

    it("accepts a kind a competition declared and the preset never knew", () => {
      const state = foldWith({ setPieceKinds: ["pc", "stroke", "penalty_corner_rebound"] }, [
        start,
        { type: "hockey.set_piece", payload: { by: FH, kind: "penalty_corner_rebound" } },
      ]);
      expect(state.setPieces).toEqual({
        home: { penalty_corner_rebound: { awarded: 1, scored: 0, resolved: 0 } },
        away: {},
      });
    });

    it("refuses a kind the competition dropped from the default list", () => {
      expect(() =>
        foldWith({ setPieceKinds: ["pc"] }, [
          start,
          { type: "hockey.set_piece", payload: { by: FH, kind: "stroke" } },
        ]),
      ).toThrowError(EngineError);
    });

    it("turns the event off entirely when the list is emptied", () => {
      expect(() =>
        foldWith({ setPieceKinds: [] }, [
          start,
          { type: "hockey.set_piece", payload: { by: FH, kind: "pc" } },
        ]),
      ).toThrowError(EngineError);
    });
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
      payload: { by: FH, kind: "pc", person: "fh-3", goalkeeper: "fa-1", outcome: "scored" },
    },
  ] as const;

  it("every branch accepts its own canonical payload, and the union accepts all", () => {
    for (const entry of canonical) {
      expect(entry.schema.safeParse(entry.payload).success, entry.name).toBe(true);
      // NOTE (W4 review item 7): the second assertion cannot fail on its own —
      // a union accepts a payload if ANY branch does, and these branches are
      // structural supersets of one another. It is kept because a branch that
      // vanished from the union WOULD show up here, but the discriminator
      // itself is pinned by the fold test below, not by this.
      expect(PeriodEv.safeParse(entry.payload).success, `union: ${entry.name}`).toBe(true);
    }
  });

  // W4 review item 7 — `{ by, class }` satisfies PeriodSuspensionStart AND
  // PeriodSuspensionEnd, so no union parse can tell them apart. `apply`
  // dispatches on the ENVELOPE's type string, and that is what actually
  // decides: fold the identical payload under both types and watch the states
  // diverge. (Same shape as football.domain.test.ts's ambiguous-payload test.)
  it("makes the envelope type the discriminator for the ambiguous suspension shape", () => {
    const ambiguous = { by: IA, class: "minor" };
    expect(PeriodSuspensionStart.safeParse(ambiguous).success).toBe(true);
    expect(PeriodSuspensionEnd.safeParse(ambiguous).success).toBe(true);

    const asStart = foldIce([start, { type: "icehockey.suspension.start", payload: ambiguous }]);
    expect(asStart.suspensions).toHaveLength(1);
    expect(asStart.cardLog).toHaveLength(1);

    // The identical payload under the other type is REFUSED outright: there is
    // no running suspension to release. Same bytes, opposite verdicts.
    expect(() =>
      foldIce([start, { type: "icehockey.suspension.end", payload: ambiguous }]),
    ).toThrowError(EngineError);

    // And once one IS running, the same payload releases it instead of adding
    // a second — so the divergence is in the fold, not only in the guard.
    const released = foldIce([
      start,
      { type: "icehockey.suspension.start", payload: ambiguous },
      { type: "icehockey.suspension.end", payload: ambiguous },
    ]);
    expect(released.suspensions).toHaveLength(0);
    expect(released.cardLog).toHaveLength(1); // the sanction still happened
    expect(JSON.stringify(asStart)).not.toBe(JSON.stringify(released));
  });

  it("the widened goal branch still refuses every sibling's discriminating key", () => {
    // `class`, `to`, `scored` and a required `kind`-only payload are what tell
    // the branches apart structurally; PeriodGoal is strict and must reject
    // the first three outright.
    expect(PeriodGoal.safeParse({ by: IA, class: "minor" }).success).toBe(false);
    expect(PeriodGoal.safeParse({ to: "P2" }).success).toBe(false);
    expect(PeriodGoal.safeParse({ by: IH, scored: true }).success).toBe(false);
    expect(PeriodGoal.safeParse({ by: IH, outcome: "scored" }).success).toBe(false);
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
