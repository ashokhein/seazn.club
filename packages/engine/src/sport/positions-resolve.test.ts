// W4 shared-engine item 2 (#407) — PositionCatalog was declared once per
// module, but a lineup is legal or illegal per VARIANT. Two audits hit the same
// wall from opposite sides:
//
//   * football declares a `small-sided` variant while positions.lineup.size is
//     11, and validateLineup compares the starting count exactly — so the
//     variant cannot hold a legal lineup at all;
//   * field hockey and ice hockey force exactly one goalkeeper (GK min 1 max
//     1), so a side that plays out with an empty net — the very situation the
//     `emptyNet` goal kind records — cannot be written down as a lineup.
//
// The fix is additive: `positions` stays exactly as it was, and a module MAY
// add `positionsFor(cfg)`. `resolvePositions` is the one place that decides.
import { describe, expect, it } from "vitest";
import type { Lineup } from "../core/types.ts";
import { builtinModules } from "../sports/index.ts";
import { football } from "../sports/football/index.ts";
import { hockey } from "../sports/hockey/index.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import { lineupFromCatalog } from "../testkit/helpers.ts";
import { resolvePositions, validateLineup, type PositionCatalog } from "./catalog.ts";

const bare: PositionCatalog = { groups: [], lineup: { size: 2 } };

describe("resolvePositions", () => {
  it("falls back to the static catalog when a module declares no positionsFor", () => {
    expect(resolvePositions({ positions: bare }, { anything: true })).toBe(bare);
  });

  it("prefers positionsFor when the module declares one", () => {
    const wide: PositionCatalog = { groups: [], lineup: { size: 5 } };
    const source = { positions: bare, positionsFor: () => wide };
    expect(resolvePositions(source, {})).toBe(wide);
  });

  it("calls positionsFor with the resolved config as its receiver's method", () => {
    const seen: unknown[] = [];
    const source = {
      positions: bare,
      positionsFor(cfg: { size: number }) {
        seen.push(cfg);
        return { groups: [], lineup: { size: cfg.size } };
      },
    };
    expect(resolvePositions(source, { size: 9 }).lineup.size).toBe(9);
    expect(seen).toEqual([{ size: 9 }]);
  });
});

describe("football — a small-sided lineup is smaller than eleven", () => {
  const cfgFor = (raw: unknown) => football.configSchema.parse(raw);

  it("keeps eleven for the default config", () => {
    expect(resolvePositions(football, cfgFor({})).lineup.size).toBe(11);
  });

  it("keeps eleven for the 11-a-side variant", () => {
    expect(resolvePositions(football, cfgFor(football.variants["11-a-side"])).lineup.size).toBe(11);
  });

  it("shrinks the starting lineup for the small-sided variant", () => {
    const catalog = resolvePositions(football, cfgFor(football.variants["small-sided"]));
    expect(catalog.lineup.size).toBeLessThan(11);
  });

  it("accepts a lineup of exactly the small-sided size and rejects an eleven", () => {
    const cfg = cfgFor(football.variants["small-sided"]);
    const catalog = resolvePositions(football, cfg);
    expect(validateLineup(catalog, lineupFromCatalog(catalog, "H"))).toEqual([]);

    const eleven = lineupFromCatalog(resolvePositions(football, cfgFor({})), "H");
    expect(validateLineup(catalog, eleven)).toContainEqual({
      kind: "starting_size",
      expected: catalog.lineup.size,
      actual: 11,
    });
  });

  it("leaves the static positions property untouched", () => {
    // Back-compat: apps/web still reads `module.positions` directly.
    expect(football.positions.lineup.size).toBe(11);
  });
});

// FIH says "GK", IIHF says "G" — the keeper vocabulary belongs to the sport,
// so the kernel must never hard-code a group key.
const KEEPERS: [typeof hockey, string, string][] = [
  [hockey, "GK", "DF"],
  [icehockey, "G", "D"],
];

describe("hockey and ice hockey — a side may take the field without a keeper", () => {
  for (const [module, gk, outfield] of KEEPERS) {
    const keeperless = (catalog: PositionCatalog): Lineup => ({
      entrantId: "H",
      slots: Array.from({ length: catalog.lineup.size }, (_, i) => ({
        personId: `H-p${i + 1}`,
        positionKey: outfield,
        slot: "starting" as const,
        orderNo: i + 1,
        ...(i === 0 ? { roles: ["captain"] } : {}),
      })),
    });

    describe(module.key, () => {
      it("still requires a goalkeeper by default", () => {
        const catalog = resolvePositions(module, module.configSchema.parse({}));
        expect(catalog.groups.find((g) => g.key === gk)?.min).toBe(1);
        expect(validateLineup(catalog, keeperless(catalog))).toContainEqual({
          kind: "group_min",
          groupKey: gk,
          min: 1,
          actual: 0,
        });
      });

      it("accepts a keeperless lineup once the competition makes the keeper optional", () => {
        const cfg = module.configSchema.parse({ goalkeeper: "optional" });
        const catalog = resolvePositions(module, cfg);
        expect(catalog.groups.find((g) => g.key === gk)?.min).toBe(0);
        expect(catalog.groups.find((g) => g.key === gk)?.max).toBe(1);
        expect(validateLineup(catalog, keeperless(catalog))).toEqual([]);
      });

      it("still refuses two keepers when the keeper is optional", () => {
        const cfg = module.configSchema.parse({ goalkeeper: "optional" });
        const catalog = resolvePositions(module, cfg);
        const two = keeperless(catalog);
        const slots = two.slots.map((s, i) => (i < 2 ? { ...s, positionKey: gk } : s));
        expect(validateLineup(catalog, { ...two, slots })).toContainEqual({
          kind: "group_max",
          groupKey: gk,
          max: 1,
          actual: 2,
        });
      });

      it("leaves the static positions property untouched", () => {
        expect(module.positions.groups.find((g) => g.key === gk)?.min).toBe(1);
      });
    });
  }
});

// Coherence guard for every catalog the engine can now resolve: a variant that
// no lineup can satisfy is exactly the defect this item fixes, so no module may
// ship one — today or after the next preset lands.
describe("every builtin variant resolves to a satisfiable catalog", () => {
  for (const module of builtinModules) {
    const raws: [string, unknown][] = [["default", {}], ...Object.entries(module.variants)];
    for (const [name, raw] of raws) {
      it(`${module.key}/${name}`, () => {
        let cfg: unknown;
        try {
          cfg = module.configSchema.parse(raw);
        } catch (error) {
          // W4 review item 7 — a bare `catch { return; }` here made this test
          // pass SILENTLY for any module whose variant config stopped parsing,
          // which is the loudest thing a config change can do. Exactly one
          // config in the engine is legitimately unparseable: `generic` has no
          // valid empty object (its variants carry the required resultMode),
          // and its own named variants are checked below. Anything else is a
          // broken preset and must fail here.
          expect(
            `${module.key}/${name}`,
            `config does not parse: ${String(error)}`,
          ).toBe("generic/default");
          return;
        }
        const catalog = resolvePositions(module, cfg);
        expect(validateLineup(catalog, lineupFromCatalog(catalog, "H"))).toEqual([]);
      });
    }
  }
});
