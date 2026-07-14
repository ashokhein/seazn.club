import { describe, expect, it } from "vitest";
import { last14Days } from "../last14";

describe("last14Days", () => {
  it("returns 14 entries ending on today", () => {
    const days = last14Days([], "2026-07-14");
    expect(days).toHaveLength(14);
    expect(days[13].iso).toBe("2026-07-14");
    expect(days[0].iso).toBe("2026-07-01");
  });

  it("flags days that appear in the activity set", () => {
    const days = last14Days(["2026-07-14", "2026-07-10", "2026-06-01"], "2026-07-14");
    const on = days.filter((d) => d.on).map((d) => d.iso);
    expect(on).toEqual(["2026-07-10", "2026-07-14"]); // out-of-window date ignored
  });

  it("labels weekdays", () => {
    const days = last14Days([], "2026-07-14"); // 2026-07-14 is a Tuesday
    expect(days[13].wd).toBe("T");
  });
});
