import { describe, expect, it } from "vitest";
import { certTitle } from "../cert";

describe("certTitle", () => {
  it("both tracks complete → Champion", () => {
    expect(certTitle(24, 24).title).toBe("Chess Quest Champion");
  });
  it("track 1 only → First Steps Champion", () => {
    expect(certTitle(24, 5).title).toBe("First Steps Champion");
  });
  it("track 2 only → Rising Player Champion", () => {
    expect(certTitle(0, 24).title).toBe("Rising Player Champion");
  });
  it("partial → Adventurer with the day count", () => {
    const r = certTitle(3, 2);
    expect(r.title).toBe("Chess Quest Adventurer");
    expect(r.line).toContain("5 of 48");
  });
});
