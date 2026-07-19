// Sponsor orders are money records; V299 flips their org/package FKs from
// CASCADE to RESTRICT after a live stg incident (2026-07-19): deleting a
// throwaway org hard-cascaded away a paid + disputed £10 order — the app's
// only record of the charge, and the dispute became permanently unmatchable.
// No app surface hard-deletes orgs or packages (both soft-flip), so the only
// paths that ever fired the cascade are scripts and direct SQL — exactly what
// a DB-level RESTRICT is for. deleteCompetition (which legitimately cascades
// its comp-scoped packages) now sweeps intent-less orders itself and refuses
// while payment-touched rows remain. Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, deleteCompetition } from "@/server/usecases/competitions";
import { refundSponsorOrder } from "@/server/usecases/sponsors";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedOrgWithComp(): Promise<{ auth: AuthCtx; orgId: string; compId: string }> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Restrict " + suffix}, ${"restrict-" + suffix}) returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, 'pro', 'active')
    on conflict (org_id) do update set plan_key = 'pro'`;
  await invalidateOrgEntitlements(orgId);
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, {
    name: `Cup ${uniq()}`,
    visibility: "private",
    branding: {},
  });
  return { auth, orgId, compId: comp.id };
}

async function seedPackage(orgId: string, compId: string | null): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
    values (${orgId}, ${compId}, 'Gold', 25000, 'gbp', 'gold') returning id`;
  return id;
}

type OrderSeed = {
  status?: string;
  intent?: string | null;
  disputedAt?: Date | null;
};

async function seedOrder(orgId: string, packageId: string, o: OrderSeed = {}): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email,
                                amount_cents, currency, status, payment_intent_id,
                                paid_at, disputed_at)
    values (${orgId}, ${packageId}, 'S', 's@x.test', 25000, 'gbp',
            ${o.status ?? "paid"}, ${o.intent === undefined ? "pi_" + uniq() : o.intent},
            ${o.intent === null ? null : new Date()}, ${o.disputedAt ?? null})
    returning id`;
  return id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("sponsor order delete protection (V299)", () => {
  it("raw org delete with a paid sponsor order is refused by the DB", async () => {
    const { orgId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, null);
    await seedOrder(orgId, pkg);
    await expect(
      sql`delete from organizations where id = ${orgId}`,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("raw package delete with a paid sponsor order is refused by the DB", async () => {
    const { orgId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, null);
    await seedOrder(orgId, pkg);
    await expect(
      sql`delete from sponsor_packages where id = ${pkg}`,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("deleteCompetition sweeps intent-less orders along with its packages", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    const orderId = await seedOrder(orgId, pkg, { status: "pending", intent: null });
    await deleteCompetition(auth, compId);
    const [comp] = await sql`select 1 from competitions where id = ${compId}`;
    expect(comp).toBeUndefined();
    const [order] = await sql`select 1 from sponsor_orders where id = ${orderId}`;
    expect(order).toBeUndefined();
  });

  it("deleteCompetition 409s while a refunded order holds payment history", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    await seedOrder(orgId, pkg, { status: "refunded" });
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409 });
  });

  it("deleteCompetition 409s while a disputed order exists", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    await seedOrder(orgId, pkg, { status: "refunded", disputedAt: new Date() });
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409 });
  });

  it("refunding a disputed order 409s in our own words, before Stripe", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    const orderId = await seedOrder(orgId, pkg, { disputedAt: new Date() });
    // Keyless test env: reaching getStripe() would throw a config error, so a
    // clean 409 also proves the guard fired before any Stripe call. The
    // message must be ours — no raw Stripe text (charge ids) leaks.
    await expect(refundSponsorOrder(auth, orderId)).rejects.toMatchObject({
      status: 409,
      message: expect.not.stringContaining("ch_"),
    });
  });
});
