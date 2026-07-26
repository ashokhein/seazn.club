// Webhook backstop for a Dashboard-refunded Event Pass (design 2026-07-26
// §5): `reversePassCreditOnRefund` claws back the UNSPENT portion of a
// pass-to-Pro subscription credit when the pass charge is refunded. Nothing
// in this codebase can stop support (or a chargeback) from refunding a pass
// charge directly in Stripe, so this is the safety net for the case
// `creditPassTowardSubscription` cannot see coming.
//
// The arithmetic is the point of this suite: Stripe's customer balance is ONE
// POOL per currency, shared with any other credit source that customer might
// ever have, so the only provably-safe reversal is
// `min(redemption.amount_minor, max(-customer.balance, 0))` — but ONLY when
// nothing else has touched the pool since the grant (a plan-downgrade
// proration credit is the concrete case: it lands on the exact same
// `customer.balance` field). `otherCreditActivitySince` proves that
// precondition before the formula is trusted at all; when it can't be proven,
// nothing is reversed and staff is alerted to look at Stripe directly rather
// than risk clawing back money that was never the pass's.
//
// Real Postgres required; skipped without DATABASE_URL. Stripe is mocked with
// a stateful fake balance ledger (same convention as pass-credit.test.ts):
// `listBalanceTransactions` and `customers.retrieve` both read back whatever
// the test seeded directly plus whatever `createBalanceTransaction` (this
// code's own reversal call) has since appended.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

interface FakeBalanceTxn {
  amount: number;
  currency: string;
  metadata?: Record<string, string>;
}

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

vi.mock("@/lib/email", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendPassCreditReversalIncompleteAlertEmail: vi.fn().mockResolvedValue(true),
  };
});

import { sql } from "@/lib/db";
import { sendPassCreditReversalIncompleteAlertEmail } from "@/lib/email";
import { PASS_CREDIT_INTENT_KEY, reversePassCreditOnRefund } from "../pass-credit";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 12);
const orgIds: string[] = [];

/** Stands in for the customer's balance history: `createBalanceTransaction`
 *  appends to it, `customers.retrieve` reports the running total (exactly the
 *  live shape `reverseAmount`'s `max(-customer.balance, 0)` reads), and
 *  `listBalanceTransactions` reports the same history back for
 *  `otherCreditActivitySince`'s scan. Tests seed the PRE-EXISTING history
 *  (grant, invoice consumption, any unrelated credit) directly via
 *  `ledger.push`. */
let ledger: FakeBalanceTxn[] = [];
const currentBalance = () => ledger.reduce((sum, t) => sum + t.amount, 0);

/** The grant's own balance-transaction entry, tagged the way
 *  `creditPassTowardSubscription` actually tags it — this is what
 *  `otherCreditActivitySince` must recognise and exclude via metadata, not
 *  via the `gte` bound alone (their `created` timestamps can land in the same
 *  second). */
function grantEntry(intent: string, amountMinor = 2500): FakeBalanceTxn {
  return { amount: -amountMinor, currency: "gbp", metadata: { [PASS_CREDIT_INTENT_KEY]: intent } };
}

async function seedOrgAndSubscription(customerId: string): Promise<{ orgId: string; subscriptionId: string }> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Refund Org " + suffix}, ${"refund-org-" + suffix}) returning id`;
  orgIds.push(orgId);
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('refundowner-' || gen_random_uuid() || '@test.local', 'Refund Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status, stripe_customer_id, currency)
      select coalesce(o.created_by, (select id from _owner)), 'pro', 'active', ${customerId}, 'gbp'
      from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  const [{ subscription_id: subscriptionId }] = await sql<{ subscription_id: string }[]>`
    select subscription_id from organizations where id = ${orgId}`;
  return { orgId, subscriptionId };
}

async function seedRedemption(opts: {
  subscriptionId: string;
  orgId: string;
  intent: string;
  amountMinor?: number;
  currency?: string;
  reversed?: boolean;
}): Promise<string> {
  const suffix = uniq();
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${opts.orgId}, ${"Refund Cup " + suffix}, ${"refund-cup-" + suffix}) returning id`;
  await sql`
    insert into pass_credit_redemptions
      (subscription_id, org_id, competition_id, payment_intent, amount_minor, currency, reversed_at)
    values (
      ${opts.subscriptionId}, ${opts.orgId}, ${competitionId}, ${opts.intent},
      ${opts.amountMinor ?? 2500}, ${opts.currency ?? "gbp"},
      ${opts.reversed ? new Date().toISOString() : null}
    )`;
  return competitionId;
}

async function redemptionRow(intent: string) {
  const [row] = await sql<
    { reversed_at: string | null; reversed_minor: number | null; amount_minor: number }[]
  >`select reversed_at, reversed_minor, amount_minor from pass_credit_redemptions where payment_intent = ${intent}`;
  return row;
}

beforeEach(() => {
  ledger = [];
  stripeMock.retrieveCustomer.mockReset().mockImplementation(async () => ({
    id: "cus_fake",
    deleted: false,
    balance: currentBalance(),
  }));
  stripeMock.listBalance.mockReset().mockImplementation(() => ({
    autoPagingToArray: async () => [...ledger],
  }));
  stripeMock.createBalance.mockReset().mockImplementation(async (_customerId: string, params: FakeBalanceTxn) => {
    ledger.push(params);
    return { id: `cbtxn_${uniq()}` };
  });
  vi.mocked(sendPassCreditReversalIncompleteAlertEmail).mockClear();
  process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (orgIds.length) {
    await sql`delete from competitions where org_id = any(${orgIds})`;
    const groups = await sql<{ subscription_id: string }[]>`
      select subscription_id from organizations
      where id = any(${orgIds}) and subscription_id is not null`;
    await sql`delete from organizations where id = any(${orgIds})`;
    if (groups.length)
      await sql`delete from subscriptions where id = any(${groups.map((g) => g.subscription_id)})`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("reversePassCreditOnRefund", () => {
  it("reverses the FULL grant when the credit is entirely unspent", async () => {
    const customerId = "cus_" + uniq();
    const { orgId, subscriptionId } = await seedOrgAndSubscription(customerId);
    const intent = "pi_" + uniq();
    // The 2500 minor units the original grant put on the balance — nothing
    // has drawn it down since.
    ledger.push(grantEntry(intent));
    await seedRedemption({ subscriptionId, orgId, intent, amountMinor: 2500 });

    await reversePassCreditOnRefund(intent);

    expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
    const [, params] = stripeMock.createBalance.mock.calls[0];
    expect(params.amount).toBe(2500);
    expect(params.currency).toBe("gbp");

    const row = await redemptionRow(intent);
    expect(row?.reversed_at).not.toBeNull();
    expect(row?.reversed_minor).toBe(2500);
    expect(sendPassCreditReversalIncompleteAlertEmail).not.toHaveBeenCalled();
  });

  it("reverses only the UNSPENT remainder — NOT the naive full amount", async () => {
    const customerId = "cus_" + uniq();
    const { orgId, subscriptionId } = await seedOrgAndSubscription(customerId);
    const intent = "pi_" + uniq();
    // 2500 granted, then an invoice consumed 1500 of it, leaving -1000.
    ledger.push(grantEntry(intent));
    ledger.push({ amount: 1500, currency: "gbp" });
    await seedRedemption({ subscriptionId, orgId, intent, amountMinor: 2500 });

    await reversePassCreditOnRefund(intent);

    expect(stripeMock.createBalance).toHaveBeenCalledTimes(1);
    const [, params] = stripeMock.createBalance.mock.calls[0];
    // This is the assertion that would fail under `reverseAmount = amount_minor`:
    // reversing the full 2500 against a customer who only has 1000 of credit
    // left would push the balance to +1500 — a debt the customer never agreed
    // to. min(2500, 1000) = 1000 is the only safe number.
    expect(params.amount).toBe(1000);

    const row = await redemptionRow(intent);
    expect(row?.reversed_minor).toBe(1000);
    // The other 1500 was absorbed — staff needs to know.
    expect(sendPassCreditReversalIncompleteAlertEmail).toHaveBeenCalledTimes(1);
    const alertArgs = vi.mocked(sendPassCreditReversalIncompleteAlertEmail).mock.calls[0]![0];
    expect(alertArgs.grantedMinor).toBe(2500);
    expect(alertArgs.reversedMinor).toBe(1000);
    expect(alertArgs.reason).toBe("consumed");
  });

  it("reverses NOTHING when the credit is fully spent, but still alerts", async () => {
    const customerId = "cus_" + uniq();
    const { orgId, subscriptionId } = await seedOrgAndSubscription(customerId);
    const intent = "pi_" + uniq();
    // The full 2500 grant was consumed by an invoice — balance is back to 0.
    ledger.push(grantEntry(intent));
    ledger.push({ amount: 2500, currency: "gbp" });
    await seedRedemption({ subscriptionId, orgId, intent, amountMinor: 2500 });

    await reversePassCreditOnRefund(intent);

    // Nothing to reverse — the Stripe call must not even be attempted.
    expect(stripeMock.createBalance).not.toHaveBeenCalled();

    const row = await redemptionRow(intent);
    expect(row?.reversed_at).not.toBeNull();
    expect(row?.reversed_minor).toBe(0);
    // The entire grant was absorbed — this is exactly the case staff most
    // needs to hear about.
    expect(sendPassCreditReversalIncompleteAlertEmail).toHaveBeenCalledTimes(1);
    const alertArgs = vi.mocked(sendPassCreditReversalIncompleteAlertEmail).mock.calls[0]![0];
    expect(alertArgs.reversedMinor).toBe(0);
    expect(alertArgs.reason).toBe("consumed");
  });

  it("no-ops when no redemption row exists for this intent", async () => {
    // Covers a non-pass refund, a duplicate-pass-payment refund (never
    // credited), and a pass refunded before it ever earned a credit.
    const intent = "pi_never_credited_" + uniq();

    await reversePassCreditOnRefund(intent);

    expect(stripeMock.listBalance).not.toHaveBeenCalled();
    expect(stripeMock.retrieveCustomer).not.toHaveBeenCalled();
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
    expect(sendPassCreditReversalIncompleteAlertEmail).not.toHaveBeenCalled();
  });

  it("no-ops when the redemption was already reversed (webhook replay)", async () => {
    const customerId = "cus_" + uniq();
    const { orgId, subscriptionId } = await seedOrgAndSubscription(customerId);
    const intent = "pi_" + uniq();
    await seedRedemption({ subscriptionId, orgId, intent, amountMinor: 2500, reversed: true });

    await reversePassCreditOnRefund(intent);

    expect(stripeMock.listBalance).not.toHaveBeenCalled();
    expect(stripeMock.retrieveCustomer).not.toHaveBeenCalled();
    expect(stripeMock.createBalance).not.toHaveBeenCalled();
  });

  it("does not throw and leaves reversed_at null when the Stripe call fails", async () => {
    const customerId = "cus_" + uniq();
    const { orgId, subscriptionId } = await seedOrgAndSubscription(customerId);
    const intent = "pi_" + uniq();
    ledger.push(grantEntry(intent));
    await seedRedemption({ subscriptionId, orgId, intent, amountMinor: 2500 });
    stripeMock.createBalance.mockRejectedValueOnce(new Error("Stripe is down"));

    await expect(reversePassCreditOnRefund(intent)).resolves.toBeUndefined();

    const row = await redemptionRow(intent);
    expect(row?.reversed_at).toBeNull();
    expect(row?.reversed_minor).toBeNull();
  });

  it("skips the Stripe reversal and alerts 'undetermined' when other balance activity touched the pool since the grant", async () => {
    const customerId = "cus_" + uniq();
    const { orgId, subscriptionId } = await seedOrgAndSubscription(customerId);
    const intent = "pi_" + uniq();
    // Grant, an invoice consuming part of it, then an UNRELATED credit (e.g.
    // a plan-downgrade proration credit landing on the same balance field,
    // billing-manage.ts:63/:256) with NO pass_payment_intent metadata — the
    // exact shape that makes the current balance un-attributable to this pass.
    ledger.push(grantEntry(intent));
    ledger.push({ amount: 1500, currency: "gbp" });
    ledger.push({ amount: -500, currency: "gbp" }); // unrelated credit
    await seedRedemption({ subscriptionId, orgId, intent, amountMinor: 2500 });

    await reversePassCreditOnRefund(intent);

    // Cannot prove the split between this pass and the unrelated credit —
    // must not guess, so the balance is never even read, let alone touched.
    expect(stripeMock.retrieveCustomer).not.toHaveBeenCalled();
    expect(stripeMock.createBalance).not.toHaveBeenCalled();

    const row = await redemptionRow(intent);
    expect(row?.reversed_at).not.toBeNull();
    expect(row?.reversed_minor).toBe(0);

    expect(sendPassCreditReversalIncompleteAlertEmail).toHaveBeenCalledTimes(1);
    const alertArgs = vi.mocked(sendPassCreditReversalIncompleteAlertEmail).mock.calls[0]![0];
    expect(alertArgs.reason).toBe("undetermined");
    expect(alertArgs.reversedMinor).toBe(0);
    expect(alertArgs.grantedMinor).toBe(2500);
  });

  it("fails closed (treated as unsafe) when the balance-activity read itself fails", async () => {
    const customerId = "cus_" + uniq();
    const { orgId, subscriptionId } = await seedOrgAndSubscription(customerId);
    const intent = "pi_" + uniq();
    ledger.push(grantEntry(intent));
    await seedRedemption({ subscriptionId, orgId, intent, amountMinor: 2500 });
    stripeMock.listBalance.mockImplementationOnce(() => {
      throw new Error("Stripe unreachable");
    });

    await reversePassCreditOnRefund(intent);

    // "Cannot prove the pool is clean" fails the same direction as "proven
    // dirty" — never "assume clean and reverse anyway".
    expect(stripeMock.retrieveCustomer).not.toHaveBeenCalled();
    expect(stripeMock.createBalance).not.toHaveBeenCalled();

    const row = await redemptionRow(intent);
    expect(row?.reversed_at).not.toBeNull();
    expect(row?.reversed_minor).toBe(0);
    expect(sendPassCreditReversalIncompleteAlertEmail).toHaveBeenCalledTimes(1);
    const alertArgs = vi.mocked(sendPassCreditReversalIncompleteAlertEmail).mock.calls[0]![0];
    expect(alertArgs.reason).toBe("undetermined");
  });

  it("only the WINNER of two concurrent deliveries writes the row and sends the alert", async () => {
    const customerId = "cus_" + uniq();
    const { orgId, subscriptionId } = await seedOrgAndSubscription(customerId);
    const intent = "pi_" + uniq();
    // Partial-consumption shape so an alert is unambiguously expected exactly
    // once — this is finding 2's race: two genuinely concurrent webhook
    // redeliveries can both pass the early `reversed_at is null` read-check
    // before either writes. The UPDATE's own `and reversed_at is null` guard
    // is the real optimistic-concurrency check; only the caller whose UPDATE
    // actually affects a row may alert.
    ledger.push(grantEntry(intent));
    ledger.push({ amount: 1500, currency: "gbp" });
    await seedRedemption({ subscriptionId, orgId, intent, amountMinor: 2500 });

    await Promise.all([reversePassCreditOnRefund(intent), reversePassCreditOnRefund(intent)]);

    expect(sendPassCreditReversalIncompleteAlertEmail).toHaveBeenCalledTimes(1);
    const row = await redemptionRow(intent);
    expect(row?.reversed_minor).toBe(1000);
  });
});
