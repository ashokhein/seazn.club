// #305 (#286 phase 2) — the STAFF RESOLUTION path for a pass-credit redemption
// stuck on `reversal_undetermined_at`.
//
// Phase 1 (V337) made an undetermined reversal hold the group's one lifetime
// pass credit PERMANENTLY: `reversed_at` is stamped (webhook idempotency) but
// nothing was actually clawed back, so the widened
// `pass_credit_redemptions_group_cap` keeps the row live. That is correct — the
// customer provably still holds the £/$ credit — but nothing ever cleared it,
// so a group whose balance staff later settled by hand in Stripe stayed capped
// forever with no release path.
//
// What this suite pins is the two things that make a release path safe rather
// than a lever that loses money:
//
//   1. BOTH outcomes are expressible. "Staff clawed it back in Stripe" frees
//      the cap; "the customer keeps it" leaves the cap held and is recorded as
//      REVIEWED. A path that only supports the first is a way to hand out a
//      second credit; a path that only supports the second is not a resolution
//      at all.
//   2. Every resolution is attributable and ATOMIC with its audit row (the
//      admin-addons.ts / #272 adminAdjust pattern): a crash between the column
//      clear and the audit insert can never leave a freed cap with nobody's
//      name on it. The FK-violation test below is the real proof of that — it
//      forces the audit insert to fail and asserts the cap did NOT move.
//
// And, crucially, resolving ONE row must not free ANY other: the
// "stays blocked" test seeds two independent groups and resolves only one.
//
// Real Postgres required; skipped without DATABASE_URL. Stripe is mocked and
// asserted NEVER to be called — staff settle the balance by hand in the Stripe
// dashboard BEFORE recording the decision here, so a second automatic claw-back
// from this path would take the money twice.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => ({
  retrieveCustomer: vi.fn(),
  listBalance: vi.fn(),
  createBalance: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    customers: {
      retrieve: stripeMock.retrieveCustomer,
      listBalanceTransactions: stripeMock.listBalance,
      createBalanceTransaction: stripeMock.createBalance,
    },
  }),
}));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { adjustmentsForOrg } from "@/server/usecases/admin-adjustments-log";
import {
  PASS_CREDIT_RESOLVE_ACTION,
  creditPassTowardSubscription,
  groupAlreadyRedeemed,
  listUndeterminedPassCreditReversals,
  resolveUndeterminedPassCreditReversal,
} from "../pass-credit";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 12);
const orgIds: string[] = [];
const actorIds: string[] = [];

async function seedActor(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, is_staff, staff_role)
    values (${"resolver-" + uniq() + "@test.local"}, 'Resolver', true, true, 'superadmin')
    returning id`;
  actorIds.push(id);
  return id;
}

/** One group holding one UNDETERMINED redemption — the exact row state
 *  `reversePassCreditOnRefund`'s unsafe branch leaves behind (reversed_at
 *  stamped as the idempotency guard, reversed_minor 0, undetermined stamped). */
async function seedUndeterminedRedemption(opts?: { amountMinor?: number }): Promise<{
  redemptionId: string;
  orgId: string;
  subscriptionId: string;
  intent: string;
}> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Resolve Org " + suffix}, ${"resolve-org-" + suffix}) returning id`;
  orgIds.push(orgId);
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('resolveowner-' || gen_random_uuid() || '@test.local', 'Resolve Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, stripe_customer_id, currency)
      select coalesce(o.created_by, (select id from _owner)), 'pro', 'active',
             ${"cus_" + suffix}, 'gbp'
      from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  const [{ subscription_id: subscriptionId }] = await sql<{ subscription_id: string }[]>`
    select subscription_id from organizations where id = ${orgId}`;

  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Resolve Cup " + suffix}, ${"resolve-cup-" + suffix}) returning id`;
  const intent = "pi_" + suffix;
  const [{ id: redemptionId }] = await sql<{ id: string }[]>`
    insert into pass_credit_redemptions
      (subscription_id, org_id, competition_id, payment_intent, amount_minor, currency,
       reversed_at, reversed_minor, reversal_undetermined_at)
    values (${subscriptionId}, ${orgId}, ${competitionId}, ${intent},
            ${opts?.amountMinor ?? 2500}, 'gbp', now(), 0, now())
    returning id`;
  return { redemptionId, orgId, subscriptionId, intent };
}

/** A second, different Event Pass on the same org — the thing the cap must go
 *  on refusing (or start allowing) depending on the resolution. */
async function seedCompetitionPass(orgId: string): Promise<string> {
  const suffix = uniq();
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Second Pass " + suffix}, ${"second-pass-" + suffix}) returning id`;
  const intent = "pi_second_" + suffix;
  await sql`
    insert into competition_passes (competition_id, org_id, stripe_payment_intent, purchased_at)
    values (${competitionId}, ${orgId}, ${intent}, now())`;
  return intent;
}

async function redemptionRow(id: string) {
  const [row] = await sql<
    {
      reversed_at: string | null;
      reversed_minor: number | null;
      amount_minor: number;
      reversal_undetermined_at: string | null;
    }[]
  >`select reversed_at, reversed_minor, amount_minor, reversal_undetermined_at
      from pass_credit_redemptions where id = ${id}`;
  return row;
}

async function auditRows(redemptionId: string) {
  return sql<{ actor_id: string; action: string; target_type: string; target_id: string; detail: Record<string, unknown> }[]>`
    select actor_id, action, target_type, target_id, detail
      from staff_audit_log
     where action = ${PASS_CREDIT_RESOLVE_ACTION}
       and detail->>'redemption_id' = ${redemptionId}
     order by created_at asc`;
}

beforeEach(() => {
  stripeMock.retrieveCustomer.mockReset();
  stripeMock.listBalance.mockReset();
  stripeMock.createBalance.mockReset();
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (actorIds.length) {
    await sql`delete from staff_audit_log where actor_id = any(${actorIds})`;
  }
  if (orgIds.length) {
    await sql`delete from competitions where org_id = any(${orgIds})`;
    const groups = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations
       where id = any(${orgIds}) and subscription_id is not null`;
    await sql`delete from organizations where id = any(${orgIds})`;
    if (groups.length)
      await sql`delete from subscriptions where id = any(${groups.map((g) => g.subscription_id)})`;
  }
  if (actorIds.length) await sql`delete from users where id = any(${actorIds})`;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("resolveUndeterminedPassCreditReversal", () => {
  it("'clawed_back' clears the hold, frees the group cap, and records who decided", async () => {
    const actorId = await seedActor();
    const { redemptionId, subscriptionId, orgId } = await seedUndeterminedRedemption();
    expect(await groupAlreadyRedeemed(subscriptionId)).toBe(true);

    const res = await resolveUndeterminedPassCreditReversal(actorId, redemptionId, {
      resolution: "clawed_back",
      reversedMinor: 2500,
      reason: "settled by hand in Stripe, txn cbtxn_x",
    });

    expect(res.resolved).toBe(true);
    const row = await redemptionRow(redemptionId);
    expect(row?.reversal_undetermined_at).toBeNull();
    expect(row?.reversed_at).not.toBeNull(); // idempotency stamp untouched
    expect(row?.reversed_minor).toBe(2500); // what staff actually removed
    // The whole point: the group can mint its next pass credit again.
    expect(await groupAlreadyRedeemed(subscriptionId)).toBe(false);

    const audit = await auditRows(redemptionId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_id).toBe(actorId);
    expect(audit[0]!.target_type).toBe("org");
    expect(audit[0]!.target_id).toBe(orgId);
    expect(audit[0]!.detail.resolution).toBe("clawed_back");
    expect(audit[0]!.detail.reversed_minor).toBe(2500);
    expect(audit[0]!.detail.reason).toBe("settled by hand in Stripe, txn cbtxn_x");
  });

  // The audit row above is the ONLY durable record of who decided — and an
  // audit nobody can read is not an audit. `/admin/orgs/[id]`'s "Adjustments
  // log" is an ALLOWLIST (ADJUSTMENT_ACTIONS), so a decision written with an
  // unlisted action lands in the table and shows up nowhere a human looks.
  // Driven through the real writer so the logged string is the one under test.
  it("surfaces the resolution in the org's adjustments log", async () => {
    const actorId = await seedActor();
    const { redemptionId, orgId } = await seedUndeterminedRedemption();

    await resolveUndeterminedPassCreditReversal(actorId, redemptionId, {
      resolution: "kept",
      reason: "customer keeps it — finance signed off",
    });

    const entries = await adjustmentsForOrg(orgId);
    const entry = entries.find((e) => e.action === PASS_CREDIT_RESOLVE_ACTION);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      actorId,
      // The `"pass"` member of AdjustmentCategory was declared for exactly this
      // action and then left with nothing mapped to it.
      category: "pass",
      // It records a decision already carried out by hand in Stripe. There is
      // no compensating staff control, so it is terminal.
      reversible: false,
      reason: "customer keeps it — finance signed off",
    });
    expect(entry!.detail.redemption_id).toBe(redemptionId);
  });

  it("'clawed_back' moves NO money — staff already settled it in Stripe by hand", async () => {
    const actorId = await seedActor();
    const { redemptionId } = await seedUndeterminedRedemption();

    await resolveUndeterminedPassCreditReversal(actorId, redemptionId, {
      resolution: "clawed_back",
      reversedMinor: 2500,
      reason: "already reversed in dashboard",
    });

    // A second automatic claw-back here would debit the customer twice.
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
    expect(stripeMock.retrieveCustomer).not.toHaveBeenCalled();
  });

  it("'kept' leaves the cap HELD and still records who decided", async () => {
    const actorId = await seedActor();
    const { redemptionId, subscriptionId, orgId } = await seedUndeterminedRedemption();

    const res = await resolveUndeterminedPassCreditReversal(actorId, redemptionId, {
      resolution: "kept",
      reason: "customer keeps the credit, confirmed with finance",
    });

    expect(res.resolved).toBe(true);
    const row = await redemptionRow(redemptionId);
    // The customer still holds the money, so the cap must go on holding.
    expect(row?.reversal_undetermined_at).not.toBeNull();
    expect(row?.reversed_minor).toBe(0);
    expect(await groupAlreadyRedeemed(subscriptionId)).toBe(true);

    // ...and a second mint is still refused, which is the money statement.
    await seedCompetitionPass(orgId);
    const second = await creditPassTowardSubscription(orgId);
    expect(second.outcome).toBe("group_already_redeemed");
    expect(stripeMock.createBalance).not.toHaveBeenCalled();

    const audit = await auditRows(redemptionId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail.resolution).toBe("kept");
    expect(audit[0]!.actor_id).toBe(actorId);
  });

  it("resolving ONE row leaves every OTHER undetermined row blocked", async () => {
    const actorId = await seedActor();
    const resolved = await seedUndeterminedRedemption();
    const untouched = await seedUndeterminedRedemption();

    await resolveUndeterminedPassCreditReversal(actorId, resolved.redemptionId, {
      resolution: "clawed_back",
      reversedMinor: 2500,
      reason: "settled",
    });

    expect(await groupAlreadyRedeemed(resolved.subscriptionId)).toBe(false);
    // The guard must not be satisfiable by resolving anything at all: this
    // group nobody looked at is still capped, and still cannot mint.
    expect(await groupAlreadyRedeemed(untouched.subscriptionId)).toBe(true);
    expect((await redemptionRow(untouched.redemptionId))?.reversal_undetermined_at).not.toBeNull();
    await seedCompetitionPass(untouched.orgId);
    expect((await creditPassTowardSubscription(untouched.orgId)).outcome).toBe(
      "group_already_redeemed",
    );
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("is atomic with its audit row — a failed audit write leaves the cap held", async () => {
    const { redemptionId, subscriptionId } = await seedUndeterminedRedemption();
    // staff_audit_log.actor_id is a NOT NULL FK to users: an actor that does
    // not exist makes the audit INSERT throw. If the column clear were not in
    // the same transaction, the cap would already be freed with no record of
    // who freed it — the exact failure this pattern exists to prevent.
    const ghostActor = randomUUID();

    await expect(
      resolveUndeterminedPassCreditReversal(ghostActor, redemptionId, {
        resolution: "clawed_back",
        reversedMinor: 2500,
        reason: "should roll back",
      }),
    ).rejects.toThrow();

    const row = await redemptionRow(redemptionId);
    expect(row?.reversal_undetermined_at).not.toBeNull();
    expect(row?.reversed_minor).toBe(0);
    expect(await groupAlreadyRedeemed(subscriptionId)).toBe(true);
  });

  it("a replayed 'clawed_back' is a no-op and writes no second audit row", async () => {
    const actorId = await seedActor();
    const { redemptionId } = await seedUndeterminedRedemption();
    const input = {
      resolution: "clawed_back" as const,
      reversedMinor: 2500,
      reason: "settled",
    };

    expect((await resolveUndeterminedPassCreditReversal(actorId, redemptionId, input)).resolved).toBe(true);
    expect((await resolveUndeterminedPassCreditReversal(actorId, redemptionId, input)).resolved).toBe(false);

    expect(await auditRows(redemptionId)).toHaveLength(1);
  });

  it("a replayed 'kept' is a no-op and writes no second audit row", async () => {
    const actorId = await seedActor();
    const { redemptionId } = await seedUndeterminedRedemption();
    const input = { resolution: "kept" as const, reason: "customer keeps it" };

    expect((await resolveUndeterminedPassCreditReversal(actorId, redemptionId, input)).resolved).toBe(true);
    expect((await resolveUndeterminedPassCreditReversal(actorId, redemptionId, input)).resolved).toBe(false);

    expect(await auditRows(redemptionId)).toHaveLength(1);
  });

  it("a 'kept' row can still be re-resolved to 'clawed_back' once staff settle it", async () => {
    const actorId = await seedActor();
    const { redemptionId, subscriptionId } = await seedUndeterminedRedemption();

    await resolveUndeterminedPassCreditReversal(actorId, redemptionId, {
      resolution: "kept",
      reason: "leave it for now",
    });
    expect(await groupAlreadyRedeemed(subscriptionId)).toBe(true);

    const res = await resolveUndeterminedPassCreditReversal(actorId, redemptionId, {
      resolution: "clawed_back",
      reversedMinor: 2500,
      reason: "finance clawed it back after all",
    });
    expect(res.resolved).toBe(true);
    expect(await groupAlreadyRedeemed(subscriptionId)).toBe(false);
    expect(await auditRows(redemptionId)).toHaveLength(2);
  });

  it("refuses an unknown redemption id with a 404", async () => {
    const actorId = await seedActor();
    await expect(
      resolveUndeterminedPassCreditReversal(actorId, randomUUID(), {
        resolution: "kept",
        reason: "x",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a redemption that was never undetermined with a 409", async () => {
    const actorId = await seedActor();
    const { redemptionId } = await seedUndeterminedRedemption();
    // A cleanly, automatically reversed row: nothing to decide.
    await sql`update pass_credit_redemptions
                 set reversal_undetermined_at = null, reversed_minor = 2500
               where id = ${redemptionId}`;

    await expect(
      resolveUndeterminedPassCreditReversal(actorId, redemptionId, {
        resolution: "kept",
        reason: "x",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await auditRows(redemptionId)).toHaveLength(0);
  });

  it("refuses a claw-back larger than the grant, changing nothing", async () => {
    const actorId = await seedActor();
    const { redemptionId, subscriptionId } = await seedUndeterminedRedemption({ amountMinor: 2500 });

    await expect(
      resolveUndeterminedPassCreditReversal(actorId, redemptionId, {
        resolution: "clawed_back",
        reversedMinor: 9999,
        reason: "fat finger",
      }),
    ).rejects.toBeInstanceOf(HttpError);

    expect((await redemptionRow(redemptionId))?.reversal_undetermined_at).not.toBeNull();
    expect(await groupAlreadyRedeemed(subscriptionId)).toBe(true);
    expect(await auditRows(redemptionId)).toHaveLength(0);
  });

  it("requires reversedMinor on a claw-back — the row must not claim 0 was taken", async () => {
    const actorId = await seedActor();
    const { redemptionId } = await seedUndeterminedRedemption();

    await expect(
      resolveUndeterminedPassCreditReversal(actorId, redemptionId, {
        resolution: "clawed_back",
        reason: "no amount given",
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect((await redemptionRow(redemptionId))?.reversal_undetermined_at).not.toBeNull();
  });
});

describe.skipIf(!HAS_DB)("listUndeterminedPassCreditReversals", () => {
  it("lists an unresolved row as open, then carries the decision once resolved", async () => {
    const actorId = await seedActor();
    const { redemptionId, orgId, intent } = await seedUndeterminedRedemption();

    const open = (await listUndeterminedPassCreditReversals()).find((r) => r.id === redemptionId);
    expect(open).toBeDefined();
    expect(open!.status).toBe("open");
    expect(open!.paymentIntent).toBe(intent);
    expect(open!.orgId).toBe(orgId);
    expect(open!.amountMinor).toBe(2500);
    expect(open!.resolvedBy).toBeNull();

    await resolveUndeterminedPassCreditReversal(actorId, redemptionId, {
      resolution: "kept",
      reason: "customer keeps it",
    });

    const reviewed = (await listUndeterminedPassCreditReversals()).find((r) => r.id === redemptionId);
    // Still holding the cap, but no longer an unanswered question.
    expect(reviewed!.status).toBe("kept");
    expect(reviewed!.resolvedBy).toBe(actorId);
    expect(reviewed!.resolvedAt).not.toBeNull();
    expect(reviewed!.reason).toBe("customer keeps it");
  });

  it("keeps a clawed-back row visible as closed history, not silently dropped", async () => {
    const actorId = await seedActor();
    const { redemptionId } = await seedUndeterminedRedemption();

    await resolveUndeterminedPassCreditReversal(actorId, redemptionId, {
      resolution: "clawed_back",
      reversedMinor: 2500,
      reason: "settled",
    });

    const closed = (await listUndeterminedPassCreditReversals()).find((r) => r.id === redemptionId);
    expect(closed).toBeDefined();
    expect(closed!.status).toBe("clawed_back");
    expect(closed!.undeterminedAt).toBeNull();
    expect(closed!.resolvedBy).toBe(actorId);
  });

  it("sorts unresolved rows before resolved ones — the worklist is the point", async () => {
    const actorId = await seedActor();
    const first = await seedUndeterminedRedemption();
    const second = await seedUndeterminedRedemption();
    await resolveUndeterminedPassCreditReversal(actorId, first.redemptionId, {
      resolution: "kept",
      reason: "reviewed",
    });

    const rows = await listUndeterminedPassCreditReversals();
    const openIdx = rows.findIndex((r) => r.id === second.redemptionId);
    const resolvedIdx = rows.findIndex((r) => r.id === first.redemptionId);
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(resolvedIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeLessThan(resolvedIdx);
  });
});
