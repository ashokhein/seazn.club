// Register/resolve SportModules by key + version — spec 03 §3 (registry &
// versioning). A division pins module_version at creation; rule changes ship
// as new versions and running divisions keep replaying under the version they
// started with. Old versions stay importable until no live division
// references them.
import { EngineError } from "../core/errors.ts";
import type { AnySportModule } from "./module.ts";

// Tiny local semver — spec 03 §3, PROMPT-03 §2 (no dep). Strict x.y.z; no
// ranges or prerelease tags: a persisted module_version is always exact.
export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(version: string): Semver {
  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new EngineError("CONFIG_INVALID", `"${version}" is not a semver x.y.z version`, {
      version,
    });
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemver(a: string, b: string): number {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  return va.major - vb.major || va.minor - vb.minor || va.patch - vb.patch;
}

export interface SportRegistry {
  register(module: AnySportModule): void;
  get(key: string, version: string): AnySportModule;
  latest(key: string): AnySportModule;
}

export function createRegistry(): SportRegistry {
  const byKey = new Map<string, Map<string, AnySportModule>>();

  return {
    register(module) {
      if (!module.key) {
        throw new EngineError("CONFIG_INVALID", "sport module needs a non-empty key");
      }
      parseSemver(module.version); // throws CONFIG_INVALID on bad versions
      const versions = byKey.get(module.key) ?? new Map<string, AnySportModule>();
      if (versions.has(module.version)) {
        throw new EngineError(
          "MODULE_DUPLICATE",
          `module "${module.key}@${module.version}" is already registered`,
          { key: module.key, version: module.version },
        );
      }
      versions.set(module.version, module);
      byKey.set(module.key, versions);
    },

    get(key, version) {
      const module = byKey.get(key)?.get(version);
      if (!module) {
        throw new EngineError("MODULE_NOT_FOUND", `no sport module "${key}@${version}"`, {
          key,
          version,
        });
      }
      return module;
    },

    latest(key) {
      const versions = byKey.get(key);
      if (!versions || versions.size === 0) {
        throw new EngineError("MODULE_NOT_FOUND", `no sport module "${key}"`, { key });
      }
      let best: AnySportModule | undefined;
      for (const module of versions.values()) {
        if (!best || compareSemver(module.version, best.version) > 0) best = module;
      }
      return best as AnySportModule;
    },
  };
}

// Shared default registry — the persistence adapter registers the shipped
// modules here at boot; tests build their own with createRegistry().
export const registry = createRegistry();
