// Shared player-stat labelling (PROMPT-65 → /me reuse): a snapshot's raw
// counters become display rows via the sport module's DECLARED playerStats
// model — metrics, derived, then awards (suffixed _awards in snapshots) —
// never hardcoded labels. Zero-valued rows are dropped; a retired module
// build yields [] so callers skip the block instead of breaking the page.
import { resolveModule } from "@/server/engine-db";

export interface LabelledPlayerStat {
  key: string;
  label: string;
  value: number;
}

export function labelPlayerStats(
  sportKey: string,
  moduleVersion: string,
  stats: Record<string, number>,
): LabelledPlayerStat[] {
  try {
    const model = resolveModule(sportKey, moduleVersion).playerStats;
    return [
      ...(model?.metrics ?? []).map((m) => ({ key: m.key, label: m.label })),
      ...(model?.derived ?? []).map((d) => ({ key: d.key, label: d.label })),
      ...(model?.awards ?? []).map((a) => ({ key: `${a.key}_awards`, label: a.label })),
    ]
      .map((m) => ({ ...m, value: stats[m.key] ?? 0 }))
      .filter((m) => m.value !== 0);
  } catch {
    return [];
  }
}
