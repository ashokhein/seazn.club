// Shared player-stat labelling (PROMPT-65 → /me reuse): a snapshot's raw
// counters become display rows via the sport module's DECLARED playerStats
// model — metrics, derived, then awards (suffixed _awards in snapshots) —
// never hardcoded labels. Zero-valued rows are dropped; a retired module
// build yields [] so callers skip the block instead of breaking the page.
//
// The module's DECLARED label is English, and that is the whole reason this
// helper takes a translator: the public player page and /me have never LOOKED
// unlocalized, because "Goals" and "Balls faced" always rendered. `m` is
// REQUIRED — an optional one would let a new caller silently ship English —
// and it resolves per-sport copy (`stat.<sportKey>.<metricKey>`), falling back
// to the module's own label for a metric this app has no key for yet.
import { resolveModule } from "@/server/engine-db";
import { playerStatLabel, type MsgFn } from "@/lib/scoring-vocab";

export interface LabelledPlayerStat {
  key: string;
  label: string;
  value: number;
}

export function labelPlayerStats(
  sportKey: string,
  moduleVersion: string,
  stats: Record<string, number>,
  m: MsgFn,
): LabelledPlayerStat[] {
  try {
    const model = resolveModule(sportKey, moduleVersion).playerStats;
    const declared = [
      ...(model?.metrics ?? []).map((x) => ({ key: x.key, label: x.label })),
      ...(model?.derived ?? []).map((d) => ({ key: d.key, label: d.label })),
      ...(model?.awards ?? []).map((a) => ({ key: `${a.key}_awards`, label: a.label })),
    ];
    // `metrics` is an AGGREGATION spec, not a display list: a module may declare
    // one key several times to credit it from several payload fields, and
    // `aggregatePlayerStats` folds them all into that single counter (boardgame
    // credits `games` from both `homePerson` and `awayPerson`). Emitting a row
    // per DECLARATION therefore renders the same counter twice under the same
    // key — and the player pages use `key` as their React key, so row identity
    // goes ambiguous the moment a list reorders or animates. One row per key,
    // first declaration wins so declared order is what renders.
    const seen = new Set<string>();
    return declared
      .filter((x) => !seen.has(x.key) && (seen.add(x.key), true))
      .map((x) => ({
        key: x.key,
        label: playerStatLabel(sportKey, x.key, m, x.label),
        value: stats[x.key] ?? 0,
      }))
      .filter((x) => x.value !== 0);
  } catch {
    return [];
  }
}
