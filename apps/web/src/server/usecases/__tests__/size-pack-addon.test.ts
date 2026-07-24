// v17 Phase 3 Task 3b: the size-pack ONE-TIME add-on ($10 → +32
// entrants.per_division.max for ONE competition). A one-time Stripe Checkout
// whose `checkout.session.completed` webhook is the SINGLE writer of the
// org_addons row; the pack's SHAPE lives in an admin-configurable DB catalog
// (size_pack_catalog, V325) but the GRANT reads the metadata SNAPSHOT stamped
// at checkout creation, so a later catalog edit never changes a bought pack.
//
// These tests drive the webhook (processStripeEvent) against real Postgres and
// assert on the resolver (getLimit), plus the catalog CRUD routes' staff gate
// and the checkout usecase's comp-scoped purchase gate (IDOR).
//
// Real Postgres required; skipped without DATABASE_URL. Run against the fresh
// v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// getLimit reads through resolve()'s entitlement cache; disable it so a
// just-written add-on row is seen on the very next read.
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

// Checkout gate (IDOR) test: control the active org + org-role gate so we can
// prove a caller who does not own the competition is refused BEFORE any Stripe
// call. Admin CRUD test: control the staff gate + silence the audit-log write.
const {
  sessionsCreateSpy,
  getActiveOrgIdMock,
  requireOrgRoleMock,
  requireStaffMock,
  requireSuperadminMock,
} = vi.hoisted(() => ({
  sessionsCreateSpy: vi.fn(),
  getActiveOrgIdMock: vi.fn(),
  requireOrgRoleMock: vi.fn(),
  requireStaffMock: vi.fn(),
  requireSuperadminMock: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: sessionsCreateSpy } },
    prices: { list: vi.fn(async () => ({ data: [{ id: "price_size_pack" }] })) },
  }),
}));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  getActiveOrgId: getActiveOrgIdMock,
  requireOrgRole: requireOrgRoleMock,
}));
vi.mock("@/lib/admin", async (orig) => ({
  ...(await (orig as () => Promise<Record<string, unknown>>)()),
  requireStaff: requireStaffMock,
  requireSuperadmin: requireSuperadminMock,
  logStaffAction: vi.fn(async () => {}),
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { walletIdFor } from "@/lib/credits";
import { getLimit } from "@/lib/entitlements";
import { getSizePack } from "@/lib/size-packs";
import { createSizePackCheckout } from "../size-pack-checkout";
import { processStripeEvent } from "../billing-events";
import { GET as adminList, POST as adminCreate } from "@/app/api/admin/size-packs/route";
import { PATCH as adminPatch, DELETE as adminDelete } from "@/app/api/admin/size-packs/[key]/route";

const HAS_DB = !!process.env.DATABASE_URL;
const FEATURE = "entrants.per_division.max";
const uniq = () => randomUUID().slice(0, 8);

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`sizepack-${uniq()}@test.local`}, 'Size Pack Owner', true) returning id`;
  return id;
}

async function makeComp(orgId: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, ${`Comp ${uniq()}`}, ${`comp-${uniq()}`}) returning id`;
  return id;
}

/** A completed size_pack checkout event as the webhook sees it — only the
 *  fields the size_pack branch reads. feature_key/delta_each default to the
 *  seeded catalog snapshot; the payment_intent id is the idempotency arbiter. */
function sizePackEvent(over: {
  targetOrgId: string;
  targetCompId: string;
  sizePackKey?: string;
  featureKey?: string | null;
  deltaEach?: number | null;
  paymentIntent?: string;
  paymentStatus?: string;
}): Stripe.Event {
  const md: Record<string, string> = {
    kind: "size_pack",
    size_pack_key: over.sizePackKey ?? "size_pack_32",
    target_org_id: over.targetOrgId,
    target_competition_id: over.targetCompId,
  };
  if (over.featureKey !== null) md.feature_key = over.featureKey ?? FEATURE;
  if (over.deltaEach !== null) md.delta_each = String(over.deltaEach ?? 32);
  return {
    id: `evt_${uniq()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${uniq()}`,
        payment_status: over.paymentStatus ?? "paid",
        payment_intent: over.paymentIntent ?? `pi_${uniq()}`,
        customer: null,
        currency: "usd",
        metadata: md,
      },
    },
  } as unknown as Stripe.Event;
}

function jsonReq(body: unknown): Request {
  return new Request("http://test.local/api/admin/size-packs", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

let planBase: number;

beforeAll(async () => {
  if (!HAS_DB) return;
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = 'community' and feature_key = ${FEATURE}`;
  planBase = row?.int_value ?? 0;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("size-pack add-on — webhook → resolver", () => {
  it("a completed pack lifts ONLY the target comp's entrant cap by +32", async () => {
    const org = await createOrgForUser(await makeUser(), "SizePack Org");
    const comp = await makeComp(org.id);
    const otherComp = await makeComp(org.id);
    const walletId = await walletIdFor(org.id);
    expect(await getLimit(org.id, FEATURE, comp)).toBe(planBase);

    await processStripeEvent(sizePackEvent({ targetOrgId: org.id, targetCompId: comp }));

    // Only the bought comp is lifted; org-level and a sibling comp are NOT.
    expect(await getLimit(org.id, FEATURE, comp)).toBe(planBase + 32);
    expect(await getLimit(org.id, FEATURE)).toBe(planBase);
    expect(await getLimit(org.id, FEATURE, otherComp)).toBe(planBase);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons
       where wallet_id = ${walletId} and status = 'active'`;
    expect(n).toBe(1);
  });

  it("a replayed webhook (same payment_intent) is idempotent — one row, lifted once", async () => {
    const org = await createOrgForUser(await makeUser(), "SizePack Idem");
    const comp = await makeComp(org.id);
    const walletId = await walletIdFor(org.id);
    const intent = `pi_${uniq()}`;
    const event = sizePackEvent({ targetOrgId: org.id, targetCompId: comp, paymentIntent: intent });

    await processStripeEvent(event);
    await processStripeEvent(event);

    expect(await getLimit(org.id, FEATURE, comp)).toBe(planBase + 32);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from org_addons where wallet_id = ${walletId}`;
    expect(n).toBe(1);
  });

  it("editing the catalog delta AFTER purchase does not change the granted pack (snapshot)", async () => {
    const org = await createOrgForUser(await makeUser(), "SizePack Snapshot");
    const comp = await makeComp(org.id);

    await processStripeEvent(sizePackEvent({ targetOrgId: org.id, targetCompId: comp }));
    expect(await getLimit(org.id, FEATURE, comp)).toBe(planBase + 32);

    // Catalog bumped 32 → 64; the already-granted (frozen) row is unaffected.
    await sql`update size_pack_catalog set delta_each = 64 where key = 'size_pack_32'`;
    try {
      expect(await getLimit(org.id, FEATURE, comp)).toBe(planBase + 32);
    } finally {
      await sql`update size_pack_catalog set delta_each = 32 where key = 'size_pack_32'`;
    }
  });

  it("an unpaid session grants nothing", async () => {
    const org = await createOrgForUser(await makeUser(), "SizePack Unpaid");
    const comp = await makeComp(org.id);
    await processStripeEvent(
      sizePackEvent({ targetOrgId: org.id, targetCompId: comp, paymentStatus: "unpaid" }),
    );
    expect(await getLimit(org.id, FEATURE, comp)).toBe(planBase);
  });
});

describe.skipIf(!HAS_DB)("size_pack_catalog V325 guard", () => {
  it("rejects a catalog row with delta_each <= 0", async () => {
    await expect(
      sql`insert into size_pack_catalog (key, label, feature_key, delta_each, stripe_lookup_key)
          values (${`bad-${uniq()}`}, 'bad', ${FEATURE}, 0, 'seazn_bad')`,
    ).rejects.toThrow();
    await expect(
      sql`insert into size_pack_catalog (key, label, feature_key, delta_each, stripe_lookup_key)
          values (${`bad-${uniq()}`}, 'bad', ${FEATURE}, -1, 'seazn_bad')`,
    ).rejects.toThrow();
  });
});

describe.skipIf(!HAS_DB)("size-pack checkout gate (IDOR)", () => {
  it("refuses a caller who does not own the competition BEFORE any Stripe call", async () => {
    const ownerOrg = await createOrgForUser(await makeUser(), "SizePack Owner Org");
    const comp = await makeComp(ownerOrg.id); // comp belongs to ownerOrg…
    const attackerOrg = await createOrgForUser(await makeUser(), "SizePack Attacker Org");

    // …but the ACTIVE org is the attacker's, and they are its owner.
    getActiveOrgIdMock.mockResolvedValue(attackerOrg.id);
    requireOrgRoleMock.mockResolvedValue({ user: { id: "u", email: "a@test.local" }, role: "owner" });
    sessionsCreateSpy.mockClear();

    await expect(
      createSizePackCheckout({ competitionId: comp, sizePackKey: "size_pack_32", req: jsonReq({}) }),
    ).rejects.toMatchObject({ status: 404 });
    expect(sessionsCreateSpy).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("size-pack catalog admin CRUD", () => {
  it("superadmin can create, edit and soft-deactivate; a non-staff caller is refused", async () => {
    const key = `size_pack_test_${uniq()}`;
    requireSuperadminMock.mockResolvedValue({ id: "staff", staff_role: "superadmin" });
    requireStaffMock.mockResolvedValue({ id: "staff" });

    // Create.
    const created = await adminCreate(
      jsonReq({ key, label: "+8 test", feature_key: FEATURE, delta_each: 8, stripe_lookup_key: "seazn_test_8" }),
    );
    expect(created.status).toBe(200);
    expect((await getSizePack(key))?.delta_each).toBe(8);

    // Edit (label + delta) via PATCH.
    const patched = await adminPatch(
      new Request("http://test.local", { method: "PATCH", body: JSON.stringify({ delta_each: 16 }) }),
      { params: Promise.resolve({ key }) },
    );
    expect(patched.status).toBe(200);
    expect((await getSizePack(key))?.delta_each).toBe(16);

    // Soft-deactivate via DELETE.
    await adminDelete(new Request("http://test.local", { method: "DELETE" }), {
      params: Promise.resolve({ key }),
    });
    expect((await getSizePack(key))?.active).toBe(false);

    // Listing (staff read) includes the row.
    const listed = await adminList();
    const body = (await listed.json()) as { data: { key: string }[] };
    expect(body.data.some((r) => r.key === key)).toBe(true);
  });

  it("a non-superadmin write is refused (401) and writes nothing", async () => {
    const { AuthError } = await import("@/lib/errors");
    const key = `size_pack_denied_${uniq()}`;
    requireSuperadminMock.mockRejectedValueOnce(new AuthError("Superadmin access required"));

    const res = await adminCreate(
      jsonReq({ key, label: "nope", feature_key: FEATURE, delta_each: 4, stripe_lookup_key: "seazn_nope" }),
    );
    expect(res.status).toBe(401);
    expect(await getSizePack(key)).toBeNull();
  });
});
