// RED STEP ONLY — the status quo: auto-schedule as it ships today.
//
// Deliberately implements greedy and nothing else, so every test that claims
// the solver improves on greedy fails for the RIGHT reason (a real board that
// is not good enough) rather than as a module-resolution error, which vitest
// reports as a collection failure and which reads as a clean skip.
import { boardMetrics, type BoardMetrics } from "./build-objectives.ts";
import {
  slotFixtures,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
} from "./calendar.ts";

export const DEFAULT_BUILD_RLIMIT = 40_000_000;
export const DEFAULT_BUILD_WALL_MS = 30_000;

export type BuildStatus =
  | "ok"
  | "already_optimal"
  | "infeasible"
  | "verifier_rejected"
  | "z3_unavailable"
  | "solver_busy";

export interface BuildInput {
  fixtures: readonly SchedulableFixture[];
  config: SlotConfig & { courts: string[] };
  existing?: readonly Assignment[];
  dependencies?: readonly OrderDependency[];
  frozen?: readonly string[];
  rlimit?: number;
  wallMs?: number;
  mode?: "build" | "polish";
}

export interface BuildResult {
  assignments: readonly Assignment[];
  conflicts: readonly Conflict[];
  metrics: BoardMetrics;
  engine: "greedy" | "z3" | "z3+lns";
  status: BuildStatus;
  tiersCompleted: number;
  budgetExpired: boolean;
  elapsedMs: number;
  moved: number;
}

export function buildSchedule(input: BuildInput): Promise<BuildResult> {
  const t0 = performance.now();
  const seed = slotFixtures({
    fixtures: input.fixtures,
    config: input.config,
    existing: input.existing,
  });
  return Promise.resolve({
    assignments: seed.assignments,
    conflicts: seed.conflicts,
    metrics: boardMetrics(seed.assignments, input.config.courts, input.fixtures.length),
    engine: "greedy",
    status: "ok",
    tiersCompleted: 0,
    budgetExpired: false,
    elapsedMs: performance.now() - t0,
    moved: 0,
  });
}
