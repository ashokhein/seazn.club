import { describe, expect, it, vi } from "vitest";
import type { Assignment, VerifyConfig } from "./calendar.ts";

/**
 * NOTHING is imported statically from `./repair.ts` or `./z3-load.ts` here, and
 * that is load-bearing.
 *
 * `packages/engine/vitest.config.ts` sets `isolate: false`, so `vi.resetModules()`
 * clears the module registry for the WHOLE worker. A binding taken before a
 * reset and one taken after are two different `z3-load.ts` instances, each with
 * its own `loaded` singleton and its own `count`. Mixing them gives two WASM
 * instances in one worker — the first orphaned, never shut down, and enough to
 * hang vitest at exit — and makes a `z3LoadCount()` assertion read the wrong
 * counter, so "z3 never loaded" can pass vacuously.
 *
 * Every test below therefore resets, imports everything it touches on the far
 * side of that reset, and shuts down its own instance in a `finally`.
 */
async function isolated<T>(
  body: (mods: {
    repair: typeof import("./repair.ts");
    z3: typeof import("./z3-load.ts");
    fixtures: typeof import("./payload-fixtures.ts");
  }) => Promise<T>,
  mock?: () => void,
): Promise<T> {
  vi.resetModules();
  mock?.();
  const z3 = await import("./z3-load.ts");
  try {
    return await body({
      repair: await import("./repair.ts"),
      z3,
      fixtures: await import("./payload-fixtures.ts"),
    });
  } finally {
    await z3.resetZ3();
    vi.doUnmock("./calendar.ts");
    vi.resetModules();
  }
}

function clashed(fixtures: typeof import("./payload-fixtures.ts")): Assignment[] {
  const golden = fixtures.goldenBadminton();
  const first = golden[0]!;
  return golden.map((a) =>
    a.fixtureId === "gf" ? { ...a, court: first.court, startAt: first.startAt, endAt: first.endAt } : a,
  );
}

function configFor(fixtures: typeof import("./payload-fixtures.ts")): VerifyConfig & {
  courts: readonly string[];
} {
  return {
    ...fixtures.BASE_CONFIG,
    tz: "UTC",
    window: { from: fixtures.at("2026-08-10T08:00:00Z"), to: fixtures.at("2026-08-17T08:00:00Z") },
    courts: ["C1", "C2"],
  };
}

const SOLVE_TIMEOUT = 120_000;

describe("repairAndVerify", () => {
  it(
    "throws when a 'repaired' schedule fails its own verifier",
    async () => {
      await isolated(
        async ({ repair, fixtures }) => {
          await expect(
            repair.repairAndVerify({
              proposal: clashed(fixtures),
              dependencies: fixtures.badmintonFeedDeps(),
              config: configFor(fixtures),
              budgetMs: 60_000,
            }),
          ).rejects.toBeInstanceOf(repair.RepairVerificationError);
        },
        () => {
          vi.doMock("./calendar.ts", async () => {
            const actual = await vi.importActual<typeof import("./calendar.ts")>("./calendar.ts");
            let call = 0;
            return {
              ...actual,
              // First call (the pre-check) reports the clash so repair runs; the
              // post-repair call lies and still reports one.
              validateAssignments: (...args: Parameters<typeof actual.validateAssignments>) => {
                call++;
                return call === 1
                  ? actual.validateAssignments(...args)
                  : [{ fixtureId: "gf", reason: "court" as const, detail: "phantom" }];
              },
            };
          });
        },
      );
    },
    SOLVE_TIMEOUT,
  );

  it(
    "carries the conflicts and the result it refused",
    async () => {
      await isolated(
        async ({ repair, fixtures }) => {
          const err = await repair
            .repairAndVerify({
              proposal: clashed(fixtures),
              dependencies: fixtures.badmintonFeedDeps(),
              config: configFor(fixtures),
              budgetMs: 60_000,
            })
            .then(
              () => null,
              (e: unknown) => e as InstanceType<typeof repair.RepairVerificationError>,
            );
          expect(err).not.toBeNull();
          expect(err!.conflicts).toHaveLength(1);
          expect(err!.conflicts[0]!.detail).toBe("phantom");
          expect(err!.result.status).toBe("repaired");
        },
        () => {
          vi.doMock("./calendar.ts", async () => {
            const actual = await vi.importActual<typeof import("./calendar.ts")>("./calendar.ts");
            let call = 0;
            return {
              ...actual,
              validateAssignments: (...args: Parameters<typeof actual.validateAssignments>) => {
                call++;
                return call === 1
                  ? actual.validateAssignments(...args)
                  : [{ fixtureId: "gf", reason: "court" as const, detail: "phantom" }];
              },
            };
          });
        },
      );
    },
    SOLVE_TIMEOUT,
  );

  it(
    "returns the repaired schedule when the verifier agrees",
    async () => {
      await isolated(async ({ repair, fixtures }) => {
        const r = await repair.repairAndVerify({
          proposal: clashed(fixtures),
          dependencies: fixtures.badmintonFeedDeps(),
          config: configFor(fixtures),
          budgetMs: 60_000,
        });
        expect(r.status).toBe("repaired");
        if (r.status !== "repaired") return;
        expect(r.moved).toEqual(["gf"]);
      });
    },
    SOLVE_TIMEOUT,
  );

  it(
    "passes a clean board straight through, still without loading z3",
    async () => {
      await isolated(async ({ repair, z3, fixtures }) => {
        expect(z3.z3LoadCount()).toBe(0);
        const r = await repair.repairAndVerify({
          proposal: fixtures.goldenBadminton(),
          dependencies: fixtures.badmintonFeedDeps(),
          config: configFor(fixtures),
        });
        expect(r.status).toBe("clean");
        // Read from the SAME loader instance the call above used — a binding
        // from the other side of the reset would answer about a different one.
        expect(z3.z3LoadCount()).toBe(0);
      });
    },
    SOLVE_TIMEOUT,
  );

  it("re-exports from the scheduling barrel without loading z3", async () => {
    await isolated(async ({ z3 }) => {
      const mod = await import("./index.ts");
      expect(typeof mod.repairAndVerify).toBe("function");
      expect(typeof mod.repairSchedule).toBe("function");
      expect(typeof mod.buildDomains).toBe("function");
      expect(typeof mod.loadZ3).toBe("function");
      expect(z3.z3LoadCount()).toBe(0);
    });
  });
});
