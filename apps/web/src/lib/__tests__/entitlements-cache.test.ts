// A resolved "deny" is null — which cacheGet also returns on a miss. Before
// the CacheEntry wrapper, a deny therefore never cached and every hasFeature
// call for an unentitled feature re-queried Postgres. These tests fail
// against the unwrapped implementation.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
let dbCalls = 0;

vi.mock("@/lib/db", () => ({
  sql: () => {
    dbCalls += 1;
    return Promise.resolve([]); // no rows anywhere → resolves to deny (null)
  },
}));

vi.mock("@/lib/cache", () => ({
  cacheGet: async (key: string) => {
    const raw = store.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  },
  cacheSet: async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
  },
  cacheDelPattern: async () => {
    store.clear();
  },
}));

// getLimit's non-null path now adds an uncached add-on sum (v17 Phase 3 T2),
// which resolves the org's wallet via walletIdFor. This suite mocks the DB
// wholesale (every sql call → []), so walletIdFor would throw "no organization";
// stub it to the group-of-one identity (wallet = orgId). The add-on sum then
// reads [] → 0, leaving the deny=0 semantics under test unchanged.
vi.mock("@/lib/credits", () => ({
  walletIdFor: async (orgId: string) => orgId,
}));

import { hasFeature, getLimit } from "@/lib/entitlements";

beforeEach(() => {
  store.clear();
  dbCalls = 0;
});

describe("entitlement deny caching", () => {
  it("serves a cached deny without re-querying Postgres", async () => {
    expect(await hasFeature("org-1", "formats.advanced")).toBe(false);
    const afterFirst = dbCalls;
    expect(afterFirst).toBeGreaterThan(0);
    expect(store.size).toBe(1);

    expect(await hasFeature("org-1", "formats.advanced")).toBe(false);
    expect(dbCalls).toBe(afterFirst);
  });

  it("keeps deny semantics through the cache (limit 0, not unlimited)", async () => {
    await getLimit("org-1", "some.metric");
    expect(await getLimit("org-1", "some.metric")).toBe(0);
  });

  it("treats stale pre-wrapper cache entries as a miss", async () => {
    // Entry written by the old code: the raw Resolved shape, no `v` wrapper.
    store.set("ent:org-1:formats.advanced", JSON.stringify({ bool_value: true, int_value: null }));
    expect(await hasFeature("org-1", "formats.advanced")).toBe(false); // re-resolved, not trusted
    expect(dbCalls).toBeGreaterThan(0);
  });
});
