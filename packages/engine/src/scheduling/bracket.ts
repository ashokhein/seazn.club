// Seeded brackets — spec 05 §2.3 (single elimination), §2.4 (double
// elimination), §2.5 (stepladder). Pure and deterministic given
// (entrants, seeds, config); the fixture wiring is uniform across SE/DE/
// stepladder — every slot is either a concrete seeded entrant, an auto-decided
// bye award, or a feed from another fixture's winner/loser.
import type { EntrantId } from "../core/types.ts";
import { seedOrder } from "./roundrobin.ts";

// A slot filled by the winner or loser of an earlier fixture (spec 05 §2.3
// feeds; §2.4 uniform winner_to/loser_to wiring).
export interface BracketSlotRef {
  fixtureId: string;
  side: "winner" | "loser";
}

export interface BracketFixtureGen {
  id: string;
  bracket?: "WB" | "LB" | "GF"; // omit for a single-lane SE bracket
  round: number; // 0-based, monotonic within a lane (higher = later)
  isFinal?: boolean; // SE final / DE grand final(s)
  thirdPlace?: boolean;
  conditional?: boolean; // DE bracket-reset game: played only if the LB champ wins GF1
  home?: EntrantId; // concrete seeded entrant (round 1)
  away?: EntrantId;
  homeFrom?: BracketSlotRef; // feed
  awayFrom?: BracketSlotRef;
  award?: EntrantId; // bye: auto-decided at generation, the advancing entrant
}

export interface GeneratedBracket {
  fixtures: BracketFixtureGen[];
  rounds: number; // SE: bracket depth log2(S). DE: WB depth.
}

// ---------------------------------------------------------------------------
// Seeding fold — spec 05 §2.3
// ---------------------------------------------------------------------------

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// Recursive interleave placing seed numbers into bracket slots so 1 meets 2
// only in the final, 1v4/2v3 in the semis, etc. (spec 05 §2.3):
//   [1] → [1,2] → [1,4,3,2] → [1,8,5,4,3,6,7,2] → …
// Each parent seed s spawns the pair (s, sum−s); the orientation alternates by
// parent index so the layout matches the standard fold (the 16-seed layout is
// the golden in the tests).
export function seedPositions(size: number): number[] {
  let seeds = [1];
  while (seeds.length < size) {
    const sum = seeds.length * 2 + 1;
    const next: number[] = [];
    seeds.forEach((s, i) => {
      if (i % 2 === 0) next.push(s, sum - s);
      else next.push(sum - s, s);
    });
    seeds = next;
  }
  return seeds;
}

const winnerOf = (fixtureId: string): BracketSlotRef => ({ fixtureId, side: "winner" });
const loserOf = (fixtureId: string): BracketSlotRef => ({ fixtureId, side: "loser" });

// ---------------------------------------------------------------------------
// Single elimination — spec 05 §2.3
// ---------------------------------------------------------------------------

export interface SingleElimOptions {
  entrants: readonly EntrantId[];
  seeds?: ReadonlyMap<EntrantId, number>;
  thirdPlace?: boolean; // add a 3rd-place playoff between the semifinal losers
  idPrefix?: string; // fixture-id namespace (default 'se'); DE uses 'wb'
  bracketTag?: "WB"; // tag fixtures (DE winners bracket)
}

interface SEResult {
  fixtures: BracketFixtureGen[];
  gameIds: string[][]; // [round][i] — for DE loser wiring
  rounds: number;
  finalId: string | undefined;
  semifinalIds: string[]; // the two SF game ids (round rounds-2), else []
}

// Build the SE bracket structure. Round-0 slots come from the seed fold; byes
// (S − n, awarded to the top seeds) auto-decide as `award`; every later slot is
// a winner feed. Returns the game-id grid so double elimination can wire the
// losers.
function buildSingleElim(opts: SingleElimOptions): SEResult {
  const ordered = seedOrder(opts.entrants, opts.seeds);
  const n = ordered.length;
  const prefix = opts.idPrefix ?? "se";
  const empty: SEResult = { fixtures: [], gameIds: [], rounds: 0, finalId: undefined, semifinalIds: [] };
  if (n < 2) return empty;

  const size = nextPowerOfTwo(n);
  const positions = seedPositions(size);
  const rounds = Math.log2(size);
  const entrantOfSeed = (k: number): EntrantId | null => (k <= n ? (ordered[k - 1] as EntrantId) : null);

  const fixtures: BracketFixtureGen[] = [];
  const gameIds: string[][] = [];
  const tag = opts.bracketTag;
  // A DE winners bracket has no "final" of its own — only the grand final does.
  const markFinal = tag === undefined;

  // Round 0 — seeded entrants / byes.
  gameIds[0] = [];
  for (let i = 0; i < size / 2; i++) {
    const id = `${prefix}-r0-i${i}`;
    const hs = positions[2 * i] as number;
    const as = positions[2 * i + 1] as number;
    const hE = entrantOfSeed(hs);
    const aE = entrantOfSeed(as);
    const base: BracketFixtureGen = {
      id,
      round: 0,
      ...(tag === undefined ? {} : { bracket: tag }),
      ...(rounds === 1 && markFinal ? { isFinal: true } : {}), // 2-entrant bracket: round 0 is the final
    };
    if (hE !== null && aE !== null) {
      fixtures.push({ ...base, home: hE, away: aE });
    } else {
      // Exactly one side is a bye ⇒ the real entrant is awarded through.
      const real = (hE ?? aE) as EntrantId;
      fixtures.push({ ...base, home: real, award: real });
    }
    (gameIds[0] as string[]).push(id);
  }

  // Later rounds — winner feeds.
  for (let r = 1; r < rounds; r++) {
    gameIds[r] = [];
    const games = size / 2 ** (r + 1);
    const prev = gameIds[r - 1] as string[];
    for (let i = 0; i < games; i++) {
      const id = `${prefix}-r${r}-i${i}`;
      fixtures.push({
        id,
        round: r,
        ...(tag === undefined ? {} : { bracket: tag }),
        ...(r === rounds - 1 && markFinal ? { isFinal: true } : {}),
        homeFrom: winnerOf(prev[2 * i] as string),
        awayFrom: winnerOf(prev[2 * i + 1] as string),
      });
      (gameIds[r] as string[]).push(id);
    }
  }

  const finalId = (gameIds[rounds - 1] as string[])[0];
  const semifinalIds = rounds >= 2 ? [...(gameIds[rounds - 2] as string[])] : [];
  return { fixtures, gameIds, rounds, finalId, semifinalIds };
}

export function generateSingleElim(opts: SingleElimOptions): GeneratedBracket {
  const se = buildSingleElim(opts);
  const fixtures = [...se.fixtures];

  // 3rd-place playoff from the semifinal losers (spec 05 §2.3).
  if (opts.thirdPlace === true && se.semifinalIds.length === 2) {
    fixtures.push({
      id: `${opts.idPrefix ?? "se"}-3p`,
      round: se.rounds - 1,
      thirdPlace: true,
      homeFrom: loserOf(se.semifinalIds[0] as string),
      awayFrom: loserOf(se.semifinalIds[1] as string),
    });
  }

  return { fixtures, rounds: se.rounds };
}

// ---------------------------------------------------------------------------
// Cross-pool seeding (group → knockout) — spec 05 §2.3
// ---------------------------------------------------------------------------

// Interleave pool finishers by rank (all winners, then all runners-up, …) — the
// A1–B2 / B1–A2 template: fed as the seed order into generateSingleElim it
// places pool winners against other pools' runners-up, and a same-pool rematch
// can only occur in the final (for two pools; larger pool counts defer it as far
// as the fold allows). `pools[p]` is pool p's finishers in rank order.
export function crossPoolSeedOrder(pools: readonly (readonly EntrantId[])[]): EntrantId[] {
  const maxRank = Math.max(0, ...pools.map((p) => p.length));
  const order: EntrantId[] = [];
  for (let rank = 0; rank < maxRank; rank++) {
    for (const pool of pools) {
      const e = pool[rank];
      if (e !== undefined) order.push(e);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Double elimination — spec 05 §2.4
// ---------------------------------------------------------------------------

export interface DoubleElimOptions {
  entrants: readonly EntrantId[];
  seeds?: ReadonlyMap<EntrantId, number>;
  bracketReset?: boolean; // grand-final bracket reset (LB champ must win twice)
}

// Winners bracket = an SE bracket. Each WB round's losers drop into the losers
// bracket at the canonical slot; the LB alternates "minor" rounds (absorbing WB
// losers) and "major" rounds (pairing LB survivors). Grand final = WB champion
// vs LB champion, with an optional bracket-reset decider.
export function generateDoubleElim(opts: DoubleElimOptions): GeneratedBracket {
  const wb = buildSingleElim({
    entrants: opts.entrants,
    ...(opts.seeds === undefined ? {} : { seeds: opts.seeds }),
    idPrefix: "wb",
    bracketTag: "WB",
  });
  if (wb.finalId === undefined) return { fixtures: [...wb.fixtures], rounds: wb.rounds };

  const fixtures: BracketFixtureGen[] = [...wb.fixtures];
  const k = wb.rounds; // WB depth = log2(size)
  const size = 2 ** k;

  // Losers bracket. 2(k−1) rounds; game counts follow the drop pattern.
  const lbGameIds: string[][] = [];
  const lbRounds = 2 * (k - 1);

  if (lbRounds >= 1) {
    // LB round 0 (minor): pairs adjacent WB round-0 losers.
    lbGameIds[0] = [];
    for (let i = 0; i < size / 4; i++) {
      const id = `lb-r0-i${i}`;
      fixtures.push({
        id,
        bracket: "LB",
        round: k, // LB numbered after WB so later rounds sort later
        homeFrom: loserOf((wb.gameIds[0] as string[])[2 * i] as string),
        awayFrom: loserOf((wb.gameIds[0] as string[])[2 * i + 1] as string),
      });
      (lbGameIds[0] as string[]).push(id);
    }

    for (let L = 1; L < lbRounds; L++) {
      lbGameIds[L] = [];
      const prev = lbGameIds[L - 1] as string[];
      if (L % 2 === 1) {
        // Major: winner(prev[i]) vs loser of WB round m+1, game i.
        const m = (L - 1) / 2;
        const wbLosers = wb.gameIds[m + 1] as string[];
        for (let i = 0; i < prev.length; i++) {
          const id = `lb-r${L}-i${i}`;
          fixtures.push({
            id,
            bracket: "LB",
            round: k + L,
            homeFrom: winnerOf(prev[i] as string),
            awayFrom: loserOf(wbLosers[i] as string),
          });
          (lbGameIds[L] as string[]).push(id);
        }
      } else {
        // Minor: winner(prev[2i]) vs winner(prev[2i+1]).
        for (let i = 0; i < prev.length / 2; i++) {
          const id = `lb-r${L}-i${i}`;
          fixtures.push({
            id,
            bracket: "LB",
            round: k + L,
            homeFrom: winnerOf(prev[2 * i] as string),
            awayFrom: winnerOf(prev[2 * i + 1] as string),
          });
          (lbGameIds[L] as string[]).push(id);
        }
      }
    }
  }

  // Grand final — WB champion (home) vs LB champion (away). With no LB (a
  // 2-entrant field) the LB champion is simply the WB final's loser.
  const gfRound = k + lbRounds;
  const lbChampFeed =
    lbRounds >= 1 ? winnerOf((lbGameIds[lbRounds - 1] as string[])[0] as string) : loserOf(wb.finalId);
  fixtures.push({
    id: "gf",
    bracket: "GF",
    round: gfRound,
    isFinal: true,
    homeFrom: winnerOf(wb.finalId),
    awayFrom: lbChampFeed,
  });

  // Optional bracket reset: a second grand final between the same two, played
  // only if the LB champion wins GF1. The persistence adapter voids it when the
  // WB champion wins (void counts as settled for stage completion).
  if (opts.bracketReset === true) {
    fixtures.push({
      id: "gf-reset",
      bracket: "GF",
      round: gfRound + 1,
      isFinal: true,
      conditional: true,
      homeFrom: winnerOf("gf"),
      awayFrom: loserOf("gf"),
    });
  }

  return { fixtures, rounds: wb.rounds };
}

// ---------------------------------------------------------------------------
// Stepladder — spec 05 §2.5
// ---------------------------------------------------------------------------

export interface StepladderOptions {
  entrants: readonly EntrantId[];
  seeds?: ReadonlyMap<EntrantId, number>;
}

// Rank-ordered ladder: the two lowest seeds play, the winner climbs to meet the
// next seed up, … up to the top seed in the final (R4 v R3 → winner v R2 →
// winner v R1). Generalised to any size k ≥ 2.
export function generateStepladder(opts: StepladderOptions): GeneratedBracket {
  const ordered = seedOrder(opts.entrants, opts.seeds); // rank 1 … k
  const k = ordered.length;
  if (k < 2) return { fixtures: [], rounds: 0 };

  const fixtures: BracketFixtureGen[] = [];
  // Game 0: the two lowest seeds (rank k−1 home, rank k away).
  fixtures.push({
    id: "sl-g0",
    round: 0,
    ...(k === 2 ? { isFinal: true } : {}),
    home: ordered[k - 2] as EntrantId,
    away: ordered[k - 1] as EntrantId,
  });
  // Game j (1…k−2): the waiting seed (rank k−1−j) vs the previous winner.
  for (let j = 1; j <= k - 2; j++) {
    fixtures.push({
      id: `sl-g${j}`,
      round: j,
      ...(j === k - 2 ? { isFinal: true } : {}),
      home: ordered[k - 2 - j] as EntrantId,
      awayFrom: winnerOf(`sl-g${j - 1}`),
    });
  }

  return { fixtures, rounds: k - 1 };
}
