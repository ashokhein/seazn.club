import { sql } from "@/lib/db";
import { PaymentRequiredError } from "@/lib/errors";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";

export { PaymentRequiredError } from "@/lib/errors";

type Resolved = { bool_value: boolean | null; int_value: number | null };

// Cache entries wrap the resolved value: a legitimate "deny" resolves to null,
// which is indistinguishable from a cache miss (cacheGet returns null for
// both), so an unwrapped deny would re-query Postgres on every call.
type CacheEntry = { v: Resolved | null };

// Resolved entitlements change only on subscription / override writes, so they
// cache well. Short TTL bounds staleness even if an invalidation is missed.
const ENT_TTL_SECONDS = 300;
const entKey = (orgId: string, featureKey: string) => `ent:${orgId}:${featureKey}`;

/**
 * Drop all cached entitlements for an org. Call after any subscription or
 * entitlement-override change (Stripe webhook, admin override).
 */
export async function invalidateOrgEntitlements(orgId: string): Promise<void> {
  await cacheDelPattern(`ent:${orgId}:*`);
}

/**
 * Resolve a single entitlement for an org (cache-aside).
 * Priority: org_entitlement_overrides → plan_entitlements → null (deny).
 * Falls back to 'community' plan when no subscription row exists.
 */
async function resolve(orgId: string, featureKey: string): Promise<Resolved | null> {
  const cached = await cacheGet<CacheEntry>(entKey(orgId, featureKey));
  // The `v` check also skips stale pre-wrapper entries (raw Resolved shape).
  if (cached && cached.v !== undefined) return cached.v;

  const fresh = await resolveFromDb(orgId, featureKey);
  await cacheSet(entKey(orgId, featureKey), { v: fresh }, ENT_TTL_SECONDS);
  return fresh;
}

async function resolveFromDb(orgId: string, featureKey: string): Promise<Resolved | null> {
  const [ov] = await sql<Resolved[]>`
    select bool_value, int_value
    from org_entitlement_overrides
    where org_id = ${orgId} and feature_key = ${featureKey}`;
  if (ov) return ov;

  const [pe] = await sql<Resolved[]>`
    select pe.bool_value, pe.int_value
    from plan_entitlements pe
    join (
      select coalesce(s.plan_key, 'community') as plan_key
      from organizations o
      left join subscriptions s on s.org_id = o.id
      where o.id = ${orgId}
    ) sub on sub.plan_key = pe.plan_key
    where pe.feature_key = ${featureKey}`;
  return pe ?? null;
}

/** Returns true if the org has a boolean feature enabled. */
export async function hasFeature(orgId: string, featureKey: string): Promise<boolean> {
  const row = await resolve(orgId, featureKey);
  return row?.bool_value === true;
}

/**
 * Returns the numeric limit for a metric, or null for unlimited.
 * Returns 0 if the feature key is not in the plan's entitlement matrix.
 */
export async function getLimit(orgId: string, featureKey: string): Promise<number | null> {
  const row = await resolve(orgId, featureKey);
  if (!row) return 0;
  return row.int_value;
}

/**
 * Checks whether performing an action that would bring a count to `wouldBe`
 * is within the org's plan limit for `featureKey`.
 * The caller is responsible for querying the current count.
 */
export async function withinLimit(
  orgId: string,
  featureKey: string,
  wouldBe: number,
): Promise<{ ok: boolean; limit: number | null }> {
  const limit = await getLimit(orgId, featureKey);
  if (limit === null) return { ok: true, limit: null };
  return { ok: wouldBe <= limit, limit };
}

/** Throws PaymentRequiredError (HTTP 402) if the feature is not enabled for the org. */
export async function requireFeature(orgId: string, featureKey: string): Promise<void> {
  const enabled = await hasFeature(orgId, featureKey);
  if (!enabled) throw new PaymentRequiredError(featureKey);
}
