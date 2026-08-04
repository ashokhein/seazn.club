// Synthetic scale boards for the repair bench and the termination test (#401).
//
// NOT a payload fixture. `payload-fixtures.ts` holds the two real payloads this
// programme is frozen against, and byte-identity is the point of that file.
// This one is the opposite: a GENERATED board whose only contract is that the
// same seed and size produce the same board, so a measured solve time is
// reproducible and a termination test is not measuring a different board every
// run.
//
// Shape, chosen so the cost it measures is the cost production pays:
//
//   * 4 courts, 10 slots a day on a 50-minute pitch (40-minute matches, a
//     5-minute court gap), so 40 fixtures a day and `ceil(n/40)` days.
//   * An explicit pack window AND one session window per day. Both are what the
//     AI runner actually passes; a board with neither measures an encoding
//     nobody runs.
//   * Entrants repeat within a day (each plays twice, 250 minutes apart) and
//     across days, so the O(n²) pair loop carries real `person`/`rest`
//     assertions rather than degenerating into `court` alone.
//   * Feed chains of 4 down each court (slots 0, 2, 4, 6 — 100 minutes apart,
//     clear of the 85 minutes a feeder owes its dependent).
//
// The clean baseline verifies with zero conflicts; every conflict on the board
// is one this file injected on purpose, and each injected clash is repairable
// by moving exactly one card. That is what makes `k` a knob rather than a
// surprise.
//
// Deliberately absent: `hard` instruction rules. `max_fixtures_per_day` has a
// live encoder bug under review, and the placement rules are relaxable families
// which — spans being blocking-only — cannot prune a pair either. They add
// assertions without changing the O(n²) shape the bench exists to measure.
import { mulberry32 } from "../core/rng.ts";
import type { Assignment, OrderDependency, VerifyConfig } from "./calendar.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const BENCH_COURTS = ["C1", "C2", "C3", "C4"] as const;
const COURTS = BENCH_COURTS.length;
const SLOTS_PER_DAY = 10;
const PER_DAY = COURTS * SLOTS_PER_DAY;
const MATCH_MIN = 40;
const GAP_MIN = 5;
const REST_MIN = 45;
/** 50 > 40 + 5, so consecutive cards on one court are clear of the court gap by
 *  five whole minutes. An exactly-touching pitch would make every measurement
 *  hostage to whether the verifier's overlap test is strict or inclusive. */
const PITCH_MIN = 50;
const OPEN_MS = 8 * HOUR;
const CLOSE_MS = 20 * HOUR;
/** A Monday, so a weekday-scoped rule added later reads the way it looks. */
const EPOCH = Date.parse("2026-09-07T00:00:00Z");
/** One chain of four per court. The other six slots stay clash-injectable:
 *  moving a card that feeds another turns one injected clash into a cascade,
 *  and then `k` no longer counts what was injected. */
const CHAIN_SLOTS = [0, 2, 4, 6] as const;
/** Entrants in rotation within a day. 20 with 8 entrant-slots per time slot
 *  puts every repeat at least two slots (100 minutes) apart, clear of the 85 a
 *  40-minute match plus 45 minutes' rest demands. */
const DAY_POOL = 20;

export interface SyntheticBoardOptions {
  /** Movable fixtures. */
  n: number;
  /** One clash injected per this many fixtures. Lower is denser. */
  clashEvery: number;
  seed?: number;
}

export interface SyntheticBoard {
  proposal: Assignment[];
  dependencies: OrderDependency[];
  config: VerifyConfig & { courts: readonly string[] };
  /** How many clashes were injected — the floor on a minimal repair's `k`. */
  clashes: number;
  days: number;
}

const idOf = (f: number): string => `f${String(f).padStart(4, "0")}`;
const entrantOf = (e: number): string => `e${String(e).padStart(3, "0")}`;

/**
 * A deterministic board of `n` movable fixtures with `floor(n / clashEvery)`
 * injected court clashes. Same options in, byte-identical board out.
 */
export function syntheticBoard(opts: SyntheticBoardOptions): SyntheticBoard {
  const { n, clashEvery } = opts;
  const days = Math.ceil(n / PER_DAY);
  const rng = mulberry32(opts.seed ?? 20_260_803);
  const poolSize = Math.max(DAY_POOL, Math.ceil(n / 6));

  const slotOf = (f: number): { day: number; slot: number; court: number } => {
    const day = Math.floor(f / PER_DAY);
    const i = f % PER_DAY;
    return { day, slot: Math.floor(i / COURTS), court: i % COURTS };
  };
  const startOf = (day: number, slot: number): number =>
    EPOCH + day * DAY + OPEN_MS + slot * PITCH_MIN * MIN;

  const proposal: Assignment[] = [];
  for (let f = 0; f < n; f++) {
    const { day, slot, court } = slotOf(f);
    // The day's pool rotates by a stride coprime with most pool sizes, so
    // consecutive days share some entrants without repeating a whole day.
    const ent = (t: number): string =>
      entrantOf((day * 13 + ((slot * 8 + 2 * court + t) % DAY_POOL)) % poolSize);
    const entrants = [ent(0), ent(1)];
    const startAt = startOf(day, slot);
    proposal.push({
      fixtureId: idOf(f),
      court: BENCH_COURTS[court]!,
      startAt,
      endAt: startAt + MATCH_MIN * MIN,
      entrants,
      people: entrants.map((e) => `p-${e}`),
    });
  }

  const dependencies: OrderDependency[] = [];
  for (let day = 0; day < days; day++) {
    for (let court = 0; court < COURTS; court++) {
      const chain = CHAIN_SLOTS.map((slot) => day * PER_DAY + slot * COURTS + court).filter(
        (f) => f < n,
      );
      for (let t = 1; t < chain.length; t++) {
        dependencies.push({ fixtureId: idOf(chain[t]!), dependsOn: idOf(chain[t - 1]!), direct: true });
      }
    }
  }

  // --- injected clashes ------------------------------------------------------
  // Each clash drops one chain-free card onto another chain-free card's court
  // and time, in the same day. Both ends are chain-free, so exactly one move
  // clears it and the injected count is the floor on the repair's `k`.
  const chainSet = new Set<number>(CHAIN_SLOTS);
  const queues: number[][] = [];
  for (let day = 0; day < days; day++) {
    const free: number[] = [];
    for (let i = 0; i < PER_DAY; i++) {
      const f = day * PER_DAY + i;
      if (f >= n) break;
      if (!chainSet.has(Math.floor(i / COURTS))) free.push(f);
    }
    // Seeded Fisher-Yates rather than `shuffle()` so one rng stream drives the
    // whole board and the day order is part of the seed.
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [free[i], free[j]] = [free[j]!, free[i]!];
    }
    queues.push(free);
  }

  const clashes = Math.floor(n / clashEvery);
  const byId = new Map(proposal.map((a) => [a.fixtureId, a]));
  let injected = 0;
  for (let c = 0; c < clashes; c++) {
    // The day with the most room left, ties to the earliest day: a short final
    // day would otherwise run dry and silently under-inject.
    let best = -1;
    for (let day = 0; day < days; day++) {
      if (queues[day]!.length >= 2 && (best === -1 || queues[day]!.length > queues[best]!.length)) {
        best = day;
      }
    }
    if (best === -1) break;
    const mover = byId.get(idOf(queues[best]!.pop()!))!;
    const target = byId.get(idOf(queues[best]!.pop()!))!;
    mover.court = target.court;
    mover.startAt = target.startAt;
    mover.endAt = target.endAt;
    injected++;
  }

  const config: VerifyConfig & { courts: readonly string[] } = {
    matchMinutes: MATCH_MIN,
    gapMinutes: GAP_MIN,
    perEntrantMinRest: REST_MIN,
    blackouts: [],
    sessionWindows: Array.from({ length: days }, (_, day) => ({
      from: EPOCH + day * DAY + OPEN_MS,
      to: EPOCH + day * DAY + CLOSE_MS,
    })),
    tz: "UTC",
    window: { from: EPOCH + OPEN_MS, to: EPOCH + (days - 1) * DAY + CLOSE_MS },
    courts: [...BENCH_COURTS],
  };

  return { proposal, dependencies, config, clashes: injected, days };
}
