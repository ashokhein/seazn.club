// PROMPT-51: GET /api/admin/revenue — superadmin-gated JSON + CSV views of
// the platform-revenue usecase. Guard + usecase mocked; asserts the range
// contract (default = last 12 calendar months on whole-month UTC boundaries,
// custom `to` day inclusive), zod 400s, guard behavior mirroring existing
// admin routes (AuthError → 401), and the exact CSV shape/escaping.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/errors";
import type { PlatformRevenue } from "@/server/usecases/platform-revenue";

const requireSuperadminMock = vi.fn<() => Promise<{ id: string }>>();
vi.mock("@/lib/admin", () => ({
  requireSuperadmin: () => requireSuperadminMock(),
}));

const revenueMock = vi.fn<(range: { from: Date; to: Date }) => Promise<PlatformRevenue>>();
vi.mock("@/server/usecases/platform-revenue", () => ({
  platformRevenue: (range: { from: Date; to: Date }) => revenueMock(range),
}));

import { GET } from "../route";

const fixture: PlatformRevenue = {
  byMonth: { gbp: { "2026-01": { gross: 1500, refunded: 200, net: 1300, count: 2 } } },
  byOrg: {
    gbp: {
      "org-a": { name: 'Club "The, Best"', slug: "riverside", gross: 1500, refunded: 200, net: 1300, count: 2 },
    },
  },
  rows: [
    // Name with quote + comma so a row asserts the CSV escaping contract.
    { month: "2026-01", org_id: "org-a", org: 'Club "The, Best"', org_slug: "riverside",
      currency: "gbp", gross: 1500, refunded: 200, net: 1300, count: 2 },
    { month: "2026-02", org_id: "disconnected", org: "(disconnected org)", org_slug: null,
      currency: "usd", gross: 700, refunded: 0, net: 700, count: 1 },
  ],
};

const get = (qs = "") => GET(new Request(`http://test/api/admin/revenue${qs}`));

beforeEach(() => {
  requireSuperadminMock.mockReset().mockResolvedValue({ id: "staff-1" });
  revenueMock.mockReset().mockResolvedValue(fixture);
  vi.useFakeTimers({ now: new Date("2026-07-13T10:00:00Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/admin/revenue", () => {
  it("rejects non-staff callers like every other admin route", async () => {
    requireSuperadminMock.mockRejectedValueOnce(new AuthError("Staff access required"));
    const res = await get();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(revenueMock).not.toHaveBeenCalled();
  });

  it("defaults to the last 12 calendar months on whole-month UTC boundaries", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const { from, to } = revenueMock.mock.calls[0][0];
    expect(from.toISOString()).toBe("2025-08-01T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    const json = (await res.json()) as { ok: boolean; data: PlatformRevenue & { from: string; to: string } };
    expect(json.ok).toBe(true);
    expect(json.data.byMonth.gbp["2026-01"].net).toBe(1300);
    expect(json.data.from).toBe("2025-08-01");
    expect(json.data.to).toBe("2026-08-01");
  });

  it("treats a custom `to` date as inclusive (exclusive bound = next day)", async () => {
    await get("?from=2026-01-01&to=2026-02-28");
    const { from, to } = revenueMock.mock.calls[0][0];
    expect(from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("400s on malformed dates before touching the usecase", async () => {
    const res = await get("?from=notadate&to=2026-02-28");
    expect(res.status).toBe(400);
    expect(revenueMock).not.toHaveBeenCalled();
  });

  it("streams CSV with the exact header and one row per org×month×currency", async () => {
    const res = await get("?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");

    const lines = (await res.text()).trimEnd().split("\n");
    expect(lines[0]).toBe("month,org,org_slug,currency,gross_minor,refunded_minor,net_minor,fee_count");
    expect(lines[1]).toBe('2026-01,"Club ""The, Best""",riverside,gbp,1500,200,1300,2');
    expect(lines[2]).toBe("2026-02,(disconnected org),,usd,700,0,700,1");
    expect(lines).toHaveLength(3);
  });
});
