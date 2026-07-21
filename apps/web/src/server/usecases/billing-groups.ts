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
  syncPaymentMethodFlagForSubscription,
} from "@/lib/billing";
import {
  invalidateGroupEntitlements,
  invalidateOrgEntitlements,
} from "@/lib/entitlements";
import { activeOrgCount, assertWithinGroupCap, groupOrgLimit } from "@/lib/billing-group";
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
  comped_until: string | null;
  trial_used_at: string | null;
  currency: string | null;
}

/** Every column the three operations read off a group. A FUNCTION, not a
 *  module-level fragment: building the fragment eagerly would open a database
 *  connection at import time, and this module is imported by routes that must
 *  load without DATABASE_URL. */
const groupCols = () => sql`
  id, owner_user_id, plan_key, status, cancel_at_period_end, quantity_paid,
  stripe_customer_id, stripe_subscription_id, current_period_end, comped_until,
  trial_used_at, currency`;

async function groupRow(subscriptionId: string): Promise<GroupRow | null> {
  const [row] = await sql<GroupRow[]>`
    select ${groupCols()} from subscriptions where id = ${subscriptionId}`;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// The quantity rule
// ---------------------------------------------------------------------------

export interface QuantitySync {
  /** The seat count Stripe now holds: the group's live org count. */
  quantity: number;
  /** True when this call raised the quantity past what had been paid for, and
   *  therefore prorated a charge. A decrement or a free re-add is false. */
  charged: boolean;
  /** True when this call actually wrote the Stripe subscription item. */
  synced: boolean;
  /** True when the group has a live subscription and NO organisations left —
   *  the caller cancels it (see syncGroupQuantity). */
  orphaned?: boolean;
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
 *
 * Scoped to writes that will actually happen: if the item is already on the
 * quantity this attach would set (a re-add into a slot Stripe still holds), the
 * sync makes no call, so refusing here would 503 an attach that costs nothing
 * and touches nothing.
 */
async function assertGroupCanBillSeats(group: GroupRow, quantity: number): Promise<void> {
  if (quantity <= 1) return;
  if (!hasLiveSubscription(group)) return;
  const { item } = await subscriptionItem(group.stripe_subscription_id);
  if (item.quantity === quantity) return;
  assertPriceBillsQuantity({
    priceId: item.price.id,
    billingScheme: item.price.billing_scheme,
    quantity,
    subscriptionId: group.id,
  });
}

/**
 * Put Stripe's subscription item on the group's ACTIVE ORG COUNT, and record
 * what has been paid for.
 *
 * The rule this replaces — "decrements make no Stripe call, renewal trues them
 * up" — cannot work, and the correction is worth stating plainly because it is
 * the difference between a customer being billed correctly and being billed for
 * ever for orgs they no longer have. **Stripe cuts a renewal invoice from the
 * subscription item's own quantity.** Nothing at Stripe reads our database at
 * cycle time, so a quantity we never lower is a quantity that never comes down:
 * a federation that goes from eight clubs to three keeps paying for eight for
 * ever. The deferred decrement had to become a real, immediate write.
 *
 * What survives intact is the customer-facing promise, because the two
 * directions are prorated differently:
 *
 *  - UP past what has already been paid for: `create_prorations`, so the extra
 *    seat is charged immediately, and `quantity_paid` rises to match.
 *  - DOWN, or back UP into a slot already paid for: `proration_behavior: "none"`.
 *    No credit on the way down (no refunds, nothing to farm by cycling orgs) and
 *    no charge on the way back up — but the item moves either way, so the NEXT
 *    invoice is the honest one. That is what makes "a removed org frees a paid
 *    slot you can reuse at no charge until the period ends" true in both halves.
 *
 * SERIALISED on the group row. Retrieve-then-update is a read-modify-write
 * against state only Stripe holds, so two of them interleaving (a detach's
 * post-commit sync against a concurrent attach's) would leave the item on one
 * caller's stale count for ever. The `for update` is therefore held ACROSS the
 * Stripe round trip — unusual, and the deliberate trade: a few hundred
 * milliseconds of contention on one group's row against a permanently wrong
 * invoice. `handOverGroup` does the same thing for the same reason (setting the
 * incoming card as default must be inside the ownership lock); those two are the
 * only places in this file that hold a lock across a network call, and both bound
 * it with a local statement_timeout and a hard client timeout (lib/stripe.ts).
 *
 * `quantity_paid` is the local mirror of what the customer has been billed for.
 * It only RISES here, and — this is the part the reconcile sweep depends on — it
 * is only written when Stripe has actually confirmed the item. A failed update
 * therefore leaves `quantity_paid` disagreeing with the org count, which is
 * precisely the sweep's predicate. It is also raised to whatever Stripe is
 * ALREADY holding, even when this call changes nothing: if the item says 2, the
 * customer is being billed for 2, and forgetting that would let a later re-add
 * charge for the same seat twice.
 *
 * `renewal: true` is the one caller allowed to LOWER it: the cycle invoice has
 * just been cut from the item, so the slots bought last period are spent and
 * what Stripe now holds is, by definition, what has been paid for.
 */
export async function syncGroupQuantity(
  subscriptionId: string,
  opts: { renewal?: boolean; invoicedQuantity?: number } = {},
): Promise<QuantitySync> {
  const res = (await sql.begin(async (tx) => {
    // Bound the blast radius of holding this lock across a Stripe round trip: if
    // Stripe hangs, fail rather than pin a pool connection and a row lock for the
    // SDK's timeout. Local to the transaction, so nothing else is affected.
    await tx`set local lock_timeout = '5s'`;
    await tx`set local statement_timeout = '30s'`;
    const [group] = await tx<GroupRow[]>`
      select ${groupCols()} from subscriptions where id = ${subscriptionId} for update`;
    if (!group) return { quantity: 0, charged: false, synced: false };
    const [countRow] = await tx<{ n: string }[]>`
      select count(*)::text as n from organizations
       where subscription_id = ${subscriptionId} and deleted_at is null`;
    const active = Number(countRow?.n ?? 0);

    // Nothing has been billed for this group (community, or a cancelled one), so
    // quantity_paid must not move: writing it would fabricate a paid slot that
    // billedQuantity would then charge nobody for.
    if (!hasLiveSubscription(group)) return { quantity: active, charged: false, synced: false };

    // A live subscription with no orgs left bills for nothing and can never be
    // corrected by a quantity (Stripe rejects 0). Previously this returned and
    // the sweep re-selected it for ever — a group whose last org was SOFT
    // DELETED rather than detached kept paying with nothing to cancel it. The
    // cancel is the correction.
    // Signalled OUT of the transaction, never cancelled inside it:
    // cancelBillingGroup goes through the connection pool, so calling it here
    // would block on the very row lock this transaction holds — a self-deadlock
    // that hangs until the statement timeout.
    if (active < 1) return { quantity: 0, charged: false, synced: false, orphaned: true };

    const { item } = await subscriptionItem(group.stripe_subscription_id);
    // What Stripe holds BEFORE this call is what the customer has been billed
    // for. Kept separate from the post-write value on purpose: overwriting it
    // after the update made the renewal path record the quantity it had just
    // SET rather than the one the invoice was cut from.
    const heldBefore = item.quantity ?? 0;
    let charged = false;
    let synced = false;

    if (heldBefore !== active) {
      // Applies in BOTH directions and to a free re-add too: a legacy per_unit
      // price bills quantity x base, so leaving the item wrong would overcharge
      // every future invoice whether or not this particular write prorated.
      assertPriceBillsQuantity({
        priceId: item.price.id,
        billingScheme: item.price.billing_scheme,
        quantity: active,
        subscriptionId,
      });
      // Charge ONLY when the customer is genuinely gaining a seat: the item is
      // going UP *and* past what has already been paid for. Both halves matter —
      // without the first, a correction that LOWERS a drifted quantity would
      // create_prorations and hand out a credit, which is the refund path this
      // design exists to have none of; without the second, re-adding into a slot
      // already paid for would charge twice for it.
      const raising = active > heldBefore && active > group.quantity_paid;
      await getStripe().subscriptions.update(group.stripe_subscription_id, {
        items: [{ id: item.id, quantity: active }],
        proration_behavior: raising ? "create_prorations" : "none",
      });
      charged = raising;
      synced = true;
    }

    // What this period has actually been paid for. `charged ? active : 0` is the
    // seat we have just raised a proration for; everything else is what Stripe
    // was already holding.
    //
    // On the RENEWAL path the invoice's own line quantity wins, because the item
    // may have moved since the invoice was cut and the invoice is the only record
    // of what was billed. `sweepStuckEvents` replays events ten minutes late by
    // design, so "the item now" and "what this period cost" routinely disagree:
    // taking the item would under-record the paid seats and make a re-add inside
    // the same period charge for a seat the customer had already bought.
    // Falls back to the pre-write item quantity when the line carries none.
    const raised = charged ? active : 0;
    const paid = opts.renewal
      ? Math.max(opts.invoicedQuantity ?? heldBefore, raised)
      : Math.max(group.quantity_paid, heldBefore, raised);
    if (paid !== group.quantity_paid) {
      await tx`
        update subscriptions set quantity_paid = ${paid}, updated_at = now()
         where id = ${subscriptionId}`;
    }
    return { quantity: active, charged, synced };
  })) as unknown as QuantitySync;

  // A live subscription with no organisations bills for nothing and can never be
  // corrected by a quantity (Stripe rejects 0). Returning quietly left the sweep
  // re-selecting it for ever — a group whose last org was SOFT DELETED rather
  // than detached kept paying with nothing to cancel it. The cancel is the
  // correction, and it runs once the lock above has been released.
  if (res.orphaned) {
    const outcome = await cancelGroupIfEmpty(subscriptionId);
    // "not_empty" is a legitimate outcome, not a failure: an org arrived between
    // the count above and this claim, and the group is billable after all.
    if (outcome !== "not_empty")
      console.error(
        `[billing] group ${subscriptionId} has a live subscription and no organisations — ` +
          (outcome === "cancelled" ? "cancelled" : "CANCEL FAILED, will retry"),
      );
  }
  return res;
}

/**
 * Reconciliation sweep for groups whose Stripe quantity has drifted from their
 * org count (cron).
 *
 * Drift is silent by nature: an attach whose sync failed after the org was
 * already repointed, an org created into a paid group during a Stripe outage, a
 * detach whose decrement never landed, a renewal whose sync threw. None of them
 * raises anything a person would see.
 *
 * The predicate is `quantity_paid <> live org count`, and it works ONLY because
 * `quantity_paid` is never written unless Stripe confirmed the item — so every
 * failed sync leaves the two disagreeing and stays visible here. (It was
 * previously possible for the renewal handler to set `quantity_paid = count`
 * unconditionally and then fail its Stripe call, satisfying the predicate for
 * ever while the item stayed wrong. That is the one shape this must never have.)
 *
 * It also selects groups that are merely holding a freed slot (`quantity_paid`
 * legitimately above the count until renewal). Those cost one Stripe retrieve
 * and correct nothing, which is the price of a predicate that cannot go blind.
 */
export async function reconcileGroupQuantities(limit = 500): Promise<{
  checked: number;
  corrected: number;
  failed: number;
}> {
  const groups = await sql<{ id: string }[]>`
    select s.id from subscriptions s
     where s.stripe_subscription_id is not null
       and s.status in ('trialing', 'active', 'past_due')
       and s.quantity_paid <> (
             select count(*) from organizations o
              where o.subscription_id = s.id and o.deleted_at is null)
     order by s.updated_at
     limit ${limit}`;
  let corrected = 0,
    failed = 0;
  for (const g of groups) {
    try {
      // No pre-compare here: syncGroupQuantity has to take the lock and read
      // Stripe anyway, and doing it out here raced the very interleaving this
      // sweep exists to repair. It writes nothing when everything already
      // agrees, and reports whether it moved anything.
      const res = await syncGroupQuantity(g.id);
      if (res.synced) corrected++;
    } catch (err) {
      // One broken group (archived price, deleted subscription) must not stop
      // the sweep for everybody else.
      failed++;
      console.error(`[billing] quantity reconcile failed for group ${g.id}`, err);
    }
  }
  if (groups.length === limit)
    console.warn(
      `[billing] quantity reconcile hit its limit of ${limit} — some groups were not visited`,
    );
  return { checked: groups.length, corrected, failed };
}

/**
 * Cancel a group ONLY if it is still empty.
 *
 * Two shapes have already failed here, and the reason is worth stating exactly,
 * because both looked airtight:
 *
 *  1. Re-count under a lock, commit, then cancel. An attach queued on that lock
 *     proceeds the instant the re-count commits, sees `status = 'active'`,
 *     passes every gate and may be charged for a seat — and only then does the
 *     cancel fire. The org ends up inside a cancelled group having just paid.
 *  2. ONE statement: `update ... where not exists (live orgs)` over a `for
 *     update` CTE. This does NOT close the race, whatever it looks like. In
 *     READ COMMITTED a statement's snapshot is taken when the STATEMENT starts.
 *     The CTE's `for update` blocks on the lock the attach holds, but
 *     `not exists (select 1 from organizations ...)` is still evaluated against
 *     the snapshot taken before the attach committed. EPQ re-evaluation does not
 *     help: it substitutes the updated tuple of the row being LOCKED and
 *     refreshes visibility for no other table — and an attach never UPDATEs the
 *     subscriptions row at all (it takes the lock and writes `organizations`),
 *     so there is no updated tuple to trigger it. Verified against real
 *     Postgres: the group is cancelled with a live org in it.
 *
 * So the lock and the count are separate STATEMENTS inside one transaction. A
 * new statement takes a new snapshot, so the count sees whatever committed while
 * statement 1 was waiting — which is the whole point. Once the row does say
 * `canceled`, attach refuses it outright (its gate reads status under its own
 * lock), so anyone racing is refused rather than admitted to a dying group.
 *
 * The claim COMMITS before Stripe is called, and is rolled back to the captured
 * previous values if Stripe refuses — leaving the group live, billable and
 * visible to the reconcile sweep rather than locally "cancelled" while still
 * charging. The Stripe call is deliberately outside the transaction: it would
 * otherwise hold this row lock across a network round trip, and this runs from
 * `syncGroupQuantity` immediately after that function has released its own.
 *
 * `not_empty` is a normal outcome, not an error: an org arrived, and the group
 * is billable after all.
 */
interface CancelClaim {
  prev_status: string;
  prev_plan: string;
  prev_comped: Date | null;
  prev_qty: number;
  stripe_subscription_id: string | null;
}

async function cancelGroupIfEmpty(
  subscriptionId: string,
): Promise<"cancelled" | "not_empty" | "cancel_failed"> {
  const claimed = (await sql.begin(async (tx) => {
    // Statement 1: take the row lock, and WAIT for whoever holds it (an attach
    // in flight). Nothing is decided here — the previous values are captured for
    // the rollback below.
    const [prev] = await tx<CancelClaim[]>`
      select status as prev_status, plan_key as prev_plan, comped_until as prev_comped,
             quantity_paid as prev_qty, stripe_subscription_id
        from subscriptions where id = ${subscriptionId} for update`;
    if (!prev) return null;
    // Statement 2, and a NEW snapshot with it: this is where an attach that
    // committed while statement 1 was blocked becomes visible. The status is
    // re-tested in SQL for symmetry only — the row is locked, so it cannot have
    // moved since it was read.
    const [claim] = await tx<{ id: string }[]>`
      update subscriptions s
         set plan_key = 'community', status = 'canceled', cancel_at_period_end = false,
             comped_until = null, quantity_paid = 1, updated_at = now(),
             status_changed_at = case when s.status is distinct from 'canceled'
                                      then now() else s.status_changed_at end
       where s.id = ${subscriptionId}
         and s.status in ('trialing', 'active', 'past_due')
         and not exists (
               select 1 from organizations o
                where o.subscription_id = s.id and o.deleted_at is null)
      returning s.id`;
    return claim ? prev : null;
  })) as CancelClaim | null;
  if (!claimed) return "not_empty";

  if (claimed.stripe_subscription_id) {
    try {
      await getStripe().subscriptions.cancel(claimed.stripe_subscription_id);
    } catch (err) {
      // Put it back exactly as it was. A row left saying `canceled` while Stripe
      // keeps charging is the worst outcome: it drops out of every
      // live-subscription filter, including the sweep's, so nothing retries.
      await sql`
        update subscriptions
           set status = ${claimed.prev_status}, plan_key = ${claimed.prev_plan},
               comped_until = ${claimed.prev_comped}, quantity_paid = ${claimed.prev_qty},
               updated_at = now()
         where id = ${subscriptionId}`;
      console.error("cancelGroupIfEmpty: Stripe cancel failed", subscriptionId, err);
      return "cancel_failed";
    }
  }
  await invalidateGroupEntitlements(subscriptionId);
  return "cancelled";
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
  // Resolved BEFORE the transaction: getLimit goes through the module-level pool
  // connection (and Redis), and acquiring a second connection while holding row
  // locks deadlocks the pool at DB_POOL_MAX concurrent attaches.
  const capLimit = await groupOrgLimit(subscriptionId);
  // Priced before anything moves — see assertGroupCanBillSeats.
  await assertGroupCanBillSeats(target, (await activeOrgCount(subscriptionId)) + 1);

  const move = await sql.begin(async (tx) => {
    // TWO locks, in this order, and both operations take them in it.
    //
    // The ORG row first: attach and detach both rewrite
    // `organizations.subscription_id`, and without a lock on the org itself a
    // concurrent pair interleaves into a lost update — the attach reads the
    // pre-detach group, overwrites the detach's write, and strands the group the
    // detach minted. The orphan is invisible to dropEmptyGroup (which only ever
    // looks at the group the attach moved FROM), and its owner is left holding
    // two groups, after which createOrgForUser stops joining either.
    //
    // Then the target GROUP, which is what two simultaneous attaches contend on
    // so the cap below is counted against committed state. Locking in a fixed
    // org → group order is what keeps attach and detach from deadlocking each
    // other; the org's CURRENT group is deliberately not locked at all.
    const [org] = await tx<{ subscription_id: string | null; deleted_at: Date | null }[]>`
      select subscription_id, deleted_at from organizations where id = ${orgId} for update`;
    if (!org || org.deleted_at) throw new HttpError(404, "Organisation not found.");

    const [locked] = await tx<GroupRow[]>`
      select ${groupCols()} from subscriptions where id = ${subscriptionId} for update`;
    if (!locked) throw new HttpError(404, "That billing group does not exist.");
    if (locked.owner_user_id !== actorUserId)
      throw new HttpError(
        403,
        "Only the person who pays for this billing group can add an organisation to it.",
      );

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
    // A cancelled (or otherwise dead) group entitles nothing and bills nothing,
    // so joining one silently gives the org Community under someone else's name
    // and loses it the group it came from. Refuse rather than "succeed".
    if (locked.status !== "active" && locked.status !== "trialing")
      throw new HttpError(
        409,
        "This billing group is not active. Restart its subscription before adding another organisation.",
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

    // `deleted_at is null`, matching activeOrgCount: a soft-deleted org bills
    // nothing and holds no quota, so counting it toward the cap would refuse a
    // Pro group its fifth real org because two dead ones are still on the row.
    const [heldRow] = await tx<{ n: string }[]>`
      select count(*)::text as n from organizations
       where subscription_id = ${subscriptionId} and deleted_at is null`;
    // Counted under the lock, compared against a limit resolved outside it.
    assertWithinGroupCap(Number(heldRow?.n ?? 0), capLimit);

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
 *  - `plan_key`      — it keeps the plan it was already using, but ONLY when
 *    there is a date on which that plan expires (below);
 *  - `comped_until = coalesce(current_period_end, comped_until)` — which the
 *    resolver already degrades to community at read time, so this needs no
 *    scheduler, no new column and no new resolver branch: the org rides out the
 *    period the old payer has already paid for and then drops to Community.
 *    The coalesce is load-bearing. A STAFF-COMPED group has `comped_until` set
 *    and `current_period_end` NULL (admin-plan.ts never sets a period end), so
 *    reading only the period end minted `plan_key='pro'` with no expiry — a
 *    permanent free Pro group that the resolver's expiry arm can never fire on,
 *    self-service, for anyone in a comped group.
 *  - `trial_used_at` — inheriting the stamp is what stops detach farming a
 *    fresh 14-day trial by cycling in and out of a group.
 *
 * NEVER MINT AN UNEXPIRING PAID PLAN. When neither date exists, or when the old
 * group was not actually paying (past_due, cancelled — an org cannot inherit a
 * paid-through period from a payer who has not paid, and doing so would let a
 * dunning org escape its own degradation by leaving), the new group is plain
 * Community and the org subscribes for itself.
 *
 * The old group's Stripe quantity DOES come down, with `proration_behavior:
 * "none"` — no credit now (the slot stays theirs until the period ends), but
 * the next invoice is honest. See syncGroupQuantity.
 */
export async function detachOrgFromGroup(args: {
  actorUserId: string;
  orgId: string;
}): Promise<DetachResult> {
  const { actorUserId, orgId } = args;

  const result = await sql.begin(async (tx) => {
    // Org row first, then its group — the same lock order attach takes, so a
    // concurrent attach and detach of the SAME org serialise instead of losing
    // one of the two writes. See the note in attachOrgToGroup.
    const [org] = await tx<
      { subscription_id: string | null; created_by: string | null; deleted_at: Date | null }[]
    >`select subscription_id, created_by, deleted_at from organizations
        where id = ${orgId} for update`;
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

    // Only a group that is actually paying can hand on a paid-through period.
    // A past_due group is mid-dunning and its orgs are counting down to
    // community; letting one leave with a comp would hand it exactly the
    // entitlement the dunning is withdrawing.
    const paying = group.status === "active" || group.status === "trialing";
    const compedUntil = paying
      ? (group.current_period_end ?? group.comped_until ?? null)
      : null;
    // No expiry date means no paid plan. Community is the only safe landing.
    const planKey = compedUntil ? group.plan_key : "community";

    const [fresh] = await tx<{ id: string }[]>`
      insert into subscriptions
        (owner_user_id, plan_key, status, quantity_paid, comped_until, trial_used_at, status_changed_at)
      values (${orgOwnerId}, ${planKey}, 'active', 1,
              ${compedUntil}, ${group.trial_used_at}, now())
      returning id`;
    await tx`update organizations set subscription_id = ${fresh.id} where id = ${orgId}`;
    return { from: group.id, to: fresh.id, remaining: others.length };
  });

  await invalidateMove(orgId, result.from, result.to);

  // Never leave a live subscription at quantity 0: the last org out cancels the
  // group it left. cancelBillingGroup is best-effort at Stripe and always makes
  // the local row truthful.
  // Never trusting the count from the committed transaction above: between that
  // commit and here, an attach can legitimately put another org into the group
  // it just emptied. cancelGroupIfEmpty re-tests emptiness under the group's row
  // lock, in a statement issued AFTER that lock is held — see the note there for
  // why doing it in one statement does not close the window.
  let cancelled: string | null = null;
  const outcome = await cancelGroupIfEmpty(result.from);
  if (outcome !== "not_empty") {
    if (outcome === "cancelled") cancelled = result.from;
    else await dropEmptyGroup(result.from);
    return { subscription_id: result.to, cancelled_group: cancelled };
  }

  // The seat the org just vacated. Stripe bills renewals from the item quantity
  // and recomputes nothing from our side at cycle time, so a decrement we do not
  // send is one the customer keeps paying for ever. Sent with no proration —
  // they keep the slot they bought for the rest of this period, and the NEXT
  // invoice is the smaller one. Best-effort: a detach must always complete (the
  // eviction path especially), and the reconcile sweep catches what fails.
  try {
    await syncGroupQuantity(result.from);
  } catch (err) {
    console.error(
      `[billing] detach: org ${orgId} left group ${result.from} but the quantity sync failed`,
      err,
    );
  }
  return { subscription_id: result.to, cancelled_group: cancelled };
}

// ---------------------------------------------------------------------------
// 3. Transfer a billing group to another payer
// ---------------------------------------------------------------------------

/** Metadata marker on the SetupIntent that carries a pending transfer. */
export const TRANSFER_INTENT_KIND = "billing_group_transfer";

/** How long an outstanding offer stays acceptable. An offer is a live claim on
 *  somebody else's subscription, so it has to lapse on its own. */
export const TRANSFER_OFFER_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface TransferOffer {
  status: "transferred" | "pending_card";
  subscription_id: string;
  owner_user_id: string;
  /** Set on "pending_card": the recipient confirms a card against this. */
  setup_intent_id?: string;
  client_secret?: string;
}

/**
 * Hand a whole billing group to another user. TWO-PHASE when there is money
 * involved, and that is the whole design.
 *
 * Distinct from `transfer-owner`, which moves ORG ownership and never touches
 * billing. A federation whose treasurer leaves needs this: without it, changing
 * hands means detaching every org and re-grouping, which loses the group and
 * re-charges tier 1 for each one.
 *
 * The card must not travel with the group — the outgoing payer's card funding a
 * group they no longer control is the thing being prevented. But simply
 * detaching it converts an administrative event into a billing outage with a
 * blast radius over other people's clubs: an eight-club federation whose
 * treasurer changes in September, on an annual subscription paid through March,
 * would lose its only card, fail the March renewal, dun, and degrade all eight
 * clubs to community at day 15 — none of whom were party to the handover. Under
 * a trial it is worse: `missing_payment_method: "cancel"` cancels outright.
 *
 * So a group with a live subscription cannot be transferred in one step. This
 * function makes an OFFER: a SetupIntent against the group's existing Stripe
 * customer, which the recipient confirms with their own card. The SetupIntent IS
 * the offer record — it needs no table of its own, it lives where the card
 * lives, and Stripe is authoritative about whether it succeeded. Ownership only
 * moves in acceptGroupTransfer, once that card is attached; the old card is
 * detached last of all, so the subscription is never cardless.
 *
 * A group with no live subscription (community, or one already cancelled) has
 * no invoice to fail and moves immediately.
 */
export async function offerGroupTransfer(args: {
  actorUserId: string;
  subscriptionId: string;
  newOwnerUserId: string;
}): Promise<TransferOffer> {
  const { actorUserId, subscriptionId, newOwnerUserId } = args;
  const recipient = await transferRecipient(newOwnerUserId);

  // Read under the lock ONLY to decide which path this is. The direct path's
  // ownership write happens in its own locked transaction below — postgres.js
  // commits and releases every row lock the moment this callback returns, so a
  // gate checked here and a write performed after it are not one atomic step.
  const group = await sql.begin(async (tx) => {
    const [row] = await tx<GroupRow[]>`
      select ${groupCols()} from subscriptions where id = ${subscriptionId} for update`;
    if (!row) throw new HttpError(404, "That billing group does not exist.");
    if (row.owner_user_id !== actorUserId)
      throw new HttpError(
        403,
        "Only the person who pays for this billing group can hand it to someone else.",
      );
    // AFTER the ownership gate, so a stranger asking gets "you do not pay for
    // this" rather than a message that implies they do.
    if (newOwnerUserId === actorUserId)
      throw new HttpError(400, "You already pay for this billing group.");
    return row;
  });

  if (hasLiveSubscription(group) && group.stripe_customer_id) {
    // No `payment_method_types`. Stripe's guidance is to let the account's
    // payment method configuration decide (Terminal excepted): pinning it here
    // turns dynamic payment methods off and silently forecloses every
    // non-card method the account accepts for subscriptions — a SEPA or Bacs
    // debit payer would simply be unable to accept a transfer. Nothing
    // downstream needs a card specifically: acceptGroupTransfer only makes the
    // confirmed method the customer's default, which is method-agnostic.
    const si = await getStripe().setupIntents.create({
      customer: group.stripe_customer_id,
      usage: "off_session",
      metadata: {
        kind: TRANSFER_INTENT_KIND,
        subscription_id: subscriptionId,
        from_user_id: actorUserId,
        to_user_id: recipient.id,
        // Bounded on purpose: an offer that never expires is a standing claim on
        // somebody else's subscription. Checked on acceptance, since Stripe will
        // happily keep the intent for ever.
        expires_at: String(Math.floor(Date.now() / 1000) + TRANSFER_OFFER_TTL_SECONDS),
      },
    });
    if (!si.client_secret) throw new HttpError(500, "Stripe returned no client secret");
    return {
      status: "pending_card",
      subscription_id: subscriptionId,
      owner_user_id: group.owner_user_id,
      setup_intent_id: si.id,
      client_secret: si.client_secret,
    };
  }

  // No live subscription: nothing can dun, nothing can cancel, so there is no
  // reason to make the recipient produce a card first. The recipient must
  // already own an org in the group, though — this path has no acceptance step,
  // so org ownership is the only consent in it.
  await assertRecipientOwnsAnOrgInGroup(subscriptionId, recipient.id);
  const moved = await handOverGroup(group, recipient, null);
  await finishHandover(moved, recipient, null);
  return { status: "transferred", subscription_id: subscriptionId, owner_user_id: recipient.id };
}

/**
 * The recipient accepts: they have confirmed `setupIntentId` with their own
 * card, so the group can change hands without the subscription ever being
 * cardless.
 *
 * Everything is re-verified against Stripe and against the row as it is NOW —
 * the offer may be minutes or days old, the group may have been transferred to
 * somebody else, cancelled, or moved to another customer since.
 */
export async function acceptGroupTransfer(args: {
  actorUserId: string;
  setupIntentId: string;
}): Promise<{ subscription_id: string; owner_user_id: string }> {
  const { actorUserId, setupIntentId } = args;
  const stripe = getStripe();
  const si = await stripe.setupIntents.retrieve(setupIntentId);
  const meta = si.metadata ?? {};
  if (meta.kind !== TRANSFER_INTENT_KIND || !meta.subscription_id)
    throw new HttpError(400, "That is not a billing group transfer.");
  if (meta.to_user_id !== actorUserId)
    throw new HttpError(403, "This billing group was offered to somebody else.");
  // One use. Without this an offer is a permanent bearer token: A hands the
  // group to B, later takes it back, and B replays the same intent to seize a
  // group full of A's organisations. Only incidentally impossible today, because
  // B's card happens to have been detached in between.
  if (meta.consumed_at) throw new HttpError(409, "That transfer has already been used.");
  if (meta.revoked_at) throw new HttpError(409, "That transfer was withdrawn.");
  if (meta.expires_at && Number(meta.expires_at) < Math.floor(Date.now() / 1000))
    throw new HttpError(409, "That transfer offer has expired — ask for a new one.");
  const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
  // The whole point of the second phase: no card, no transfer.
  if (si.status !== "succeeded" || !pmId)
    throw new HttpError(400, "Add a card to take over this billing group.");

  const recipient = await transferRecipient(actorUserId);
  const siCustomer = typeof si.customer === "string" ? si.customer : si.customer?.id;

  // BURN THE OFFER FIRST, and treat a failure to burn it as fatal.
  //
  // This was a `.catch(log)` after the handover, which made single-use a
  // best-effort property: a failed stamp left the offer acceptable for the rest
  // of its 7-day TTL, and a replay was only *incidentally* useless because it
  // would try to default a payment method that had since been detached.
  // Incidental is not an invariant.
  //
  // Burning first inverts the failure: a handover that then fails leaves a spent
  // offer and the payer re-offers, which is a nuisance. Not burning it leaves a
  // live claim on somebody else's subscription, which is a security property.
  // The nuisance is the right side to fail on.
  //
  // A durable local row would be better still — this is Stripe's storage, and
  // A -> B -> A returns `from_user_id` to matching — but that needs a table, and
  // the ownership compare-and-swap in handOverGroup covers the same-tenure case.
  await stripe.setupIntents.update(setupIntentId, {
    metadata: { ...meta, consumed_at: String(Math.floor(Date.now() / 1000)) },
  });

  const moved = await handOverGroup(
    { id: meta.subscription_id, expectOwner: meta.from_user_id, expectCustomer: siCustomer },
    recipient,
    pmId,
  );
  await finishHandover(moved, recipient, pmId);
  return { subscription_id: moved.id, owner_user_id: recipient.id };
}

/**
 * Withdraw an outstanding offer. A payer who changes their mind — or who
 * offered the group to the wrong person — must not have to wait out the TTL
 * while somebody else holds a live claim on their subscription.
 */
export async function revokeGroupTransfer(args: {
  actorUserId: string;
  setupIntentId: string;
}): Promise<{ revoked: boolean }> {
  const stripe = getStripe();
  const si = await stripe.setupIntents.retrieve(args.setupIntentId);
  const meta = si.metadata ?? {};
  if (meta.kind !== TRANSFER_INTENT_KIND || !meta.subscription_id)
    throw new HttpError(400, "That is not a billing group transfer.");
  const group = await groupRow(meta.subscription_id);
  // The CURRENT payer, not the one who made the offer: if the group has changed
  // hands, the person holding it now is the one with an interest in killing a
  // stale claim on it.
  if (!group || group.owner_user_id !== args.actorUserId)
    throw new HttpError(403, "Only the person who pays for this billing group can withdraw it.");
  if (meta.consumed_at) throw new HttpError(409, "That transfer has already been used.");
  await stripe.setupIntents.update(args.setupIntentId, {
    metadata: { ...meta, revoked_at: String(Math.floor(Date.now() / 1000)) },
  });
  // Belt and braces: a cancelled intent can never be confirmed either.
  await stripe.setupIntents
    .cancel(args.setupIntentId)
    .catch(() => {/* already succeeded/cancelled — the metadata stamp stands */});
  return { revoked: true };
}

export interface PendingTransferOffer {
  setup_intent_id: string;
  subscription_id: string;
  /** Only ever populated for the RECIPIENT — see listGroupTransferOffers. */
  client_secret: string | null;
  from_user_id: string | null;
  to_user_id: string | null;
  expires_at: number | null;
  direction: "made_by_me" | "made_to_me";
}

/**
 * Outstanding transfer offers involving this user, read back from STRIPE.
 *
 * This closes a hole the offer design had rather than adding the table it
 * avoided. `offerGroupTransfer` returned the SetupIntent id exactly once, to the
 * offerer, and nothing stored it — so after a page reload the payer could no
 * longer REVOKE the offer they had just made. It stood as a live claim on their
 * own subscription for the whole seven-day TTL with no way to withdraw it. The
 * recipient, meanwhile, had no way to find it at all.
 *
 * The fix is to take the design at its word: the SetupIntent IS the record, and
 * Stripe can be asked for it. Offers are listed per customer, which is bounded —
 * a payer has one group, occasionally two after a detach.
 *
 * `client_secret` is returned ONLY to the recipient. They are the one who has to
 * confirm a card against it; the offerer never needs to see it, and handing them
 * a secret to forward is how it ends up in an email thread. That also means
 * nobody has to "send a link" any more — the offer appears on the recipient's
 * own billing page.
 *
 * Spent, withdrawn and lapsed offers are filtered out here rather than shown
 * greyed: an offer that cannot be acted on is not information, it is clutter.
 */
export async function listGroupTransferOffers(
  userId: string,
): Promise<PendingTransferOffer[]> {
  // Customers to ask about: the groups this user PAYS for (offers they made),
  // and the groups their organisations sit in (offers made to them). A user is
  // usually in both sets for the same group; dedupe before calling Stripe.
  const rows = await sql<{ id: string; stripe_customer_id: string | null; mine: boolean }[]>`
    select s.id, s.stripe_customer_id, (s.owner_user_id = ${userId}) as mine
      from subscriptions s
     where s.stripe_customer_id is not null
       and (s.owner_user_id = ${userId}
            or exists (select 1 from organizations o
                        join org_members m on m.org_id = o.id
                       where o.subscription_id = s.id
                         and o.deleted_at is null
                         and m.user_id = ${userId}
                         and m.role = 'owner'))`;

  const byCustomer = new Map<string, { subscriptionId: string; mine: boolean }>();
  for (const r of rows) {
    if (!r.stripe_customer_id) continue;
    const seen = byCustomer.get(r.stripe_customer_id);
    // `mine` wins if either row says so — being the payer is what decides
    // whether an offer on this customer is one you made.
    byCustomer.set(r.stripe_customer_id, {
      subscriptionId: r.id,
      mine: (seen?.mine ?? false) || r.mine,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const offers: PendingTransferOffer[] = [];
  for (const [customerId, ctx] of byCustomer) {
    // One broken customer must not blank the whole list — a payer with two
    // groups still deserves to see the offers on the other one.
    const list = await getStripe()
      .setupIntents.list({ customer: customerId, limit: 100 })
      .catch((err) => {
        console.error(`[billing] could not list transfer offers for ${customerId}`, err);
        return null;
      });
    if (!list) continue;
    for (const si of list.data) {
      const meta = si.metadata ?? {};
      if (meta.kind !== TRANSFER_INTENT_KIND || !meta.subscription_id) continue;
      if (meta.consumed_at || meta.revoked_at) continue;
      if (meta.expires_at && Number(meta.expires_at) < now) continue;
      const toMe = meta.to_user_id === userId;
      // Neither party: an offer on a customer whose group this user merely owns
      // an org in, made to somebody else. Not theirs to see.
      if (!toMe && !ctx.mine) continue;
      offers.push({
        setup_intent_id: si.id,
        subscription_id: meta.subscription_id,
        client_secret: toMe ? si.client_secret : null,
        from_user_id: meta.from_user_id ?? null,
        to_user_id: meta.to_user_id ?? null,
        expires_at: meta.expires_at ? Number(meta.expires_at) : null,
        direction: toMe ? "made_to_me" : "made_by_me",
      });
    }
  }
  return offers;
}

/**
 * The ownership write, and the ONLY place it happens.
 *
 * The write lives inside the SAME transaction as the `for update`, because
 * postgres.js releases the lock when the callback returns: a gate checked in one
 * transaction and a write performed in another is not atomic, and two concurrent
 * accepts both pass. What makes the loser fail is re-reading `owner_user_id`
 * under the lock; the `where owner_user_id = <expected>` on the update is a
 * second line of defence that also catches a caller passing a stale expectation.
 * Failing here is what stops the loser going on to detach the winner's card in
 * finishHandover.
 *
 * Setting the incoming card as the customer default happens INSIDE the lock too,
 * before the swap, so the subscription is funded by the new payer before they
 * own it and the loser of a race never touches Stripe at all.
 */
async function handOverGroup(
  target: GroupRow | { id: string; expectOwner: string; expectCustomer?: string },
  recipient: { id: string; email: string; display_name: string },
  newPaymentMethodId: string | null,
): Promise<GroupRow> {
  const expectOwner = "expectOwner" in target ? target.expectOwner : target.owner_user_id;
  const expectCustomer = "expectCustomer" in target ? target.expectCustomer : undefined;
  return sql.begin(async (tx) => {
    // Bounded for the same reason syncGroupQuantity is: the customers.update
    // below is a network call made while this lock is held.
    await tx`set local lock_timeout = '5s'`;
    await tx`set local statement_timeout = '30s'`;
    const [row] = await tx<GroupRow[]>`
      select ${groupCols()} from subscriptions where id = ${target.id} for update`;
    if (!row) throw new HttpError(404, "That billing group no longer exists.");
    if (row.owner_user_id !== expectOwner)
      throw new HttpError(409, "This billing group has changed hands since it was offered.");
    if (expectCustomer !== undefined && row.stripe_customer_id !== expectCustomer)
      throw new HttpError(409, "This offer no longer matches the group's billing account.");

    if (row.stripe_customer_id && newPaymentMethodId) {
      await getStripe().customers.update(row.stripe_customer_id, {
        invoice_settings: { default_payment_method: newPaymentMethodId },
      });
    }

    const [swapped] = await tx<{ id: string }[]>`
      update subscriptions set owner_user_id = ${recipient.id}, updated_at = now()
       where id = ${target.id} and owner_user_id = ${expectOwner}
      returning id`;
    if (!swapped)
      throw new HttpError(409, "This billing group has changed hands since it was offered.");
    return row;
  }) as unknown as GroupRow;
}

/**
 * Everything after the handover has committed: repoint the invoice contact, and
 * only then detach the cards that funded the OLD owner's tenure.
 *
 * Detaching last is the whole safety property — a live subscription is never
 * without a payment method — and it runs for the winner of a race only, because
 * the loser threw inside handOverGroup.
 */
async function finishHandover(
  group: GroupRow,
  recipient: { id: string; email: string; display_name: string },
  newPaymentMethodId: string | null,
): Promise<void> {
  const customerId = group.stripe_customer_id;
  if (!customerId) return;
  const stripe = getStripe();
  // Invoices, receipts and dunning email must reach the new payer.
  await stripe.customers.update(customerId, {
    name: recipient.display_name,
    email: recipient.email,
  });
  const cards = await stripe.customers.listPaymentMethods(customerId, { type: "card", limit: 100 });
  for (const pm of cards.data) {
    if (pm.id === newPaymentMethodId) continue;
    // Belt and braces against the outage this design exists to avoid: never
    // strip the last card off a live subscription, whatever the caller asked.
    if (!newPaymentMethodId && hasLiveSubscription(group)) break;
    await stripe.paymentMethods.detach(pm.id);
  }
  // Re-derives the has_payment_method mirror from Stripe rather than assuming —
  // the same rule every other writer follows.
  await syncPaymentMethodFlagForSubscription(group.id);
}

async function transferRecipient(
  userId: string,
): Promise<{ id: string; email: string; display_name: string }> {
  const [recipient] = await sql<{ id: string; email: string; display_name: string }[]>`
    select id, email, display_name from users
     where id = ${userId} and deleted_at is null`;
  if (!recipient) throw new HttpError(404, "That person does not have an account.");
  return recipient;
}

/** A group may only be pushed onto someone who already owns one of its orgs.
 *  Only enforced where the recipient never says yes — the accept path has their
 *  consent AND their card, which is stronger, and requiring membership there
 *  would break the documented federation/agency case (decision M3: the payer
 *  need not be a member). */
async function assertRecipientOwnsAnOrgInGroup(
  subscriptionId: string,
  userId: string,
): Promise<void> {
  const [row] = await sql<{ id: string }[]>`
    select o.id from organizations o
      join org_members m on m.org_id = o.id and m.user_id = ${userId} and m.role = 'owner'
     where o.subscription_id = ${subscriptionId} and o.deleted_at is null
     limit 1`;
  if (!row)
    throw new HttpError(
      400,
      "That person does not own an organisation in this billing group — ask them to accept the transfer instead.",
    );
}
