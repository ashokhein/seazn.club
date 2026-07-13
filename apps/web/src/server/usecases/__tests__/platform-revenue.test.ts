// PROMPT-51 acceptance: application-fee pagination exhausts has_more pages,
// UTC month bucketing, refunds reduce net but keep gross, currencies never
// sum together, unknown connected accounts group under "(disconnected org)",
// 300s cache-aside skips Stripe on a hit, range/config guards (422/503).
// Stripe + db + cache all mocked — this exercises the rollup math and the
// pagination/caching contract, not the network.
import { beforeEach, describe, expect, it, vi } from "vitest";

type FeePage = { data: FeeFixture[]; has_more: boolean };
type FeeFixture = {
  id: string;
  account: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  created: number;
};

const stripeMock = vi.hoisted(() => {
  const feesList = vi.fn<(params: Record<string, unknown>) => Promise<FeePage>>();
  return { feesList, stripe: { applicationFees: { list: feesList } } };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

const db = vi.hoisted(() => ({ orgRows: [] as unknown[], calls: 0 }));
vi.mock("@/lib/db", () => ({
  sql: (...args: unknown[]) => {
    // Template-tag call (strings array carries .raw) → the org join query;
    // plain call (sql(list)) is the in-clause helper, value only interpolated.
    if (Array.isArray(args[0]) && "raw" in (args[0] as object)) {
      db.calls += 1;
      return Promise.resolve(db.orgRows);
    }
    return args[0];
  },
}));

const cache = vi.hoisted(() => ({
  store: new Map<string, string>(),
  ttls: [] as number[],
}));
vi.mock("@/lib/cache", () => ({
  cacheGet: async (key: string) => {
    const raw = cache.store.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  },
  cacheSet: async (key: string, value: unknown, ttlSeconds: number) => {
    cache.store.set(key, JSON.stringify(value));
    cache.ttls.push(ttlSeconds);
  },
}));

import { platformRevenue } from "../platform-revenue";

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// Jan fees on acct_1 (known org): 1000 clean + 500 with 200 refunded. The
// second sits at 23:30 UTC on Jan 31 — a local-time bucketing bug would file
// it under February in any timezone east of UTC.
const feeJan1: FeeFixture = {
  id: "fee_1", account: "acct_1", amount: 1000, amount_refunded: 0,
  currency: "gbp", created: utc("2026-01-15T12:00:00Z"),
};
const feeJan2: FeeFixture = {
  id: "fee_2", account: "acct_1", amount: 500, amount_refunded: 200,
  currency: "gbp", created: utc("2026-01-31T23:30:00Z"),
};
// Page 2: a USD fee on the known org + a GBP fee on an unknown account.
const feeFebUsd: FeeFixture = {
  id: "fee_3", account: "acct_1", amount: 700, amount_refunded: 0,
  currency: "usd", created: utc("2026-02-03T09:00:00Z"),
};
const feeFebGone: FeeFixture = {
  id: "fee_4", account: "acct_gone", amount: 300, amount_refunded: 0,
  currency: "gbp", created: utc("2026-02-10T09:00:00Z"),
};

const range = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-03-01T00:00:00Z") };

beforeEach(() => {
  cache.store.clear();
  cache.ttls.length = 0;
  db.calls = 0;
  db.orgRows = [
    { id: "org-a", name: "Riverside", slug: "riverside", stripe_account_id: "acct_1" },
  ];
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  stripeMock.feesList.mockReset();
  stripeMock.feesList
    .mockResolvedValueOnce({ data: [feeJan1, feeJan2], has_more: true })
    .mockResolvedValueOnce({ data: [feeFebUsd, feeFebGone], has_more: false });
});

describe("platformRevenue", () => {
  it("exhausts has_more pages and buckets fees by UTC month", async () => {
    const result = await platformRevenue(range);

    expect(stripeMock.feesList).toHaveBeenCalledTimes(2);
    expect(stripeMock.feesList.mock.calls[1][0]).toMatchObject({ starting_after: "fee_2" });

    expect(result.byMonth.gbp["2026-01"]).toEqual({
      gross: 1500, refunded: 200, net: 1300, count: 2,
    });
    expect(result.byMonth.gbp["2026-02"]).toEqual({
      gross: 300, refunded: 0, net: 300, count: 1,
    });
  });

  it("keeps refunded fees in gross while reducing net", async () => {
    const result = await platformRevenue(range);
    const jan = result.byMonth.gbp["2026-01"];
    expect(jan.gross).toBe(1500);
    expect(jan.net).toBe(jan.gross - jan.refunded);
  });

  it("never sums across currencies", async () => {
    const result = await platformRevenue(range);
    expect(result.byMonth.usd).toEqual({
      "2026-02": { gross: 700, refunded: 0, net: 700, count: 1 },
    });
    expect(result.byMonth.gbp["2026-02"].gross).toBe(300); // usd 700 not folded in
    expect(result.byOrg.usd["org-a"]).toMatchObject({ gross: 700, count: 1 });
  });

  it("groups fees on unknown accounts under (disconnected org)", async () => {
    const result = await platformRevenue(range);
    expect(result.byOrg.gbp["org-a"]).toMatchObject({
      name: "Riverside", slug: "riverside", gross: 1500, refunded: 200, net: 1300, count: 2,
    });
    expect(result.byOrg.gbp.disconnected).toMatchObject({
      name: "(disconnected org)", slug: null, gross: 300, net: 300, count: 1,
    });
  });

  it("serves the second call from cache without touching Stripe or Postgres", async () => {
    await platformRevenue(range);
    const stripeCalls = stripeMock.feesList.mock.calls.length;
    const dbCalls = db.calls;
    expect(cache.ttls).toEqual([300]);

    const again = await platformRevenue(range);
    expect(stripeMock.feesList.mock.calls.length).toBe(stripeCalls);
    expect(db.calls).toBe(dbCalls);
    expect(again.byMonth.gbp["2026-01"].net).toBe(1300);
  });

  it("exposes flat org×month×currency rows for the CSV export", async () => {
    const result = await platformRevenue(range);
    expect(result.rows).toContainEqual({
      month: "2026-01", org_id: "org-a", org: "Riverside", org_slug: "riverside",
      currency: "gbp", gross: 1500, refunded: 200, net: 1300, count: 2,
    });
    expect(result.rows).toContainEqual({
      month: "2026-02", org_id: "org-a", org: "Riverside", org_slug: "riverside",
      currency: "usd", gross: 700, refunded: 0, net: 700, count: 1,
    });
    expect(result.rows).toContainEqual({
      month: "2026-02", org_id: "disconnected", org: "(disconnected org)", org_slug: null,
      currency: "gbp", gross: 300, refunded: 0, net: 300, count: 1,
    });
    expect(result.rows).toHaveLength(3);
  });

  it("rejects ranges longer than 24 months with 422", async () => {
    await expect(
      platformRevenue({ from: new Date("2024-01-01T00:00:00Z"), to: new Date("2026-03-01T00:00:00Z") }),
    ).rejects.toMatchObject({ status: 422 });
    expect(stripeMock.feesList).not.toHaveBeenCalled();
  });

  it("returns 503 when Stripe is not configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await expect(platformRevenue(range)).rejects.toMatchObject({ status: 503 });
    expect(stripeMock.feesList).not.toHaveBeenCalled();
  });
});
