import { describe, expect, it } from "vitest";
import { certTitle } from "../cert";

describe("certTitle", () => {
  it("all three tracks → Grandmaster", () => {
    expect(certTitle(24, 24, 5).title).toBe("Chess Quest Grandmaster");
  });
  it("tracks 1+2 done, track 3 partial → Champion", () => {
    expect(certTitle(24, 24, 2).title).toBe("Chess Quest Champion");
  });
  it("track 1 only → First Steps Champion", () => {
    expect(certTitle(24, 5, 0).title).toBe("First Steps Champion");
  });
  it("track 2 only → Rising Player Champion", () => {
    expect(certTitle(0, 24, 0).title).toBe("Rising Player Champion");
  });
  it("track 3 only → Opening Range Champion", () => {
    expect(certTitle(3, 2, 5).title).toBe("Opening Range Champion");
  });
  it("partial → Adventurer with the day count", () => {
    const r = certTitle(3, 2, 1);
    expect(r.title).toBe("Chess Quest Adventurer");
    expect(r.line).toContain("6 of 53");
  });
});
