// Set-based kernel + presets (volleyball / badminton / table-tennis) — spec 04
// §3–5 + engine/sports/{volleyball,badminton,table-tennis}.md. One parametric
// rally/set engine, three thin presets (PROMPT-06).
export {
  makeSetBasedModule,
  SetBasedRally,
  SetBasedSummary,
  SetSummaryPositional,
  SetSummaryByEntrant,
  SetBasedEv,
  PointsPair,
  type SetBasedCfg,
  type SetBasedParams,
  type SetBasedPreset,
  type SetBasedState,
  type SetState,
} from "./kernel.ts";
export { volleyball } from "./volleyball.ts";
export { badminton } from "./badminton.ts";
export { tabletennis } from "./tabletennis.ts";
