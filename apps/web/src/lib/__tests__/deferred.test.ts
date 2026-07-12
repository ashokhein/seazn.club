import { describe, expect, it, vi } from "vitest";

// `after` is wrapped (not replaced) so the two request-scope-less tests below
// keep exercising the REAL next/server after() throwing outside a request
// scope (the actual behavior this helper's fallback branch depends on) — only
// the regression test overrides it, per-call, via mockImplementationOnce.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn(actual.after) };
});

import { after } from "next/server";
import { deferred } from "@/lib/deferred";

describe("deferred", () => {
  it("runs the callback inline when outside a Next request scope", async () => {
    const fn = vi.fn(async () => {});
    deferred(fn);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
  });

  it("swallows callback rejections", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(() => deferred(fn)).not.toThrow();
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
  });

  // Task 6 review finding 1 (CRITICAL) / finding 4: `run` used to be
  // non-async and returned undefined, so after(run) hands Next's after()
  // nothing to wait on — the after-window can close (Redis invalidation +
  // revalidateTag racing the response) even though `run` is still mid-flight.
  // Simulates being inside a request scope (after() registers instead of
  // throwing) and proves the registered callback's OWN returned promise
  // tracks fn's completion, not just fn's synchronous kickoff.
  it("hands after() a callback whose promise stays pending until fn settles", async () => {
    let captured: (() => unknown) | undefined;
    vi.mocked(after).mockImplementationOnce((task) => {
      captured = task as () => unknown;
    });

    let flag = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    deferred(async () => {
      await gate;
      flag = true;
    });

    expect(captured).toBeTypeOf("function");

    let settled = false;
    const returned = Promise.resolve(captured!()).then(() => {
      settled = true;
    });

    // Drain microtasks AND a macrotask tick without releasing the gate — a
    // non-async `run` (the bug) resolves `captured()` immediately regardless,
    // so this is where the unfixed helper fails.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(flag).toBe(false);

    release();
    await returned;

    expect(settled).toBe(true);
    expect(flag).toBe(true);
  });
});
