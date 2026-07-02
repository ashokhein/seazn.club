import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  createEngine,
  start,
  recordResult,
  playableMatches,
  standings,
  champion,
  type EngineConfig,
  type EngineState,
} from "../engine";
import { pairKey } from "../pairing";
import type { TournamentFormat } from "../types";

// ---------------------------------------------------------------------------
// Invariant checker — runs after every simulation step.
// ---------------------------------------------------------------------------

function assertInvariants(state: EngineState) {
  // No self-pairing.
  for (const m of state.matches) {
    if (m.player1_id && m.player2_id) {
      expect(m.player1_id, "self-pairing").not.toBe(m.player2_id);
    }
  }

  // Per round: a player never appears in two matches of the same round.
  const byRound = new Map<string, string[]>();
  for (const m of state.matches) {
    const arr = byRound.get(m.round_id) ?? [];
    if (m.player1_id) arr.push(m.player1_id);
    if (m.player2_id) arr.push(m.player2_id);
    byRound.set(m.round_id, arr);
  }
  for (const [rid, ids] of byRound) {
    expect(new Set(ids).size, `dup player in round ${rid}`).toBe(ids.length);
  }

  // At most one bye per GROUP round; byes only when active count is odd.
  const activeCount = state.players.filter((p) => p.checked_in).length;
  for (const r of state.rounds.filter((x) => x.stage === "group")) {
    const ms = state.matches.filter((m) => m.round_id === r.id);
    const byes = ms.filter((m) => m.is_bye);
    expect(byes.length, `>1 bye in round ${r.round_number}`).toBeLessThanOrEqual(1);
    if (byes.length === 1)
      expect(activeCount % 2, "bye on even field").toBe(1);
  }

  // A completed decisive (non-draw) match has a winner that is one of its players.
  for (const m of state.matches) {
    if (m.status === "completed" && m.winner_id && !m.is_draw) {
      expect([m.player1_id, m.player2_id]).toContain(m.winner_id);
    }
  }
}

// Points conservation (S1): sum of standings points == expected from W/D/L.
function assertPointsConserved(state: EngineState) {
  const cfg = state.config;
  const rows = standings(state);
  for (const row of rows) {
    const expected =
      row.wins * cfg.points_win +
      row.draws * cfg.points_draw +
      row.losses * cfg.points_loss;
    expect(row.points, `points for ${row.player.name}`).toBe(expected);
    // W+D+L == played
    expect(row.wins + row.draws + row.losses).toBe(row.played);
  }
}

// ---------------------------------------------------------------------------
// Simulation driver — plays a full tournament, choosing winners via `pick`.
// Returns whether it terminated cleanly (reached "completed").
// ---------------------------------------------------------------------------

interface SimResult {
  terminated: boolean;
  stuck: boolean;
  steps: number;
  finalsPairings: string[]; // pairKeys of finals-stage decisive matches
}

function simulate(
  state: EngineState,
  pick: (playableIds: string[], step: number) => number,
): SimResult {
  start(state);
  assertInvariants(state);

  let steps = 0;
  const finalsPairings: string[] = [];

  while (state.status !== "completed") {
    const playable = playableMatches(state);
    if (playable.length === 0) {
      // Deadlock: not completed but nothing to play → engine bug.
      return { terminated: false, stuck: true, steps, finalsPairings };
    }
    const idx = pick(playable.map((m) => m.id), steps) % playable.length;
    const m = playable[idx];
    const round = state.rounds.find((r) => r.id === m.round_id)!;
    if (round.stage !== "group" && m.player1_id && m.player2_id) {
      finalsPairings.push(pairKey(m.player1_id, m.player2_id));
    }
    // Winner = whichever slot the picker's parity selects (deterministic-ish).
    const winner = steps % 2 === 0 ? m.player1_id! : m.player2_id!;
    recordResult(state, m.id, { winner_id: winner });
    assertInvariants(state);
    steps += 1;
    if (steps > 2000) throw new Error("runaway simulation");
  }
  return { terminated: true, stuck: false, steps, finalsPairings };
}

const FORMATS: TournamentFormat[] = [
  "knockout",
  "round_robin",
  "swiss_knockout",
  "progress_stepladder",
];

function baseConfig(format: TournamentFormat, groupRounds: number): Partial<EngineConfig> {
  return {
    format,
    num_group_rounds: groupRounds,
    knockout_size: 4,
    result_mode: "win_loss",
    points_win: 1,
    points_draw: 0,
    points_loss: 0,
    allow_draws: false,
    use_progress_score: format !== "knockout",
  };
}

const names = (n: number) => Array.from({ length: n }, (_, i) => `P${i + 1}`);

// ---------------------------------------------------------------------------
// The specific combos the product owner called out.
// ---------------------------------------------------------------------------

describe("named combos reach a single champion (all pick strategies)", () => {
  const combos: Array<[number, number]> = [
    [2, 3],
    [4, 2],
    [8, 3],
  ];
  const strategies: Array<[string, (ids: string[], step: number) => number]> = [
    ["first", () => 0],
    ["last", (ids) => ids.length - 1],
    ["rotate", (_ids, step) => step],
  ];

  for (const format of FORMATS) {
    for (const [p, r] of combos) {
      for (const [sname, pick] of strategies) {
        it(`${format} ${p}p/${r}r (${sname}) → completes, one champion`, () => {
          const state = createEngine(baseConfig(format, r), names(p));
          const res = simulate(state, pick);
          expect(res.stuck, "engine deadlocked").toBe(false);
          expect(res.terminated).toBe(true);
          expect(state.status).toBe("completed");
          expect(champion(state)).not.toBeNull();
          assertPointsConserved(state);
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Broad fuzz — every format, player counts 2..12 (incl. odd), random ordering.
// ---------------------------------------------------------------------------

describe("fuzz: engine always terminates with one champion & no ghost advance", () => {
  for (const format of FORMATS) {
    it(`${format}: no deadlock / duplicate / lost champion`, () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 12 }),
          fc.integer({ min: 1, max: 5 }),
          fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 60 }),
          (playerCount, groupRounds, picks) => {
            const state = createEngine(
              baseConfig(format, groupRounds),
              names(playerCount),
            );
            const res = simulate(state, (ids, step) => picks[step % picks.length] % ids.length);

            // Must not deadlock.
            expect(res.stuck).toBe(false);
            expect(state.status).toBe("completed");

            // Exactly one champion.
            expect(champion(state)).not.toBeNull();

            // Points conserved throughout.
            assertPointsConserved(state);

            // P6 (all formats): no pairing repeats within the finals run —
            // the stepladder rematch class of bug (doc 12 §2).
            const seen = new Set<string>();
            for (const key of res.finalsPairings) {
              expect(seen.has(key), `repeated finals pairing ${key}`).toBe(false);
              seen.add(key);
            }
          },
        ),
        { numRuns: 200 },
      );
    }, 30_000);
  }
});

// ---------------------------------------------------------------------------
// P6 regression: 3-player stepladder tie → play-off winner goes straight to the
// Final; the play-off opponents NEVER meet again (the historical bug).
// ---------------------------------------------------------------------------

describe("P6: stepladder seeding play-off never causes a finals rematch", () => {
  // Regression for doc 12 §2: the play-off opponents must never meet again in
  // the same finals run. Historically fixed for the 3-seed ladder but NOT the
  // 4-seed ladder (the play-off loser dropped to the Eliminator, won, and faced
  // the play-off winner again in the Semi-final). Both ladder sizes covered.
  const cases: Array<[number, number]> = [
    [3, 3], // 3 players, 3-seed ladder
    [4, 4], // 4 players, 4-seed ladder (the newly fixed case)
    [5, 4],
    [6, 4],
  ];
  for (const [players, ko] of cases) {
    it(`${players} players / ${ko}-seed ladder: no play-off rematch`, () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 40 }),
          (picks) => {
            const state = createEngine(
              {
                format: "progress_stepladder",
                num_group_rounds: 2,
                knockout_size: ko,
                use_progress_score: true,
              },
              names(players),
            );
            const res = simulate(
              state,
              (ids, step) => picks[step % picks.length] % ids.length,
            );
            expect(res.stuck).toBe(false);

            const seen = new Set<string>();
            for (const key of res.finalsPairings) {
              expect(seen.has(key), `repeated finals pairing ${key}`).toBe(false);
              seen.add(key);
            }
          },
        ),
        { numRuns: 500 },
      );
    });
  }
});

// ---------------------------------------------------------------------------
// No eliminated player resurfaces in a LATER finals round (ghost advance).
// ---------------------------------------------------------------------------

describe("no ghost advancement: a knocked-out player never reappears later", () => {
  for (const format of ["knockout", "swiss_knockout"] as TournamentFormat[]) {
    it(`${format}: losers stay out`, () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 10 }),
          fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 40 }),
          (playerCount, picks) => {
            const state = createEngine(baseConfig(format, 2), names(playerCount));
            simulate(state, (ids, step) => picks[step % picks.length] % ids.length);

            // For pure knockout stages, once a player LOSES a knockout/final
            // match they must not appear in any strictly-later knockout match.
            const koRounds = state.rounds
              .filter((r) => r.stage === "knockout" || r.stage === "final")
              .sort((a, b) => a.round_number - b.round_number);
            const eliminatedAt = new Map<string, number>();
            for (const r of koRounds) {
              const ms = state.matches.filter(
                (m) => m.round_id === r.id && m.status === "completed" && m.winner_id && !m.is_bye,
              );
              for (const m of ms) {
                const loser =
                  m.player1_id === m.winner_id ? m.player2_id : m.player1_id;
                if (loser && !eliminatedAt.has(loser))
                  eliminatedAt.set(loser, r.round_number);
              }
            }
            for (const r of koRounds) {
              for (const m of state.matches.filter((x) => x.round_id === r.id)) {
                for (const pid of [m.player1_id, m.player2_id]) {
                  if (!pid) continue;
                  const elim = eliminatedAt.get(pid);
                  if (elim != null) {
                    expect(
                      r.round_number,
                      `player ${pid} eliminated R${elim} reappears R${r.round_number}`,
                    ).toBeLessThanOrEqual(elim);
                  }
                }
              }
            }
          },
        ),
        { numRuns: 300 },
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Custom scoring configs (league / football style with draws).
// ---------------------------------------------------------------------------

describe("custom scoring: league with draws stays consistent", () => {
  it("round_robin league (3/1/0, draws) conserves points and completes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 40 }),
        (playerCount, picks) => {
          const state = createEngine(
            {
              format: "round_robin",
              num_group_rounds: 0,
              knockout_size: 0,
              result_mode: "score",
              points_win: 3,
              points_draw: 1,
              points_loss: 0,
              allow_draws: true,
              use_progress_score: false,
            },
            names(playerCount),
          );
          start(state);
          let guard = 0;
          while (state.status !== "completed" && guard++ < 500) {
            const playable = playableMatches(state);
            if (!playable.length) break;
            const i = picks[guard % picks.length] % playable.length;
            const m = playable[i];
            // mix in draws and score wins
            const mode = picks[guard % picks.length] % 3;
            if (mode === 0) recordResult(state, m.id, { player1_score: 1, player2_score: 1 });
            else if (mode === 1) recordResult(state, m.id, { player1_score: 2, player2_score: 0 });
            else recordResult(state, m.id, { player1_score: 0, player2_score: 2 });
          }
          expect(state.status).toBe("completed");
          assertPointsConserved(state);
        },
      ),
      { numRuns: 200 },
    );
  });
});
