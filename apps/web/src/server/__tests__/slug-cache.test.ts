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

import {
  orgBySlugUncached,
  compBySlugUncached,
  divBySlugUncached,
  invalidateSlugCache,
} from "@/server/slug-resolve";
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

  // Review finding 2: the test above only ever drove the plain double-miss
  // (live miss + history miss -> null) — the actual `{ renamedTo }` branch
  // (live miss -> history HIT -> target HIT) was never exercised, so a
  // regression that started caching that branch would have gone undetected.
  it("never caches a renamedTo fallback", async () => {
    results.push([], [{ entity_id: "org-2" }], [{ slug: "riverside-new" }]);
    expect(await orgBySlugUncached("riverside-old")).toEqual({ renamedTo: "riverside-new" });
    expect(sql).toHaveBeenCalledTimes(3); // live miss, slug_history hit, target lookup
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("invalidateSlugCache deletes old and new slug keys for org, competition and division", async () => {
    await invalidateSlugCache("org", null, "riverside", "riverside-united");
    expect(cacheDelPattern).toHaveBeenCalledWith("slug:org:riverside");
    expect(cacheDelPattern).toHaveBeenCalledWith("slug:org:riverside-united");

    await invalidateSlugCache("competition", "org-1", "spring-open", "autumn-open");
    expect(cacheDelPattern).toHaveBeenCalledWith("slug:comp:org-1:spring-open");
    expect(cacheDelPattern).toHaveBeenCalledWith("slug:comp:org-1:autumn-open");

    await invalidateSlugCache("division", "comp-1", "u16-boys", "u18-boys");
    expect(cacheDelPattern).toHaveBeenCalledWith("slug:div:comp-1:u16-boys");
    expect(cacheDelPattern).toHaveBeenCalledWith("slug:div:comp-1:u18-boys");
  });
});

describe("slug resolution cache — competition", () => {
  const live = { id: "comp-1", name: "Summer Smash", slug: "summer-smash" };
  const orgId = "org-1";

  it("caches a live resolution and serves the repeat from Redis", async () => {
    results.push([live]); // first call: DB answers
    expect(await compBySlugUncached(orgId, "summer-smash")).toEqual(live);
    expect(cacheSet).toHaveBeenCalledWith(`slug:comp:${orgId}:summer-smash`, live, 60);

    // second call: no DB result queued — must come from cache
    expect(await compBySlugUncached(orgId, "summer-smash")).toEqual(live);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("never caches a miss", async () => {
    results.push([], []); // live miss, history miss
    expect(await compBySlugUncached(orgId, "ghost")).toBeNull();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("never caches a renamedTo fallback", async () => {
    results.push([], [{ entity_id: "comp-2" }], [{ slug: "autumn-open" }]);
    expect(await compBySlugUncached(orgId, "spring-open")).toEqual({ renamedTo: "autumn-open" });
    expect(sql).toHaveBeenCalledTimes(3);
    expect(cacheSet).not.toHaveBeenCalled();
  });
});

describe("slug resolution cache — division", () => {
  const live = { id: "div-1", name: "U16 Boys", slug: "u16-boys" };
  const compId = "comp-1";

  it("caches a live resolution and serves the repeat from Redis", async () => {
    results.push([live]); // first call: DB answers
    expect(await divBySlugUncached(compId, "u16-boys")).toEqual(live);
    expect(cacheSet).toHaveBeenCalledWith(`slug:div:${compId}:u16-boys`, live, 60);

    // second call: no DB result queued — must come from cache
    expect(await divBySlugUncached(compId, "u16-boys")).toEqual(live);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("never caches a miss", async () => {
    results.push([], []); // live miss, history miss
    expect(await divBySlugUncached(compId, "ghost")).toBeNull();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("never caches a renamedTo fallback", async () => {
    results.push([], [{ entity_id: "div-2" }], [{ slug: "u18-boys" }]);
    expect(await divBySlugUncached(compId, "u16-boys-old")).toEqual({ renamedTo: "u18-boys" });
    expect(sql).toHaveBeenCalledTimes(3);
    expect(cacheSet).not.toHaveBeenCalled();
  });
});
