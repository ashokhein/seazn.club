import { sql } from "@/lib/db";
import { PaymentRequiredError } from "@/lib/errors";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";
// Leaf module, NOT lib/billing.ts: billing imports invalidateOrgEntitlements
// from here, so importing it back would close a cycle.
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status";

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
 * The override wins FIELD BY FIELD, not wholesale: a null column is no answer,
 * not a deny, and falls through — same as the SQL resolver's coalesce.
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

/**
 * Does this plan key pay us anything? The ONE predicate for "paid org".
 *
 * It is deliberately the same test the pass arm of `resolveFromDb` applies:
 * under any paid plan the Event Pass is moot, because every key the pass lifts
 * the paid matrix lifts further. Anything that decides whether to OFFER a pass
 * must therefore ask exactly this question of exactly this plan key, or it will
 * offer a $29 downgrade (event_pass grants 10 AI runs per division against
 * pro's 20, and 64 entrants per division against pro's 256).
 *
 * Note what this is NOT: `hasLiveSubscription`. That answers "is Stripe billing
 * this org", which is false for a staff comp — an org holding the Pro matrix
 * with no Stripe subscription at all. Paid-ness is about the resolved plan,
 * never about the presence of a Stripe id.
 */
export function isPaidPlan(planKey: string): boolean {
  return planKey !== "community";
}

/**
 * The org's plan AS THE RESOLVER SEES IT — after the read-time degradations,
 * which is the only version that predicts what an entitlement read will do.
 *
 * `subscriptions.plan_key` raw is not this: a lapsed staff comp and a past_due
 * subscription 14 days into dunning both still carry `plan_key = 'pro'` on the
 * row while resolving as community. Callers deciding what to SELL need the
 * resolved answer, or they refuse a pass to an org whose entitlements the pass
 * would genuinely lift.
 *
 * Exported so surfaces outside the entitlement path (the competition layout,
 * which must tell its gates whether a pass is worth offering) share this
 * derivation instead of re-writing it. The app has already paid for three
 * divergent copies of it once — see `__tests__/entitlements-duplicate-resolvers`.
 *
 * NOT cached: `resolve()` caches whole entitlement answers a layer above, and a
 * second TTL here would let a plan change and its entitlements disagree.
 */
export async function orgPlanKey(orgId: string): Promise<string> {
  // A comped plan past its end date resolves as community at read time —
  // no scheduler flips it, the resolution does (bounded by the 5-min cache).
  const [orgPlan] = await sql<{ plan_key: string }[]>`
    select case
      -- A comp/grant past its end date resolves as community at read time — no
      -- scheduler flips it, the resolution does. A CANCELLED subscription keeps
      -- its id forever, so an is-null test alone would leave a win-back grant
      -- running for ever; a live subscription still owns the plan, so exempt.
      -- The status list is INTERPOLATED from LIVE_SUBSCRIPTION_STATUSES (the
      -- same set hasLiveSubscription uses), so the two can no longer drift —
      -- negated rather than listing the dead statuses, which would drift.
      -- coalesce is load-bearing: a bare NOT IN over a null status yields NULL,
      -- not true, so the arm would silently never fire for rows with no status.
      -- BEHAVIOUR CHANGE (deliberate): negating the live list is WIDER than the
      -- old "status = canceled" test — it also fires for 'suspended', which is
      -- written in-app by the staff suspend route and never restored on
      -- reactivate. A suspended org's lapsed comp therefore now degrades where
      -- before it kept running. That is the intent: suspension is not billing.
      when s.comped_until is not null and s.comped_until <= now()
           and (s.stripe_subscription_id is null
                or coalesce(s.status, '') not in ${sql([...LIVE_SUBSCRIPTION_STATUSES])})
           then 'community'
      -- past_due grace (spec P1-6): dunning gets 14 days, then reads degrade to
      -- community until an invoice succeeds (which flips status back to active).
      -- Anchored on the TRANSITION (status_changed_at): dunning retries touch
      -- updated_at and must not re-arm the window. Coalesce covers rows the
      -- V291 backfill never saw.
      when s.status = 'past_due'
           and coalesce(s.status_changed_at, s.updated_at) <= now() - interval '14 days'
           then 'community'
      -- A CANCELLED subscription does not convey its plan. Without this arm the
      -- only thing standing between a departed org and permanent Pro is the
      -- customer.subscription.deleted handler having run and written
      -- plan_key = 'community' (billing-events.ts) — and a webhook that must
      -- not be missed is a webhook that will be.
      --
      -- The leak this closes: dunning exhausts, Stripe cancels, the deleted
      -- event goes astray, so the row still reads past_due. needsRenewalResync
      -- fires on ANY past_due row (lib/billing-manage.ts), the billing page
      -- re-syncs from the live subscription, and syncSubscription rewrites
      -- plan_key from the subscription's PRICE — which a cancelled subscription
      -- still carries. The row lands on status='canceled', plan_key='pro', and
      -- needsRenewalResync returns false for canceled, so nothing ever revisits
      -- it. Free Pro, for ever, triggered by the owner opening their own
      -- billing page.
      --
      -- The comp guard is load-bearing, not defensive: compOrg deliberately
      -- LEAVES a dead subscription's cancelled status in place
      -- (admin-plan.ts — writing a live-looking status onto a departed row
      -- would resurrect liveness and break the comp-expiry branch above). So
      -- a cancelled status + a comp still running is a legitimate staff grant, and
      -- degrading it here would revoke every comp handed to an org that once
      -- subscribed. A LAPSED comp is already community via the first arm.
      when s.status = 'canceled'
           and (s.comped_until is null or s.comped_until <= now())
           then 'community'
      else coalesce(s.plan_key, 'community')
    end as plan_key
    from organizations o
    left join subscriptions s on s.org_id = o.id
    where o.id = ${orgId}`;
  return orgPlan?.plan_key ?? "community";
}

async function resolveFromDb(
  orgId: string,
  featureKey: string,
  competitionId?: string,
): Promise<Resolved | null> {
  // Plan first: both the pass branch and the override overlay need it, and it
  // must be resolved exactly once.
  const planKey = await orgPlanKey(orgId);

  // Event Pass (v3/07 §3): lifts a single competition for community orgs
  // only — under any paid plan the pass is deliberately moot (Pro's matrix is
  // a strict superset), which is also what lets it survive a later downgrade.
  // Keys missing from the pass matrix fall through to the plan row, so
  // Pro-only features stay Pro on a passed competition.
  //
  // `isPaidPlan` is the same predicate the competition layout uses to decide
  // whether to OFFER a pass, on purpose: "the pass does nothing here" and
  // "stop selling the pass here" must never be able to disagree.
  let base: Resolved | null = null;
  if (!isPaidPlan(planKey) && competitionId) {
    const [pass] = await sql<Resolved[]>`
      select pe.bool_value, pe.int_value
      from competition_passes cp
      join plan_entitlements pe
        on pe.plan_key = cp.pass_key and pe.feature_key = ${featureKey}
      where cp.competition_id = ${competitionId} and cp.org_id = ${orgId}`;
    base = pass ?? null;
  }
  if (!base) {
    const [pe] = await sql<Resolved[]>`
      select bool_value, int_value
      from plan_entitlements
      where plan_key = ${planKey} and feature_key = ${featureKey}`;
    base = pe ?? null;
  }

  // A live override wins — but a null `bool_value` is NO ANSWER, not a deny, so
  // it falls through to the base. That is exactly the SQL resolver's coalesce
  // (org_has_feature, V306), and it is what stops an int-only override (say a
  // raised quota) from silently switching the feature itself off.
  //
  // `int_value` is NOT coalesced, deliberately. A null int_value is a real,
  // load-bearing answer on this column: it means UNLIMITED (lib/auth.ts:216,
  // and the admin route writes `int_value ?? null` for exactly that grant).
  // Falling a null int through to the plan row would turn every staff
  // "unlimited" grant back into the plan's number. The asymmetry is the schema's,
  // not ours: only bool_value overloads null as "unset". org_has_feature returns
  // a boolean and never reads int_value, so nothing here can drift from SQL.
  //
  // Expired overrides are dead (v3/08 §1 admin expiry) — ignored here; the
  // admin panel shows and sweeps them.
  const [ov] = await sql<Resolved[]>`
    select bool_value, int_value
    from org_entitlement_overrides
    where org_id = ${orgId} and feature_key = ${featureKey}
      and (expires_at is null or expires_at > now())`;
  if (!ov) return base;
  return {
    bool_value: ov.bool_value ?? base?.bool_value ?? null,
    int_value: ov.int_value,
  };
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
 * Returns true if the feature is enabled for the org on ANY competition it
 * holds an Event Pass for (or org-wide, which subsumes every competition).
 *
 * For ORG-LEVEL surfaces only — the ones with no single competition in scope,
 * where a competition list on screen is a PICKER and not a scope. Threading an
 * arbitrary id off such a list would be a lie; asking `hasFeature` without one
 * makes a paid pass invisible (the pass arm above only fires with a competition
 * in hand, which is how `sponsors.tiers` and `sponsors.monetize` shipped as a
 * permanent upsell for orgs that had already bought them). Neither is right, so
 * this asks the only question the surface can honestly ask: is this reachable
 * ANYWHERE?
 *
 * Use it for AFFORDANCES, never for enforcement. The write path must still
 * resolve the competition actually being written — usecases/sponsors.ts does —
 * or a pass on one competition silently unlocks the whole org, which is the
 * exact leak the pass-scoping guard exists to prevent.
 *
 * Per-competition resolution goes through `hasFeature`, so the override layer
 * and plan fallback stay identical to every other read (a staff deny beats a
 * pass, and must beat it here too). The org-wide answer is asked first: it
 * short-circuits every paid plan without touching competition_passes at all.
 */
export async function hasFeatureOnAnyPass(orgId: string, featureKey: string): Promise<boolean> {
  if (await hasFeature(orgId, featureKey)) return true;
  const passes = await sql<{ competition_id: string }[]>`
    select competition_id from competition_passes where org_id = ${orgId}`;
  for (const { competition_id } of passes) {
    if (await hasFeature(orgId, featureKey, competition_id)) return true;
  }
  return false;
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
