import { describe, expect, it, vi } from "vitest";
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
});
