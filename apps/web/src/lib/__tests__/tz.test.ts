import { afterEach, describe, expect, it, vi } from "vitest";

// resolveTimezone reads getCurrentUser() + cookies(); mock both so the
// precedence logic is exercised without a request context or DB.
const mockUser = vi.fn();
const mockCookieGet = vi.fn();

vi.mock("@/lib/auth", () => ({ getCurrentUser: () => mockUser() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (k: string) => mockCookieGet(k) }),
}));

import { isValidIana, pickTimezone, DEFAULT_TZ } from "@/lib/tz";
import { resolveTimezone } from "@/lib/tz-server";

afterEach(() => vi.clearAllMocks());

describe("isValidIana", () => {
  it("accepts real zones (incl. aliases)", () => {
    expect(isValidIana("Asia/Kolkata")).toBe(true);
    expect(isValidIana("Europe/London")).toBe(true);
    expect(isValidIana("UTC")).toBe(true);
    expect(isValidIana("Asia/Calcutta")).toBe(true); // legacy alias
  });
  it("rejects blanks and nonsense", () => {
    expect(isValidIana(null)).toBe(false);
    expect(isValidIana(undefined)).toBe(false);
    expect(isValidIana("")).toBe(false);
    expect(isValidIana("   ")).toBe(false);
    expect(isValidIana("Mars/Phobos")).toBe(false);
    expect(isValidIana("Not A Zone")).toBe(false);
  });
});

describe("pickTimezone precedence", () => {
  it("prefers a valid user pref over cookie", () => {
    expect(pickTimezone("Asia/Kolkata", "Europe/London")).toBe("Asia/Kolkata");
  });
  it("falls to cookie when user pref is null/invalid", () => {
    expect(pickTimezone(null, "Europe/London")).toBe("Europe/London");
    expect(pickTimezone("Mars/Phobos", "Europe/London")).toBe("Europe/London");
  });
  it("falls to UTC when both missing/invalid", () => {
    expect(pickTimezone(null, null)).toBe(DEFAULT_TZ);
    expect(pickTimezone("bogus", "also-bogus")).toBe(DEFAULT_TZ);
  });
});

describe("resolveTimezone (integration of sources)", () => {
  it("uses users.timezone when set", async () => {
    mockUser.mockResolvedValue({ id: "u1", timezone: "Asia/Tokyo" });
    mockCookieGet.mockReturnValue({ value: "Europe/London" });
    await expect(resolveTimezone()).resolves.toBe("Asia/Tokyo");
  });
  it("uses the seazn_tz cookie for a user with no pref", async () => {
    mockUser.mockResolvedValue({ id: "u1", timezone: null });
    mockCookieGet.mockReturnValue({ value: "Europe/London" });
    await expect(resolveTimezone()).resolves.toBe("Europe/London");
  });
  it("uses the cookie for an anonymous viewer", async () => {
    mockUser.mockResolvedValue(null);
    mockCookieGet.mockReturnValue({ value: "America/New_York" });
    await expect(resolveTimezone()).resolves.toBe("America/New_York");
  });
  it("falls to UTC with no pref and no cookie", async () => {
    mockUser.mockResolvedValue(null);
    mockCookieGet.mockReturnValue(undefined);
    await expect(resolveTimezone()).resolves.toBe(DEFAULT_TZ);
  });
});

// The zone LIST moved to lib/tz-options.ts (over the generated lib/tz-data.ts)
// so this module stays importable without the ~20KB zone table. Its tests moved
// with it — see __tests__/tz-options.test.ts.
