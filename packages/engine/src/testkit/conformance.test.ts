// PROMPT-02's toy coin-flip sport, migrated onto the conformance kit
// (PROMPT-03 acceptance). Upgraded from FoldableModule to a full SportModule —
// including a coarse `coin.summary` fidelity + coarsen() so the §9.6
// dual-fidelity hook is exercised before any real dual-fidelity sport lands.
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import type { CoreEv, EventEnvelope } from "../core/events.ts";
import type { MatchOutcome, StandingsDelta } from "../core/types.ts";
import type { ModuleEvent, SportModule } from "../sport/module.ts";
import { conformanceSuite } from "./conformance.ts";
import { defaultLineupPair, lineupFromCatalog } from "./helpers.ts";

const CoinCfg = z.object({ target: z.number().int().positive() });
type CoinCfg = z.infer<typeof CoinCfg>;

const CoinFlip = z.strictObject({ to: z.enum(["home", "away"]) });
const CoinStop = z.strictObject({});
const CoinSummary = z.strictObject({
  home: z.number().int().nonnegative(),
  away: z.number().int().nonnegative(),
});
const CoinHandshake = z.strictObject({});
const CoinEv = z.union([CoinFlip, CoinSummary, CoinStop, CoinHandshake]);
type CoinEv = z.infer<typeof CoinEv>;

interface CoinState {
  phase: "pre" | "live" | "done" | "final";
  target: number;
  entrants: { home: string; away: string };
  score: { home: number; away: number };
  outcome: MatchOutcome | null;
  notes: string[];
}

type Side = "home" | "away";

function decide(state: CoinState, score: { home: number; away: number }): CoinState {
  const winnerSide: Side | null =
    score.home >= state.target ? "home" : score.away >= state.target ? "away" : null;
  if (winnerSide === null) return { ...state, score };
  const loserSide: Side = winnerSide === "home" ? "away" : "home";
  return {
    ...state,
    score,
    phase: "done",
    outcome: {
      kind: "win",
      winner: state.entrants[winnerSide],
      loser: state.entrants[loserSide],
      method: "regulation",
    },
  };
}

const coinflip: SportModule<CoinCfg, CoinEv, CoinState> = {
  key: "coinflip",
  version: "0.1.0",
  configSchema: CoinCfg,
  eventSchema: CoinEv,
  positions: { groups: [], lineup: { size: 1, benchMax: 0 } },
  variants: { quick: { target: 2 }, standard: { target: 3 } },
  postDecisionTypes: ["coin.handshake"],

  init: (cfg, lineups) => ({
    phase: "pre",
    target: cfg.target,
    entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
    score: { home: 0, away: 0 },
    outcome: null,
    notes: [],
  }),

  apply(state, event: EventEnvelope<CoinEv | CoreEv>): CoinState {
    switch (event.type) {
      case "core.start": {
        if (state.phase !== "pre") throw new EngineError("WRONG_PHASE", "already started");
        return { ...state, phase: "live" };
      }
      case "coin.flip": {
        if (state.phase !== "live") throw new EngineError("WRONG_PHASE", "not live");
        const parsed = CoinFlip.safeParse(event.payload);
        if (!parsed.success) throw new EngineError("INVALID_EVENT", "bad flip");
        const to = parsed.data.to;
        return decide(state, { ...state.score, [to]: state.score[to] + 1 });
      }
      // Coarse fidelity (doc 14 §1 Tier 1): absolute totals in one event.
      case "coin.summary": {
        if (state.phase !== "live") throw new EngineError("WRONG_PHASE", "not live");
        const parsed = CoinSummary.safeParse(event.payload);
        if (!parsed.success) throw new EngineError("INVALID_EVENT", "bad summary");
        if (parsed.data.home >= state.target && parsed.data.away >= state.target) {
          throw new EngineError("INVALID_EVENT", "both sides past target");
        }
        return decide(state, parsed.data);
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
      case "core.note":
        return { ...state, notes: [...state.notes, (event.payload as { text: string }).text] };
      case "coin.handshake":
        return { ...state, notes: [...state.notes, "handshake"] };
      default:
        throw new EngineError("INVALID_EVENT", `unknown event type "${event.type}"`);
    }
  },

  outcome: (state) => state.outcome,

  summary: (state) => ({
    headline: `${state.score.home} — ${state.score.away}`,
    perSide: [
      { entrantId: state.entrants.home, line: String(state.score.home) },
      { entrantId: state.entrants.away, line: String(state.score.away) },
    ],
  }),

  standingsDelta(outcome, _cfg, _ctx, state): [StandingsDelta, StandingsDelta] {
    const metrics = (side: Side) => ({
      for: state.score[side],
      against: state.score[side === "home" ? "away" : "home"],
      diff: state.score[side] - state.score[side === "home" ? "away" : "home"],
    });
    const row = (side: Side, w: number, d: number, l: number, points: number): StandingsDelta => ({
      entrantId: state.entrants[side],
      played: 1,
      won: w,
      drawn: d,
      lost: l,
      points,
      metrics: metrics(side),
    });
    switch (outcome.kind) {
      case "win":
      case "award": {
        const winnerSide: Side = outcome.winner === state.entrants.home ? "home" : "away";
        const home = winnerSide === "home" ? row("home", 1, 0, 0, 2) : row("home", 0, 0, 1, 0);
        const away = winnerSide === "away" ? row("away", 1, 0, 0, 2) : row("away", 0, 0, 1, 0);
        return [home, away];
      }
      case "draw":
      case "tie":
        return [row("home", 0, 1, 0, 1), row("away", 0, 1, 0, 1)];
      case "no_result":
        return [row("home", 0, 0, 0, 1), row("away", 0, 0, 0, 1)];
    }
  },

  metrics: [
    { key: "for", label: "Flips won", direction: "desc" },
    { key: "against", label: "Flips lost", direction: "asc" },
    { key: "diff", label: "Flip difference", direction: "desc" },
  ],
  defaultTiebreakers: ["points", "diff", "lots"],
  supportsDraws: (_cfg, stage) => stage === "league" || stage === "group" || stage === "swiss",
  declaredPointsSets: () => [2],
  fidelityTiers: [
    { tier: 0, eventTypes: ["coin.stop"] },
    { tier: 1, eventTypes: ["coin.summary"] },
    { tier: 3, eventTypes: ["coin.flip"] },
  ],
  officialLabel: { scorer: "Scorer" },

  arbitraryEvent(state, rng): ModuleEvent<CoinEv> | null {
    if (state.phase === "done" || state.phase === "final") return null;
    if (state.phase === "pre") {
      return rng() < 0.9
        ? { type: "core.start", payload: {} }
        : {
            type: "core.forfeit",
            payload: { by: rng() < 0.5 ? state.entrants.home : state.entrants.away, reason: "no-show" },
          };
    }
    const roll = rng();
    if (roll < 0.05) return { type: "core.abandon", payload: { reason: "rain" } };
    if (roll < 0.15) return { type: "coin.stop", payload: {} };
    return { type: "coin.flip", payload: { to: rng() < 0.5 ? "home" : "away" } };
  },

  // §9.6 — collapse flip runs into coin.summary events carrying cumulative
  // absolute totals, keeping every non-flip event in order.
  coarsen(events): ModuleEvent<CoinEv>[] {
    const out: ModuleEvent<CoinEv>[] = [];
    const totals = { home: 0, away: 0 };
    let pendingFlips = false;
    const emit = () => {
      if (pendingFlips) {
        out.push({ type: "coin.summary", payload: { ...totals } });
        pendingFlips = false;
      }
    };
    for (const event of events) {
      if (event.type === "coin.flip") {
        const to = (event.payload as { to: Side }).to;
        totals[to] += 1;
        pendingFlips = true;
        continue;
      }
      emit(); // summary lands where its flip run ended
      out.push({ type: event.type, payload: event.payload as CoinEv });
    }
    emit();
    return out;
  },
};

// PROMPT-03 §4/§5 — the migrated toy module passes the full kit, including
// the dual-fidelity hook.
conformanceSuite(coinflip, { cfg: { target: 3 } });

describe("testkit helpers", () => {
  it("lineupFromCatalog satisfies group minimums, maximums and roles", () => {
    const lineup = lineupFromCatalog(
      {
        groups: [
          { key: "GK", name: "Goalkeeper", min: 1, max: 1 },
          { key: "DF", name: "Defender" },
        ],
        roles: [{ key: "captain", unique: true, required: true }],
        lineup: { size: 4 },
      },
      "H",
    );
    expect(lineup.slots).toHaveLength(4);
    expect(lineup.slots.filter((s) => s.positionKey === "GK")).toHaveLength(1);
    expect(lineup.slots.filter((s) => s.roles?.includes("captain"))).toHaveLength(1);
    expect(new Set(lineup.slots.map((s) => s.personId)).size).toBe(4);
  });

  it("defaultLineupPair builds distinct entrants", () => {
    const pair = defaultLineupPair({ groups: [], lineup: { size: 1 } });
    expect(pair.home.entrantId).not.toBe(pair.away.entrantId);
  });
});
