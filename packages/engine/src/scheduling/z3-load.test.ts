import { describe, expect, it } from "vitest";
import { loadZ3, resetZ3, z3LoadCount } from "./z3-load.ts";

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
