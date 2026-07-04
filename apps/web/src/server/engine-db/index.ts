import "server-only";
// Persistence adapter (spec 03 §5) — the only code that knows both the engine
// and Postgres. Everything runs inside withTenant(orgId) so RLS enforces org
// isolation.
export { appendEvent, type AppendInput, type AppendResult } from "./append-event";
export { rebuildState, verifyStateConsistency, type ConsistencyReport } from "./rebuild";
export {
  recomputeStandings,
  completeStageIfReady,
  type CompleteResult,
} from "./competition";
export { resolveModule } from "./registry";
export type { FoldedFixture } from "./fold";
