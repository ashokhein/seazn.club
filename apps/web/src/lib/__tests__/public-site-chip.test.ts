import { describe, it, expect } from "vitest";
import { chipLabelKey } from "@/lib/public-site";

describe("chipLabelKey", () => {
  it("maps competition status to the public-namespace dict key", () => {
    expect(chipLabelKey("live")).toBe("chip.onNow");
    expect(chipLabelKey("completed")).toBe("chip.finished");
    expect(chipLabelKey("archived")).toBe("chip.finished");
    expect(chipLabelKey("draft")).toBe("chip.upcoming");
    expect(chipLabelKey("whatever")).toBe("chip.upcoming");
  });
});
