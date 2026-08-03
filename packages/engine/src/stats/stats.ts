// Player statistics fold (Jul3/07 §3) — another disposable projection of the
// score-event ledger, like match_states and standings_snapshots. Pure and
// deterministic; voided events (and their assists) never count.
import { resolveVoids, type EventEnvelope } from "../core/events.ts";

/**
 * Resolve a payload path — a plain dotted walk through objects, so a metric can
 * name a nested credit (`"runs.bat"` for the striker, `"wicket.fielder"` for
 * the catcher). Deliberately NOT a query language: no array indexing, no
 * wildcards, no predicates.
 *
 * Three rules make it safe against real scoring payloads:
 *
 * 1. **A path that does not resolve returns `undefined`, never a throw.**
 *    Payloads are heterogeneous by design — `wicket` is absent on every ball
 *    that is not a dismissal — so a missing path is the normal case, not an
 *    error. Walking through `undefined`, `null` or a scalar all land here.
 * 2. **A literal key wins over the walk**, at every step. That is what keeps
 *    every pre-existing single-segment lookup (`"scorer"`, `"person"`) byte-for
 *    -byte identical, and it also makes a payload key that genuinely contains a
 *    dot reachable rather than shadowed.
 * 3. **Arrays are a leaf, not a step.** A resolved array still credits every
 *    person in it (ice hockey's two assists — see below), but a path may not
 *    index into one. An empty segment resolves to nothing rather than to the
 *    object it was written on, so a typo can never credit a whole record.
 */
export function resolvePayloadPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  let rest = path;
  for (;;) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    const obj = cursor as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, rest)) return obj[rest];
    const dot = rest.indexOf(".");
    if (dot <= 0) return undefined; // no separator left, or an empty leading segment
    cursor = obj[rest.slice(0, dot)];
    rest = rest.slice(dot + 1);
  }
}

// Sport-declared stat model — the plugin mirror of the position catalog.
export interface PlayerStatMetric {
  key: string; // 'goals'
  label: string; // 'Goals'
  from: string; // event type: 'football.goal'
  /** Payload path carrying the person id (default 'person'). Dotted paths walk
   *  into nested objects: `'wicket.fielder'`. */
  field?: string;
  agg: "count" | "sum";
  /** For agg:'sum' — the payload path holding the numeric value, dotted like
   *  `field` (`'runs.bat'`). */
  sumField?: string;
  /** Extra payload predicate (e.g. skip own goals, filter card colour). */
  when?: (payload: Record<string, unknown>) => boolean;
}

export interface PlayerStatDerive {
  key: string;
  label: string;
  derive: (stats: Record<string, number>) => number; // points = goals + assists
}

export interface PlayerAwardSpec {
  key: string; // 'motm'
  label: string; // 'Man of the Match'
}

export interface PlayerStatsModel {
  metrics: PlayerStatMetric[];
  derived?: PlayerStatDerive[];
  awards?: PlayerAwardSpec[];
}

export interface PlayerStatRow {
  personId: string;
  stats: Record<string, number>;
}

/**
 * Fold one fixture's event ledger into per-person stat contributions
 * (Jul3/07 §3). `core.void` drops the voided event entirely — a voided goal
 * takes its assist with it (§8). Deterministic: rows come back sorted by
 * personId.
 */
export function aggregatePlayerStats(
  events: readonly EventEnvelope[],
  model: PlayerStatsModel,
): PlayerStatRow[] {
  const active = resolveVoids([...events]);
  const rows = new Map<string, Record<string, number>>();
  const bump = (personId: string, key: string, by: number) => {
    const stats = rows.get(personId) ?? {};
    stats[key] = (stats[key] ?? 0) + by;
    rows.set(personId, stats);
  };

  for (const event of active) {
    const payload = event.payload as Record<string, unknown>;
    for (const metric of model.metrics) {
      if (event.type !== metric.from) continue;
      if (metric.when !== undefined && !metric.when(payload)) continue;
      const person = resolvePayloadPath(payload, metric.field ?? "person");
      // An array field credits every listed person once (ice-hockey assists:
      // up to two per goal, each worth one assist — v6/00 §3).
      const persons = Array.isArray(person)
        ? person.filter((p): p is string => typeof p === "string" && p !== "")
        : typeof person === "string" && person !== ""
          ? [person]
          : [];
      if (persons.length === 0) continue;
      if (metric.agg === "count") {
        for (const p of persons) bump(p, metric.key, 1);
      } else {
        const value = resolvePayloadPath(payload, metric.sumField ?? "value");
        if (typeof value === "number") for (const p of persons) bump(p, metric.key, value);
      }
    }
    if (event.type === "core.award") {
      const person = payload.person;
      const key = payload.key;
      if (typeof person === "string" && typeof key === "string") {
        const spec = (model.awards ?? []).find((a) => a.key === key);
        if (spec !== undefined) bump(person, `${key}_awards`, 1);
      }
    }
  }

  for (const [, stats] of rows) {
    for (const d of model.derived ?? []) {
      stats[d.key] = d.derive(stats);
    }
  }
  return [...rows.entries()]
    .map(([personId, stats]) => ({ personId, stats }))
    .sort((a, b) => a.personId.localeCompare(b.personId));
}

/** Sum per-fixture rows into a division table (addition is commutative — the
 *  fold is order-independent, same discipline as standings). */
export function sumPlayerStats(
  perFixture: readonly PlayerStatRow[][],
  model: PlayerStatsModel,
): PlayerStatRow[] {
  const rows = new Map<string, Record<string, number>>();
  for (const fixture of perFixture) {
    for (const row of fixture) {
      const stats = rows.get(row.personId) ?? {};
      for (const [key, value] of Object.entries(row.stats)) {
        if ((model.derived ?? []).some((d) => d.key === key)) continue; // re-derived below
        stats[key] = (stats[key] ?? 0) + value;
      }
      rows.set(row.personId, stats);
    }
  }
  for (const [, stats] of rows) {
    for (const d of model.derived ?? []) stats[d.key] = d.derive(stats);
  }
  return [...rows.entries()]
    .map(([personId, stats]) => ({ personId, stats }))
    .sort((a, b) => a.personId.localeCompare(b.personId));
}
