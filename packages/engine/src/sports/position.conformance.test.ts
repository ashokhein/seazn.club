// W4a (#425) T6b — the SHARED match-position conformance suite.
//
// WHY THIS FILE EXISTS. `position` is one axis across eleven sports, and the
// wave has already proved twice what happens when eleven modules each own a
// copy of one rule: `playPhases` was fixed three times, and football alone had
// five divergences from the period kernel's time model. The lesson recorded
// there was "share the FUNCTION by reference and assert identity", and where a
// kernel makes that possible this file asserts exactly that. Where it does not
// — football and the period kernel have different state types and cannot share
// a module member — the next best thing is one suite both must pass, so a
// sport that hand-rolls its own answer has something it can RUN that reds.
//
// WHAT IS ASSERTED. Facts observable from a folded state, never a private
// helper name. Three shapes recur:
//
//   1. The projection at `init`, mid-match, and AFTER THE MATCH IS DECIDED.
//      The decided case is the one that carries the bug: `completed + 1` names
//      a set nobody played, and every sport would rediscover it separately.
//   2. A DISAGREEMENT case wherever the state offers two ways to derive the
//      same fact. That is the failure mode the whole read-side design exists to
//      avoid, and it is invisible unless the case where the two differ is
//      written down.
//   3. Monotonicity over a generated stream: position never travels backwards
//      as a match is folded, for any sport, under any seed.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import {
  MatchPosition,
  comparePosition,
  currentUnit,
  formatPosition,
  matchPositionOf,
} from "../core/position.ts";
import type { AnySportModule } from "../sport/module.ts";
import { buildStream, defaultLineupPair } from "../testkit/helpers.ts";
import { builtinModules } from "./index.ts";
import { boardgame } from "./boardgame/boardgame.ts";
import { carrom, type CarromBoardRecord, type CarromState } from "./carrom/carrom.ts";
import { cricket, type CricketState } from "./cricket/cricket.ts";
import { football, type FootballState } from "./football/football.ts";
import { generic } from "./generic/generic.ts";
import { hockey } from "./hockey/hockey.ts";
import { icehockey } from "./icehockey/icehockey.ts";
import { badminton } from "./setbased/badminton.ts";
import { tabletennis } from "./setbased/tabletennis.ts";
import { volleyball } from "./setbased/volleyball.ts";
import { tennis } from "./tennis/tennis.ts";
import type { PeriodState } from "./period/kernel.ts";
import type { NestedState } from "./nested/kernel.ts";
import type { SetBasedState } from "./setbased/kernel.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `init` under this module's default cfg, plus the cfg it was built from. */
function fresh<S>(module: AnySportModule): { cfg: unknown; state: S } {
  const cfg: unknown = module.configSchema.parse({});
  return { cfg, state: module.init(cfg, defaultLineupPair(module.positions)) as S };
}

/** The projection, rendered — what a plain-text consumer would print. */
function line(module: AnySportModule, state: unknown): string {
  const position = matchPositionOf(module, state);
  if (position === null) throw new Error(`module "${module.key}" declares no position`);
  return formatPosition(position);
}

// A decided outcome is only ever read for its non-nullness here.
const DECIDED = { kind: "win", winner: "home", loser: "away" } as const;

// ---------------------------------------------------------------------------
// 1. Which sports have a position, and which honestly do not
// ---------------------------------------------------------------------------

describe("the axis is declared, sport by sport, and never fabricated", () => {
  const PROJECTS = [
    "football",
    "hockey",
    "icehockey",
    "tennis",
    "badminton",
    "tabletennis",
    "volleyball",
    "cricket",
    "carrom",
  ];
  // NOT a gap. Boardgame's position IS the move index, which
  // `BoardgameResult.moves` already carries on its single terminal event — it
  // has no phases and nothing to project mid-match. Generic holds a running
  // score and no cursor at all. Inventing "Move 1" for either would be the
  // denormalised second source of truth the whole design refuses, so both fall
  // back to `seq` through the one place that decision lives.
  const ABSTAINS = ["boardgame", "generic"];

  it("every builtin module has decided one way or the other", () => {
    // Derived from the real registry, so a twelfth sport lands here unclassified
    // rather than quietly shipping with no position and no one noticing.
    const declared = builtinModules.filter((m) => m.position !== undefined).map((m) => m.key);
    const abstained = builtinModules.filter((m) => m.position === undefined).map((m) => m.key);
    expect([...declared].sort()).toEqual([...PROJECTS].sort());
    expect([...abstained].sort()).toEqual([...ABSTAINS].sort());
  });

  // generic's cfg has two fields with no default, so it cannot use `fresh`.
  const abstainers: [AnySportModule, unknown][] = [
    [boardgame, boardgame.configSchema.parse({})],
    [generic, generic.configSchema.parse({ resultMode: "score", allowDraws: true })],
  ];

  for (const [module, cfg] of abstainers) {
    it(`${module.key} falls back to seq, via the one call site`, () => {
      const state = module.init(cfg, defaultLineupPair(module.positions));
      expect(matchPositionOf(module, state)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Shared by REFERENCE where a kernel makes it possible
// ---------------------------------------------------------------------------

describe("sports built from one kernel hold ONE position function", () => {
  it("hockey and ice hockey are the same reference, not two equal lists", () => {
    // Identity, exactly like `mod.playPhases === playPhases`: a sport that
    // forks the derivation and still agrees today fails here, which is the
    // whole point — list equality would not.
    expect(hockey.position).toBeTypeOf("function");
    expect(hockey.position).toBe(icehockey.position);
  });

  it("all three set-based sports are the same reference", () => {
    expect(badminton.position).toBeTypeOf("function");
    expect(badminton.position).toBe(tabletennis.position);
    expect(badminton.position).toBe(volleyball.position);
  });

  it("football and the period kernel project the SAME shape for the same instant", () => {
    // These two cannot share a member — different state types — so this is the
    // guarantee that actually matters to W8: one renderer, one shape. It reds
    // if either hand-rolls a different key, label or ordinal basis.
    const fb = fresh<FootballState>(football);
    const hk = fresh<PeriodState>(hockey);
    const fbAt = {
      ...fb.state,
      phase: "H2" as const,
      periods: [
        { phase: "H1" as const, home: 0, away: 0 },
        { phase: "H2" as const, home: 0, away: 0 },
      ],
      asOf: { period: "H2", elapsed: 761 },
    };
    const hkAt = {
      ...hk.state,
      phase: "Q3",
      periods: [
        { phase: "Q1", home: 0, away: 0 },
        { phase: "Q2", home: 0, away: 0 },
        { phase: "Q3", home: 0, away: 0 },
      ],
      asOf: { period: "Q3", elapsed: 761 },
    };
    const fbPos = matchPositionOf(football, fbAt);
    const hkPos = matchPositionOf(hockey, hkAt);
    // H2 is index 2 of ["pre","H1","H2"]; Q3 is index 3 of
    // ["pre","Q1","Q2","Q3","Q4"] — different ordinals, same SHAPE.
    expect(fbPos?.segments.map((s) => ({ key: s.key, label: s.label }))).toEqual(
      hkPos?.segments.map((s) => ({ key: s.key, label: s.label })),
    );
    expect(fbPos?.segments[1]).toEqual(hkPos?.segments[1]);
    expect(formatPosition(fbPos as MatchPosition)).toBe("H2 · 12:41");
    expect(formatPosition(hkPos as MatchPosition)).toBe("Q3 · 12:41");
  });
});

// ---------------------------------------------------------------------------
// 3. Period sports — the phase, and the clock only when it belongs to it
// ---------------------------------------------------------------------------

describe("ice hockey — P2 12:41", () => {
  it("is the opening phase, unstamped, at init", () => {
    const { state } = fresh<PeriodState>(icehockey);
    expect(matchPositionOf(icehockey, state)).toEqual({
      segments: [{ key: "period", value: "pre", ordinal: 0 }],
    });
  });

  it("reads the period and the clock mid-match", () => {
    const { state } = fresh<PeriodState>(icehockey);
    const mid: PeriodState = {
      ...state,
      phase: "P2",
      periods: [
        { phase: "P1", home: 1, away: 0 },
        { phase: "P2", home: 0, away: 1 },
      ],
      asOf: { period: "P2", elapsed: 761 },
    };
    expect(line(icehockey, mid)).toBe("P2 · 12:41");
  });

  it("names the last phase PLAYED once the match is over, never 'done'", () => {
    // "done" is a terminal marker, not a place on the ice. A goal in a match
    // that has since ended still happened in P3, and the match report prints
    // that. `done` is also absent from `playPhases`, so reporting it would
    // hand W6 an unorderable position for every finished fixture.
    const { state } = fresh<PeriodState>(icehockey);
    const over: PeriodState = {
      ...state,
      phase: "done",
      periods: [
        { phase: "P1", home: 1, away: 0 },
        { phase: "P2", home: 0, away: 1 },
        { phase: "P3", home: 1, away: 0 },
      ],
      outcome: { ...DECIDED },
      asOf: { period: "P3", elapsed: 1199 },
    };
    expect(line(icehockey, over)).toBe("P3 · 19:59");
  });

  it("names SHOOTOUT for a match decided there", () => {
    const { state } = fresh<PeriodState>(icehockey);
    const so: PeriodState = {
      ...state,
      phase: "final",
      periods: [
        { phase: "P1", home: 0, away: 0 },
        { phase: "P2", home: 0, away: 0 },
        { phase: "P3", home: 0, away: 0 },
        { phase: "OT", home: 0, away: 0 },
      ],
      shootout: { kicks: [] },
      outcome: { ...DECIDED },
    };
    expect(line(icehockey, so)).toBe("SHOOTOUT");
  });
});

describe("DISAGREEMENT — the phase the fold is IN vs the phase the last stamp names", () => {
  // `PeriodState` offers two derivations of "which period are we in": `phase`,
  // and `asOf.period`. They legitimately differ — a period advances on an
  // UNSTAMPED whistle, and `asOf` then still names the period before it. Both
  // are `string`, so a producer that reached for the wrong one compiles, folds
  // and looks right, which is precisely the `DisciplineCard.entrantSide` shape
  // (`core/types.ts:38`). Pinned here in the case where the two differ.
  const cases: [string, AnySportModule, string, string, string][] = [
    ["ice hockey", icehockey, "P1", "P2", "P2"],
    ["football", football, "H1", "H2", "H2"],
  ];

  for (const [name, module, stale, current, expected] of cases) {
    it(`${name} takes the phase from the fold and DROPS the stale clock`, () => {
      const { state } = fresh<Record<string, unknown>>(module);
      const drifted = {
        ...state,
        phase: current,
        periods: [
          { phase: stale, home: 0, away: 0 },
          { phase: current, home: 0, away: 0 },
        ],
        // The newest stamp this fold applied — recorded in the PREVIOUS phase.
        asOf: { period: stale, elapsed: 2699 },
      };
      // The clock reading 44:59 belongs to the period that ended. Printing it
      // beside the current one asserts something false about where play is; the
      // honest answer is the phase alone, and `comparePosition` handles the
      // shorter position by comparing the common prefix.
      expect(line(module, drifted)).toBe(expected);
      expect(matchPositionOf(module, drifted)?.segments).toHaveLength(1);
    });

    it(`${name} keeps the clock when the stamp names the phase the fold is in`, () => {
      // The other half: without this, "drop the clock" could be implemented as
      // "never show the clock" and the case above would still pass.
      const { state } = fresh<Record<string, unknown>>(module);
      const agreed = {
        ...state,
        phase: current,
        periods: [
          { phase: stale, home: 0, away: 0 },
          { phase: current, home: 0, away: 0 },
        ],
        asOf: { period: current, elapsed: 2699 },
      };
      expect(line(module, agreed)).toBe(`${expected} · 44:59`);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Tennis — Set 2, Game 4, 30–15
// ---------------------------------------------------------------------------

describe("tennis — the brief's own example", () => {
  it("is set 1, game 1, love-all at init", () => {
    const { state } = fresh<NestedState>(tennis);
    expect(line(tennis, state)).toBe("Set 1 · Game 1 · 0–0");
  });

  it("reads Set 2 · Game 4 · 30–15", () => {
    const { state } = fresh<NestedState>(tennis);
    const mid: NestedState = {
      ...state,
      phase: "live",
      sets: [{ home: 6, away: 4 }],
      games: { home: 3, away: 0 },
      points: { kind: "standard", home: 2, away: 1, advantage: null },
    };
    expect(line(tennis, mid)).toBe("Set 2 · Game 4 · 30–15");
  });

  it("carries the tie-break through the same points segment", () => {
    const { state } = fresh<NestedState>(tennis);
    const tb: NestedState = {
      ...state,
      phase: "live",
      sets: [],
      games: { home: 6, away: 6 },
      points: { kind: "tiebreak", home: 5, away: 3 },
    };
    // Game 13 of the set — the tie-break IS a game, and `games` being held at
    // 6–6 is what makes that fall out rather than needing a special case.
    expect(line(tennis, tb)).toBe("Set 1 · Game 13 · TB 5–3");
  });

  it("DISAGREEMENT — a decided match names the last set played, not a phantom next one", () => {
    // `sets.length + 1` is the obvious derivation and it is wrong exactly once:
    // at the end. A best-of-three won 2–0 reads "Set 3", naming a set nobody
    // played, on every match report and every timeline row for that fixture.
    const { state } = fresh<NestedState>(tennis);
    const over: NestedState = {
      ...state,
      phase: "done",
      sets: [
        { home: 6, away: 4 },
        { home: 7, away: 5 },
      ],
      games: { home: 0, away: 0 },
      setsWon: { home: 2, away: 0 },
      outcome: { ...DECIDED },
    };
    expect(state.sets.length + 1).not.toBe(2); // the naive answer, spelled out
    expect(line(tennis, over)).toBe("Set 2 · Game 12");
    // …and the games come from the set that was played, not from `games`,
    // which the kernel resets when the set banks.
    expect(currentUnit(12, false)).toBe(12);
  });

  it("drops the game segment in a match tie-break, which has no games", () => {
    const { state } = fresh<NestedState>(tennis);
    const mtb: NestedState = {
      ...state,
      phase: "live",
      sets: [
        { home: 6, away: 4 },
        { home: 3, away: 6 },
      ],
      games: { home: 0, away: 0 },
      points: { kind: "matchTiebreak", home: 7, away: 5 },
    };
    expect(line(tennis, mtb)).toBe("Set 3 · MTB 7–5");
  });
});

// ---------------------------------------------------------------------------
// 5. Set-based — Set 3, 21–19
// ---------------------------------------------------------------------------

describe("set-based sports — set number and the running rally score", () => {
  it("is set 1 at love-all before the first rally", () => {
    const { state } = fresh<SetBasedState>(volleyball);
    expect(line(volleyball, state)).toBe("Set 1 · 0–0");
  });

  it("reads the OPEN set, not the length of the array", () => {
    const { state } = fresh<SetBasedState>(volleyball);
    const mid: SetBasedState = {
      ...state,
      phase: "live",
      sets: [
        { home: 25, away: 20, closed: true },
        { home: 18, away: 25, closed: true },
        { home: 21, away: 19, closed: false },
      ],
      setsWon: { home: 1, away: 1 },
    };
    // `sets` holds the closed sets AND the trailing open one, so `sets.length`
    // and "closed + 1" agree here and disagree between sets — the rule has to
    // be the completed count, and this is the case that says so.
    expect(line(volleyball, mid)).toBe("Set 3 · 21–19");
  });

  it("is the NEXT set at love-all between sets, when nothing is open", () => {
    const { state } = fresh<SetBasedState>(volleyball);
    const between: SetBasedState = {
      ...state,
      phase: "live",
      sets: [{ home: 25, away: 20, closed: true }],
      setsWon: { home: 1, away: 0 },
    };
    expect(line(volleyball, between)).toBe("Set 2 · 0–0");
  });

  it("DISAGREEMENT — a decided match names the last set played and its final score", () => {
    const { state } = fresh<SetBasedState>(badminton);
    const over: SetBasedState = {
      ...state,
      phase: "done",
      sets: [
        { home: 21, away: 19, closed: true },
        { home: 21, away: 15, closed: true },
      ],
      setsWon: { home: 2, away: 0 },
      outcome: { ...DECIDED },
    };
    expect(line(badminton, over)).toBe("Set 2 · 21–15");
  });

  it("ranks the rally score by points played, so two positions in one set order", () => {
    const { state } = fresh<SetBasedState>(volleyball);
    const at = (home: number, away: number): SetBasedState => ({
      ...state,
      phase: "live",
      sets: [{ home, away, closed: false }],
    });
    const earlier = matchPositionOf(volleyball, at(5, 3)) as MatchPosition;
    const later = matchPositionOf(volleyball, at(5, 8)) as MatchPosition;
    expect(comparePosition(earlier, later)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 6. Cricket — Innings 2, Over 12.3
// ---------------------------------------------------------------------------

describe("cricket — innings and the decimalised over", () => {
  const inn = (over: Partial<CricketState["innings"][number]>): CricketState["innings"][number] => ({
    battingSide: "home",
    runs: 0,
    wickets: 0,
    legalBalls: 0,
    boundaries: 0,
    declared: false,
    closed: false,
    ballsLimit: null,
    fine: null,
    ...over,
  });

  it("is innings 1 at the top of the innings", () => {
    const { state } = fresh<CricketState>(cricket);
    // `oversText` is cricket's own notation, shared with `summary`: a completed
    // over prints bare, so a fresh innings is "0", not "0.0".
    expect(line(cricket, state)).toBe("Innings 1 · Over 0");
  });

  it("reads Innings 2 · Over 12.3", () => {
    const { state } = fresh<CricketState>(cricket);
    const mid: CricketState = {
      ...state,
      phase: "live",
      innings: [inn({ closed: true, legalBalls: 120, runs: 152 }), inn({ legalBalls: 75, runs: 60 })],
    };
    expect(line(cricket, mid)).toBe("Innings 2 · Over 12.3");
  });

  it("DISAGREEMENT — the over comes from LEGAL balls, never balls bowled", () => {
    // An innings holds `legalBalls` and, on a fine innings, `extras`. Both are
    // integers on the same object and both count deliveries; only one of them
    // is the over reading. Three wides into an over the scoreboard says 0.3,
    // not 0.6, and the difference is invisible in a summary — it shows up as a
    // timeline that puts a wicket in the wrong over.
    const { state } = fresh<CricketState>(cricket);
    const wides: CricketState = {
      ...state,
      phase: "live",
      innings: [inn({ legalBalls: 3, runs: 7 })],
    };
    expect(line(cricket, wides)).toBe("Innings 1 · Over 0.3");
  });

  it("continues the innings count into a super over rather than restarting at 1", () => {
    // The super over's innings are the third and fourth of the match. Numbering
    // them 1 and 2 would send position BACKWARDS mid-fixture, which the
    // monotonicity property below would then catch — but only for cricket, and
    // only under a seed that reaches a tie.
    const { state } = fresh<CricketState>(cricket);
    const so: CricketState = {
      ...state,
      phase: "super_over",
      innings: [inn({ closed: true, legalBalls: 120 }), inn({ closed: true, legalBalls: 120 })],
      superOver: { innings: [inn({ legalBalls: 4, runs: 11 })], dismissed: { home: [], away: [] } },
    };
    expect(line(cricket, so)).toBe("Innings 3 · Over 0.4");
  });

  it("names the last innings played once the match is decided", () => {
    const { state } = fresh<CricketState>(cricket);
    const over: CricketState = {
      ...state,
      phase: "done",
      innings: [inn({ closed: true, legalBalls: 120 }), inn({ closed: true, legalBalls: 113 })],
      outcome: { ...DECIDED },
    };
    expect(line(cricket, over)).toBe("Innings 2 · Over 18.5");
  });
});

// ---------------------------------------------------------------------------
// 7. Carrom — Game 2, Board 3
// ---------------------------------------------------------------------------

describe("carrom — game and board", () => {
  const board = (winner: "home" | "away", points: number): CarromBoardRecord => ({
    winner,
    points,
    queenTo: null,
    queenScored: false,
    breaker: "home",
  });

  it("is game 1, board 1 at init", () => {
    const { state } = fresh<CarromState>(carrom);
    expect(line(carrom, state)).toBe("Game 1 · Board 1");
  });

  it("counts the board being played, not the boards already banked", () => {
    const { state } = fresh<CarromState>(carrom);
    const mid: CarromState = {
      ...state,
      phase: "live",
      games: [
        { boards: [], score: { home: 25, away: 12 }, winner: "home" },
        {
          // Two boards banked in the open game ⇒ the third is in progress.
          boards: [board("home", 5), board("away", 3)],
          score: { home: 6, away: 3 },
          winner: null,
        },
      ],
      gamesWon: { home: 1, away: 0 },
    };
    expect(line(carrom, mid)).toBe("Game 2 · Board 3");
  });

  it("DISAGREEMENT — a decided match names the board it ended on, not the next one", () => {
    const { state } = fresh<CarromState>(carrom);
    const over: CarromState = {
      ...state,
      phase: "done",
      games: [
        { boards: [], score: { home: 25, away: 4 }, winner: "home" },
        {
          boards: [board("home", 8), board("home", 9), board("home", 8)],
          score: { home: 25, away: 0 },
          winner: "home",
        },
      ],
      gamesWon: { home: 2, away: 0 },
      outcome: { ...DECIDED },
    };
    expect(line(carrom, over)).toBe("Game 2 · Board 3");
  });
});

// ---------------------------------------------------------------------------
// 8. Cross-sport properties, over real folded streams
// ---------------------------------------------------------------------------

const PROJECTING: AnySportModule[] = [
  football,
  hockey,
  icehockey,
  tennis,
  badminton,
  tabletennis,
  volleyball,
  cricket,
  carrom,
];

describe("every projecting sport, over generated streams", () => {
  const SEEDS = [1, 7, 42, 1337, 90210];

  for (const module of PROJECTING) {
    it(`${module.key} — position is well-formed and never travels backwards`, () => {
      const cfg: unknown = module.configSchema.parse({});
      const lineups = defaultLineupPair(module.positions);
      let steps = 0;
      for (const seed of SEEDS) {
        const events = buildStream(module, cfg, lineups, seed, 400);
        let state: unknown = module.init(cfg, lineups);
        let previous = matchPositionOf(module, state) as MatchPosition;
        expect(MatchPosition.safeParse(previous).success, `${module.key} @init`).toBe(true);
        for (const envelope of events) {
          state = module.apply(state, envelope);
          const current = matchPositionOf(module, state) as MatchPosition;
          const parsed = MatchPosition.safeParse(current);
          expect(parsed.success, `${module.key} seq ${envelope.seq}: ${JSON.stringify(current)}`).toBe(
            true,
          );
          expect(
            comparePosition(previous, current),
            `${module.key} seq ${envelope.seq}: ${formatPosition(previous)} → ${formatPosition(current)}`,
          ).toBeLessThanOrEqual(0);
          previous = current;
          steps += 1;
        }
      }
      // A property over an empty stream is not a property. Football's coarse
      // generator is the thinnest of the nine and still clears this.
      expect(steps, `${module.key} generated no events to check`).toBeGreaterThan(20);
    });
  }

  it("refuses to order two different sports rather than sorting them arbitrarily", () => {
    const tennisPos = matchPositionOf(tennis, fresh<NestedState>(tennis).state) as MatchPosition;
    const cricketPos = matchPositionOf(cricket, fresh<CricketState>(cricket).state) as MatchPosition;
    expect(() => comparePosition(tennisPos, cricketPos)).toThrowError(EngineError);
  });
});

describe("position is a projection, never a field of state", () => {
  for (const module of PROJECTING) {
    it(`${module.key} folds to a state that stores no position`, () => {
      // cfg and state are serialised into the frozen golden strings. A
      // `position` key in `init` would break all eleven corpora at once — and
      // would be the recorded-vs-derived pair this axis exists to refuse.
      const cfg: unknown = module.configSchema.parse({});
      const lineups = defaultLineupPair(module.positions);
      const events = buildStream(module, cfg, lineups, 7, 200);
      let state: unknown = module.init(cfg, lineups);
      for (const envelope of events) state = module.apply(state, envelope);
      expect(JSON.stringify(state)).not.toContain('"position"');
      expect(JSON.stringify(state)).not.toContain('"segments"');
    });
  }
});
