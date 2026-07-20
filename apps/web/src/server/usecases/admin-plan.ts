import "server-only";
// Admin plan tools (v3/08 §1): comp-to-Pro, downgrade with freeze preview,
// trial extension that keeps Stripe in agreement. Every action takes a
// reason and lands in staff_audit_log with before→after detail — the panel
// renders that history, so nothing here is silent.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { downgradeToCommunity, hasLiveSubscription } from "@/lib/billing";
import { getStripe } from "@/lib/stripe";
import { logStaffAction } from "@/lib/admin";
import {
  ACTIVE_COMPETITION_STATUSES,
  selectFrozen,
} from "@/server/usecases/entitlement-freeze";

interface SubRow {
  plan_key: string;
  status: string;
  trial_end: string | null;
  comped_until: string | null;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

export interface PlanPanel extends SubRow {
  /** Where the plan comes from: a Stripe subscription or an admin comp. */
  source: "stripe" | "comped" | "none";
}

export async function planPanel(orgId: string): Promise<PlanPanel> {
  const [sub] = await sql<SubRow[]>`
    select plan_key, status, trial_end, comped_until, current_period_end,
           stripe_customer_id, stripe_subscription_id
    from subscriptions where org_id = ${orgId}`;
  if (!sub) {
    return {
      plan_key: "community", status: "active", trial_end: null, comped_until: null,
      current_period_end: null, stripe_customer_id: null, stripe_subscription_id: null,
      source: "none",
    };
  }
  // Liveness, not mere presence: a cancelled subscription keeps its id for
  // ever, and that org's plan is no longer sourced from Stripe.
  // Any PAID plan without a live subscription is a comp — an org comped at
  // pro_plus is just as comped as one at pro.
  const source = hasLiveSubscription(sub)
    ? "stripe"
    : sub.plan_key === "pro" || sub.plan_key === "pro_plus"
      ? "comped"
      : "none";
  return { ...sub, source };
}

/** Comp an org to Pro until a date (or forever). Refuses Stripe-billed orgs —
 *  their plan belongs to the subscription lifecycle, not to us. Also burns the
 *  org's one trial (V277): a comp IS free Pro, so it stamps trial_used_at and
 *  a later self-serve upgrade bills from day one. The first comp's date wins. */
export async function compToPro(
  actorId: string,
  orgId: string,
  until: Date | null,
  reason: string,
): Promise<void> {
  const before = await planPanel(orgId);
  // A DEPARTED org keeps its cancelled subscription id, so presence alone would
  // wrongly refuse it a win-back comp. Only a LIVE subscription owns the plan.
  if (hasLiveSubscription(before)) {
    throw new HttpError(400, "This org is billed through Stripe — adjust the subscription there.");
  }
  if (until && until.getTime() <= Date.now()) {
    throw new HttpError(400, "The end date must be in the future.");
  }
  await sql`
    update subscriptions set
      plan_key = 'pro',
      -- status only moves when there is NO subscription id at all. A departed
      -- org keeps its dead id, and writing a live-looking status onto that row
      -- would resurrect liveness: the resolver's comp-expiry branch could never
      -- fire (the comp would never lapse), checkout would 409 and downgrade
      -- would 400. So a cancelled status stands. Same shape as extendTrial.
      status = case when stripe_subscription_id is null then 'active' else status end,
      comped_until = ${until ? until.toISOString() : null},
      -- A comp IS the free ride: the org has had Pro without paying, so a
      -- later self-serve upgrade bills from day one. coalesce keeps the first
      -- comp's date across re-comps. Reversible via Restore trial.
      trial_used_at = coalesce(trial_used_at, now()),
      status_changed_at = case when stripe_subscription_id is null
                                    and status is distinct from 'active'
                               then now() else status_changed_at end,
      updated_at = now()
    where org_id = ${orgId}`;
  await invalidateOrgEntitlements(orgId);
  await logStaffAction(actorId, "comp_to_pro", "org", orgId, {
    reason,
    before: { plan_key: before.plan_key, comped_until: before.comped_until },
    after: { plan_key: "pro", comped_until: until?.toISOString() ?? "forever" },
  });
}

export interface FreezePreview {
  limit: number | null;
  active: number;
  /** Competitions that would become read-only, most-stale first. */
  frozen: { id: string; name: string }[];
}

/** What an immediate downgrade would freeze (v3/08 §1 — shown BEFORE the
 *  confirm). Community limits applied to the org's active competitions. */
export async function downgradeFreezePreview(orgId: string): Promise<FreezePreview> {
  // The community limit, not the org's current one — that's the target plan.
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
    where plan_key = 'community' and feature_key = 'competitions.max_active'`;
  const limit = row ? row.int_value : (await getLimit(orgId, "competitions.max_active"));
  const candidates = await sql<{ id: string; name: string; last_active: string }[]>`
    select c.id, c.name,
           greatest(c.created_at, coalesce(max(e.recorded_at), c.created_at)) as last_active
    from competitions c
    left join divisions d on d.competition_id = c.id
    left join fixtures f on f.division_id = d.id
    left join score_events e on e.fixture_id = f.id
    where c.org_id = ${orgId} and c.status in ${sql([...ACTIVE_COMPETITION_STATUSES])}
    group by c.id, c.name, c.created_at`;
  const frozenIds = selectFrozen(
    candidates.map((c) => ({ id: c.id, lastActiveAt: c.last_active })),
    limit,
  );
  return {
    limit,
    active: candidates.length,
    frozen: candidates.filter((c) => frozenIds.has(c.id)).map(({ id, name }) => ({ id, name })),
  };
}

/** Immediate downgrade to Community (comped orgs only — reuses the one
 *  downgrade path; Stripe orgs must cancel through the portal). */
export async function adminDowngrade(
  actorId: string,
  orgId: string,
  reason: string,
): Promise<FreezePreview> {
  const before = await planPanel(orgId);
  const preview = await downgradeFreezePreview(orgId);
  await downgradeToCommunity(orgId); // throws 400 for Stripe-billed orgs
  await sql`update subscriptions set comped_until = null where org_id = ${orgId}`;
  await logStaffAction(actorId, "admin_downgrade", "org", orgId, {
    reason,
    before: { plan_key: before.plan_key },
    after: { plan_key: "community", frozen: preview.frozen.map((f) => f.name) },
  });
  return preview;
}

/** Extend (or start) a trial. Writes trial_end in-app and, when a Stripe
 *  subscription exists, pushes the same trial_end so Stripe agrees. Also burns
 *  the org's one trial (V277): a staff-granted trial stamps trial_used_at, so
 *  checkout offers no second one. The first grant's date survives extensions. */
export async function extendTrial(
  actorId: string,
  orgId: string,
  days: number,
  reason: string,
): Promise<string> {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new HttpError(400, "Trial extension must be 1–365 days.");
  }
  const before = await planPanel(orgId);
  const live = hasLiveSubscription(before);
  // Verified against Stripe test mode 2026-07-20: pushing trial_end onto an
  // ACTIVE subscription is accepted but TRUNCATES the paid period to the trial
  // end and rewrites the next invoice (a $19/mo sub paid to 20 Aug came back
  // with period_end 27 Jul and a 429 preview). Dunning is refused for the same
  // reason — the subscription owns the billing timeline either way. Guarded
  // before any write and before any Stripe call: this arm changes nothing.
  if (live && before.status !== "trialing") {
    throw new HttpError(
      400,
      "This organization is billed through Stripe — apply a coupon or credit in Stripe instead.",
    );
  }

  const base = before.trial_end && new Date(before.trial_end).getTime() > Date.now()
    ? new Date(before.trial_end)
    : new Date();
  const trialEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  const iso = trialEnd.toISOString();

  if (live) {
    // Mid-trial on Stripe: push their trial_end so the first charge moves. The
    // plan already came from the price, and comped_until stays out of it — the
    // subscription owns this org's lifecycle.
    await getStripe().subscriptions.update(before.stripe_subscription_id, {
      trial_end: Math.floor(trialEnd.getTime() / 1000),
      proration_behavior: "none",
    });
    await sql`
      update subscriptions set
        status = 'trialing', trial_end = ${iso},
        -- One trial per org (V277) counts staff-granted trials too: without
        -- this stamp the org could downgrade and take a fresh 14-day checkout
        -- trial. coalesce keeps the FIRST grant's date across extensions, and
        -- the syncSubscription upsert coalesces the same way, so Stripe agrees.
        trial_used_at = coalesce(trial_used_at, now()),
        status_changed_at = case when status is distinct from 'trialing'
                                 then now() else status_changed_at end,
        updated_at = now()
      where org_id = ${orgId}`;
  } else {
    // No live subscription: the grant has to CONVEY Pro, because entitlements
    // resolve on plan_key — status/trial_end grant nothing. comped_until is the
    // expiry the resolver already honours, so nothing needs to sweep it. Only
    // lift a community org; an org comped at pro_plus must not be demoted.
    //
    // status only moves to 'trialing' when there is NO subscription id at all.
    // A departed org keeps its dead id, and writing a live-looking status onto
    // that row would make the next call take the Stripe arm (updating a dead
    // subscription), block checkout, and hide the grant from the resolver's
    // comp-expiry branch — so its cancelled status stands.
    await sql`
      update subscriptions set
        plan_key = case when plan_key = 'community' then 'pro' else plan_key end,
        status = case when stripe_subscription_id is null then 'trialing' else status end,
        trial_end = ${iso}, comped_until = ${iso},
        trial_used_at = coalesce(trial_used_at, now()),
        status_changed_at = case when stripe_subscription_id is null
                                      and status is distinct from 'trialing'
                                 then now() else status_changed_at end,
        updated_at = now()
      where org_id = ${orgId}`;
  }

  await invalidateOrgEntitlements(orgId);
  await logStaffAction(actorId, "extend_trial", "org", orgId, {
    reason, days,
    before: { trial_end: before.trial_end, plan_key: before.plan_key },
    after: { trial_end: iso, granted_pro: !live },
  });
  return iso;
}
