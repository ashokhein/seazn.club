import "server-only";
// Registry boot — the persistence adapter registers every shipped SportModule
// into the engine's shared default registry once, at first use (spec 03 §3).
// A division pins its module version at creation; the adapter resolves that
// exact (sport_key, module_version) so a running division always replays under
// the version it started with.
import { EngineError } from "@seazn/engine/core";
import { registry, type AnySportModule } from "@seazn/engine/sport";
import { registerBuiltins } from "@seazn/engine/sports";

let booted = false;

function bootRegistry(): typeof registry {
  if (booted) return registry;
  try {
    registerBuiltins(registry);
  } catch (err) {
    // Tolerate a module already registered by another boot path — only that is
    // benign; any other registry error is a real bug.
    if (!EngineError.is(err, "MODULE_DUPLICATE")) throw err;
  }
  booted = true;
  return registry;
}

// Resolve the pinned module for a division (sport_key + module_version).
export function resolveModule(sportKey: string, moduleVersion: string): AnySportModule {
  return bootRegistry().get(sportKey, moduleVersion);
}
