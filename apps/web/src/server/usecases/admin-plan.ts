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

  // The live arm's local UPDATE is pinned to the row we validated, so a
  // concurrent cancellation makes it a no-op. Staff must see that.
  let localWriteSkipped = false;

  if (live) {
    // Mid-trial on Stripe: push their trial_end so the first charge moves. The
    // plan already came from the price, and comped_until stays out of it — the
    // subscription owns this org's lifecycle.
    await getStripe().subscriptions.update(before.stripe_subscription_id, {
      trial_end: Math.floor(trialEnd.getTime() / 1000),
      proration_behavior: "none",
    });
    const pinned = await sql<{ org_id: string }[]>`
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
      -- planPanel read the row BEFORE the Stripe call; a cancellation landing in
      -- between would make this write resurrect liveness on a departed row.
      -- The racing writer is handleSubscriptionDeleted in billing-events.ts: it
      -- sets status = canceled keyed on org_id and LEAVES THE ID INTACT, so an
      -- id pin alone never fires for that race. STATUS is the column that moves.
      -- The id pin covers the other race — a resubscribe swapping in a NEW
      -- subscription id. It does NOT prevent the Stripe-side mistake: the
      -- subscriptions.update above has already run, so the trial_end went onto
      -- whichever subscription the id we read names. All the id conjunct buys
      -- is that the LOCAL row is not overwritten to describe a subscription it
      -- no longer belongs to; the Stripe write must be reconciled by the
      -- webhook. Two races, two conjuncts.
      -- A zero-row result is SAFE, not an error: the row is exactly as read and
      -- the webhook has written the truth. It is recorded in the audit detail
      -- below rather than thrown, because the Stripe call already succeeded.
      where org_id = ${orgId}
        and status = 'trialing'
        and stripe_subscription_id = ${before.stripe_subscription_id}
      returning org_id`;
    localWriteSkipped = pinned.length === 0;
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
    // trial_end names what the LOCAL row now holds; when the pinned write was
    // skipped the row holds no such date, so the value is reported under
    // trial_end_stripe — what was pushed to Stripe and nowhere else.
    after: {
      ...(localWriteSkipped ? { trial_end_stripe: iso } : { trial_end: iso }),
      granted_pro: !live,
    },
    // Stripe accepted the new trial_end but the local row had already moved on
    // (cancelled or resubscribed between the read and the write), so nothing was
    // written here. Surfaced, never silent.
    ...(localWriteSkipped ? { local_write_skipped: true } : {}),
  });
  return iso;
}

/**
 * Give an org its trial back. "One trial per organisation" (V277) is enforced
 * on every route that grants Pro, which makes it strict enough to be wrong
 * occasionally — a comp that turns into a paid pilot, a test org promoted to a
 * real customer. This is the sanctioned undo, so nobody edits subscriptions by
 * hand.
 *
 * Refuses a LIVE Stripe subscription: syncSubscription upserts
 * `trial_used_at = coalesce(subscriptions.trial_used_at, excluded.trial_used_at, now())`
 * on every sync of any subscription, so clearing the burn on a Stripe-billed
 * org would be silently re-stamped by the next webhook or reconcile — an
 * honest refusal beats a restore that reverts itself. A departed org
 * (cancelled status, dead subscription id) is not live and passes through;
 * that is exactly the case this hatch exists for. The next grant of any kind
 * (comp, staff trial, or a fresh Stripe checkout) re-stamps the burn — this is
 * a one-time reopening, not a permanent bypass.
 */
export async function restoreTrial(
  actorId: string,
  orgId: string,
  reason: string,
): Promise<void> {
  if (!reason.trim()) throw new HttpError(400, "A reason is required.");
  const [before] = await sql<{
    trial_used_at: string | null;
    stripe_subscription_id: string | null;
    status: string | null;
  }[]>`
    select trial_used_at, stripe_subscription_id, status
    from subscriptions where org_id = ${orgId}`;
  if (!before) throw new HttpError(404, "Organization has no subscription row.");
  if (hasLiveSubscription(before)) {
    throw new HttpError(
      400,
      "This organization is billed through Stripe — the next sync would re-stamp the trial as used.",
    );
  }
  await sql`update subscriptions set trial_used_at = null, updated_at = now()
            where org_id = ${orgId}`;
  await invalidateOrgEntitlements(orgId);
  await logStaffAction(actorId, "restore_trial", "org", orgId, {
    reason,
    before: { trial_used_at: before.trial_used_at },
    after: { trial_used_at: null },
  });
}
