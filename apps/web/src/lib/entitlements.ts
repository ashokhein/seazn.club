import { sql } from "@/lib/db";
import { PaymentRequiredError } from "@/lib/errors";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";

export { PaymentRequiredError } from "@/lib/errors";

type Resolved = { bool_value: boolean | null; int_value: number | null };

// Cache entries wrap the resolved value: a legitimate "deny" resolves to null,
// which is indistinguishable from a cache miss (cacheGet returns null for
// both), so an unwrapped deny would re-query Postgres on every call.
type CacheEntry = { v: Resolved | null };

// Resolved entitlements change only on subscription / override / pass writes,
// so they cache well. Short TTL bounds staleness even if an invalidation is
// missed.
const ENT_TTL_SECONDS = 300;
const entKey = (orgId: string, featureKey: string, competitionId?: string) =>
  competitionId ? `ent:${orgId}:${competitionId}:${featureKey}` : `ent:${orgId}:${featureKey}`;

/**
 * Drop all cached entitlements for an org — both org-wide and
 * competition-scoped keys share the `ent:<org>:` prefix. Call after any
 * subscription, entitlement-override, or Event Pass change.
 */
export async function invalidateOrgEntitlements(orgId: string): Promise<void> {
  await cacheDelPattern(`ent:${orgId}:*`);
}

/**
 * Resolve a single entitlement for an org (cache-aside).
 * Priority (v3/07 §3): org_entitlement_overrides → competition pass (community
 * orgs only, when a competition is in scope) → plan_entitlements → null (deny).
 * Falls back to 'community' plan when no subscription row exists.
 */
async function resolve(
  orgId: string,
  featureKey: string,
  competitionId?: string,
): Promise<Resolved | null> {
  const cached = await cacheGet<CacheEntry>(entKey(orgId, featureKey, competitionId));
  // The `v` check also skips stale pre-wrapper entries (raw Resolved shape).
  if (cached && cached.v !== undefined) return cached.v;

  const fresh = await resolveFromDb(orgId, featureKey, competitionId);
  await cacheSet(entKey(orgId, featureKey, competitionId), { v: fresh }, ENT_TTL_SECONDS);
  return fresh;
}

async function resolveFromDb(
  orgId: string,
  featureKey: string,
  competitionId?: string,
): Promise<Resolved | null> {
  // Expired overrides are dead (v3/08 §1 admin expiry) — ignored here; the
  // admin panel shows and sweeps them.
  const [ov] = await sql<Resolved[]>`
    select bool_value, int_value
    from org_entitlement_overrides
    where org_id = ${orgId} and feature_key = ${featureKey}
      and (expires_at is null or expires_at > now())`;
  if (ov) return ov;

  // A comped plan past its end date resolves as community at read time —
  // no scheduler flips it, the resolution does (bounded by the 5-min cache).
  const [orgPlan] = await sql<{ plan_key: string }[]>`
    select case
      when s.comped_until is not null and s.comped_until <= now()
           and s.stripe_subscription_id is null then 'community'
      else coalesce(s.plan_key, 'community')
    end as plan_key
    from organizations o
    left join subscriptions s on s.org_id = o.id
    where o.id = ${orgId}`;
  const planKey = orgPlan?.plan_key ?? "community";

  // Event Pass (v3/07 §3): lifts a single competition for community orgs
  // only — under any paid plan the pass is deliberately moot (Pro's matrix is
  // a strict superset), which is also what lets it survive a later downgrade.
  // Keys missing from the pass matrix fall through to the plan row, so
  // Pro-only features stay Pro on a passed competition.
  if (planKey === "community" && competitionId) {
    const [pass] = await sql<Resolved[]>`
      select pe.bool_value, pe.int_value
      from competition_passes cp
      join plan_entitlements pe
        on pe.plan_key = cp.pass_key and pe.feature_key = ${featureKey}
      where cp.competition_id = ${competitionId} and cp.org_id = ${orgId}`;
    if (pass) return pass;
  }

  const [pe] = await sql<Resolved[]>`
    select bool_value, int_value
    from plan_entitlements
    where plan_key = ${planKey} and feature_key = ${featureKey}`;
  return pe ?? null;
}

/** Returns true if the org has a boolean feature enabled. */
export async function hasFeature(
  orgId: string,
  featureKey: string,
  competitionId?: string,
): Promise<boolean> {
  const row = await resolve(orgId, featureKey, competitionId);
  return row?.bool_value === true;
}

/**
 * Returns the numeric limit for a metric, or null for unlimited.
 * Returns 0 if the feature key is not in the plan's entitlement matrix.
 */
export async function getLimit(
  orgId: string,
  featureKey: string,
  competitionId?: string,
): Promise<number | null> {
  const row = await resolve(orgId, featureKey, competitionId);
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
  competitionId?: string,
): Promise<{ ok: boolean; limit: number | null }> {
  const limit = await getLimit(orgId, featureKey, competitionId);
  if (limit === null) return { ok: true, limit: null };
  return { ok: wouldBe <= limit, limit };
}

/** Throws PaymentRequiredError (HTTP 402) if the feature is not enabled for the org. */
export async function requireFeature(
  orgId: string,
  featureKey: string,
  competitionId?: string,
): Promise<void> {
  const enabled = await hasFeature(orgId, featureKey, competitionId);
  if (!enabled) throw new PaymentRequiredError(featureKey);
}
