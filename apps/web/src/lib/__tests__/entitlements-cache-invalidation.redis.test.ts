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
import { recordPassPurchase, revokePassForRefundedCharge } from "@/lib/billing";
import type Stripe from "stripe";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "@/server/usecases/competitions";
import { processStripeEvent } from "@/server/usecases/billing-events";
import { setOrgSuspension } from "@/server/usecases/admin-orgs";
import { setOrgPlan } from "./_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;
const HAS_REDIS = !!process.env.REDIS_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Community org an Event Pass can lift (`realtime`: community false, pro
 *  true, event_pass true — same probe key entitlements-sql-parity.test.ts
 *  uses, and for the same reason: V310 made `branding` free for community,
 *  so it can no longer show a pass LIFT). */
async function seedCommunityOrg(): Promise<AuthCtx> {
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
      ends_on: "2030-12-31",
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

  it("recordPassPurchase busts the cache the instant the pass is granted", async () => {
    const auth = await seedCommunityOrg();
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug)
      values (${auth.orgId}, ${"Grant Cup " + randomUUID().slice(0, 6)},
              ${"grant-cup-" + randomUUID().slice(0, 6)}) returning id`;
    await invalidateOrgEntitlements(auth.orgId);

    // Warm the cache on the pre-purchase (deny) answer.
    expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(false);

    await recordPassPurchase({
      orgId: auth.orgId,
      competitionId: compId,
      passKey: "event_pass",
      paymentIntent: `pi_${randomUUID().slice(0, 8)}`,
    });

    // recordPassPurchase already calls invalidateOrgEntitlements
    // (lib/billing.ts:819) — this proves it, doesn't just assert it.
    expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(true);
  });

  it("recordPassPurchase busts the cache on the HEALING replay, not only the winning insert", async () => {
    const auth = await seedCommunityOrg();
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug)
      values (${auth.orgId}, ${"Heal Cup " + randomUUID().slice(0, 6)},
              ${"heal-cup-" + randomUUID().slice(0, 6)}) returning id`;
    const intent = `pi_${randomUUID().slice(0, 8)}`;
    await invalidateOrgEntitlements(auth.orgId);

    // (1) Warm the cache on the pre-purchase DENY — a real 300s entry (denies
    // are cached too; lib/entitlements.ts wraps them `{ v: null }`).
    expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(false);

    // (2) Simulate a FIRST attempt that crashed between the pass insert and the
    // invalidate: the row exists, the warm deny above was never busted. Raw SQL
    // deliberately — going through recordPassPurchase here would bust it and
    // destroy the very state under test.
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${auth.orgId}, ${intent})`;

    // (3) The healing retry — SAME intent, so this is a replay, not a duplicate
    // second charge: it takes the already-existed fallthrough, re-runs the
    // credit grant and returns.
    const result = await recordPassPurchase({
      orgId: auth.orgId,
      competitionId: compId,
      passKey: "event_pass",
      paymentIntent: intent,
    });
    expect(result).toEqual({ recorded: false, duplicateIntent: null });

    // (4) Pre-fix the fallthrough returned WITHOUT invalidating, so the stale
    // deny warmed in (1) outlived the healed purchase for up to 5 minutes —
    // a paid pass that does nothing. The invalidate is now unconditional.
    expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(true);
  });

  it("revokePassForRefundedCharge busts the cache the instant a refund revokes the pass", async () => {
    const auth = await seedCommunityOrg();
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug)
      values (${auth.orgId}, ${"Refund Cup " + randomUUID().slice(0, 6)},
              ${"refund-cup-" + randomUUID().slice(0, 6)}) returning id`;
    const intent = `pi_${randomUUID().slice(0, 8)}`;
    await recordPassPurchase({ orgId: auth.orgId, competitionId: compId, passKey: "event_pass", paymentIntent: intent });
    await invalidateOrgEntitlements(auth.orgId);

    // Warm the cache on the granted (true) answer.
    expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(true);

    const charge = { payment_intent: intent, refunded: true } as unknown as Stripe.Charge;
    expect(await revokePassForRefundedCharge(charge)).toBe(true);

    // revokePassForRefundedCharge already calls invalidateOrgEntitlements
    // (lib/billing.ts:881) — this proves it, doesn't just assert it.
    expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(false);
  });

  // v17 W2 Task 8 (b). The dispute-lost revoke is a SECOND, independent delete
  // of a competition_passes row (billing-events.ts handlePlatformDispute) — it
  // does not go through revokePassForRefundedCharge, so the test above proves
  // nothing about it. platform-dispute.test.ts asserts the row is gone; only a
  // real Redis can show whether the org stops resolving the pass, and a
  // chargeback that leaves 300s of paid-for entitlement behind is the one
  // direction that costs money.
  it("a lost dispute busts the cache the instant it revokes the pass", async () => {
    const auth = await seedCommunityOrg();
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug)
      values (${auth.orgId}, ${"Dispute Cup " + randomUUID().slice(0, 6)},
              ${"dispute-cup-" + randomUUID().slice(0, 6)}) returning id`;
    const intent = `pi_${randomUUID().slice(0, 8)}`;
    await recordPassPurchase({ orgId: auth.orgId, competitionId: compId, passKey: "event_pass", paymentIntent: intent });
    await invalidateOrgEntitlements(auth.orgId);

    // Warm the cache on the granted (true) answer.
    expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(true);

    // The pass branch of handlePlatformDispute matches on payment_intent, so
    // this runs keyless — no Stripe call, no mock (same reason
    // platform-dispute.test.ts's pass tests do).
    await processStripeEvent({
      id: `evt_${randomUUID().slice(0, 12)}`,
      type: "charge.dispute.closed",
      data: {
        object: {
          id: `dp_${randomUUID().slice(0, 8)}`,
          status: "lost",
          amount: 2900,
          currency: "gbp",
          payment_intent: intent,
          charge: `ch_${randomUUID().slice(0, 8)}`,
        },
      },
    } as unknown as Stripe.Event);

    // The row is gone AND the org knows it.
    const [row] = await sql`
      select 1 from competition_passes where stripe_payment_intent = ${intent}`;
    expect(row).toBeUndefined();
    expect(await hasFeature(auth.orgId, "realtime", compId)).toBe(false);
  });

  // v17 W2 Task 9. organizations.status is a RESOLVER INPUT, and the loudest
  // one: `when o.status = 'suspended' then 'community'` is the FIRST arm of
  // both resolvers (orgPlanKey's CASE and org_has_feature's SQL twin). The
  // staff suspend route wrote that column and stopped, so on a Redis-backed
  // target moderation was cosmetic for up to 300s — a suspended org kept
  // serving its paid plan, and (worse for the innocent) a reactivated org
  // stayed degraded just as long after staff had already restored it.
  it("suspending an org busts the cache the instant moderation lands", async () => {
    const auth = await seedCommunityOrg();
    await setOrgPlan(auth.orgId, "pro", "active");
    await invalidateOrgEntitlements(auth.orgId);

    // Warm the cache on the PAID answer (`realtime` is Pro-only).
    expect(await hasFeature(auth.orgId, "realtime")).toBe(true);

    // The write under test, exactly as the route performs it — the route is a
    // thin wrapper over this usecase, so no manual invalidate here.
    expect(
      await setOrgSuspension(auth.userId!, auth.orgId, "suspend", "cache bust probe"),
    ).toBe("suspended");

    // Pre-fix this read the 300s entry warmed above: suspended on paper,
    // fully entitled in practice.
    expect(await hasFeature(auth.orgId, "realtime")).toBe(false);

    // And the same in the direction that harms the org rather than us: staff
    // lift the suspension, the org must be whole again immediately.
    expect(
      await setOrgSuspension(auth.userId!, auth.orgId, "reactivate", "cache bust probe"),
    ).toBe("active");
    expect(await hasFeature(auth.orgId, "realtime")).toBe(true);
  });

  it("refuses an org id that matched nothing, instead of logging a moderation that never happened", async () => {
    // The suspend route looks the org up and 404s before calling this, so the
    // update always matches TODAY. That guard belongs to the route, though, and
    // the next caller — a cron, a staff script, a second route — inherits none
    // of it. Without a rowcount check the use case updates zero rows and then
    // carries on regardless: it busts a cache, writes a staff-action log naming
    // an org it never touched, and RETURNS the new status as though it had been
    // applied. The audit trail is the thing that must not be able to lie.
    const ghost = randomUUID();
    await expect(setOrgSuspension(ghost, ghost, "suspend", "no such org")).rejects.toThrow(
      /no organization/i,
    );
    const [logged] = await sql`
      select 1 from staff_audit_log where target_id = ${ghost}`;
    expect(logged).toBeUndefined();
  });
});
