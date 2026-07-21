import "server-only";
// Moving organisations between billing groups (spec 2026-07-21 billing-groups
// §Operations): attach, detach, and transferring a whole group to another payer.
//
// lib/billing-group.ts owns the lookups and the arithmetic; this file owns the
// three MUTATIONS, because each one has to talk to Stripe, take a row lock, and
// fan the entitlement cache out over two groups at once. Keeping them together
// is deliberate: the quantity rule below is the only thing standing between a
// customer and being charged twice, and it must have exactly one implementation.
//
// Deliberately NOT here: Stripe Connect. `organizations.stripe_account_id` is the
// club's own bank account with its own KYC, and regrouping who pays for the
// SOFTWARE has no effect on money in or out. Nothing in this file touches it.
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getStripe } from "@/lib/stripe";
import {
  assertPriceBillsQuantity,
  cancelBillingGroup,
  syncPaymentMethodFlagForSubscription,
} from "@/lib/billing";
import {
  invalidateGroupEntitlements,
  invalidateOrgEntitlements,
} from "@/lib/entitlements";
import { activeOrgCount, assertGroupMayHoldAnotherOrg } from "@/lib/billing-group";
import { hasLiveSubscription } from "@/lib/subscription-status";

interface GroupRow {
  id: string;
  owner_user_id: string;
  plan_key: string;
  status: string | null;
  cancel_at_period_end: boolean;
  quantity_paid: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  trial_used_at: string | null;
  currency: string | null;
}

/** Every column the three operations read off a group. A FUNCTION, not a
 *  module-level fragment: building the fragment eagerly would open a database
 *  connection at import time, and this module is imported by routes that must
 *  load without DATABASE_URL. */
const groupCols = () => sql`
  id, owner_user_id, plan_key, status, cancel_at_period_end, quantity_paid,
  stripe_customer_id, stripe_subscription_id, current_period_end, trial_used_at, currency`;

async function groupRow(subscriptionId: string): Promise<GroupRow | null> {
  const [row] = await sql<GroupRow[]>`
    select ${groupCols()} from subscriptions where id = ${subscriptionId}`;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// The quantity rule
// ---------------------------------------------------------------------------

export interface QuantitySync {
  /** What Stripe should be on: max(active_org_count, quantity_paid). */
  quantity: number;
  /** True when this call actually raised the Stripe quantity (and prorated). */
  charged: boolean;
}

/** The single item on a group's live Stripe subscription. */
async function subscriptionItem(
  stripeSubscriptionId: string,
): Promise<{ live: Stripe.Subscription; item: Stripe.SubscriptionItem }> {
  const live = await getStripe().subscriptions.retrieve(stripeSubscriptionId);
  const item = live.items.data[0];
  if (!item) throw new HttpError(500, "Subscription has no items.");
  return { live, item };
}

/**
 * Refuse, BEFORE anything is moved, to bill a seat the group's price cannot
 * price fairly.
 *
 * The check itself lives in lib/billing.ts; what this adds is the timing. A
 * legacy `per_unit` price bills quantity x base, so raising quantity on one
 * charges N x the full rate instead of base + half per extra org — and finding
 * that out AFTER the org has been repointed would leave it attached, entitled,
 * and silently unbilled. Costs one extra Stripe retrieve on the attach path
 * only, and only for groups that actually have a live subscription.
 */
async function assertGroupCanBillSeats(group: GroupRow, quantity: number): Promise<void> {
  if (quantity <= 1) return;
  if (!hasLiveSubscription(group)) return;
  const { item } = await subscriptionItem(group.stripe_subscription_id);
  assertPriceBillsQuantity({
    priceId: item.price.id,
    billingScheme: item.price.billing_scheme,
    quantity,
    subscriptionId: group.id,
  });
}

/**
 * Put Stripe on `max(active_org_count, quantity_paid)` — the one sync rule.
 *
 * INCREMENT: update the subscription item now with
 * `proration_behavior: "create_prorations"` so the extra seat is charged
 * immediately, then record it in `quantity_paid`.
 *
 * DECREMENT: make NO Stripe call at all. Renewal trues it up (and
 * handleInvoicePaymentSucceeded resets `quantity_paid` to the real count when
 * it does), which is what makes a removed org's slot reusable at no charge
 * until the period ends — up to eleven months on an annual plan. It is also
 * what removes every refund path: the quantity never drops mid-period, so
 * add/remove cycling can never produce a credit to farm.
 *
 * Derived by COUNT, never by increment: two concurrent attaches that both land
 * before either sync still produce one correct absolute quantity, and a retry
 * after a failure is a no-op rather than a second charge.
 */
export async function syncGroupQuantity(subscriptionId: string): Promise<QuantitySync> {
  const group = await groupRow(subscriptionId);
  if (!group) return { quantity: 0, charged: false };
  const active = await activeOrgCount(subscriptionId);
  const target = Math.max(active, group.quantity_paid);

  // Nothing has been billed for this group (community, or a cancelled one), so
  // quantity_paid must not move: writing it would fabricate a paid slot that
  // billedQuantity would then charge nobody for.
  if (!hasLiveSubscription(group)) return { quantity: target, charged: false };
  // Decrement, or already there.
  if (target <= group.quantity_paid) return { quantity: target, charged: false };

  const { item } = await subscriptionItem(group.stripe_subscription_id);
  assertPriceBillsQuantity({
    priceId: item.price.id,
    billingScheme: item.price.billing_scheme,
    quantity: target,
    subscriptionId,
  });
  if (item.quantity !== target) {
    await getStripe().subscriptions.update(group.stripe_subscription_id, {
      items: [{ id: item.id, quantity: target }],
      proration_behavior: "create_prorations",
    });
  }
  // `quantity_paid < target` guards a lost race: whichever sync ran with the
  // higher count wins, and a slower one can never lower a slot the customer has
  // already been charged for.
  await sql`
    update subscriptions set quantity_paid = ${target}, updated_at = now()
     where id = ${subscriptionId} and quantity_paid < ${target}`;
  return { quantity: target, charged: true };
}

/** Both sides of a move lose their cached entitlements: the org's plan comes
 *  from whichever group it is in, and the cache is keyed per ORG. */
async function invalidateMove(
  orgId: string,
  fromSubscriptionId: string | null,
  toSubscriptionId: string,
): Promise<void> {
  await invalidateOrgEntitlements(orgId);
  if (fromSubscriptionId && fromSubscriptionId !== toSubscriptionId)
    await invalidateGroupEntitlements(fromSubscriptionId);
  await invalidateGroupEntitlements(toSubscriptionId);
}

/**
 * Drop a group nobody is in any more, but ONLY when it never reached Stripe.
 * The common case is an org leaving its own brand-new community group; leaving
 * the empty row behind would give its owner two groups, after which
 * createOrgForUser stops joining either of them. A group that has ever had a
 * Stripe customer or subscription is kept for ever — it carries trial_used_at,
 * dispute history and the customer link, and the partial unique index on
 * stripe_customer_id makes it unambiguous which group a customer belongs to.
 */
async function dropEmptyGroup(subscriptionId: string): Promise<void> {
  await sql`
    delete from subscriptions s
     where s.id = ${subscriptionId}
       and s.stripe_customer_id is null
       and s.stripe_subscription_id is null
       and not exists (select 1 from organizations o where o.subscription_id = s.id)`;
}

// ---------------------------------------------------------------------------
// 1. Attach — move an org into an existing group
// ---------------------------------------------------------------------------

export interface AttachResult {
  subscription_id: string;
  quantity: number;
  charged: boolean;
}

/**
 * Move `orgId` into the billing group `subscriptionId`.
 *
 * Owner-gated on BOTH sides: the actor must be the org's owner member and the
 * group's payer (`subscriptions.owner_user_id`). Admin is an operational role,
 * not a financial one, and neither half implies the other after an org
 * ownership transfer.
 *
 * Every refusal is a precondition, never a side effect. In particular an attach
 * must not resume a cancelling subscription or settle a past_due one on the
 * user's behalf: "resume, then add" is two clear steps, and the second one is
 * this.
 *
 * Idempotent — attaching an org that is already in the group re-runs the
 * quantity sync and charges nothing, which is what makes a failed sync safe to
 * retry.
 */
export async function attachOrgToGroup(args: {
  actorUserId: string;
  orgId: string;
  subscriptionId: string;
}): Promise<AttachResult> {
  const { actorUserId, orgId, subscriptionId } = args;

  const target = await groupRow(subscriptionId);
  if (!target) throw new HttpError(404, "That billing group does not exist.");
  // Priced before anything moves — see assertGroupCanBillSeats.
  await assertGroupCanBillSeats(target, (await activeOrgCount(subscriptionId)) + 1);

  const move = await sql.begin(async (tx) => {
    // THE lock. Two simultaneous attaches into the same group serialise here,
    // so the cap below is counted against committed state and neither can slip
    // a sixth org into a Pro group. Only the TARGET row is locked — the org's
    // current group is read without one, so two attaches in opposite directions
    // cannot deadlock.
    const [locked] = await tx<GroupRow[]>`
      select ${groupCols()} from subscriptions where id = ${subscriptionId} for update`;
    if (!locked) throw new HttpError(404, "That billing group does not exist.");
    if (locked.owner_user_id !== actorUserId)
      throw new HttpError(
        403,
        "Only the person who pays for this billing group can add an organisation to it.",
      );

    const [org] = await tx<{ subscription_id: string | null; deleted_at: Date | null }[]>`
      select subscription_id, deleted_at from organizations where id = ${orgId}`;
    if (!org || org.deleted_at) throw new HttpError(404, "Organisation not found.");

    const [member] = await tx<{ role: string }[]>`
      select role from org_members where org_id = ${orgId} and user_id = ${actorUserId}`;
    if (member?.role !== "owner")
      throw new HttpError(
        403,
        "Only the organisation's owner can move it into another billing group — being an admin is not enough.",
      );

    // Already there: fall through to the quantity sync so a retry after a
    // failed sync completes rather than 400ing.
    if (org.subscription_id === subscriptionId) return { from: null, moved: false };

    if (locked.status === "past_due")
      throw new HttpError(
        409,
        "This billing group has an unpaid invoice. Settle it before adding another organisation.",
      );
    if (locked.cancel_at_period_end)
      throw new HttpError(
        409,
        "This billing group is scheduled to cancel. Resume the subscription before adding another organisation.",
      );

    if (org.subscription_id) {
      const [current] = await tx<
        { status: string | null; stripe_subscription_id: string | null }[]
      >`select status, stripe_subscription_id from subscriptions
          where id = ${org.subscription_id}`;
      // v1 limitation, deliberate: Stripe cannot move credit between customers,
      // and refunding an annual plan mid-term could be $130+. The org must be on
      // a community group (cancel its own subscription first) to move.
      if (hasLiveSubscription(current))
        throw new HttpError(
          409,
          "This organisation still pays for its own subscription. Cancel that subscription first — an organisation can only join another billing group from Community.",
        );
    }

    const held = await tx<{ id: string }[]>`
      select id from organizations where subscription_id = ${subscriptionId}`;
    await assertGroupMayHoldAnotherOrg(
      subscriptionId,
      held.map((r) => r.id),
    );

    await tx`update organizations set subscription_id = ${subscriptionId} where id = ${orgId}`;
    return { from: org.subscription_id, moved: true };
  });

  if (move.moved) {
    await invalidateMove(orgId, move.from, subscriptionId);
    if (move.from) await dropEmptyGroup(move.from);
  }

  // After the commit, on purpose. A failed increment INVOICE does not roll the
  // attach back (it enters the group's normal dunning ladder — one failure mode,
  // not two), and a failed increment CALL leaves the org attached and the group
  // one seat under-billed: loud, and recoverable by retrying the attach, which
  // is idempotent and derives quantity by count so it cannot double-charge.
  try {
    const q = await syncGroupQuantity(subscriptionId);
    return { subscription_id: subscriptionId, ...q };
  } catch (err) {
    console.error(
      `[billing] attach: org ${orgId} joined group ${subscriptionId} but the quantity sync failed`,
      err,
    );
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      502,
      "The organisation was added, but we could not update your subscription quantity. Please try again from the billing page.",
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Detach — move an org out to a billing group of its own
// ---------------------------------------------------------------------------

export interface DetachResult {
  subscription_id: string;
  /** The old group, if it was cancelled because its last org left. */
  cancelled_group: string | null;
}

/**
 * Move `orgId` out of its billing group and onto a fresh one of its own.
 *
 * EITHER SIDE may initiate: the group's payer can push an org out, and the
 * org's own owner can pull itself out. Nobody needs permission from the person
 * funding them in order to leave, and no payer is trapped funding an org that
 * refuses to pay.
 *
 * DETACH REQUIRES NO PAYMENT. The new group inherits:
 *  - `plan_key`      — it keeps the plan it was already using;
 *  - `comped_until = <old group's current_period_end>` — which the resolver
 *    already degrades to community at read time, so this needs no scheduler, no
 *    new column and no new resolver branch: the org rides out the period the
 *    old payer has already paid for and then drops to Community;
 *  - `trial_used_at` — inheriting the stamp is what stops detach farming a
 *    fresh 14-day trial by cycling in and out of a group.
 *
 * The old group's quantity is NOT decremented. Renewal trues it up, so the
 * freed slot stays reusable at no charge until the period ends.
 */
export async function detachOrgFromGroup(args: {
  actorUserId: string;
  orgId: string;
}): Promise<DetachResult> {
  const { actorUserId, orgId } = args;

  const result = await sql.begin(async (tx) => {
    const [org] = await tx<
      { subscription_id: string | null; created_by: string | null; deleted_at: Date | null }[]
    >`select subscription_id, created_by, deleted_at from organizations where id = ${orgId}`;
    if (!org || org.deleted_at) throw new HttpError(404, "Organisation not found.");
    if (!org.subscription_id)
      throw new HttpError(400, "This organisation has no billing group to leave.");

    const [group] = await tx<GroupRow[]>`
      select ${groupCols()} from subscriptions where id = ${org.subscription_id} for update`;
    if (!group) throw new HttpError(400, "This organisation has no billing group to leave.");

    // The org's owner MEMBER, not organizations.created_by — an ownership
    // transfer leaves created_by on the original creator. created_by is only the
    // fallback for an org whose owner row has been lost.
    const [owner] = await tx<{ user_id: string }[]>`
      select m.user_id from org_members m
       where m.org_id = ${orgId} and m.role = 'owner'
       order by m.created_at, m.user_id limit 1`;
    const orgOwnerId = owner?.user_id ?? org.created_by;

    const mayDetach = group.owner_user_id === actorUserId || orgOwnerId === actorUserId;
    if (!mayDetach)
      throw new HttpError(
        403,
        "Only this organisation's owner or the group's payer can move it out of the billing group.",
      );
    if (!orgOwnerId)
      throw new HttpError(
        400,
        "This organisation has no owner to bill — transfer ownership before separating it.",
      );

    const others = await tx<{ id: string }[]>`
      select id from organizations
       where subscription_id = ${group.id} and id <> ${orgId} and deleted_at is null`;
    if (others.length === 0 && group.owner_user_id === orgOwnerId)
      throw new HttpError(400, "This organisation already has its own billing group.");

    const [fresh] = await tx<{ id: string }[]>`
      insert into subscriptions
        (owner_user_id, plan_key, status, quantity_paid, comped_until, trial_used_at, status_changed_at)
      values (${orgOwnerId}, ${group.plan_key}, 'active', 1,
              ${group.current_period_end}, ${group.trial_used_at}, now())
      returning id`;
    await tx`update organizations set subscription_id = ${fresh.id} where id = ${orgId}`;
    return { from: group.id, to: fresh.id, remaining: others.length };
  });

  await invalidateMove(orgId, result.from, result.to);

  // Never leave a live subscription at quantity 0: the last org out cancels the
  // group it left. cancelBillingGroup is best-effort at Stripe and always makes
  // the local row truthful.
  let cancelled: string | null = null;
  if (result.remaining === 0) {
    const old = await groupRow(result.from);
    if (old && hasLiveSubscription(old)) {
      await cancelBillingGroup(result.from);
      cancelled = result.from;
    } else {
      await dropEmptyGroup(result.from);
    }
  }
  return { subscription_id: result.to, cancelled_group: cancelled };
}

// ---------------------------------------------------------------------------
// 3. Transfer a billing group to another payer
// ---------------------------------------------------------------------------

/**
 * Hand a whole billing group to another user.
 *
 * Distinct from `transfer-owner`, which moves ORG ownership and never touches
 * billing. A federation whose treasurer leaves needs this: without it, changing
 * hands means detaching every org and re-grouping, which loses the group and
 * re-charges tier 1 for each one.
 *
 * The CARD IS NOT MOVED. The group keeps its Stripe customer (the subscription
 * lives on it), so the outgoing payer's cards are detached and the default is
 * cleared — otherwise the person who just handed the group over would keep
 * being charged for it with no way to stop, since every billing gate has just
 * moved to someone else. The new owner re-enters a card; until they do, the
 * group dunns like any other.
 *
 * Stripe first, then the local write: a Stripe failure leaves the old owner in
 * charge of a group whose card is still theirs, which is the safe direction.
 */
export async function transferGroupOwnership(args: {
  actorUserId: string;
  subscriptionId: string;
  newOwnerUserId: string;
}): Promise<{ subscription_id: string; owner_user_id: string }> {
  const { actorUserId, subscriptionId, newOwnerUserId } = args;
  const group = await groupRow(subscriptionId);
  if (!group) throw new HttpError(404, "That billing group does not exist.");
  if (group.owner_user_id !== actorUserId)
    throw new HttpError(
      403,
      "Only the person who pays for this billing group can hand it to someone else.",
    );
  if (newOwnerUserId === actorUserId)
    throw new HttpError(400, "You already pay for this billing group.");

  const [recipient] = await sql<{ id: string; email: string; display_name: string }[]>`
    select id, email, display_name from users
     where id = ${newOwnerUserId} and deleted_at is null`;
  if (!recipient) throw new HttpError(404, "That person does not have an account.");

  if (group.stripe_customer_id) {
    const stripe = getStripe();
    const customerId = group.stripe_customer_id;
    // Invoices, receipts and dunning email must reach the new payer.
    await stripe.customers.update(customerId, {
      name: recipient.display_name,
      email: recipient.email,
      invoice_settings: { default_payment_method: "" },
    });
    const cards = await stripe.customers.listPaymentMethods(customerId, {
      type: "card",
      limit: 100,
    });
    for (const pm of cards.data) await stripe.paymentMethods.detach(pm.id);
  }

  await sql`
    update subscriptions set owner_user_id = ${recipient.id}, updated_at = now()
     where id = ${subscriptionId}`;
  // Re-derives the has_payment_method mirror from Stripe rather than assuming —
  // the same rule every other writer follows.
  await syncPaymentMethodFlagForSubscription(subscriptionId);
  return { subscription_id: subscriptionId, owner_user_id: recipient.id };
}
