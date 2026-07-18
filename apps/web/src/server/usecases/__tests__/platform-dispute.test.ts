// Platform-charge disputes (payments-hardening Task 7, P1-4, decisions §6.2): a
// chargeback on a Pro / Pro Plus subscription invoice or an Event Pass purchase
// is a PLATFORM charge — the money already left the platform account, there is
// NO transfer to reverse. Recovery is entitlement truth-up: `created` = flag +
// staff alert; `closed lost` on a subscription = auto-downgrade the org; `closed
// lost` on a pass = revoke it; `closed won` clears the flag. Dispatched LAST,
// after the registration + sponsor handlers (which no-op on platform charges).
//
// Real Postgres required; skipped without DATABASE_URL. Keyless test env: the
// pass branch matches by payment_intent (no Stripe call); the subscription
// branch reads the customer off the charge object the event carries inline (a
// real webhook sends a charge id string, which the handler retrieves — guarded
// on STRIPE_SECRET_KEY, absent here). Seeds are run-unique (randomUUID) so a
// re-run never collides with a prior run's rows.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// Observe the staff alert without touching the rest of the email module (send()
// is a no-op without RESEND_API_KEY either way).
const emailMock = vi.hoisted(() => ({ staff: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendStaffDisputeAlertEmail: emailMock.staff,
}));

import { sql } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { processStripeEvent } from "@/server/usecases/billing-events";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 12);

// A pro-plan org with a linked Stripe customer — the subscription-charge match
// key. stripe_subscription_id makes it a realistic Stripe-billed sub.
async function seedSubOrg(plan = "pro"): Promise<{ orgId: string; customer: string }> {
  const suffix = uniq();
  const customer = `cus_${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Sub Org " + suffix}, ${"sub-org-" + suffix}) returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status, stripe_customer_id, stripe_subscription_id)
    values (${orgId}, ${plan}, 'active', ${customer}, ${"sub_" + suffix})`;
  return { orgId, customer };
}

// A community org that bought an Event Pass for one competition.
async function seedPassOrg(): Promise<{ orgId: string; compId: string; intent: string }> {
  const suffix = uniq();
  const intent = `pi_pass_${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Pass Org " + suffix}, ${"pass-org-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Pass Cup " + suffix}, ${"pass-cup-" + suffix}) returning id`;
  await sql`
    insert into competition_passes (competition_id, org_id, stripe_payment_intent)
    values (${compId}, ${orgId}, ${intent})`;
  return { orgId, compId, intent };
}

/** A charge.dispute.* event for a SUBSCRIPTION charge: `charge` is expanded to
 *  an object carrying the customer (keyless tests supply it inline). The
 *  payment_intent is a non-pass value so the pass branch falls through to the
 *  customer match. */
function subDisputeEvent(
  phase: "created" | "closed",
  customer: string,
  id: string,
  status = "needs_response",
): Stripe.Event {
  return {
    type: phase === "created" ? "charge.dispute.created" : "charge.dispute.closed",
    data: {
      object: {
        id,
        status,
        amount: 1900,
        currency: "gbp",
        payment_intent: `pi_sub_${uniq()}`,
        charge: { customer },
      },
    },
  } as unknown as Stripe.Event;
}

/** A charge.dispute.* event for a PASS charge: matched by payment_intent, so the
 *  charge stays an opaque id string (as a real webhook sends it). */
function passDisputeEvent(
  phase: "created" | "closed",
  intent: string,
  id: string,
  status = "needs_response",
): Stripe.Event {
  return {
    type: phase === "created" ? "charge.dispute.created" : "charge.dispute.closed",
    data: {
      object: {
        id,
        status,
        amount: 2900,
        currency: "gbp",
        payment_intent: intent,
        charge: `ch_${uniq()}`,
      },
    },
  } as unknown as Stripe.Event;
}

beforeEach(() => emailMock.staff.mockClear());
afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("platform-charge disputes — subscription", () => {
  it("created: flags the sub with disputed_at + dispute_id, no plan change", async () => {
    const { orgId, customer } = await seedSubOrg("pro");
    const did = "dp_" + uniq();
    await processStripeEvent(subDisputeEvent("created", customer, did));
    const [s] = await sql<{ disputed_at: Date | null; dispute_id: string; plan_key: string }[]>`
      select disputed_at, dispute_id, plan_key from subscriptions where org_id = ${orgId}`;
    expect(s.dispute_id).toBe(did);
    expect(s.disputed_at).not.toBeNull();
    expect(s.plan_key).toBe("pro"); // created only flags — money is still contested
  });

  it("closed lost: auto-downgrades to community/canceled and invalidates entitlements", async () => {
    const { orgId, customer } = await seedSubOrg("pro");
    // Pro resolves the Pro feature before the loss (also warms the cache).
    expect(await hasFeature(orgId, "branding")).toBe(true);
    const did = "dp_" + uniq();
    await processStripeEvent(subDisputeEvent("created", customer, did));
    await processStripeEvent(subDisputeEvent("closed", customer, did, "lost"));
    const [s] = await sql<{ plan_key: string; status: string }[]>`
      select plan_key, status from subscriptions where org_id = ${orgId}`;
    expect(s.plan_key).toBe("community");
    expect(s.status).toBe("canceled");
    // Entitlement cache invalidated → the Pro feature is denied on the next probe.
    expect(await hasFeature(orgId, "branding")).toBe(false);
  });

  it("closed won: clears the flag, plan untouched", async () => {
    const { orgId, customer } = await seedSubOrg("pro");
    const did = "dp_" + uniq();
    await processStripeEvent(subDisputeEvent("created", customer, did));
    await processStripeEvent(subDisputeEvent("closed", customer, did, "won"));
    const [s] = await sql<{ disputed_at: Date | null; plan_key: string }[]>`
      select disputed_at, plan_key from subscriptions where org_id = ${orgId}`;
    expect(s.disputed_at).toBeNull();
    expect(s.plan_key).toBe("pro");
  });

  it("created replay: dispute stays flagged, no plan change, no throw", async () => {
    const { orgId, customer } = await seedSubOrg("pro");
    const did = "dp_" + uniq();
    await processStripeEvent(subDisputeEvent("created", customer, did));
    await processStripeEvent(subDisputeEvent("created", customer, did)); // replay
    const [s] = await sql<{ dispute_id: string; disputed_at: Date | null; plan_key: string }[]>`
      select dispute_id, disputed_at, plan_key from subscriptions where org_id = ${orgId}`;
    expect(s.dispute_id).toBe(did);
    expect(s.disputed_at).not.toBeNull();
    expect(s.plan_key).toBe("pro");
  });

  it("closed lost replay: stays community/canceled (idempotent)", async () => {
    const { orgId, customer } = await seedSubOrg("pro");
    const did = "dp_" + uniq();
    await processStripeEvent(subDisputeEvent("created", customer, did));
    const lost = subDisputeEvent("closed", customer, did, "lost");
    await processStripeEvent(lost);
    await processStripeEvent(lost); // replay converges, never toggles back
    const [s] = await sql<{ plan_key: string; status: string }[]>`
      select plan_key, status from subscriptions where org_id = ${orgId}`;
    expect(s.plan_key).toBe("community");
    expect(s.status).toBe("canceled");
  });

  it("closed lost on an already-community org is a convergent no-harm downgrade", async () => {
    const { orgId, customer } = await seedSubOrg("community");
    const did = "dp_" + uniq();
    await expect(
      processStripeEvent(subDisputeEvent("closed", customer, did, "lost")),
    ).resolves.toBeUndefined();
    const [s] = await sql<{ plan_key: string; status: string }[]>`
      select plan_key, status from subscriptions where org_id = ${orgId}`;
    expect(s.plan_key).toBe("community");
    expect(s.status).toBe("canceled");
  });

  it("fires the staff alert to STAFF_ALERT_EMAIL when it is set", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.club");
    const { customer } = await seedSubOrg("pro");
    await processStripeEvent(subDisputeEvent("created", customer, "dp_" + uniq()));
    expect(emailMock.staff).toHaveBeenCalledTimes(1);
    expect(emailMock.staff.mock.calls[0]![0]).toMatchObject({
      to: "ops@seazn.club",
      kind: "subscription",
    });
  });
});

describe.skipIf(!HAS_DB)("platform-charge disputes — Event Pass", () => {
  it("closed lost: revokes the pass (row deleted)", async () => {
    const { intent } = await seedPassOrg();
    const did = "dp_" + uniq();
    await processStripeEvent(passDisputeEvent("closed", intent, did, "lost"));
    const [row] = await sql`
      select 1 from competition_passes where stripe_payment_intent = ${intent}`;
    expect(row).toBeUndefined();
  });

  it("created: flags only — the pass is NOT revoked while the dispute is open", async () => {
    const { intent } = await seedPassOrg();
    await processStripeEvent(passDisputeEvent("created", intent, "dp_" + uniq()));
    const [row] = await sql`
      select 1 from competition_passes where stripe_payment_intent = ${intent}`;
    expect(row).toBeTruthy();
  });

  it("closed won: keeps the pass", async () => {
    const { intent } = await seedPassOrg();
    const did = "dp_" + uniq();
    await processStripeEvent(passDisputeEvent("created", intent, did));
    await processStripeEvent(passDisputeEvent("closed", intent, did, "won"));
    const [row] = await sql`
      select 1 from competition_passes where stripe_payment_intent = ${intent}`;
    expect(row).toBeTruthy();
  });

  it("closed lost replay: an already-revoked pass is a clean no-op", async () => {
    const { intent } = await seedPassOrg();
    const lost = passDisputeEvent("closed", intent, "dp_" + uniq(), "lost");
    await processStripeEvent(lost);
    await expect(processStripeEvent(lost)).resolves.toBeUndefined(); // replay, row already gone
    const [row] = await sql`
      select 1 from competition_passes where stripe_payment_intent = ${intent}`;
    expect(row).toBeUndefined();
  });

  it("fires the staff alert with kind=event_pass when STAFF_ALERT_EMAIL is set", async () => {
    vi.stubEnv("STAFF_ALERT_EMAIL", "ops@seazn.club");
    const { intent } = await seedPassOrg();
    await processStripeEvent(passDisputeEvent("closed", intent, "dp_" + uniq(), "lost"));
    expect(emailMock.staff).toHaveBeenCalledTimes(1);
    expect(emailMock.staff.mock.calls[0]![0]).toMatchObject({ kind: "event_pass" });
  });
});

describe.skipIf(!HAS_DB)("platform-charge disputes — routing", () => {
  it("no-ops on a charge that is neither a subscription nor a pass", async () => {
    // A customer matching no subscription + an intent matching no pass.
    const ev = subDisputeEvent("created", `cus_nobody_${uniq()}`, "dp_" + uniq());
    await expect(processStripeEvent(ev)).resolves.toBeUndefined();
    expect(emailMock.staff).not.toHaveBeenCalled();
  });

  it("keyless: a real webhook charge id string can't resolve a customer → sub no-op", async () => {
    // Seed a sub, but send the dispute with the charge as an opaque id string
    // (as Stripe really does). With no STRIPE_SECRET_KEY the charge can't be
    // retrieved, so the subscription branch cannot identify the org and no-ops.
    const { orgId, customer } = await seedSubOrg("pro");
    void customer;
    const ev = {
      type: "charge.dispute.created",
      data: {
        object: {
          id: "dp_" + uniq(),
          status: "needs_response",
          amount: 1900,
          currency: "gbp",
          payment_intent: `pi_sub_${uniq()}`,
          charge: `ch_${uniq()}`, // string id, not expanded
        },
      },
    } as unknown as Stripe.Event;
    await expect(processStripeEvent(ev)).resolves.toBeUndefined();
    const [s] = await sql<{ disputed_at: Date | null; plan_key: string }[]>`
      select disputed_at, plan_key from subscriptions where org_id = ${orgId}`;
    expect(s.disputed_at).toBeNull(); // untouched — couldn't be identified
    expect(s.plan_key).toBe("pro");
  });
});
