// Player statistics fold (Jul3/07 §3) — another disposable projection of the
// score-event ledger, like match_states and standings_snapshots. Pure and
// deterministic; voided events (and their assists) never count.
import { resolveVoids, type EventEnvelope } from "../core/events.ts";

// Sport-declared stat model — the plugin mirror of the position catalog.
export interface PlayerStatMetric {
  key: string; // 'goals'
  label: string; // 'Goals'
  from: string; // event type: 'football.goal'
  /** Payload field carrying the person id (default 'person'). */
  field?: string;
  agg: "count" | "sum";
  /** For agg:'sum' — the payload field holding the numeric value. */
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
      const person = payload[metric.field ?? "person"];
      if (typeof person !== "string" || person === "") continue;
      if (metric.agg === "count") {
        bump(person, metric.key, 1);
      } else {
        const value = payload[metric.sumField ?? "value"];
        if (typeof value === "number") bump(person, metric.key, value);
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
