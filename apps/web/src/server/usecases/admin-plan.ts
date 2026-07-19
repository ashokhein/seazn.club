import "server-only";
// Admin plan tools (v3/08 §1): comp-to-Pro, downgrade with freeze preview,
// trial extension that keeps Stripe in agreement. Every action takes a
// reason and lands in staff_audit_log with before→after detail — the panel
// renders that history, so nothing here is silent.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { downgradeToCommunity } from "@/lib/billing";
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
  const source = sub.stripe_subscription_id
    ? "stripe"
    : sub.plan_key === "pro"
      ? "comped"
      : "none";
  return { ...sub, source };
}

/** Comp an org to Pro until a date (or forever). Refuses Stripe-billed orgs —
 *  their plan belongs to the subscription lifecycle, not to us. */
export async function compToPro(
  actorId: string,
  orgId: string,
  until: Date | null,
  reason: string,
): Promise<void> {
  const before = await planPanel(orgId);
  if (before.stripe_subscription_id) {
    throw new HttpError(400, "This org is billed through Stripe — adjust the subscription there.");
  }
  if (until && until.getTime() <= Date.now()) {
    throw new HttpError(400, "The end date must be in the future.");
  }
  await sql`
    update subscriptions set
      plan_key = 'pro', status = 'active',
      comped_until = ${until ? until.toISOString() : null},
      status_changed_at = case when status is distinct from 'active'
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
 *  subscription exists, pushes the same trial_end so Stripe agrees. */
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
  const base = before.trial_end && new Date(before.trial_end).getTime() > Date.now()
    ? new Date(before.trial_end)
    : new Date();
  const trialEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  if (before.stripe_subscription_id) {
    await getStripe().subscriptions.update(before.stripe_subscription_id, {
      trial_end: Math.floor(trialEnd.getTime() / 1000),
      proration_behavior: "none",
    });
  }
  await sql`
    update subscriptions set
      status = 'trialing', trial_end = ${trialEnd.toISOString()},
      status_changed_at = case when status is distinct from 'trialing'
                               then now() else status_changed_at end,
      updated_at = now()
    where org_id = ${orgId}`;
  await invalidateOrgEntitlements(orgId);
  await logStaffAction(actorId, "extend_trial", "org", orgId, {
    reason, days,
    before: { trial_end: before.trial_end },
    after: { trial_end: trialEnd.toISOString() },
  });
  return trialEnd.toISOString();
}
