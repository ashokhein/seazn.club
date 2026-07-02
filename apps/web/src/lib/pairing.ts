/**
 * Pure pairing / bracket helpers. No database access here.
 */

export interface Pairing {
  player1: string;
  player2: string | null; // null => bye
}

/**
 * Swiss pairing for the next group round.
 *
 * @param rankedIds  player ids ordered best-first (by current standings)
 * @param playedKeys set of "a|b" (sorted) pairs that have already met
 * @param hadBye     set of player ids that already received a bye
 */
export function swissPairings(
  rankedIds: string[],
  playedKeys: Set<string>,
  hadBye: Set<string>,
): Pairing[] {
  const remaining = [...rankedIds];
  const pairings: Pairing[] = [];

  // Odd field: give a bye to the lowest-ranked player who has not had one yet.
  let byePlayer: string | null = null;
  if (remaining.length % 2 === 1) {
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (!hadBye.has(remaining[i])) {
        byePlayer = remaining[i];
        break;
      }
    }
    if (!byePlayer) byePlayer = remaining[remaining.length - 1];
    remaining.splice(remaining.indexOf(byePlayer), 1);
  }

  while (remaining.length > 0) {
    const p1 = remaining.shift()!;
    // Prefer the highest-ranked opponent p1 has not yet played.
    let oppIndex = remaining.findIndex(
      (p2) => !playedKeys.has(pairKey(p1, p2)),
    );
    if (oppIndex === -1) oppIndex = 0; // forced rematch
    const p2 = remaining.splice(oppIndex, 1)[0];
    pairings.push({ player1: p1, player2: p2 });
  }

  if (byePlayer) pairings.push({ player1: byePlayer, player2: null });
  return pairings;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Full round-robin schedule (circle method) so everyone plays everyone once.
 * Odd player counts get one bye per round. Returns an array of rounds.
 */
export function roundRobinRounds(ids: string[]): Pairing[][] {
  const arr: (string | null)[] = [...ids];
  if (arr.length % 2 === 1) arr.push(null); // dummy => bye
  const n = arr.length;
  const rounds: Pairing[][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: Pairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a === null || b === null) {
        const real = (a ?? b) as string;
        pairs.push({ player1: real, player2: null });
      } else {
        pairs.push({ player1: a, player2: b });
      }
    }
    rounds.push(pairs);
    // rotate everyone except the first element
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop()!);
    arr.splice(0, arr.length, fixed, ...rest);
  }
  return rounds;
}

/**
 * Standard single-elimination seed order for a bracket of `size`
 * (size must be a power of two). Returns 1-based seed numbers in bracket order
 * so that seed 1 meets the lowest seed, etc.
 */
export function standardSeeding(size: number): number[] {
  let seeds = [1, 2];
  while (seeds.length < size) {
    const n = seeds.length * 2;
    const next: number[] = [];
    for (const s of seeds) {
      next.push(s);
      next.push(n + 1 - s);
    }
    seeds = next;
  }
  return seeds;
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export interface BracketSlot {
  // index into the supplied seed array, or null for a bye/placeholder
  seed1: number | null;
  seed2: number | null;
}

/**
 * Build the first-round pairings of a single-elimination bracket given a list
 * of ranked player ids (best first). Players beyond a power-of-two boundary are
 * padded with byes. Returns first-round pairings; later rounds are created
 * empty and filled as winners advance.
 */
export function knockoutFirstRound(rankedIds: string[]): Pairing[] {
  const size = nextPowerOfTwo(Math.max(2, rankedIds.length));
  const order = standardSeeding(size); // seed numbers, length = size
  const slots: (string | null)[] = order.map((seedNum) =>
    seedNum <= rankedIds.length ? rankedIds[seedNum - 1] : null,
  );
  const pairings: Pairing[] = [];
  for (let i = 0; i < slots.length; i += 2) {
    pairings.push({ player1: slots[i] ?? "", player2: slots[i + 1] });
  }
  // Normalize: if player1 is a bye but player2 exists, swap so a present
  // player is always player1.
  return pairings.map((p) =>
    !p.player1 && p.player2
      ? { player1: p.player2, player2: null }
      : { player1: p.player1, player2: p.player2 },
  );
}

/**
 * Recommend how many group rounds fit a player count inside a target window.
 * Each chess game in the rules runs ~30 min; we assume boards run in parallel,
 * so wall-clock ≈ roundDurationMin * (groupRounds + knockoutRounds).
 */
export function recommendGroupRounds(
  playerCount: number,
  targetMinutes = 180,
  roundDurationMin = 30,
): { groupRounds: number; knockoutSize: number } {
  const knockoutSize = playerCount >= 8 ? 4 : playerCount >= 4 ? 2 : 0;
  const knockoutRounds =
    knockoutSize >= 2 ? Math.ceil(Math.log2(knockoutSize)) : 0;
  const maxRounds = Math.max(1, Math.floor(targetMinutes / roundDurationMin));
  // Sensible default: enough rounds that everyone plays a few games, capped by
  // both the time budget and the player count.
  let groupRounds = Math.min(
    Math.max(3, Math.ceil(Math.log2(Math.max(2, playerCount))) + 1),
    playerCount - 1,
    maxRounds - knockoutRounds,
  );
  if (groupRounds < 1) groupRounds = 1;
  return { groupRounds, knockoutSize };
}
