// v17 #287: lib/entitlements.ts caches resolved answers under
// `ent:<org>:<competition>:<feature>` for 300s (ENT_TTL_SECONDS). A
// competition write that moves status/ends_on — which the Event Pass lock
// (isPassLocked) reads live off the row on every resolve — must bust that
// cache in the SAME call, or a warm answer outlives the write for up to 5
// minutes. The bug is structurally invisible without a real Redis: with
// REDIS_URL unset, cacheGet always misses and every read hits Postgres
// fresh (lib/cache.ts), so this suite needs BOTH a real Postgres (usecase
// seeding) and a real Redis (an actually-warm cache to go stale). Skipped
// without either. CI runs this in its own step, mirroring
// rate-limit.redis.test.ts's REDIS_URL scoping (ci.yml).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { incrWindow } from "@/lib/cache";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "@/server/usecases/competitions";
import { setOrgPlan } from "./_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const HAS_REDIS = !!process.env.REDIS_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Community org an Event Pass can lift (`realtime`: community false, pro
 *  true, event_pass true — same probe key entitlements-sql-parity.test.ts
 *  uses, and for the same reason: V310 made `branding` free for community,
 *  so it can no longer show a pass LIFT). */
export async function seedCommunityOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`cachebust-${suffix}@test.local`}, 'Cache Bust Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Cache Bust " + suffix}, ${"cache-bust-" + suffix}, ${ownerId}) returning id`;
  await setOrgPlan(orgId, "community", "active");
  return { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
}

describe.skipIf(!HAS_DB || !HAS_REDIS)("entitlement cache invalidation (real Redis)", () => {
  // The client uses enableOfflineQueue:false, so a command fired before the
  // socket is 'ready' rejects (incrWindow returns null). A long-lived server
  // warms the singleton once; here we warm it explicitly before asserting —
  // same pattern as rate-limit.redis.test.ts.
  beforeAll(async () => {
    for (let i = 0; i < 50; i++) {
      if ((await incrWindow(`warmup:${randomUUID()}`, 5)) !== null) return;
      await sleep(100);
    }
    throw new Error("Redis did not become ready");
  });

  afterAll(async () => {
    const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
    const dbClient = globalForDb._sql;
    globalForDb._sql = undefined;
    await dbClient?.end();
    const g = globalThis as unknown as { _redis?: { quit?: () => Promise<unknown> } };
    await g._redis?.quit?.().catch(() => {});
  });

  it("patchCompetition busts the cache the instant a pass-bearing competition locks", async () => {
    const auth = await seedCommunityOrg();
    const comp = await createCompetition(auth, {
      name: `Cache Lock ${randomUUID().slice(0, 6)}`,
      visibility: "private",
      branding: {},
    });
    await sql`insert into competition_passes (competition_id, org_id) values (${comp.id}, ${auth.orgId})`;
    await invalidateOrgEntitlements(auth.orgId);

    // Warm the cache: still 'draft' (isPassLocked's active set), so the
    // pass lifts `realtime`.
    expect(await hasFeature(auth.orgId, "realtime", comp.id)).toBe(true);

    // The write under test — no manual invalidateOrgEntitlements call here,
    // unlike the raw-SQL seeding above. This is what proves the FIX, not
    // just the seed.
    const patched = await patchCompetition(auth, comp.id, { status: "completed" });
    expect(patched.status).toBe("completed");

    // Pre-#287 this reads the 300s-TTL entry warmed above and wrongly stays
    // true for up to 5 minutes even though the competition is now terminal.
    expect(await hasFeature(auth.orgId, "realtime", comp.id)).toBe(false);
  });
});
