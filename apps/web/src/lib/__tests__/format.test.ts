import { describe, expect, it } from "vitest";
import { fmtDate, fmtTime, fmtDateTime, fmtZoneAbbrev, fmtRange } from "@/lib/format";

// A fixed UTC instant: 2026-08-16T13:30:00Z == 19:00 in Asia/Kolkata (IST).
const IST_1900 = "2026-08-16T13:30:00Z";

describe("fmtTime", () => {
  it("renders the wall-clock time in the given zone (h23)", () => {
    expect(fmtTime("Asia/Kolkata", IST_1900)).toBe("19:00");
    expect(fmtTime("Europe/London", IST_1900)).toBe("14:30"); // BST = UTC+1 in Aug
    expect(fmtTime("UTC", IST_1900)).toBe("13:30");
  });
  it("returns empty string for null/invalid input", () => {
    expect(fmtTime("UTC", null)).toBe("");
    expect(fmtTime("UTC", "not-a-date")).toBe("");
  });
});

describe("fmtZoneAbbrev — DST-dependent", () => {
  // The exact string is runtime-ICU-dependent: Node emits "GMT+5:30" where a
  // browser emits "IST" (why the label renders client-side). What IS invariant
  // and worth guarding: the value TRACKS DST — different in a zone's summer vs
  // winter, stable in a zone without DST — and it never throws / never blanks.
  it("Europe/London differs winter vs summer (DST tracked)", () => {
    const winter = fmtZoneAbbrev("Europe/London", "2026-01-15T12:00:00Z");
    const summer = fmtZoneAbbrev("Europe/London", "2026-07-15T12:00:00Z");
    expect(winter).toBe("GMT"); // London winter names deterministically across ICU
    expect(summer).not.toBe(winter);
    expect(summer).toBeTruthy();
  });
  it("Asia/Kolkata is stable year-round (no DST)", () => {
    const jan = fmtZoneAbbrev("Asia/Kolkata", "2026-01-15T12:00:00Z");
    const aug = fmtZoneAbbrev("Asia/Kolkata", IST_1900);
    expect(jan).toBe(aug);
    expect(jan).toBeTruthy();
  });
});

describe("unknown zone falls back to UTC, never throws", () => {
  it("fmtTime tolerates a bogus zone", () => {
    expect(() => fmtTime("Mars/Phobos", IST_1900)).not.toThrow();
    expect(fmtTime("Mars/Phobos", IST_1900)).toBe("13:30"); // UTC fallback
  });
});

describe("fmtDate / fmtDateTime", () => {
  it("formats a date in-zone", () => {
    // 13:30Z is still 16 Aug in Kolkata but also 16 Aug in London.
    expect(fmtDate("Asia/Kolkata", IST_1900)).toContain("16 Aug");
  });
  it("crosses midnight by zone", () => {
    // 22:30Z on the 16th is 04:00 on the 17th in Kolkata.
    expect(fmtDate("Asia/Kolkata", "2026-08-16T22:30:00Z")).toContain("17 Aug");
    expect(fmtDate("UTC", "2026-08-16T22:30:00Z")).toContain("16 Aug");
  });
  it("fmtDateTime combines both", () => {
    expect(fmtDateTime("UTC", IST_1900)).toMatch(/16 Aug/);
  });
});

describe("fmtRange", () => {
  it("collapses a single day", () => {
    expect(fmtRange("UTC", IST_1900, IST_1900)).toBe("16 Aug");
  });
  it("shows a span across days", () => {
    expect(fmtRange("UTC", "2026-08-12T10:00:00Z", "2026-08-14T10:00:00Z")).toBe("12 Aug – 14 Aug");
  });
  it("treats missing 'to' as single day", () => {
    expect(fmtRange("UTC", IST_1900, null)).toBe("16 Aug");
  });
});
