// Redis read-through cache for slug resolution (v3 perf wave, Task 2).
// React cache() memoizes per request; in vitest that would make a second
// `orgBySlug` call in the same test skip our code entirely and pass
// vacuously, so these tests exercise the uncached inner export instead —
// the public `orgBySlug` stays cache()-wrapped for real request dedupe.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
vi.mock("@/lib/cache", () => ({
  cacheGet: vi.fn(async (k: string) => store.get(k) ?? null),
  cacheSet: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
  cacheDelPattern: vi.fn(async (p: string) => void store.delete(p)),
}));

// Each sql`` call resolves to the next queued result — enough to script
// live-hit vs miss sequences without a database.
const results: unknown[][] = [];
vi.mock("@/lib/db", () => ({
  sql: vi.fn(() => Promise.resolve(results.shift() ?? [])),
}));

import { orgBySlugUncached, invalidateSlugCache } from "@/server/slug-resolve";
import { cacheSet, cacheDelPattern } from "@/lib/cache";
import { sql } from "@/lib/db";

beforeEach(() => {
  store.clear();
  results.length = 0;
  vi.clearAllMocks();
});

describe("slug resolution cache", () => {
  const live = { id: "org-1", name: "Riverside", slug: "riverside" };

  it("caches a live resolution and serves the repeat from Redis", async () => {
    results.push([live]); // first call: DB answers
    expect(await orgBySlugUncached("riverside")).toEqual(live);
    expect(cacheSet).toHaveBeenCalledWith("slug:org:riverside", live, 60);

    // second call: no DB result queued — must come from cache
    expect(await orgBySlugUncached("riverside")).toEqual(live);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("never caches a miss or a rename fallback", async () => {
    results.push([], []); // live miss, history miss
    expect(await orgBySlugUncached("ghost")).toBeNull();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("invalidateSlugCache deletes old and new slug keys", async () => {
    await invalidateSlugCache("org", null, "riverside", "riverside-united");
    expect(cacheDelPattern).toHaveBeenCalledWith("slug:org:riverside");
    expect(cacheDelPattern).toHaveBeenCalledWith("slug:org:riverside-united");
  });
});
