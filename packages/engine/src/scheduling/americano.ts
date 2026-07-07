// Americano / Mexicano (Jul3/08 §3, 21 May) — padel rotating-partner formats.
// Individuals rotate partners each round; points are personal. Pure and
// deterministic:
//  - americano: a fixed, seeded rotation covering partner/opponent pairings
//    as evenly as the field allows (whist-style round robin of pairs);
//  - mexicano: round r+1 pairs 1+4 vs 2+3 within standing quartets — a
//    re-rank-each-round generator in the same family as Swiss pairRound.
import type { EntrantId } from "../core/types.ts";

export interface AmericanoConfig {
  mode: "americano" | "mexicano";
  courtCount: number; // parallel courts per round
  rounds: number;
}

export interface AmericanoMatch {
  id: string; // stable: `am-r{round}-c{court}`
  roundNo: number;
  court: number;
  team1: [EntrantId, EntrantId];
  team2: [EntrantId, EntrantId];
}

export interface AmericanoRound {
  roundNo: number;
  matches: AmericanoMatch[];
  byes: EntrantId[]; // players sitting out (field not divisible by 4 / court cap)
  /** Jul3/08 §9: uneven fields repeat some pairings — best-effort, warned. */
  warnings: string[];
}

// Whist-style rotation: fix player 0, rotate the rest; each round the circle
// yields quartets (i, i+1) vs (i+2, i+3) over the rotated order. This covers
// partners/opponents evenly when players ≡ 0 (mod 4).
function rotationOrder(players: readonly EntrantId[], round: number): EntrantId[] {
  if (players.length <= 1) return [...players];
  const [pivot, ...rest] = players;
  const n = rest.length;
  const k = round % n;
  const rotated = rest.map((_, i) => rest[(i + k) % n] as EntrantId);
  return [pivot as EntrantId, ...rotated];
}

function quartets(
  order: readonly EntrantId[],
  courtCount: number,
  roundNo: number,
): { matches: AmericanoMatch[]; byes: EntrantId[] } {
  const matches: AmericanoMatch[] = [];
  const playable = Math.min(Math.floor(order.length / 4), courtCount);
  for (let c = 0; c < playable; c++) {
    const q = order.slice(c * 4, c * 4 + 4) as EntrantId[];
    matches.push({
      id: `am-r${roundNo}-c${c + 1}`,
      roundNo,
      court: c + 1,
      // 1+4 vs 2+3 inside each quartet — balances strength in both modes
      team1: [q[0]!, q[3]!],
      team2: [q[1]!, q[2]!],
    });
  }
  return { matches, byes: order.slice(playable * 4) };
}

/** Americano: the full seeded rotation, all rounds upfront. */
export function generateAmericano(
  players: readonly EntrantId[],
  config: AmericanoConfig,
): AmericanoRound[] {
  const rounds: AmericanoRound[] = [];
  const warnings: string[] =
    players.length % 4 === 0 ? [] : [`${players.length} players — some sit out or pairings repeat`];
  for (let r = 1; r <= config.rounds; r++) {
    const order = rotationOrder(players, r - 1);
    const { matches, byes } = quartets(order, config.courtCount, r);
    rounds.push({ roundNo: r, matches, byes, warnings: r === 1 ? warnings : [] });
  }
  return rounds;
}

export interface AmericanoStanding {
  playerId: EntrantId;
  points: number; // personal points (fractional legal, Jul3/05)
}

/** Mexicano: ONE next round derived from the current personal standings —
 *  sort by points, quartet by rank, 1+4 vs 2+3 (21 May "re-rank each round"). */
export function pairMexicanoRound(
  standings: readonly AmericanoStanding[],
  config: Pick<AmericanoConfig, "courtCount">,
  roundNo: number,
): AmericanoRound {
  const order = [...standings]
    .sort((a, b) => b.points - a.points || a.playerId.localeCompare(b.playerId))
    .map((s) => s.playerId);
  const { matches, byes } = quartets(order, config.courtCount, roundNo);
  return {
    roundNo,
    matches,
    byes,
    warnings: order.length % 4 === 0 ? [] : [`${order.length} players — byes this round`],
  };
}
