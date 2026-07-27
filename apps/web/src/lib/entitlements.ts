import { sql } from "@/lib/db";
import { PaymentRequiredError } from "@/lib/errors";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";
import { walletIdFor } from "@/lib/credits";
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
 * Drop cached entitlements for EVERY org billing through a subscription.
 *
 * Cache keys are per-org (`ent:<org>:…`) but the plan behind them is now per
 * GROUP, so a plan change, cancel, or dunning transition on a three-org group
 * would otherwise leave two orgs serving the old plan for up to the 300s TTL.
 * Any write that touches a subscription row must call this, not
 * invalidateOrgEntitlements — org-scoped writes (overrides, Event Passes) keep
 * the single-org version, because those genuinely affect one org.
 *
 * Reads the membership itself rather than taking a caller-supplied list: the
 * caller that just cancelled a subscription generally knows one org, and the
 * whole point is the ones it does not know about.
 */
export async function invalidateGroupEntitlements(subscriptionId: string): Promise<void> {
  const orgs = await sql<{ id: string }[]>`
    select id from organizations where subscription_id = ${subscriptionId}`;
  await Promise.all(orgs.map((o) => invalidateOrgEntitlements(o.id)));
}

/** Fan out from an org to every sibling org sharing its subscription. */
export async function invalidateEntitlementsForOrgGroup(orgId: string): Promise<void> {
  const [row] = await sql<{ subscription_id: string | null }[]>`
    select subscription_id from organizations where id = ${orgId}`;
  if (row?.subscription_id) await invalidateGroupEntitlements(row.subscription_id);
  else await invalidateOrgEntitlements(orgId);
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
 * offer a downgrade (event_pass grants 128 entrants per division against pro's
 * 256, and neither pass rung lifts player stats, the brand colour, officials or
 * API access at all).
 *
 * Note what this is NOT: `hasLiveSubscription`. That answers "is Stripe billing
 * this org", which is false for a staff comp — an org holding the Pro matrix
 * with no Stripe subscription at all. Paid-ness is about the resolved plan,
 * never about the presence of a Stripe id.
 */
export function isPaidPlan(planKey: string): boolean {
  return planKey !== "community";
}

/** A subscription whose row still claims a paid plan (`pro`/`pro_plus`) while
 *  the resolver has degraded it to community — a lapsed trial, an expired staff
 *  comp, or exhausted dunning. The billing page uses this to show the RESOLVED
 *  plan plus a resubscribe path for such an org, instead of the stale
 *  "Pro / trialing" the raw row would print. Pure so the display logic is
 *  unit-testable without a DB. */
export function isPlanLapsed(
  rawPlanKey: string | null | undefined,
  effectivePlanKey: string,
): boolean {
  return isPaidPlan(rawPlanKey ?? "community") && !isPaidPlan(effectivePlanKey);
}

/** Grace period (days) an Event Pass keeps applying AFTER its competition's
 *  ends_on date, before the ended-competition lock (arm B) fires. SPEC-4 §7.2. */
export const PASS_END_GRACE_DAYS = 7;

/**
 * Is an Event Pass no longer eligible to apply because its competition is over?
 * (v17 SPEC-4 §7, the "hybrid" lifecycle rule, mapped to the real competition
 * status vocabulary.)
 *
 * Compute-at-read (SPEC §13.1): NO column on competition_passes, no status
 * write-back, no auto-archiving — the answer is derived from the competition's
 * live `status` and `ends_on` every time. The pass ROW is never deleted; this is
 * runtime eligibility only.
 *
 *   A (terminal):  status in {completed, archived} — SPEC §7's terminal set, and
 *                  both are reachable: a finished competition is set to
 *                  'completed' (usecases/competitions.ts) and archived to
 *                  'archived'. The active set is {draft, published, live} (V270).
 *   B (long-ended): ends_on is set AND ends_on + PASS_END_GRACE_DAYS < today.
 *                   A date-only comparison (ends_on is a DATE), grace 7 days.
 *
 * Kept exactly in step with the SQL resolver's pass arm (org_has_feature, V328,
 * grace boundary moved to UTC in V334):
 * `not (c.status in ('archived','completed') or (c.ends_on is not null and
 * c.ends_on + interval '7 days' < (now() at time zone 'utc')::date))`. Both
 * sides now compare against the UTC calendar date — the SQL used to compare
 * against bare `current_date` (the DB session's TimeZone GUC, Europe/London in
 * production), which could disagree with this function's UTC computation for
 * an up-to-1h window around UTC midnight; V334 aligned SQL to this function's
 * basis rather than the other way round. The entitlements-sql-parity suite is
 * the tie. Exported so the OFFER side can reuse it later; this task wires no
 * other call site.
 */
export function isPassLocked(status: string, endsOn: Date | string | null): boolean {
  if (status === "archived" || status === "completed") return true;
  if (endsOn == null) return false;
  // ends_on is a DATE; the postgres driver hands it back as a Date at UTC
  // midnight, and `new Date('YYYY-MM-DD')` also parses to UTC midnight, so UTC
  // getters give a stable day-number for either shape.
  const end = endsOn instanceof Date ? endsOn : new Date(endsOn);
  const endMs = end.getTime();
  if (Number.isNaN(endMs)) return false;
  const graceEndMs = endMs + PASS_END_GRACE_DAYS * 86_400_000;
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return graceEndMs < todayMs;
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
      -- Negating the live list is WIDER than the old "status = canceled" test.
      -- It used to also fire for 'suspended' on this row; since V314 §2b
      -- NOTHING writes that status (staff suspension moved to
      -- organizations.status, and V314 reset the rows the old route left behind
      -- to 'active'), so that arm is now reachable only by genuinely dead
      -- subscriptions. Suspension is handled by the org branch below instead.
      --
      -- MODERATION, not billing: a suspended ORG resolves community regardless
      -- of what its group pays for. This is deliberately scoped to the one org —
      -- the group keeps billing, keeps its plan, and every sibling org is
      -- untouched, because a moderator suspending one club must not degrade
      -- other people's clubs that happen to share a payer. It also restores the
      -- bite suspension lost when it stopped writing subscriptions.status.
      when o.status = 'suspended' then 'community'
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
      -- Trial-end backstop: a trialing sub whose trial ended over a day ago is a
      -- MISSED transition webhook (Stripe moves trialing→active/past_due/canceled at
      -- trial_end). The resolver stops trusting the stale status, cron-free, the same
      -- way the past_due arm above does. 1-day grace absorbs Stripe's transition lag.
      -- trial_end IS null on a never-trialed sub → guard it so those stay on plan.
      when s.status = 'trialing'
           and s.trial_end is not null
           and s.trial_end <= now() - interval '1 day'
           then 'community'
      -- A never-paid subscription conveys NO plan. 'incomplete' means the FIRST
      -- invoice never succeeded (an abandoned 3DS challenge, a declined card at
      -- the sheet). It used to fold into past_due and so inherited the 14-day
      -- grace: full Pro, paid for nothing, until Stripe expired it ~23h later
      -- (#206/#223-B). The past_due grace is for a subscription that WAS active
      -- and then a renewal failed; a first payment that never landed gets none.
      when s.status = 'incomplete' then 'community'
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
      -- would resurrect liveness and break the comp-expiry branch above). So a
      -- cancelled status plus a staff comp is a legitimate grant, and degrading
      -- it here would revoke every comp handed to an org that once subscribed.
      --
      -- The guard is comped_at, NOT comped_until: a forever-comp writes
      -- comped_until = null, so a null-comped_until test cannot tell an
      -- indefinite comp from a row that never had one. V313 added comped_at for
      -- exactly this. A LAPSED comp is already community via the first arm.
      when s.status = 'canceled' and s.comped_at is null
           then 'community'
      else coalesce(s.plan_key, 'community')
    end as plan_key
    from organizations o
    left join subscriptions s on s.id = o.subscription_id
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

  // Plan row first: it is the base whenever no pass applies AND the fall-through
  // the pass overlay below coalesces into — a pass that answers null on a bool
  // is no answer, not a deny, and must resolve to the plan's bool (org_has_feature
  // does exactly this in SQL). Fetching it unconditionally is behaviour-neutral:
  // the old code reached the same query on every path a pass did not fully own.
  const [planRow] = await sql<Resolved[]>`
    select bool_value, int_value
    from plan_entitlements
    where plan_key = ${planKey} and feature_key = ${featureKey}`;
  let base: Resolved | null = planRow ?? null;

  // Event Pass (v3/07 §3): lifts a single competition for community orgs
  // only — under any paid plan the pass is deliberately moot (Pro's matrix is
  // a strict superset), which is also what lets it survive a later downgrade.
  // Keys missing from the pass matrix fall through to the plan row, so
  // Pro-only features stay Pro on a passed competition.
  //
  // `isPaidPlan` is the same predicate the competition layout uses to decide
  // whether to OFFER a pass, on purpose: "the pass does nothing here" and
  // "stop selling the pass here" must never be able to disagree.
  if (!isPaidPlan(planKey) && competitionId) {
    // Also load the competition's lifecycle so a pass on an ARCHIVED or
    // long-ended competition stops applying (v17 SPEC-4 §7). Compute-at-read:
    // the competitions row is joined live, never a stored flag. The lock mirrors
    // org_has_feature (V328); entitlements-sql-parity is the tie.
    const [pass] = await sql<
      (Resolved & { status: string; ends_on: Date | string | null })[]
    >`
      select pe.bool_value, pe.int_value, c.status, c.ends_on
      from competition_passes cp
      join competitions c on c.id = cp.competition_id
      join plan_entitlements pe
        on pe.plan_key = cp.pass_key and pe.feature_key = ${featureKey}
      where cp.competition_id = ${competitionId} and cp.org_id = ${orgId}`;
    if (pass && !isPassLocked(pass.status, pass.ends_on)) {
      // Overlay field by field, EXACTLY as the override arm below and as the SQL
      // resolver's coalesce (org_has_feature, V306): a null pass bool_value is no
      // answer and falls THROUGH to the plan bool, never a deny. int_value stays
      // wholesale — a null pass int is UNLIMITED, a load-bearing answer on that
      // column, not "unset". Skipping the coalesce is what let TS deny a feature
      // the plan grants while SQL allowed it (issue #209).
      base = {
        bool_value: pass.bool_value ?? base?.bool_value ?? null,
        int_value: pass.int_value,
      };
    }
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
 * The ADDITIVE add-on axis (SPEC-2 §3, §11.3, V323): capacity purchased (or
 * admin-granted) on TOP of the plan's base cap. Sums `delta_each · qty` over
 * the org's non-canceled add-on rows whose target matches, so
 * effective_cap = plan_base + bonus.
 *
 * Keyed by the org's WALLET (`coalesce(group_subscription_id, org_id)`, the
 * same billing entity `lib/credits` charges), because an add-on is bought by
 * the group payer once and lifts every org on the wallet — unless
 * `target_org_id` narrows it to one org. `status in ('active','granted')` is
 * the count set: 'active' (Stripe-paid) and 'granted' (admin) both lift the
 * cap; 'canceled' is frozen-not-deleted and does not.
 *
 * Scope (SPEC-2 §11.3): a null `target_org_id` is group-wide, a null
 * `target_competition_id` is any-comp. When `competitionId` is undefined — an
 * org-level cap like members.max — `target_competition_id = null` cannot match
 * a comp-scoped row, so ONLY any-comp rows count: a comp-scoped size pack must
 * never lift an org-level cap.
 *
 * Deliberately UNCACHED (unlike `resolve()`): a just-purchased seat must lift
 * the cap on the very next check, and a just-canceled one must drop it, without
 * waiting out the 300s entitlement TTL — which is exactly why the caller
 * (`getLimit`) sums this after `resolve()` returns, not inside it.
 */
async function addonBonus(
  orgId: string,
  featureKey: string,
  competitionId?: string,
): Promise<number> {
  const walletId = await walletIdFor(orgId);
  const [r] = await sql<{ bonus: number }[]>`
    select coalesce(sum(delta_each * qty), 0)::int as bonus
      from org_addons
     where wallet_id = ${walletId}
       and feature_key = ${featureKey}
       and status in ('active', 'granted')
       and (target_org_id is null or target_org_id = ${orgId})
       and (target_competition_id is null or target_competition_id = ${competitionId ?? null})`;
  return r?.bonus ?? 0;
}

/**
 * Returns the numeric limit for a metric, or null for unlimited.
 * Returns 0 if the feature key is not in the plan's entitlement matrix.
 *
 * The single int-reader path (`withinLimit`/`requireFeature`-adjacent callers
 * all funnel through here), so the add-on layer lives here and nowhere else:
 * `resolve()` gives the cached plan base, then `addonBonus` adds any purchased
 * capacity on top. A null base is UNLIMITED and short-circuits BEFORE the
 * add-on query — an add-on can never turn unlimited into a finite number.
 */
export async function getLimit(
  orgId: string,
  featureKey: string,
  competitionId?: string,
): Promise<number | null> {
  const row = await resolve(orgId, featureKey, competitionId);
  const base = row ? row.int_value : 0;
  if (base === null) return null;
  const bonus = await addonBonus(orgId, featureKey, competitionId);
  return base + bonus;
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
