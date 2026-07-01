import { describe, it, expect } from "vitest";
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
import { SYSTEM_SPORT_PRESET_DEFS } from "../sport-presets";
import type { TournamentFormat, ResultMode } from "../types";

// ---------------------------------------------------------------------------
// Invariants (self-contained copy so this file stands alone).
// ---------------------------------------------------------------------------

function assertStepInvariants(state: EngineState, label: string) {
  const active = state.players.filter((p) => p.checked_in).length;
  const byRound = new Map<string, string[]>();
  for (const m of state.matches) {
    if (m.player1_id && m.player2_id)
      expect(m.player1_id, `${label}: self-pairing`).not.toBe(m.player2_id);
    const arr = byRound.get(m.round_id) ?? [];
    if (m.player1_id) arr.push(m.player1_id);
    if (m.player2_id) arr.push(m.player2_id);
    byRound.set(m.round_id, arr);
  }
  for (const [rid, ids] of byRound)
    expect(new Set(ids).size, `${label}: dup in round ${rid}`).toBe(ids.length);
  for (const r of state.rounds.filter((x) => x.stage === "group")) {
    const byes = state.matches.filter((m) => m.round_id === r.id && m.is_bye);
    expect(byes.length, `${label}: >1 bye`).toBeLessThanOrEqual(1);
    if (byes.length === 1) expect(active % 2, `${label}: bye on even`).toBe(1);
  }
}

function assertPointsConserved(state: EngineState, label: string) {
  const c = state.config;
  for (const row of standings(state)) {
    const expected =
      row.wins * c.points_win +
      row.draws * c.points_draw +
      row.losses * c.points_loss;
    expect(row.points, `${label}: points ${row.player.name}`).toBe(expected);
    expect(row.wins + row.draws + row.losses, `${label}: wdl`).toBe(row.played);
  }
}

// Deterministic RNG so any failure is reproducible from (config, seed).
function rng(seed: number) {
  let s = seed || 1;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

// ---------------------------------------------------------------------------
// A result-mode-aware driver: enters winners, scores, or draws exactly the way
// a real operator would for THIS scoring config.
// ---------------------------------------------------------------------------

function playToCompletion(state: EngineState, seed: number, label: string) {
  start(state);
  assertStepInvariants(state, label);
  const rand = rng(seed);
  const cfg = state.config;
  const finalsPairings: string[] = [];
  let steps = 0;

  while (state.status !== "completed") {
    const playable = playableMatches(state);
    expect(playable.length, `${label}: DEADLOCK (not completed, none playable)`).toBeGreaterThan(0);
    const m = playable[Math.floor(rand() * playable.length)];
    const round = state.rounds.find((r) => r.id === m.round_id)!;
    const isGroup = round.stage === "group";
    if (!isGroup) finalsPairings.push(pairKey(m.player1_id!, m.player2_id!));

    const wantDraw = cfg.allow_draws && isGroup && rand() < 0.3;

    if (cfg.result_mode === "score") {
      if (wantDraw) {
        recordResult(state, m.id, { player1_score: 1, player2_score: 1 });
      } else {
        const p1High = rand() < 0.5;
        recordResult(state, m.id, {
          player1_score: p1High ? 2 : 0,
          player2_score: p1High ? 0 : 2,
        });
      }
    } else {
      if (wantDraw) {
        recordResult(state, m.id, { is_draw: true });
      } else {
        recordResult(state, m.id, {
          winner_id: rand() < 0.5 ? m.player1_id : m.player2_id,
        });
      }
    }

    assertStepInvariants(state, label);
    if (++steps > 3000) throw new Error(`${label}: runaway`);
  }

  // Post conditions.
  assertPointsConserved(state, label);
  expect(champion(state), `${label}: no champion`).not.toBeNull();
  const seen = new Set<string>();
  for (const k of finalsPairings) {
    expect(seen.has(k), `${label}: finals rematch ${k}`).toBe(false);
    seen.add(k);
  }
}

// ---------------------------------------------------------------------------
// 1. The seven built-in games (mirrors src/lib/sport-presets.ts exactly).
// ---------------------------------------------------------------------------

interface GameCfg extends Partial<EngineConfig> {
  name: string;
}

const SYSTEM_GAMES: GameCfg[] = [
  { name: "Chess", format: "swiss_knockout", result_mode: "win_loss", points_win: 1, points_draw: 0, points_loss: 0, allow_draws: false, use_progress_score: true },
  { name: "Carrom", format: "swiss_knockout", result_mode: "win_loss", points_win: 1, points_draw: 0, points_loss: 0, allow_draws: false, use_progress_score: false },
  { name: "Football", format: "round_robin", result_mode: "score", points_win: 3, points_draw: 1, points_loss: 0, allow_draws: true, use_progress_score: false },
  { name: "Cricket", format: "round_robin", result_mode: "score", points_win: 2, points_draw: 1, points_loss: 0, allow_draws: true, use_progress_score: false },
  { name: "Volleyball", format: "knockout", result_mode: "score", points_win: 1, points_draw: 0, points_loss: 0, allow_draws: false, use_progress_score: false },
  { name: "Table Tennis", format: "knockout", result_mode: "score", points_win: 1, points_draw: 0, points_loss: 0, allow_draws: false, use_progress_score: false },
  { name: "Badminton", format: "knockout", result_mode: "score", points_win: 1, points_draw: 0, points_loss: 0, allow_draws: false, use_progress_score: false },
];

const names = (n: number) => Array.from({ length: n }, (_, i) => `P${i + 1}`);

// Drift guard: the grid above must stay in lock-step with the shipped presets.
// If a preset's scoring config changes, this fails until the grid is updated.
it("grid covers every system preset with matching scoring config", () => {
  expect(SYSTEM_GAMES.map((g) => g.name).sort()).toEqual(
    SYSTEM_SPORT_PRESET_DEFS.map((d) => d.sport_name).sort(),
  );
  for (const def of SYSTEM_SPORT_PRESET_DEFS) {
    const g = SYSTEM_GAMES.find((x) => x.name === def.sport_name)!;
    expect(g, `missing grid entry for ${def.sport_name}`).toBeTruthy();
    expect({
      format: g.format,
      result_mode: g.result_mode,
      points_win: g.points_win,
      points_draw: g.points_draw,
      points_loss: g.points_loss,
      allow_draws: g.allow_draws,
      use_progress_score: g.use_progress_score,
    }).toEqual({
      format: def.format,
      result_mode: def.result_mode,
      points_win: def.points_win,
      points_draw: def.points_draw,
      points_loss: def.points_loss,
      allow_draws: def.allow_draws,
      use_progress_score: def.use_progress_score,
    });
  }
});

describe("scoring grid — every built-in game, native result entry", () => {
  for (const game of SYSTEM_GAMES) {
    for (const count of [2, 3, 4, 5, 8]) {
      for (const seed of [1, 2, 3]) {
        it(`${game.name} · ${count}p · seed ${seed}`, () => {
          const state = createEngine(
            { num_group_rounds: 2, knockout_size: 4, ...game },
            names(count),
          );
          playToCompletion(state, seed, `${game.name}/${count}p/s${seed}`);
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Full custom matrix — every format × result_mode × draws × progress, over
//    several point schemes and knockout sizes. This is the "all combinations"
//    grid an org can build with a custom sport preset.
// ---------------------------------------------------------------------------

const FORMATS: TournamentFormat[] = [
  "knockout",
  "round_robin",
  "swiss_knockout",
  "progress_stepladder",
];
const MODES: ResultMode[] = ["win_loss", "score"];
const POINTS = [
  { points_win: 1, points_draw: 0, points_loss: 0 },
  { points_win: 3, points_draw: 1, points_loss: 0 },
  { points_win: 2, points_draw: 1, points_loss: 0 },
  { points_win: 0, points_draw: 0, points_loss: 0 }, // pathological: all zero
  { points_win: 2, points_draw: 1, points_loss: 1 }, // loss still scores
];

describe("scoring grid — full custom matrix", () => {
  for (const format of FORMATS) {
    for (const mode of MODES) {
      for (const draws of [false, true]) {
        for (const progress of [false, true]) {
          for (const koSize of [2, 4]) {
            for (const pts of POINTS) {
              const label = `${format}/${mode}/d${draws ? 1 : 0}/pr${progress ? 1 : 0}/ko${koSize}/${pts.points_win}-${pts.points_draw}-${pts.points_loss}`;
              it(label, () => {
                for (const count of [3, 4, 5]) {
                  for (const seed of [1, 2]) {
                    const state = createEngine(
                      {
                        format,
                        result_mode: mode,
                        allow_draws: draws,
                        use_progress_score: progress,
                        num_group_rounds: 2,
                        knockout_size: koSize,
                        ...pts,
                      },
                      names(count),
                    );
                    playToCompletion(state, seed, `${label}/${count}p/s${seed}`);
                  }
                }
              });
            }
          }
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Explicit scoring-correctness spot checks per scheme (not just invariants).
// ---------------------------------------------------------------------------

describe("scoring correctness — exact points per scheme", () => {
  it("football 3/1/0: win=3, draw=1 each", () => {
    const state = createEngine(
      { format: "round_robin", result_mode: "score", points_win: 3, points_draw: 1, points_loss: 0, allow_draws: true, use_progress_score: false, knockout_size: 0 },
      names(3),
    );
    start(state);
    // Play a deterministic set: P1 beats P2 (2-0), P1 draws P3 (1-1), P2 beats P3.
    const play = (p1: string, p2: string, s1: number, s2: number) => {
      const m = playableMatches(state).find(
        (x) => (x.player1_id === p1 && x.player2_id === p2) || (x.player1_id === p2 && x.player2_id === p1),
      )!;
      const swap = m.player1_id !== p1;
      recordResult(state, m.id, {
        player1_score: swap ? s2 : s1,
        player2_score: swap ? s1 : s2,
      });
    };
    play("p1", "p2", 2, 0);
    play("p1", "p3", 1, 1);
    play("p2", "p3", 2, 1);
    const rows = standings(state);
    const P = (id: string) => rows.find((r) => r.player.id === id)!;
    expect(P("p1").points).toBe(4); // win + draw
    expect(P("p2").points).toBe(3); // loss + win
    expect(P("p3").points).toBe(1); // draw + loss
  });

  it("cricket 2/1/0: win=2 not 3", () => {
    const state = createEngine(
      { format: "round_robin", result_mode: "score", points_win: 2, points_draw: 1, points_loss: 0, allow_draws: true, use_progress_score: false, knockout_size: 0 },
      names(2),
    );
    start(state);
    const m = playableMatches(state)[0];
    recordResult(state, m.id, { player1_score: 200, player2_score: 150 });
    const rows = standings(state);
    expect(rows.find((r) => r.player.id === "p1")!.points).toBe(2);
  });

  it("all-zero points scheme still ranks and completes (progress breaks ties)", () => {
    const state = createEngine(
      { format: "swiss_knockout", result_mode: "win_loss", points_win: 0, points_draw: 0, points_loss: 0, allow_draws: false, use_progress_score: true, num_group_rounds: 2, knockout_size: 4 },
      names(4),
    );
    playToCompletion(state, 1, "all-zero");
    expect(state.status).toBe("completed");
  });
});
