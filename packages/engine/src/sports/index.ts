// @seazn/engine/sports — the shipped SportModules, aggregated.
//
// The persistence adapter registers these into the shared registry at boot
// (spec 03 §3), and scripts/sync-sports.ts reads them to generate the DB sport
// catalog (sports + system sport_variants). This is the single source of truth
// for "which sports ship in this engine build" — add a module here and both the
// runtime registry and the DB catalog pick it up.
import type { AnySportModule } from "../sport/module.ts";
import type { SportRegistry } from "../sport/registry.ts";
import { football } from "./football/index.ts";
import { cricket } from "./cricket/index.ts";
import { boardgame } from "./boardgame/index.ts";
import { carrom } from "./carrom/index.ts";
import { generic } from "./generic/index.ts";
import { volleyball } from "./setbased/volleyball.ts";
import { badminton } from "./setbased/badminton.ts";
import { tabletennis } from "./setbased/tabletennis.ts";

// Every SportModule the engine ships. Order is not significant.
export const builtinModules: readonly AnySportModule[] = [
  football,
  cricket,
  boardgame,
  carrom,
  generic,
  volleyball,
  badminton,
  tabletennis,
];

// Register all shipped modules into a registry (the adapter calls this once at
// boot with the shared default registry). Idempotent per registry: registering
// the same (key, version) twice throws MODULE_DUPLICATE, so guard callers boot
// exactly once.
export function registerBuiltins(registry: SportRegistry): void {
  for (const module of builtinModules) registry.register(module);
}
