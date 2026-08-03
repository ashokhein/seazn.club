// W4 sport-domain audit — the additive extensions recorded in DOMAIN.md.
//
// Every test here pins a fact a real cricket scorebook records that the
// module could not represent (or parsed and dropped) before this wave:
// fielder credit, the 10th mode of dismissal, a captain-chosen incoming
// batter, retirement (hurt vs out) and the return of a retired batter, the
// reason an innings closed, the new ball, powerplays and DRS reviews.
//
// The additive contract is pinned too: with none of these used, the folded
// state JSON must be byte-identical to the pre-wave shape (golden replay
// compares JSON.stringify of the whole state), and every pre-wave payload
// must still parse against the widened union.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { buildStream, makeEnvelope } from "../../testkit/index.ts";
import { CricketEv, cricket, type CricketBallEv, type CricketCfg } from "./cricket.ts";

// Eleven per side; batting order = orderNo (spec §2.7).
function lineup(prefix: string): LineupPair["home"] {
  return {
    entrantId: prefix,
    slots: Array.from({ length: 11 }, (_, i) => ({
      personId: `${prefix}-${i + 1}`,
      slot: "starting" as const,
      orderNo: i + 1,
      ...(i === 0 ? { roles: ["captain"] } : i === 1 ? { roles: ["wicketkeeper"] } : {}),
    })),
  };
}
const lineups: LineupPair = { home: lineup("H"), away: lineup("A") };
const fold = (cfg: CricketCfg, events: EventEnvelope[]) =>
  foldMatch(cricket, cfg, lineups, events);

// 10 overs a side, one bowler quota wide enough for the hand-written streams.
const short: CricketCfg = cricket.configSchema.parse({
  ballsPerInnings: 60,
  maxOversPerBowler: 10,
  minOversForResult: 5,
});

type Wicket = NonNullable<CricketBallEv["wicket"]>;

interface BallSpec {
  striker: string;
  nonStriker: string;
  bowler: string;
  bat?: number;
  wicket?: Wicket;
  extras?: NonNullable<CricketBallEv["runs"]["extras"]>;
}

/** A tiny stream builder that keeps the fold's over/ball cursor for us and
 *  lets non-ball events be interleaved without disturbing it. */
class Ledger {
  private readonly specs: Array<[string, unknown]> = [];
  private legal = 0;
  constructor(private readonly bpo = 6) {
    this.specs.push(["core.start", {}]);
  }
  ball(spec: BallSpec): this {
    this.specs.push([
      "cricket.ball",
      {
        over: Math.floor(this.legal / this.bpo),
        ballInOver: (this.legal % this.bpo) + 1,
        striker: spec.striker,
        nonStriker: spec.nonStriker,
        bowler: spec.bowler,
        runs: {
          bat: spec.bat ?? 0,
          ...(spec.extras === undefined ? {} : { extras: spec.extras }),
        },
        ...(spec.wicket === undefined ? {} : { wicket: spec.wicket }),
      } satisfies CricketBallEv,
    ]);
    // Wides and no-balls do not advance the fold's over/ball cursor (§2.2).
    const kind = spec.extras?.kind;
    if (kind !== "wide" && kind !== "noball") this.legal += 1;
    return this;
  }
  ev(type: string, payload: unknown = {}): this {
    this.specs.push([type, payload]);
    return this;
  }
  build(): EventEnvelope[] {
    return this.specs.map(([type, payload], i) => makeEnvelope(i, { type, payload }));
  }
}

const engineError = (code: string) => expect.objectContaining({ code });
const openFine = (events: EventEnvelope[], cfg: CricketCfg = short) => {
  const state = fold(cfg, events);
  const innings = state.innings[0];
  if (innings === undefined || innings.fine === null) throw new Error("no fine innings");
  return { state, innings, fine: innings.fine };
};

// ---------------------------------------------------------------------------
// Fielder credit — the scorebook's "c Smith b Jones" / "run out (Patel/Khan)"
// ---------------------------------------------------------------------------

describe("cricket W4: fielding credit is folded, not dropped", () => {
  const caught: Wicket = { kind: "caught", out: "H-1", fielder: "A-5", bowlerCredited: true };
  const runout: Wicket = {
    kind: "runout",
    out: "H-2",
    fielder: "A-7",
    fielderAssist: "A-3",
    bowlerCredited: false,
  };
  const stumped: Wicket = { kind: "stumped", out: "H-3", fielder: "A-2", bowlerCredited: true };

  it("credits catches, run-outs (with the assisting fielder) and stumpings", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", wicket: caught })
      .ball({ striker: "H-3", nonStriker: "H-2", bowler: "A-11", wicket: runout })
      .ball({ striker: "H-3", nonStriker: "H-4", bowler: "A-11", wicket: stumped })
      .build();
    const { fine } = openFine(events);
    expect(fine.fielding).toEqual({
      "A-5": { catches: 1, runOuts: 0, stumpings: 0 },
      "A-7": { catches: 0, runOuts: 1, stumpings: 0 },
      "A-3": { catches: 0, runOuts: 1, stumpings: 0 },
      "A-2": { catches: 0, runOuts: 0, stumpings: 1 },
    });
  });

  it("rejects a fielder who is not in the fielding lineup", () => {
    const events = new Ledger()
      .ball({
        striker: "H-1",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "caught", out: "H-1", fielder: "H-9", bowlerCredited: true },
      })
      .build();
    expect(() => fold(short, events)).toThrowError(engineError("INVALID_EVENT"));
  });

  it("rejects an assisting fielder with no primary fielder, or a duplicate of it", () => {
    const noPrimary = new Ledger()
      .ball({
        striker: "H-1",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "runout", out: "H-1", fielderAssist: "A-3", bowlerCredited: false },
      })
      .build();
    expect(() => fold(short, noPrimary)).toThrowError(engineError("INVALID_EVENT"));

    const duplicate = new Ledger()
      .ball({
        striker: "H-1",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: {
          kind: "runout",
          out: "H-1",
          fielder: "A-3",
          fielderAssist: "A-3",
          bowlerCredited: false,
        },
      })
      .build();
    expect(() => fold(short, duplicate)).toThrowError(engineError("INVALID_EVENT"));
  });

  it("leaves the fielding card unset when no dismissal names a fielder", () => {
    const events = new Ledger()
      .ball({
        striker: "H-1",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "bowled", out: "H-1", bowlerCredited: true },
      })
      .build();
    expect(openFine(events).fine.fielding).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Modes of dismissal — Laws of Cricket (2017 Code) 32–39
// ---------------------------------------------------------------------------

describe("cricket W4: hit the ball twice completes the dismissal enum", () => {
  it("takes a wicket that no bowler is credited with", () => {
    const events = new Ledger()
      .ball({
        striker: "H-1",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "hitballtwice", out: "H-1", bowlerCredited: false },
      })
      .build();
    const { innings, fine } = openFine(events);
    expect(innings.wickets).toBe(1);
    expect(fine.dismissed).toEqual(["H-1"]);
    expect(fine.bowlerWickets).toEqual({});
  });

  it("refuses to credit the bowler with it", () => {
    const events = new Ledger()
      .ball({
        striker: "H-1",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "hitballtwice", out: "H-1", bowlerCredited: true },
      })
      .build();
    expect(() => fold(short, events)).toThrowError(engineError("INVALID_EVENT"));
  });
});

// ---------------------------------------------------------------------------
// The incoming batter — a real batting order is the captain's choice, not the
// lineup's orderNo (Laws 25.1: any member of the side may bat next).
// ---------------------------------------------------------------------------

describe("cricket W4: the incoming batter can be named", () => {
  it("promotes the named batter and leaves the order cursor for the rest", () => {
    const events = new Ledger()
      .ball({
        striker: "H-1",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "bowled", out: "H-1", bowlerCredited: true, incoming: "H-7" },
      })
      .ball({
        striker: "H-7",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "bowled", out: "H-7", bowlerCredited: true },
      })
      .build();
    const { fine } = openFine(events);
    // H-7 was promoted; the next fall of wicket still takes H-3, the first
    // batter in the order who has not been used.
    expect(fine.striker).toBe("H-3");
    expect(fine.dismissed).toEqual(["H-1", "H-7"]);
  });

  it("rejects an incoming batter who is out, already in, or not in the lineup", () => {
    const cases: Array<[string, string]> = [
      ["H-2", "already at the crease"],
      ["A-4", "not in the lineup"],
    ];
    for (const [incoming] of cases) {
      const events = new Ledger()
        .ball({
          striker: "H-1",
          nonStriker: "H-2",
          bowler: "A-11",
          wicket: { kind: "bowled", out: "H-1", bowlerCredited: true, incoming },
        })
        .build();
      expect(() => fold(short, events), incoming).toThrowError(engineError("INVALID_EVENT"));
    }
    const reused = new Ledger()
      .ball({
        striker: "H-1",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "bowled", out: "H-1", bowlerCredited: true },
      })
      .ball({
        striker: "H-3",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "bowled", out: "H-3", bowlerCredited: true, incoming: "H-1" },
      })
      .build();
    expect(() => fold(short, reused)).toThrowError(engineError("INVALID_EVENT"));
  });
});

// ---------------------------------------------------------------------------
// Retirement — Law 25.4. Retired out is a dismissal credited to no bowler;
// retired not out (hurt/ill) costs no wicket and the batter may resume.
// ---------------------------------------------------------------------------

describe("cricket W4: retired hurt vs retired out", () => {
  it("retired hurt costs no wicket and keeps the batter available", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 })
      .ev("cricket.retire", { person: "H-1", reason: "hurt", incoming: "H-3" })
      .build();
    const { innings, fine } = openFine(events);
    expect(innings.wickets).toBe(0);
    expect(innings.runs).toBe(2);
    expect(fine.striker).toBe("H-3");
    expect(fine.dismissed).toEqual([]);
    expect(fine.retiredNotOut).toEqual(["H-1"]);
  });

  it("retired out costs a wicket and credits no bowler", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 })
      .ev("cricket.retire", { person: "H-1", reason: "out" })
      .build();
    const { innings, fine } = openFine(events);
    expect(innings.wickets).toBe(1);
    expect(fine.dismissed).toEqual(["H-1"]);
    expect(fine.bowlerWickets).toEqual({});
    expect(fine.retiredNotOut).toBeUndefined();
    expect(fine.striker).toBe("H-3");
  });

  it("a retired-not-out batter is skipped by the order cursor but may return", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 })
      .ev("cricket.retire", { person: "H-1", reason: "hurt", incoming: "H-3" })
      // Default replacement must skip H-1 (retired) and H-3 (at the crease).
      .ball({
        striker: "H-3",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "bowled", out: "H-3", bowlerCredited: true },
      })
      .build();
    expect(openFine(events).fine.striker).toBe("H-4");

    const returning = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 })
      .ev("cricket.retire", { person: "H-1", reason: "hurt", incoming: "H-3" })
      .ball({
        striker: "H-3",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "bowled", out: "H-3", bowlerCredited: true, incoming: "H-1" },
      })
      .build();
    const { fine } = openFine(returning);
    expect(fine.striker).toBe("H-1");
    expect(fine.retiredNotOut).toBeUndefined();
  });

  it("rejects retiring a batter who is not at the crease", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 })
      .ev("cricket.retire", { person: "H-5", reason: "hurt" })
      .build();
    expect(() => fold(short, events)).toThrowError(engineError("INVALID_EVENT"));
  });

  it("rejects a retirement before the innings has started", () => {
    const events = [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, {
        type: "cricket.retire",
        payload: { person: "H-1", reason: "hurt" },
      }),
    ];
    expect(() => fold(short, events)).toThrowError(engineError("INVALID_EVENT"));
  });

  it("a final retired-out closes the innings like any other wicket", () => {
    // 2 a side: all out = 1 wicket, so the first retired-out ends the innings.
    const tiny = cricket.configSchema.parse({ playersPerSide: 2, ballsPerInnings: 60 });
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 3 })
      .ev("cricket.retire", { person: "H-1", reason: "out" })
      .build();
    const state = fold(tiny, events);
    expect(state.innings[0]?.closed).toBe(true);
    expect(state.innings[0]?.wickets).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Innings close reason — a scorebook always says WHY an innings ended.
// ---------------------------------------------------------------------------

describe("cricket W4: innings close carries a reason", () => {
  it("folds the reason and shows it in the summary detail", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4 })
      .ev("cricket.innings.close", { reason: "weather" })
      .build();
    const state = fold(short, events);
    expect(state.innings[0]?.closeReason).toBe("weather");
    const detail = cricket.summary(state).detail as {
      innings: Array<Record<string, unknown>>;
    };
    expect(detail.innings[0]?.closeReason).toBe("weather");
  });

  it("leaves the reason unset for a bare close and for auto-closes", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4 })
      .ev("cricket.innings.close")
      .build();
    const state = fold(short, events);
    expect(state.innings[0]?.closed).toBe(true);
    expect(state.innings[0]?.closeReason).toBeUndefined();
    const detail = cricket.summary(state).detail as { innings: Array<Record<string, unknown>> };
    expect("closeReason" in (detail.innings[0] ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// New ball — Law 4.5; the scorer records the over at which it was taken.
// ---------------------------------------------------------------------------

describe("cricket W4: the new ball", () => {
  it("records the ball count at which each new ball was taken", () => {
    const led = new Ledger();
    for (let i = 0; i < 6; i++) {
      led.ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 });
    }
    const events = led.ev("cricket.newball").build();
    expect(openFine(events).innings.newBallAt).toEqual([6]);
  });

  it("rejects two new balls at the same point, and one with no innings open", () => {
    const twice = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 })
      .ev("cricket.newball")
      .ev("cricket.newball")
      .build();
    expect(() => fold(short, twice)).toThrowError(engineError("INVALID_EVENT"));

    const noInnings = [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "cricket.newball", payload: {} }),
    ];
    expect(() => fold(short, noInnings)).toThrowError(engineError("INVALID_EVENT"));
  });
});

// ---------------------------------------------------------------------------
// Powerplay — limited-overs fielding-restriction blocks, marked by the scorer.
// ---------------------------------------------------------------------------

describe("cricket W4: powerplay blocks", () => {
  it("opens and closes a block against the ball count", () => {
    const led = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 })
      .ev("cricket.powerplay", { kind: "mandatory", phase: "start" });
    for (let i = 0; i < 5; i++) {
      led.ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 });
    }
    const events = led.ev("cricket.powerplay", { kind: "mandatory", phase: "end" }).build();
    expect(openFine(events).innings.powerplays).toEqual([
      { kind: "mandatory", fromBalls: 1, toBalls: 6 },
    ]);
  });

  it("rejects an end with no block open and a second overlapping start", () => {
    const orphanEnd = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 })
      .ev("cricket.powerplay", { kind: "batting", phase: "end" })
      .build();
    expect(() => fold(short, orphanEnd)).toThrowError(engineError("INVALID_EVENT"));

    const overlap = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 })
      .ev("cricket.powerplay", { kind: "mandatory", phase: "start" })
      .ev("cricket.powerplay", { kind: "batting", phase: "start" })
      .build();
    expect(() => fold(short, overlap)).toThrowError(engineError("INVALID_EVENT"));
  });
});

// ---------------------------------------------------------------------------
// Reviews (DRS) — who reviewed, the outcome, and how many are left.
// ---------------------------------------------------------------------------

describe("cricket W4: reviews", () => {
  const reviewed: CricketCfg = cricket.configSchema.parse({
    ballsPerInnings: 60,
    minOversForResult: 5,
    reviews: { perInnings: 1 },
  });

  it("keeps a per-side ledger: an unsuccessful review is spent, umpire's call is not", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 })
      .ev("cricket.review", { by: "A", kind: "player", outcome: "umpires_call" })
      .ev("cricket.review", { by: "A", kind: "player", outcome: "struck_down" })
      .ev("cricket.review", { by: "H", kind: "player", outcome: "upheld" })
      .build();
    expect(openFine(events, reviewed).innings.reviews).toEqual({
      home: { taken: 1, lost: 0 },
      away: { taken: 2, lost: 1 },
    });
  });

  it("refuses a review once the side's allowance is spent", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 })
      .ev("cricket.review", { by: "A", kind: "player", outcome: "struck_down" })
      .ev("cricket.review", { by: "A", kind: "player", outcome: "upheld" })
      .build();
    expect(() => fold(reviewed, events)).toThrowError(engineError("INVALID_EVENT"));
  });

  it("an umpire review never consumes the side's allowance", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 })
      .ev("cricket.review", { by: "A", kind: "player", outcome: "struck_down" })
      .ev("cricket.review", { by: "A", kind: "umpire", outcome: "upheld" })
      .build();
    expect(openFine(events, reviewed).innings.reviews).toEqual({
      home: { taken: 0, lost: 0 },
      away: { taken: 2, lost: 1 },
    });
  });

  it("leaves the allowance unlimited when the config declares none", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 })
      .ev("cricket.review", { by: "H", kind: "player", outcome: "struck_down" })
      .ev("cricket.review", { by: "H", kind: "player", outcome: "struck_down" })
      .build();
    expect(openFine(events).innings.reviews?.home).toEqual({ taken: 2, lost: 2 });
    expect(short.reviews).toBeUndefined();
  });

  it("rejects a review from an entrant that is not in this match", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 0 })
      .ev("cricket.review", { by: "Z", kind: "player", outcome: "upheld" })
      .build();
    expect(() => fold(short, events)).toThrowError(engineError("INVALID_EVENT"));
  });
});

// ---------------------------------------------------------------------------
// The additive contract
// ---------------------------------------------------------------------------

describe("cricket W4: the extensions are additive", () => {
  it("adds no key to the folded state when nothing new is used", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4 })
      .ball({
        striker: "H-1",
        nonStriker: "H-2",
        bowler: "A-11",
        wicket: { kind: "bowled", out: "H-1", bowlerCredited: true },
      })
      .ball({ striker: "H-3", nonStriker: "H-2", bowler: "A-11", bat: 1 })
      .build();
    const json = JSON.stringify(fold(short, events));
    for (const key of [
      "fielding",
      "fielderAssist",
      "retiredNotOut",
      "closeReason",
      "newBallAt",
      "powerplays",
      "reviews",
      "incoming",
    ]) {
      expect(json.includes(`"${key}"`), `state JSON must not mention "${key}"`).toBe(false);
    }
  });

  it("keeps module.version at 1.0.0 (the wave extends in place)", () => {
    expect(cricket.version).toBe("1.0.0");
  });

  // z.union takes the FIRST branch that parses. A round-trip equality check
  // catches a branch that swallowed a sibling's payload and stripped its keys.
  it("every branch of the event union still parses as itself", () => {
    const canonical: Array<[string, Record<string, unknown>]> = [
      [
        "cricket.ball",
        {
          over: 0,
          ballInOver: 1,
          striker: "H-1",
          nonStriker: "H-2",
          bowler: "A-11",
          runs: { bat: 1 },
        },
      ],
      [
        "cricket.ball (extended wicket)",
        {
          over: 0,
          ballInOver: 1,
          striker: "H-1",
          nonStriker: "H-2",
          bowler: "A-11",
          runs: { bat: 0, extras: { kind: "legbye", runs: 2 } },
          wicket: {
            kind: "runout",
            out: "H-1",
            fielder: "A-5",
            fielderAssist: "A-3",
            incoming: "H-7",
            bowlerCredited: false,
          },
          boundary: 4,
          freeHit: true,
        },
      ],
      ["cricket.innings.summary", { runs: 140, wickets: 6, legalBalls: 120, boundaries: 12 }],
      ["cricket.toss", { wonBy: "H", elected: "bat" }],
      ["cricket.innings.declare", {}],
      ["cricket.innings.close", { reason: "weather" }],
      ["cricket.interruption", { kind: "rain", oversLostEstimate: 4 }],
      ["cricket.revise", { oversPerSide: 15, target: 120 }],
      ["cricket.player.line", { innings: 1, person: "H-1", batting: { runs: 40, balls: 30 } }],
      ["cricket.retire", { person: "H-1", reason: "hurt", incoming: "H-7" }],
      ["cricket.powerplay", { kind: "mandatory", phase: "start" }],
      ["cricket.review", { by: "H", kind: "player", person: "H-1", outcome: "struck_down" }],
    ];
    for (const [label, payload] of canonical) {
      const parsed = CricketEv.safeParse(payload);
      expect(parsed.success, `${label}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
      expect(parsed.data, label).toEqual(payload);
    }
    // The payload-free branches are structurally identical by design; they are
    // told apart by the envelope type, and all of them must accept {}.
    expect(CricketEv.safeParse({}).success).toBe(true);
  });

  it("declares every new event type in a fidelity tier", () => {
    const declared = new Set(cricket.fidelityTiers.flatMap((tier) => tier.eventTypes));
    for (const type of [
      "cricket.retire",
      "cricket.newball",
      "cricket.powerplay",
      "cricket.review",
    ]) {
      expect(declared.has(type), `${type} must appear in a fidelity tier`).toBe(true);
    }
  });

  it("can generate every new event type (W5 branch reachability)", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 120; seed++) {
      for (const event of buildStream(cricket, short, lineups, seed, 400)) {
        seen.add(event.type);
      }
    }
    for (const type of [
      "cricket.retire",
      "cricket.newball",
      "cricket.powerplay",
      "cricket.review",
    ]) {
      expect(seen.has(type), `arbitraryEvent never emitted ${type}`).toBe(true);
    }
  });

  it("coarsens a retired-out into the innings wicket column", () => {
    const events = new Ledger()
      .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 })
      .ev("cricket.retire", { person: "H-1", reason: "out", incoming: "H-3" })
      .ball({ striker: "H-3", nonStriker: "H-2", bowler: "A-11", bat: 1 })
      .ev("cricket.innings.close")
      .build();
    const fine = fold(short, events);
    const coarse = fold(
      short,
      (cricket.coarsen as (events: readonly EventEnvelope[]) => Array<{
        type: string;
        payload: unknown;
      }>)(events).map((event, i) => makeEnvelope(i, event)),
    );
    expect(coarse.innings[0]?.wickets).toBe(fine.innings[0]?.wickets);
    expect(coarse.innings[0]?.runs).toBe(fine.innings[0]?.runs);
    expect(cricket.summary(coarse)).toEqual(cricket.summary(fine));
  });
});

// ---------------------------------------------------------------------------
// Player leaderboards — the DOMAIN.md row that was `deferred` because
// `PlayerStatMetric.field`/`sumField` resolved only top-level payload keys and
// every cricket credit worth a leaderboard is nested. Dotted paths landed in
// `src/stats/stats.ts`, so the model is now declarable off `cricket.ball`.
// ---------------------------------------------------------------------------

describe("cricket W4: playerStats leaderboards off the ball ledger", () => {
  // One legal over from A-11 plus a wide, a bye, a no-ball and three
  // dismissals, then a second over from A-10. Folded first, so every payload
  // below is a ball a real scorer could have entered.
  // Every stroke is an even number of runs, so strike never rotates mid-over
  // and the crease succession stays readable: the incoming batter replaces the
  // dismissed one at the striker's end, and the ends swap at the over.
  const events = new Ledger()
    .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 4 })
    .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", extras: { kind: "wide", runs: 1 } })
    .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", extras: { kind: "bye", runs: 2 } })
    .ball({ striker: "H-1", nonStriker: "H-2", bowler: "A-11", bat: 2 })
    .ball({
      striker: "H-1", nonStriker: "H-2", bowler: "A-11",
      wicket: { kind: "caught", out: "H-1", fielder: "A-5", bowlerCredited: true },
    })
    .ball({
      striker: "H-3", nonStriker: "H-2", bowler: "A-11",
      wicket: { kind: "runout", out: "H-3", fielder: "A-7", fielderAssist: "A-3", bowlerCredited: false },
    })
    .ball({
      striker: "H-4", nonStriker: "H-2", bowler: "A-11", bat: 2,
      extras: { kind: "noball", runs: 1 },
    })
    .ball({ striker: "H-4", nonStriker: "H-2", bowler: "A-11" })
    .ball({
      striker: "H-2", nonStriker: "H-4", bowler: "A-10",
      wicket: { kind: "stumped", out: "H-2", fielder: "A-2", bowlerCredited: true },
    })
    .build();

  const table = () => {
    const rows = aggregatePlayerStats(events, cricket.playerStats!);
    return Object.fromEntries(rows.map((r) => [r.personId, r.stats]));
  };

  it("batting: runs come off `runs.bat`; a wide and a no-ball are not balls faced", () => {
    const t = table();
    // H-1 faced 5 deliveries, one of them a wide: 4 + 0 (bye) + 2 + 0 = 6 off
    // the bat from four legal balls.
    expect(t["H-1"]).toEqual({ runs: 6, balls_faced: 4 });
    // H-4 scored 2 off a no-ball, which is not a ball faced; the next legal
    // delivery is.
    expect(t["H-4"]).toEqual({ runs: 2, balls_faced: 1 });
    expect(t["H-3"]).toEqual({ runs: 0, balls_faced: 1 });
  });

  it("bowling: legal balls, runs conceded (bat + wides/no-balls, never byes) and wickets", () => {
    const t = table();
    // A-11: 6 legal balls; conceded 8 off the bat + 1 wide + 1 no-ball = 10;
    // the 2 byes are the keeper's, not his. One of the two dismissals off him
    // is a run out, which credits no bowler.
    expect(t["A-11"]).toEqual({ balls_bowled: 6, runs_conceded: 10, wickets: 1 });
    expect(t["A-10"]).toEqual({ balls_bowled: 1, runs_conceded: 0, wickets: 1 });
  });

  it("fielding: catches, stumpings and run outs, the assisting fielder included", () => {
    const t = table();
    expect(t["A-5"]).toEqual({ catches: 1 });
    expect(t["A-2"]).toEqual({ stumpings: 1 });
    expect(t["A-7"]).toEqual({ run_outs: 1 });
    expect(t["A-3"]).toEqual({ run_outs: 1 });
  });

  it("agrees with the fold: same fielding credit, same legal-ball count", () => {
    const { innings, fine } = openFine(events);
    const t = table();
    expect(fine.fielding).toBeDefined();
    for (const [person, credit] of Object.entries(fine.fielding ?? {})) {
      expect([person, t[person]?.catches ?? 0]).toEqual([person, credit.catches]);
      expect([person, t[person]?.stumpings ?? 0]).toEqual([person, credit.stumpings]);
      expect([person, t[person]?.run_outs ?? 0]).toEqual([person, credit.runOuts]);
    }
    const bowled = Object.values(t).reduce((n, s) => n + (s.balls_bowled ?? 0), 0);
    expect(bowled).toBe(innings.legalBalls);
    // Runs off the bat + the extras the scorebook charged elsewhere = innings.
    const batted = Object.values(t).reduce((n, s) => n + (s.runs ?? 0), 0);
    expect(batted).toBe(innings.runs - 4); // 1 wide + 2 byes + 1 no-ball
  });

  it("a voided ball takes its runs, its wicket and its fielding credit with it", () => {
    // events[6] is the run out — the only ball A-7 and A-3 appear on.
    const voided = [
      ...events,
      makeEnvelope(events.length, { type: "core.void", payload: {} }, events[6]!.id),
    ];
    const rows = aggregatePlayerStats(voided, cricket.playerStats!);
    const t = Object.fromEntries(rows.map((r) => [r.personId, r.stats]));
    expect(t["A-7"]).toBeUndefined();
    expect(t["A-3"]).toBeUndefined();
    expect(t["H-3"]).toBeUndefined();
    expect(t["A-11"]).toEqual({ balls_bowled: 5, runs_conceded: 10, wickets: 1 });
  });
});
