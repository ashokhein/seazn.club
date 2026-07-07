// Circle-method round robin — spec 05 §2.1. Deterministic given
// (entrants, seeds, config, rngSeed); regeneration is byte-identical (spec 05
// §6 idempotence). Zero effectful deps: no wall clock, no Math.random.
//
// Construction (provably balanced "two-row" circle method):
//   Lay the padded field in two rows of n/2. Column i pairs top-row i with
//   bottom-row i; the top player is home, bottom away. One player is the pivot
//   (top-left, column 0) and stays put; every other slot rotates by one each
//   round, so over n−1 rounds each pair meets exactly once. The pivot's own
//   game flips home/away by round parity — which keeps |home−away| ≤ 1 for
//   *every* entrant (proof: each rotating entrant visits all n−1 non-pivot
//   slots once; n/2−1 are fixed-home, n/2−1 fixed-away, and the single column-0
//   slot flips, so the count is (n/2−1) ± 1 either way).
//   Odd field ⇒ the pivot is the BYE, so column 0 is always the bye pairing and
//   every real game is a fixed-orientation column — real entrants come out with
//   |home−away| = 0.
import type { EntrantId } from "../core/types.ts";

// legs=2 mirrors leg 1 (same pairings, home/away swapped); legs>2 alternate
// the mirror per leg (Jul3/08 §2 — a triple RR gives every pairing a 2/1
// home/away split). Board indices are assigned 1..(games per round) and
// rotated so the pivot never monopolises board 1; physical court packing is
// calendar.ts's job (spec 05 §2.6).
export interface RoundRobinConfig {
  legs?: number; // ≥1; capped at 8 by the config validator
}

export interface RoundRobinOptions {
  entrants: readonly EntrantId[];
  // Pairing order: entrants sorted by seed ascending (1 = top) when supplied,
  // else input order. The top of the order is the pivot for even fields.
  seeds?: ReadonlyMap<EntrantId, number>;
  config?: RoundRobinConfig;
  // Accepted for a uniform generator signature (spec 05 §2.6 item 5); the
  // circle method is fully determined by seed order, so it is not consulted.
  rngSeed?: number;
}

export interface RoundRobinFixture {
  id: string; // `rr-r{roundNo}-c{court}` — stable across regeneration
  roundNo: number; // 1-based, continuous across legs
  leg: number; // 1-based
  court: number; // 1-based board index within the round (rotated)
  home: EntrantId;
  away: EntrantId;
}

export interface RoundRobinRound {
  roundNo: number;
  leg: number;
  fixtures: RoundRobinFixture[];
  bye?: EntrantId; // the entrant sitting out (odd field only)
}

export interface RoundRobinSchedule {
  rounds: RoundRobinRound[];
  fixtures: RoundRobinFixture[]; // flat, round-then-court order
}

// Entrants in pairing order: by seed asc when a seed map is present (ties and
// unseeded entrants fall back to input order, stably), else input order.
export function seedOrder(
  entrants: readonly EntrantId[],
  seeds?: ReadonlyMap<EntrantId, number>,
): EntrantId[] {
  const order = [...entrants];
  if (seeds === undefined) return order;
  const index = new Map(order.map((id, i) => [id, i]));
  return order.sort((a, b) => {
    const sa = seeds.get(a) ?? Number.MAX_SAFE_INTEGER;
    const sb = seeds.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return (index.get(a) as number) - (index.get(b) as number);
  });
}

// Rotate `arr` forward by `by` (element at i moves to i+by, wrapping).
function rotate<T>(arr: readonly T[], by: number): T[] {
  const n = arr.length;
  if (n === 0) return [];
  const k = ((by % n) + n) % n;
  return arr.map((_, i) => arr[(i - k + n) % n] as T);
}

export function generateRoundRobin(opts: RoundRobinOptions): RoundRobinSchedule {
  const real = seedOrder(opts.entrants, opts.seeds);
  const legs = opts.config?.legs ?? 1;
  const rounds: RoundRobinRound[] = [];
  const flat: RoundRobinFixture[] = [];
  if (real.length < 2) return { rounds, fixtures: flat };

  const odd = real.length % 2 === 1;
  // Pivot = BYE (null) when odd so column 0 is always the bye; else the top seed.
  const players: (EntrantId | null)[] = odd ? [null, ...real] : [...real];
  const n = players.length; // even
  const half = n / 2;
  const roundsPerLeg = n - 1;
  const pivot = players[0] as EntrantId | null; // null iff odd
  const u0 = players.slice(1); // the n−1 rotating slots

  for (let leg = 1; leg <= legs; leg++) {
    for (let r = 0; r < roundsPerLeg; r++) {
      const roundNo = (leg - 1) * roundsPerLeg + r + 1;
      const u = rotate(u0, r);
      const fixtures: RoundRobinFixture[] = [];
      let bye: EntrantId | undefined;

      // Assemble this round's columns as (top, bottom) pairs. Column 0 involves
      // the pivot; columns 1..half-1 are U-vs-U.
      const columns: { top: EntrantId | null; bottom: EntrantId | null; isPivot: boolean }[] = [];
      columns.push({ top: pivot, bottom: (u[n - 2] ?? null) as EntrantId | null, isPivot: true });
      for (let i = 1; i < half; i++) {
        columns.push({
          top: (u[i - 1] ?? null) as EntrantId | null,
          bottom: (u[n - 2 - i] ?? null) as EntrantId | null,
          isPivot: false,
        });
      }

      // Court rotation: number the real games and offset by the round so the
      // pivot's game does not always land on board 1.
      const k = columns.filter((c) => c.top !== null && c.bottom !== null).length;
      let realSeen = 0;

      for (const col of columns) {
        if (col.top === null || col.bottom === null) {
          // The bye pairing: the non-null side sits out this round.
          bye = (col.top ?? col.bottom) ?? undefined;
          continue;
        }
        // top = home, bottom = away — except the pivot column, which flips by
        // round parity. Leg 2 mirrors: swap every fixture's home/away.
        let home = col.top;
        let away = col.bottom;
        if (col.isPivot && r % 2 === 1) [home, away] = [away, home];
        if (leg % 2 === 0) [home, away] = [away, home]; // even legs mirror (Jul3/08 §2)
        const court = ((realSeen + r) % k) + 1;
        realSeen++;
        const fixture: RoundRobinFixture = {
          id: `rr-r${roundNo}-c${court}`,
          roundNo,
          leg,
          court,
          home,
          away,
        };
        fixtures.push(fixture);
        flat.push(fixture);
      }

      fixtures.sort((a, b) => a.court - b.court);
      rounds.push({ roundNo, leg, fixtures, ...(bye === undefined ? {} : { bye }) });
    }
  }

  return { rounds, fixtures: flat };
}

// Total fixture count for a field of `n` real entrants over `legs` — the
// completeness target n(n−1)/2·legs (spec 05 §2.1).
export function roundRobinFixtureCount(n: number, legs = 1): number {
  if (n < 2) return 0;
  return ((n * (n - 1)) / 2) * legs;
}
