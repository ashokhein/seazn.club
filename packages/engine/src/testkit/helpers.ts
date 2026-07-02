// Deterministic builders for module tests — spec 03 §6 (ids/time injected:
// `e-${n}` ids, fixed instant, seeded rng; never wall time).
import type { CoreEv, EventEnvelope } from "../core/events.ts";
import { mulberry32 } from "../core/rng.ts";
import type { Lineup, LineupPair, LineupSlot } from "../core/types.ts";
import type { PositionCatalog } from "../sport/catalog.ts";
import type { ModuleEvent, SportModule } from "../sport/module.ts";

export const TEST_INSTANT = "2026-01-01T00:00:00.000Z";

export function makeEnvelope(seq: number, event: ModuleEvent, voids?: string): EventEnvelope {
  return {
    id: `e-${seq}`,
    fixtureId: "fx-testkit",
    seq,
    type: event.type,
    payload: event.payload,
    recordedAt: TEST_INSTANT,
    recordedBy: "testkit",
    ...(voids === undefined ? {} : { voids }),
  };
}

// Builds a minimal catalog-valid starting lineup: group minimums first, then
// round-robin padding within group maximums; every declared role assigned to
// one distinct starting slot (satisfies unique + required).
export function lineupFromCatalog(catalog: PositionCatalog, entrantId: string): Lineup {
  const positions: (string | undefined)[] = [];
  for (const group of catalog.groups) {
    for (let i = 0; i < (group.min ?? 0); i++) positions.push(group.key);
  }
  const counts = new Map<string, number>(
    catalog.groups.map((group) => [group.key, group.min ?? 0]),
  );
  let cursor = 0;
  while (positions.length < catalog.lineup.size) {
    if (catalog.groups.length === 0) {
      positions.push(undefined);
      continue;
    }
    const group = catalog.groups[cursor % catalog.groups.length];
    cursor++;
    if (!group) break;
    const used = counts.get(group.key) ?? 0;
    if (group.max !== undefined && used >= group.max) continue;
    counts.set(group.key, used + 1);
    positions.push(group.key);
  }

  const roles = catalog.roles ?? [];
  const slots: LineupSlot[] = positions.slice(0, catalog.lineup.size).map((positionKey, i) => {
    const role = roles[i];
    return {
      personId: `${entrantId}-p${i + 1}`,
      ...(positionKey === undefined ? {} : { positionKey }),
      slot: "starting" as const,
      orderNo: i + 1,
      ...(role === undefined ? {} : { roles: [role.key] }),
    };
  });
  return { entrantId, slots };
}

export function defaultLineupPair(catalog: PositionCatalog): LineupPair {
  return {
    home: lineupFromCatalog(catalog, "H"),
    away: lineupFromCatalog(catalog, "A"),
  };
}

// Grows a valid event stream by walking the module's arbitraryEvent generator
// (spec 03 §6) from a single seed. Streams may end undecided (seed budget
// exhausted) — conformance invariants must hold on those too.
export function buildStream<Cfg, Ev, State>(
  module: SportModule<Cfg, Ev, State>,
  cfg: Cfg,
  lineups: LineupPair,
  seed: number,
  maxEvents: number,
): EventEnvelope[] {
  const generate = module.arbitraryEvent;
  if (!generate) {
    throw new Error(`module "${module.key}" does not implement arbitraryEvent`);
  }
  const rng = mulberry32(seed);
  let state = module.init(cfg, lineups);
  const events: EventEnvelope[] = [];
  for (let i = 0; i < maxEvents; i++) {
    const next = generate.call(module, state, rng);
    if (!next) break;
    const envelope = makeEnvelope(events.length, next);
    state = module.apply(state, envelope as EventEnvelope<Ev | CoreEv>);
    events.push(envelope);
  }
  return events;
}
