// Kernel guarantees as executable tests — spec 03 §2 list 1–4, PROMPT-02 §5.
// Written against a toy in-file coin-flip sport so the kernel is testable
// before any real module exists.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import {
  CORE_EVENT_SCHEMAS,
  foldMatch,
  isCoreEventType,
  resolveVoids,
  validateCoreEvent,
  type EventEnvelope,
  type FoldableModule,
} from "./events.ts";
import type { LineupPair, MatchOutcome } from "./types.ts";

// ---------------------------------------------------------------------------
// Toy coin-flip sport module. First side to `target` flips wins; `coin.stop`
// ends early (draw if level, win otherwise); `coin.handshake` is a
// sport-declared post-decision event.
// ---------------------------------------------------------------------------

interface CoinCfg {
  target: number;
}

interface CoinState {
  phase: "pre" | "live" | "done" | "final";
  target: number;
  entrants: { home: string; away: string };
  score: { home: number; away: number };
  outcome: MatchOutcome | null;
  notes: string[];
}

const cfg: CoinCfg = { target: 3 };

const lineups: LineupPair = {
  home: { entrantId: "H", slots: [{ personId: "p1", slot: "starting", orderNo: 1 }] },
  away: { entrantId: "A", slots: [{ personId: "p2", slot: "starting", orderNo: 1 }] },
};

const coinflip: FoldableModule<CoinCfg, CoinState> = {
  init: (c, lu) => ({
    phase: "pre",
    target: c.target,
    entrants: { home: lu.home.entrantId, away: lu.away.entrantId },
    score: { home: 0, away: 0 },
    outcome: null,
    notes: [],
  }),
  apply(state, event) {
    switch (event.type) {
      case "core.start": {
        if (state.phase !== "pre") throw new EngineError("WRONG_PHASE", "already started");
        return { ...state, phase: "live" };
      }
      case "coin.flip": {
        if (state.phase !== "live") throw new EngineError("WRONG_PHASE", "not live");
        const to = (event.payload as { to: string }).to;
        if (to !== "home" && to !== "away") throw new EngineError("INVALID_EVENT", "bad flip");
        const score = { ...state.score, [to]: state.score[to] + 1 };
        if (score[to] >= state.target) {
          const winner = state.entrants[to];
          const loser = to === "home" ? state.entrants.away : state.entrants.home;
          return {
            ...state,
            score,
            phase: "done",
            outcome: { kind: "win", winner, loser, method: "regulation" },
          };
        }
        return { ...state, score };
      }
      case "coin.stop": {
        if (state.phase !== "live") throw new EngineError("WRONG_PHASE", "not live");
        if (state.score.home === state.score.away) {
          return { ...state, phase: "done", outcome: { kind: "draw" } };
        }
        const homeLeads = state.score.home > state.score.away;
        return {
          ...state,
          phase: "done",
          outcome: {
            kind: "win",
            winner: homeLeads ? state.entrants.home : state.entrants.away,
            loser: homeLeads ? state.entrants.away : state.entrants.home,
            method: "timeout",
          },
        };
      }
      case "core.forfeit": {
        if (state.phase === "done" || state.phase === "final") {
          throw new EngineError("WRONG_PHASE", "already over");
        }
        const by = (event.payload as { by: string }).by;
        if (by !== state.entrants.home && by !== state.entrants.away) {
          throw new EngineError("INVALID_EVENT", "unknown entrant");
        }
        const winner = by === state.entrants.home ? state.entrants.away : state.entrants.home;
        return { ...state, phase: "done", outcome: { kind: "award", winner } };
      }
      case "core.abandon": {
        if (state.phase !== "live") throw new EngineError("WRONG_PHASE", "not live");
        return { ...state, phase: "done", outcome: { kind: "no_result" } };
      }
      case "core.finalize": {
        if (state.phase !== "done") throw new EngineError("WRONG_PHASE", "not decided");
        return { ...state, phase: "final" };
      }
      case "core.note": {
        return { ...state, notes: [...state.notes, (event.payload as { text: string }).text] };
      }
      case "coin.handshake": {
        return { ...state, notes: [...state.notes, "handshake"] };
      }
      default:
        throw new EngineError("INVALID_EVENT", `unknown event type "${event.type}"`);
    }
  },
  outcome: (state) => state.outcome,
  postDecisionTypes: ["coin.handshake"],
};

// Same sport without declared post-decision types — exercises the `?? []`
// fallback in foldMatch.
const bareCoinflip: FoldableModule<CoinCfg, CoinState> = {
  ...coinflip,
  postDecisionTypes: undefined,
};

function env(seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope {
  return {
    id: `e-${seq}`,
    fixtureId: "fx-1",
    seq,
    type,
    payload,
    recordedAt: "2026-01-01T00:00:00.000Z",
    recordedBy: "scorer-1",
    ...(voids === undefined ? {} : { voids }),
  };
}

function stream(...specs: Array<[type: string, payload?: unknown, voids?: string]>) {
  return specs.map(([type, payload, voids], i) => env(i, type, payload, voids));
}

const fold = (events: EventEnvelope[]) => foldMatch(coinflip, cfg, lineups, events);

// Fold to state or to an EngineError code — void-equivalence must hold for
// throwing streams too.
function foldResult(events: EventEnvelope[]): { ok: CoinState } | { err: string } {
  try {
    return { ok: fold(events) };
  } catch (error) {
    if (EngineError.is(error)) return { err: error.code };
    throw error;
  }
}

const START: [string] = ["core.start"];
const FLIP_H: [string, unknown] = ["coin.flip", { to: "home" }];
const FLIP_A: [string, unknown] = ["coin.flip", { to: "away" }];

// ---------------------------------------------------------------------------
// resolveVoids
// ---------------------------------------------------------------------------

describe("resolveVoids", () => {
  it("passes a void-free stream through unchanged", () => {
    const events = stream(START, FLIP_H, FLIP_A);
    expect(resolveVoids(events)).toEqual(events);
  });

  it("drops the voided event and the void itself, preserving order", () => {
    const events = stream(START, FLIP_H, FLIP_A, ["core.void", {}, "e-1"]);
    expect(resolveVoids(events).map((e) => e.id)).toEqual(["e-0", "e-2"]);
  });

  it("resolves multiple voids independently", () => {
    const events = stream(
      START,
      FLIP_H,
      FLIP_A,
      ["core.void", {}, "e-1"],
      FLIP_H,
      ["core.void", {}, "e-2"],
    );
    expect(resolveVoids(events).map((e) => e.id)).toEqual(["e-0", "e-4"]);
  });

  it("treats a duplicate void of the same event as idempotent", () => {
    const events = stream(START, FLIP_H, ["core.void", {}, "e-1"], ["core.void", {}, "e-1"]);
    expect(resolveVoids(events).map((e) => e.id)).toEqual(["e-0"]);
  });

  it("rejects a void of a void — voids are not themselves voidable (PROMPT-02)", () => {
    const events = stream(START, FLIP_H, ["core.void", {}, "e-1"], ["core.void", {}, "e-2"]);
    expect(() => resolveVoids(events)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT", message: expect.stringMatching(/not themselves voidable/) }),
    );
  });

  it("rejects a void without a target id", () => {
    const events = stream(START, ["core.void", {}]);
    expect(() => resolveVoids(events)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT", message: expect.stringMatching(/requires a `voids` target/) }),
    );
  });

  it("rejects a void of an unknown event id", () => {
    const events = stream(START, ["core.void", {}, "e-99"]);
    expect(() => resolveVoids(events)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT", message: expect.stringMatching(/unknown or non-prior/) }),
    );
  });

  it("rejects a void of a later event — voids cancel prior events only", () => {
    const events = stream(START, ["core.void", {}, "e-2"], FLIP_H);
    expect(() => resolveVoids(events)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT", message: expect.stringMatching(/unknown or non-prior/) }),
    );
  });

  it("rejects a void targeting itself", () => {
    const events = stream(START, ["core.void", {}, "e-1"]);
    expect(() => resolveVoids(events)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT", message: expect.stringMatching(/unknown or non-prior/) }),
    );
  });
});

// ---------------------------------------------------------------------------
// core event payload validation
// ---------------------------------------------------------------------------

describe("core event payloads", () => {
  it("knows exactly the seven core types (spec 03 §2 + Jul3/07 core.award)", () => {
    expect(Object.keys(CORE_EVENT_SCHEMAS).sort()).toEqual([
      "core.abandon",
      "core.award",
      "core.finalize",
      "core.forfeit",
      "core.note",
      "core.start",
      "core.void",
    ]);
    expect(isCoreEventType("core.start")).toBe(true);
    expect(isCoreEventType("cricket.ball")).toBe(false);
  });

  it("accepts valid payloads and ignores non-core types", () => {
    expect(() => validateCoreEvent(env(0, "core.forfeit", { by: "H", reason: "no-show" }))).not.toThrow();
    expect(() => validateCoreEvent(env(0, "coin.flip", { to: "nonsense" }))).not.toThrow();
  });

  it("rejects unknown core.* types", () => {
    expect(() => validateCoreEvent(env(0, "core.explode", {}))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT", message: expect.stringMatching(/unknown core event type/) }),
    );
  });

  it("rejects malformed core payloads with zod issues attached", () => {
    try {
      validateCoreEvent(env(0, "core.forfeit", { by: "H" }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(EngineError.is(error, "INVALID_EVENT")).toBe(true);
      expect((error as EngineError).data).toMatchObject({ eventId: "e-0" });
    }
  });
});

// ---------------------------------------------------------------------------
// foldMatch — spec 03 §2 guarantees 1–4
// ---------------------------------------------------------------------------

describe("foldMatch", () => {
  it("folds an empty stream to the initial state", () => {
    const state = fold([]);
    expect(state.phase).toBe("pre");
    expect(state.score).toEqual({ home: 0, away: 0 });
  });

  it("folds a full match to a decided, finalized state", () => {
    const state = fold(stream(START, FLIP_H, FLIP_A, FLIP_H, FLIP_H, ["core.finalize"]));
    expect(state.phase).toBe("final");
    expect(state.score).toEqual({ home: 3, away: 1 });
    expect(state.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "regulation" });
  });

  it("maps core.forfeit to an award and core.abandon to no_result", () => {
    expect(fold(stream(START, ["core.forfeit", { by: "H", reason: "no-show" }])).outcome).toEqual({
      kind: "award",
      winner: "A",
    });
    expect(fold(stream(START, ["core.abandon", { reason: "rain" }])).outcome).toEqual({
      kind: "no_result",
    });
  });

  it("validates core payloads before the module sees them", () => {
    expect(() => fold(stream(START, ["core.forfeit", { by: "H" }]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  // spec 03 §2 guarantee 1
  describe("guarantee 1 — determinism", () => {
    it("same inputs → deep-equal state", () => {
      const events = stream(START, FLIP_H, FLIP_A, ["core.note", { text: "windy" }], FLIP_H);
      expect(fold(events)).toEqual(fold(events));
    });
  });

  // spec 03 §2 guarantee 2 — persistence appends only if the fold accepts.
  describe("guarantee 2 — validation before append", () => {
    function tryAppend(ledger: EventEnvelope[], event: EventEnvelope): EventEnvelope[] {
      const next = [...ledger, event];
      foldMatch(coinflip, cfg, lineups, next); // throws → nothing appended
      return next;
    }

    it("rejects invalid events without touching the ledger", () => {
      let ledger = tryAppend([], env(0, "core.start"));
      expect(() => tryAppend(ledger, env(1, "coin.flip", { to: "sideways" }))).toThrowError(
        expect.objectContaining({ code: "INVALID_EVENT" }),
      );
      expect(() => tryAppend(ledger, env(1, "core.start"))).toThrowError(
        expect.objectContaining({ code: "WRONG_PHASE" }),
      );
      expect(ledger).toHaveLength(1);
      ledger = tryAppend(ledger, env(1, "coin.flip", { to: "home" }));
      expect(ledger).toHaveLength(2);
    });

    it("rejects unknown event types", () => {
      expect(() => fold(stream(START, ["coin.teleport"]))).toThrowError(
        expect.objectContaining({ code: "INVALID_EVENT" }),
      );
    });
  });

  // spec 03 §2 guarantee 3
  describe("guarantee 3 — undo = void", () => {
    it("voiding an event refolds as if it never happened", () => {
      const events = stream(START, FLIP_H, FLIP_A, FLIP_H);
      const withVoid = [...events, env(4, "core.void", {}, "e-2")];
      const without = events.filter((e) => e.id !== "e-2");
      expect(fold(withVoid)).toEqual(fold(without));
      expect(fold(withVoid).score).toEqual({ home: 2, away: 0 });
    });

    it("voiding the decisive event un-decides the match", () => {
      const events = stream(START, FLIP_H, FLIP_H, FLIP_H); // H wins 3-0
      const state = fold([...events, env(4, "core.void", {}, "e-3")]);
      expect(state.outcome).toBeNull();
      expect(state.phase).toBe("live");
    });

    it("modules never see core.void events", () => {
      const seen: string[] = [];
      const spy: FoldableModule<CoinCfg, CoinState> = {
        ...coinflip,
        apply: (s, e) => {
          seen.push(e.type);
          return coinflip.apply(s, e);
        },
      };
      foldMatch(spy, cfg, lineups, stream(START, FLIP_H, ["core.void", {}, "e-1"]));
      expect(seen).toEqual(["core.start"]);
    });
  });

  // spec 03 §2 guarantee 4
  describe("guarantee 4 — outcome monotonicity", () => {
    const decided = stream(START, FLIP_H, FLIP_H, FLIP_H); // H wins

    it("rejects further sport events once decided", () => {
      expect(() => fold([...decided, env(4, "coin.flip", { to: "away" })])).toThrowError(
        expect.objectContaining({ code: "ALREADY_DECIDED" }),
      );
    });

    it("accepts core.note and core.finalize after decision", () => {
      const state = fold([
        ...decided,
        env(4, "core.note", { text: "gg" }),
        env(5, "core.finalize"),
      ]);
      expect(state.phase).toBe("final");
      expect(state.notes).toEqual(["gg"]);
    });

    it("accepts sport-declared post-decision types", () => {
      const state = fold([...decided, env(4, "coin.handshake")]);
      expect(state.notes).toEqual(["handshake"]);
    });

    it("rejects undeclared post-decision types when the module declares none", () => {
      expect(() =>
        foldMatch(bareCoinflip, cfg, lineups, [...decided, env(4, "coin.handshake")]),
      ).toThrowError(expect.objectContaining({ code: "ALREADY_DECIDED" }));
    });

    it("a void that un-decides the match re-opens it for events", () => {
      const state = fold([
        ...decided,
        env(4, "core.void", {}, "e-3"),
        env(5, "coin.flip", { to: "away" }),
      ]);
      expect(state.score).toEqual({ home: 2, away: 1 });
      expect(state.outcome).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Property tests — spec 03 §6, PROMPT-02 acceptance (≥1000 generated streams).
// ---------------------------------------------------------------------------

type Command = { type: string; payload: unknown };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.constant<Command>({ type: "core.start", payload: {} }),
  fc.constantFrom<"home" | "away">("home", "away").map((to) => ({
    type: "coin.flip",
    payload: { to },
  })),
  fc.constant<Command>({ type: "coin.stop", payload: {} }),
  fc.constantFrom("H", "A").map((by) => ({
    type: "core.forfeit",
    payload: { by, reason: "walkover" },
  })),
  fc.constant<Command>({ type: "core.abandon", payload: { reason: "rain" } }),
  fc.constant<Command>({ type: "core.finalize", payload: {} }),
  fc.constant<Command>({ type: "core.note", payload: { text: "obs" } }),
  fc.constant<Command>({ type: "coin.handshake", payload: {} }),
);

// Mirrors the persistence append path: an event enters the ledger only if the
// fold accepts it — yields a random *valid* stream (spec 03 §2 guarantee 2).
function buildValidStream(commands: Command[]): EventEnvelope[] {
  const ledger: EventEnvelope[] = [];
  for (const command of commands) {
    const event = env(ledger.length, command.type, command.payload);
    try {
      fold([...ledger, event]);
    } catch {
      continue;
    }
    ledger.push(event);
  }
  return ledger;
}

const validStreamArb = fc.array(commandArb, { maxLength: 25 }).map(buildValidStream);

describe("kernel properties (fast-check)", () => {
  it("fold(events) deepEquals fold(events) over ≥1000 streams", () => {
    fc.assert(
      fc.property(validStreamArb, (events) => {
        expect(fold(events)).toEqual(fold(events));
      }),
      { numRuns: 1000 },
    );
  });

  it("voiding event i ≡ folding without it, over ≥1000 streams", () => {
    fc.assert(
      fc.property(validStreamArb, fc.nat(), (events, pick) => {
        fc.pre(events.length > 0);
        const i = pick % events.length;
        const target = events[i] as EventEnvelope;
        const withVoid = [...events, env(events.length, "core.void", {}, target.id)];
        const without = events.filter((_, index) => index !== i);
        expect(foldResult(withVoid)).toEqual(foldResult(without));
      }),
      { numRuns: 1000 },
    );
  });

  it("void of any event never crashes with a non-engine error", () => {
    fc.assert(
      fc.property(validStreamArb, fc.nat(), (events, pick) => {
        fc.pre(events.length > 0);
        const target = events[pick % events.length] as EventEnvelope;
        const result = foldResult([...events, env(events.length, "core.void", {}, target.id)]);
        if ("err" in result) expect(result.err).toBeTypeOf("string");
      }),
      { numRuns: 200 },
    );
  });
});
