import { afterEach, describe, expect, it, vi } from "vitest";
import { loadZ3, resetZ3, z3LoadCount } from "./z3-load.ts";

/** A synthetic `z3-solver` whose `init` fails the first `failures` times and
 *  then succeeds. Fully fake on purpose: this exercises the loader's STATE
 *  MACHINE, and booting the real WASM a second time in-process would be slow
 *  and would fight the singleton the other tests share (`isolate: false`). */
function fakeZ3(opts: { failures: number; shutdownThrows?: boolean }): { inits: () => number } {
  let inits = 0;
  vi.doMock("z3-solver", () => ({
    init: async () => {
      inits++;
      if (inits <= opts.failures) throw new Error("wasm boom");
      return {
        Context: (name: string) => ({ name }),
        em: {
          PThread: {
            terminateAllThreads: () => {
              if (opts.shutdownThrows === true) throw new Error("shutdown boom");
            },
          },
        },
        setParam: () => {},
      };
    },
  }));
  return { inits: () => inits };
}

/** A FRESH copy of the loader, so its `loaded`/`count` start clean and the
 *  singleton the tests above share is left untouched. */
async function freshLoader(): Promise<typeof import("./z3-load.ts")> {
  vi.resetModules();
  return import("./z3-load.ts");
}

describe("z3 lazy load", () => {
  it("does not load the WASM until someone asks for it", () => {
    expect(z3LoadCount()).toBe(0);
  });

  it("loads exactly once however many callers ask", async () => {
    const [a, b] = await Promise.all([loadZ3(), loadZ3()]);
    expect(a).toBe(b);
    expect(z3LoadCount()).toBe(1);
    await resetZ3();
  });

  it("solves a trivial system deterministically", async () => {
    const { Z3 } = await loadZ3();
    const s = new Z3.Solver();
    const x = Z3.Int.const("x");
    s.add(x.ge(3), x.le(3));
    expect(await s.check()).toBe("sat");
    expect(s.model().eval(x).toString()).toBe("3");
    await resetZ3();
  });
});

// A rejected load used to be cached forever: `loaded` kept the rejected promise
// and `count` stayed at 1, so every later caller got the same failure and
// `resetZ3` rethrew before clearing anything. Unrecoverable without a process
// restart, on the one path — a transient WASM boot failure — most likely to be
// transient.
describe("z3 load failure is recoverable", () => {
  afterEach(() => {
    vi.doUnmock("z3-solver");
    vi.resetModules();
  });

  it("a failed load is not cached — the next caller can still succeed", async () => {
    const z3 = fakeZ3({ failures: 1 });
    const mod = await freshLoader();
    await expect(mod.loadZ3()).rejects.toThrow("wasm boom");
    // The failed attempt left no tombstone: nothing loaded, nothing counted.
    expect(mod.z3LoadCount()).toBe(0);
    const ctx = await mod.loadZ3();
    expect(ctx.Z3).toBeDefined();
    expect(mod.z3LoadCount()).toBe(1);
    expect(z3.inits()).toBe(2);
    // And it is still a singleton after the recovery.
    expect(await mod.loadZ3()).toBe(ctx);
    expect(mod.z3LoadCount()).toBe(1);
    await mod.resetZ3();
    expect(mod.z3LoadCount()).toBe(0);
  });

  it("resetZ3 clears the singleton even when shutdown throws", async () => {
    fakeZ3({ failures: 0, shutdownThrows: true });
    const mod = await freshLoader();
    await mod.loadZ3();
    expect(mod.z3LoadCount()).toBe(1);
    await expect(mod.resetZ3()).rejects.toThrow("shutdown boom");
    // The rethrow must not strand the singleton — a second reset is a no-op and
    // a later load starts from scratch.
    expect(mod.z3LoadCount()).toBe(0);
    await expect(mod.resetZ3()).resolves.toBeUndefined();
    await mod.loadZ3();
    expect(mod.z3LoadCount()).toBe(1);
    await expect(mod.resetZ3()).rejects.toThrow("shutdown boom");
  });
});
