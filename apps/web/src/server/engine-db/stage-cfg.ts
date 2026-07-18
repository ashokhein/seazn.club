import "server-only";

// PROMPT-61 §2 — stage-scoped decider overlay. A groups+knockout division
// keeps one sport config, but the knockout STAGE may carry `shootout` /
// `extraTime`; those two keys (and only those) overlay the division config for
// fixtures in that stage — the same overlay philosophy competition.ts applies
// for points/rngSeed/rounds. Identity when the stage sets neither key, so the
// fold sites can pass the result unconditionally.
const STAGE_DECIDER_KEYS = ["shootout", "extraTime"] as const;

export function stageScopedCfg(
  divisionCfg: unknown,
  stageCfg: Record<string, unknown> | null | undefined,
): unknown {
  if (stageCfg == null) return divisionCfg;
  const overlay: Record<string, unknown> = {};
  for (const key of STAGE_DECIDER_KEYS) {
    if (stageCfg[key] !== undefined) overlay[key] = stageCfg[key];
  }
  if (Object.keys(overlay).length === 0) return divisionCfg;
  return { ...(divisionCfg as Record<string, unknown>), ...overlay };
}
