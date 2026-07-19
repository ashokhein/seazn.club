// P0-3a (payments hardening): a fully-refunded Event Pass charge — including a
// refund made straight from the Stripe dashboard — must revoke the pass so the
// competition rejoins the plan's active-competition allowance, and the org
// owner is emailed. Partial refunds and non-pass charges leave every pass
// untouched. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// Observe the owner notification without touching the rest of the email module
// (send() is a no-op without RESEND_API_KEY either way).
const emailMock = vi.hoisted(() => ({ passRevoked: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendPassRevokedEmail: emailMock.passRevoked,
}));

import { sql } from "@/lib/db";
import { revokePassForRefundedCharge } from "@/lib/billing";
import { processStripeEvent } from "@/server/usecases/billing-events";

const HAS_DB = !!process.env.DATABASE_URL;

const chargeFor = (intent: string, refunded: boolean) =>
  ({ payment_intent: intent, refunded }) as unknown as Stripe.Charge;

/** A charge.refunded Stripe event as the webhook/replay path sees it. */
const chargeRefundedEvent = (intent: string, over: Partial<Stripe.Charge> = {}) =>
  ({
    type: "charge.refunded",
    data: { object: { payment_intent: intent, refunded: true, amount_refunded: 500, ...over } },
  }) as unknown as Stripe.Event;

/** Sibling-suite seeding style (billing-sync-trial): a fresh org + competition,
 *  the only two FK parents a competition_passes row needs. */
async function seedOrgWithComp(): Promise<{ orgId: string; compId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Pass Org " + suffix}, ${"pass-org-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${"Pass Cup " + suffix}, ${"pass-cup-" + suffix}) returning id`;
  return { orgId, compId };
}

/** Richer seed for the dispatch path: the org's owner (via org_members) is a
 *  DIFFERENT user than organizations.created_by, so the test proves the owner
 *  email comes from the membership role — created_by is a trap. */
async function seedPassOrg(): Promise<{
  orgId: string;
  compId: string;
  orgName: string;
  compName: string;
  ownerEmail: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const ownerEmail = `owner-${suffix}@test.local`;
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${ownerEmail}, 'Owner', true) returning id`;
  const [{ id: trapId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`trap-${suffix}@test.local`}, 'Trap Creator', true) returning id`;
  const orgName = "Pass Org " + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${orgName}, ${"pass-org-" + suffix}, ${trapId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  const compName = "Pass Cup " + suffix;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${compName}, ${"pass-cup-" + suffix}) returning id`;
  return { orgId, compId, orgName, compName, ownerEmail };
}

beforeEach(() => {
  emailMock.passRevoked.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("revokePassForRefundedCharge", () => {
  it("deletes the pass when its charge is fully refunded", async () => {
    const { orgId, compId } = await seedOrgWithComp(); // sibling-suite seeding style
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, 'pi_pass_r1')`;
    expect(await revokePassForRefundedCharge(chargeFor("pi_pass_r1", true))).toBe(true);
    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeUndefined();
  });

  it("ignores partial refunds and non-pass charges", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, 'pi_pass_r2')`;
    expect(await revokePassForRefundedCharge(chargeFor("pi_pass_r2", false))).toBe(false);
    expect(await revokePassForRefundedCharge(chargeFor("pi_other", true))).toBe(false);
    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeTruthy();
  });

  it("is idempotent — a replayed full refund revokes nothing the second time", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, ${orgId}, 'pi_pass_r3')`;
    expect(await revokePassForRefundedCharge(chargeFor("pi_pass_r3", true))).toBe(true);
    expect(await revokePassForRefundedCharge(chargeFor("pi_pass_r3", true))).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("charge.refunded dispatch → revoke + owner email", () => {
  it("revokes the pass and emails the org owner (via org_members, not created_by)", async () => {
    const { compId, orgName, compName, ownerEmail } = await seedPassOrg();
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, (select org_id from competitions where id = ${compId}), 'pi_pass_int1')`;

    await processStripeEvent(chargeRefundedEvent("pi_pass_int1"));

    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeUndefined();
    expect(emailMock.passRevoked).toHaveBeenCalledTimes(1);
    expect(emailMock.passRevoked).toHaveBeenCalledWith({
      to: ownerEmail,
      orgName,
      competitionName: compName,
    });
  });

  it("a partial refund through the dispatch leaves the pass and sends no mail", async () => {
    const { compId } = await seedPassOrg();
    await sql`insert into competition_passes (competition_id, org_id, stripe_payment_intent)
              values (${compId}, (select org_id from competitions where id = ${compId}), 'pi_pass_int2')`;

    await processStripeEvent(chargeRefundedEvent("pi_pass_int2", { refunded: false }));

    const [row] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(row).toBeTruthy();
    expect(emailMock.passRevoked).not.toHaveBeenCalled();
  });
});
