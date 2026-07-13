import { describe, expect, it } from "vitest";
import { consentLocked } from "@/lib/guardian";

// Guardian gate (PROMPT-53, owner decision 2026-07-13): a claimed player
// under 16 by dob sees consent read-only — organiser-set values hold.
describe("consentLocked", () => {
  const now = new Date("2026-07-13T12:00:00Z");

  it("unknown dob is not locked", () => {
    expect(consentLocked(null, now)).toBe(false);
  });

  it("15-year-old is locked", () => {
    expect(consentLocked("2011-07-14", now)).toBe(true);
  });

  it("day before the 16th birthday is still locked", () => {
    expect(consentLocked("2010-07-14", now)).toBe(true);
  });

  it("16th birthday today unlocks", () => {
    expect(consentLocked("2010-07-13", now)).toBe(false);
  });

  it("adult is not locked", () => {
    expect(consentLocked("1986-01-01", now)).toBe(false);
  });

  it("unparseable dob is treated as unknown (not locked)", () => {
    expect(consentLocked("not-a-date", now)).toBe(false);
  });
});
