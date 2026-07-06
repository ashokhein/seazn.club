// Sourcing resolver (Jul3/02 §3, ideas 3 Jun / 17 Jun) — pure: turns
// standings/outcomes into officiating entrants for the next phase. A source
// resolves ONLY once its stage/pool or fixture is decided — that is what lets
// the console offer "assign Phase 1 now, Phase 2 when Phase 1 finishes"
// instead of greying the button out.
import type { OfficialSourcing, SourcingResult, SourcingSnapshot } from "./types.ts";

export function resolveOfficialSourcing(
  sources: readonly OfficialSourcing[],
  snapshot: SourcingSnapshot,
): SourcingResult {
  const withdrawn = new Set(snapshot.withdrawnEntrantIds ?? []);
  const resolved: SourcingResult["resolved"] = [];
  const pending: SourcingResult["pending"] = [];

  for (const source of sources) {
    if (source.kind === "result") {
      const fixture = snapshot.fixtures.find((f) => f.id === source.fromFixture);
      if (!fixture) {
        pending.push({ source, reason: "fixture not found" });
        continue;
      }
      if (!fixture.decided) {
        pending.push({ source, reason: "fixture not decided yet" });
        continue;
      }
      const entrantId = source.side === "winner" ? fixture.winnerId : fixture.loserId;
      if (!entrantId) {
        pending.push({ source, reason: `fixture has no ${source.side} (draw/no-result)` });
        continue;
      }
      if (withdrawn.has(entrantId)) {
        // Jul3/02 §6: eliminated/withdrawn teams drop from the pool.
        pending.push({ source, reason: "entrant withdrawn" });
        continue;
      }
      resolved.push({ entrantId, source });
      continue;
    }

    // rank sourcing: "4th in group G refs game X" (3 Jun)
    for (const take of source.take) {
      const table = snapshot.standings.find(
        (s) =>
          s.stageId === source.fromStage &&
          (take.poolId === undefined ? s.poolId === undefined : s.poolId === take.poolId),
      );
      const single = { kind: "rank" as const, fromStage: source.fromStage, take: [take] };
      if (!table) {
        pending.push({ source: single, reason: "standings not found" });
        continue;
      }
      if (!table.decided) {
        pending.push({ source: single, reason: "stage not decided yet" });
        continue;
      }
      const row = table.rows.find((r) => r.rank === take.rank);
      if (!row) {
        pending.push({ source: single, reason: `no rank ${take.rank} in the table` });
        continue;
      }
      if (withdrawn.has(row.entrantId)) {
        pending.push({ source: single, reason: "entrant withdrawn" });
        continue;
      }
      resolved.push({ entrantId: row.entrantId, source: single });
    }
  }
  return { resolved, pending };
}
