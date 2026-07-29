// #336: platform-settings.ts caches the resolved platform fee under a
// SINGLE GLOBAL Redis key ("platform:fee_percent") — unlike
// lib/entitlements.ts's entKey(orgId, featureKey, competitionId), nothing in
// it is scoped to DB_SCHEMA, tenant, or run. Two callers that are logically
// different "runs" but share one Redis instance — two migrated test schemas,
// or a local dev database sitting alongside a test database — therefore
// share one 300s cache entry: a write meant for one bleeds straight into a
// read meant for the other.
//
// Structurally invisible without a real Redis: with REDIS_URL unset every
// read hits Postgres fresh (lib/cache.ts is fail-open), so this suite needs
// a real Redis actually holding a warm, mis-scoped entry. Same reason the
// rest of the `*.redis.test.ts` family exists. CI runs this in its own
// REDIS_URL-scoped step, mirroring rate-limit.redis.test.ts and
// entitlements-cache-invalidation.redis.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { cacheSet, cacheDelPattern } from "@/lib/cache";
import { platformFeeDefault, __platformFeeCacheKeyForTests } from "@/lib/platform-settings";

const HAS_DB = !!process.env.DATABASE_URL;
const HAS_REDIS = !!process.env.REDIS_URL;

describe.skipIf(!HAS_DB || !HAS_REDIS)("platform fee cache isolation (real Redis)", () => {
  afterAll(async () => {
    const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
    const dbClient = globalForDb._sql;
    globalForDb._sql = undefined;
    await dbClient?.end();
    const g = globalThis as unknown as { _redis?: { quit?: () => Promise<unknown> } };
    await g._redis?.quit?.().catch(() => {});
  });

  it("a value cached for one DB_SCHEMA does not leak into a read under another", async () => {
    // lib/db.ts's postgres client is a lazily-initialised singleton: the
    // FIRST query fixes its `search_path` (connectionOptions reads
    // process.env.DB_SCHEMA once, at that moment) and every later query
    // reuses that same connection regardless of what DB_SCHEMA becomes
    // afterwards. Force that initialisation now, against the REAL schema
    // this test process is actually migrated against, before faking
    // DB_SCHEMA below purely to vary the CACHE key — otherwise the next
    // section's fake schema names would be sent to Postgres as a real
    // search_path and the query would 42P01 on a schema that doesn't exist.
    await sql`select 1`;

    const prevSchema = process.env.DB_SCHEMA;
    let keyA = "";
    let keyB = "";
    try {
      // "Suite A" (or a dev DB, or a differently-schema'd test run): its own
      // resolved fee is cached under whatever key this run computes for its
      // DB_SCHEMA.
      process.env.DB_SCHEMA = `w11_iso_a_${randomUUID().slice(0, 6)}`;
      keyA = __platformFeeCacheKeyForTests();
      await cacheSet(keyA, { v: 999 }, 60);

      // "Suite B": a DIFFERENT run/schema. Pre-fix, CACHE_KEY is the same
      // literal string regardless of DB_SCHEMA, so keyB === keyA and this
      // read would return the 999 "Suite A" just wrote — a real order
      // dependence, not a hypothetical one. Post-fix the keys differ, so
      // this read misses A's entry and resolves fresh (the seeded default,
      // 5 — definitely not 999).
      process.env.DB_SCHEMA = `w11_iso_b_${randomUUID().slice(0, 6)}`;
      keyB = __platformFeeCacheKeyForTests();
      expect(keyB).not.toBe(keyA); // sanity: isolation is only possible if the keys differ

      expect(await platformFeeDefault()).not.toBe(999);
    } finally {
      await cacheDelPattern(keyA);
      await cacheDelPattern(keyB);
      process.env.DB_SCHEMA = prevSchema;
    }
  });
});
