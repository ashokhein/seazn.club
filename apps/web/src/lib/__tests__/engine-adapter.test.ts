import { describe, it, expect } from "vitest";
import {
  createEngine,
  engineFromBundle,
  diffState,
  start,
  recordResult,
  playableMatches,
  standings,
  champion,
  type EngineConfig,
  type EngineDiff,
} from "../engine";
import type { Match, Player, Round, Tournament } from "../types";

// A uuid-ish generator so adapter rows look like production rows (not r-N/m-N).
let uid = 0;
const uuid = () => `uuid-${++uid}`;

const names = (n: number) => Array.from({ length: n }, (_, i) => `P${i + 1}`);

function fakeTournament(config: Partial<EngineConfig>): Tournament {
  const base = createEngine(config, ["x", "y"]).config;
  return {
    id: "t",
    org_id: "o",
    season_id: null,
    created_by: null,
    sport: "custom",
    name: "T",
    category: "open",
    status: "setup",
    undo_remaining: 3,
    num_group_rounds: base.num_group_rounds,
    knockout_size: base.knockout_size,
    result_mode: base.result_mode,
    score_label: "Score",
    points_win: base.points_win,
    points_draw: base.points_draw,
    points_loss: base.points_loss,
    allow_draws: base.allow_draws,
    use_progress_score: base.use_progress_score,
    format: base.format,
    starts_at: null,
    round_minutes: 30,
    clock_minutes: 0,
    is_public: false,
    public_slug: null,
    state_version: 0,
    venue: null,
    created_at: "now",
  };
}

// A minimal in-memory "database" whose only mutations come from applying an
// EngineDiff — exactly what tournament.ts does with SQL.
interface FakeDb {
  tournament: Tournament;
  players: Player[];
  rounds: Round[];
  matches: Match[];
}

const MUT = [
  "player1_id",
  "player2_id",
  "winner_id",
  "loser_id",
  "player1_score",
  "player2_score",
  "is_draw",
  "is_bye",
  "status",
] as const;

function applyDiff(db: FakeDb, diff: EngineDiff) {
  for (const r of diff.newRounds) db.rounds.push({ ...r });
  for (const r of diff.updatedRounds) {
    const t = db.rounds.find((x) => x.id === r.id)!;
    t.status = r.status;
  }
  for (const m of diff.newMatches) db.matches.push({ ...m });
  for (const m of diff.updatedMatches) {
    const t = db.matches.find((x) => x.id === m.id)! as unknown as Record<string, unknown>;
    const src = m as unknown as Record<string, unknown>;
    for (const k of MUT) t[k] = src[k];
  }
  db.tournament.status = diff.status;
}

function rng(seed: number) {
  let s = seed || 1;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

// Runs a tournament purely through the adapter cycle:
//   load DB -> engineFromBundle -> engine op -> diffState -> applyDiff.
function adapterRun(config: Partial<EngineConfig>, playerCount: number, seed: number): FakeDb {
  const db: FakeDb = {
    tournament: fakeTournament(config),
    players: names(playerCount).map((name, i) => ({
      id: `p${i + 1}`,
      tournament_id: "t",
      name,
      seed: i + 1,
      checked_in: true,
      image_url: null,
      image_storage_path: null,
    })),
    rounds: [],
    matches: [],
  };

  // start
  {
    const before = { rounds: db.rounds, matches: db.matches };
    const state = engineFromBundle(db, uuid);
    start(state);
    applyDiff(db, diffState(before, state));
  }

  const rand = rng(seed);
  let guard = 0;
  while (db.tournament.status !== "completed") {
    const playable = db.matches.filter(
      (m) => m.status === "ready" && m.player1_id && m.player2_id,
    );
    if (!playable.length) throw new Error("adapter deadlock");
    const m = playable[Math.floor(rand() * playable.length)];
    const winner = rand() < 0.5 ? m.player1_id! : m.player2_id!;

    const before = { rounds: db.rounds, matches: db.matches };
    const state = engineFromBundle(db, uuid);
    recordResult(state, m.id, { winner_id: winner });
    applyDiff(db, diffState(before, state));

    if (++guard > 3000) throw new Error("adapter runaway");
  }
  return db;
}

// ---------------------------------------------------------------------------

describe("engineFromBundle", () => {
  it("does not mutate the source bundle when the engine runs", () => {
    const seed = createEngine({ format: "knockout" }, names(4));
    start(seed);
    const bundle = {
      tournament: fakeTournament({ format: "knockout" }),
      players: seed.players,
      rounds: seed.rounds,
      matches: seed.matches,
    };
    bundle.tournament.status = "knockout";
    const roundsSnapshot = JSON.stringify(bundle.rounds);
    const matchesSnapshot = JSON.stringify(bundle.matches);

    const state = engineFromBundle(bundle, uuid);
    // decide a match in the rebuilt state
    const m = playableMatches(state)[0];
    recordResult(state, m.id, { winner_id: m.player1_id });

    expect(JSON.stringify(bundle.rounds)).toBe(roundsSnapshot);
    expect(JSON.stringify(bundle.matches)).toBe(matchesSnapshot);
  });
});

describe("diffState", () => {
  it("start of a 4-player knockout is all-new, nothing updated", () => {
    const before = { rounds: [] as Round[], matches: [] as Match[] };
    const state = engineFromBundle(
      { tournament: fakeTournament({ format: "knockout" }), players: [], rounds: [], matches: [] },
      uuid,
    );
    // seed the engine with players and start
    const s2 = createEngine({ format: "knockout" }, names(4));
    start(s2);
    // reuse s2 as the "after"
    const diff = diffState(before, s2);
    expect(diff.newRounds).toHaveLength(2); // SF + Final
    expect(diff.newMatches).toHaveLength(3); // 2 SF + 1 Final
    expect(diff.updatedRounds).toHaveLength(0);
    expect(diff.updatedMatches).toHaveLength(0);
    void state;
  });

  it("recording a result marks that match updated and adds no phantom rows", () => {
    const s = createEngine({ format: "round_robin", knockout_size: 0 }, names(4));
    start(s);
    const before = { rounds: s.rounds.map((r) => ({ ...r })), matches: s.matches.map((m) => ({ ...m })) };
    const m = playableMatches(s)[0];
    recordResult(s, m.id, { winner_id: m.player1_id });
    const diff = diffState(before, s);
    expect(diff.newMatches).toHaveLength(0);
    expect(diff.updatedMatches.map((x) => x.id)).toContain(m.id);
    // exactly the one played match changed (round-status may also flip)
    expect(diff.updatedMatches).toHaveLength(1);
  });
});

describe("adapter cycle matches direct engine (load → diff → persist)", () => {
  const combos: Array<Partial<EngineConfig> & { label: string }> = [
    { label: "chess swiss", format: "swiss_knockout", num_group_rounds: 2, knockout_size: 4, use_progress_score: true },
    { label: "football RR", format: "round_robin", knockout_size: 0, result_mode: "score", points_win: 3, points_draw: 1, allow_draws: true },
    { label: "volleyball KO", format: "knockout", result_mode: "score" },
    { label: "stepladder", format: "progress_stepladder", num_group_rounds: 2, knockout_size: 4 },
  ];

  for (const combo of combos) {
    for (const count of [3, 4, 5, 8]) {
      for (const seed of [1, 2, 3]) {
        it(`${combo.label} · ${count}p · seed ${seed} completes with one champion`, () => {
          const db = adapterRun(combo, count, seed);
          expect(db.tournament.status).toBe("completed");

          // Rebuild a state from the persisted DB and check the invariants.
          const final = engineFromBundle(db, uuid);
          expect(champion(final), "no champion").not.toBeNull();

          // points conserved on the persisted data
          const c = final.config;
          for (const row of standings(final)) {
            expect(row.points).toBe(
              row.wins * c.points_win + row.draws * c.points_draw + row.losses * c.points_loss,
            );
          }

          // no duplicate player within any round on the persisted data
          const byRound = new Map<string, string[]>();
          for (const m of db.matches) {
            const arr = byRound.get(m.round_id) ?? [];
            if (m.player1_id) arr.push(m.player1_id);
            if (m.player2_id) arr.push(m.player2_id);
            byRound.set(m.round_id, arr);
          }
          for (const [, ids] of byRound) expect(new Set(ids).size).toBe(ids.length);
        });
      }
    }
  }
});
