import "server-only";
// Persistence adapter (spec 03 §5) — the only code that knows both the engine
// and Postgres. Everything runs inside withTenant(orgId) so RLS enforces org
// isolation.
export {
  appendEvent,
  fixtureStatusFromFold,
  LOCKED_FIXTURE_STATUSES,
  type AppendInput,
  type AppendResult,
} from "./append-event";
export { hasFrozenCfg, resolveFixtureCfg } from "./fixture-cfg";
export { rebuildState, verifyStateConsistency, type ConsistencyReport } from "./rebuild";
export {
  recomputeStandings,
  completeStageIfReady,
  appendDivisionEvent,
  type CompleteResult,
} from "./competition";
export { resolveModule } from "./registry";
export type { FoldedFixture } from "./fold";
