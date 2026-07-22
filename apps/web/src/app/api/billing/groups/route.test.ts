// GET /api/billing/groups — the listing that makes attach callable at all.
//
// Real Postgres, because the two things worth testing here are both about rows:
// who the payer gate lets through, and whether seats and organisations are
// reported as separate numbers. `requireUser` is mocked to choose the caller;
// everything else is genuine.
//
// Skipped without DATABASE_URL. If you see this file skip, the payer gate below
// is not being tested — see vitest.globalSetup.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const caller = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: caller.id }) }));

// The entitlement resolver is cache-aside; an in-memory store keeps the cap
// honest per group instead of leaking one group's answer into the next.
const store = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => true,
  cacheGet: async (key: string) => {
    const raw = store.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  },
  cacheSet: async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
  },
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

import { sql } from "@/lib/db";
import { GET } from "./route";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

interface Seeded {
  payerId: string;
  subId: string;
  orgIds: string[];
}

async function seedGroup(
  plan: string,
  orgCount: number,
  over: { quantityPaid?: number } = {},
): Promise<Seeded> {
  const s = uniq();
  const [{ id: payerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`groups-route-${s}@test.local`}, 'Payer', true) returning id`;
  const [{ id: subId }] = await sql<{ id: string }[]>`
    insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
    values (${payerId}, ${plan}, 'active', ${over.quantityPaid ?? orgCount}) returning id`;
  const orgIds: string[] = [];
  for (let i = 0; i < orgCount; i++) {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${`Groups Route ${s} ${i}`}, ${`groups-route-${s}-${i}`}, ${payerId}, ${subId})
      returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${id}, ${payerId}, 'owner')`;
    orgIds.push(id);
  }
  return { payerId, subId, orgIds };
}

type Body = {
  ok: boolean;
  data: {
    id: string;
    plan_key: string;
    quantity_paid: number;
    max_orgs: number | null;
    orgs: {
      id: string;
      name: string;
      slug: string;
      status: string;
      owner_user_id: string | null;
      owner_name: string | null;
    }[];
  }[];
};

const call = async (): Promise<Body> => (await GET()).json() as Promise<Body>;

beforeEach(() => {
  store.clear();
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe.skipIf(!HAS_DB)("GET /api/billing/groups", () => {
  it("returns the caller's group with every organisation in it", async () => {
    const g = await seedGroup("pro", 3);
    caller.id = g.payerId;

    const body = await call();
    expect(body.ok).toBe(true);
    const mine = body.data.find((x) => x.id === g.subId);
    expect(mine).toBeDefined();
    expect(mine!.plan_key).toBe("pro");
    expect(mine!.orgs.map((o) => o.id).sort()).toEqual([...g.orgIds].sort());
    // Pro holds 5 (V310). The cap is what the UI needs to say "2 slots left"
    // without inventing the number itself.
    expect(mine!.max_orgs).toBe(5);
  });

  it("names each organisation's owner, which is the transfer picker's candidate list", async () => {
    // A payer can only hand the bill to someone who owns an organisation in it,
    // so this field IS the picker. Without it the transfer flow has no way to
    // name a recipient — the use case takes a user id a browser cannot obtain.
    const g = await seedGroup("pro", 2);
    caller.id = g.payerId;

    const mine = (await call()).data.find((x) => x.id === g.subId)!;
    for (const o of mine.orgs) expect(o.owner_user_id).toBe(g.payerId);
    expect(mine.orgs[0]!.owner_name).toBe("Payer");
  });

  it("leaves the owner null when an organisation has none, rather than dropping it", async () => {
    // An org whose owner member is gone still bills and still occupies a seat,
    // so it must stay in the list — it just cannot be a transfer candidate. An
    // inner join here would have hidden a billed organisation from its payer.
    const g = await seedGroup("pro", 2);
    await sql`delete from org_members where org_id = ${g.orgIds[1]} and role = 'owner'`;
    caller.id = g.payerId;

    const mine = (await call()).data.find((x) => x.id === g.subId)!;
    expect(mine.orgs).toHaveLength(2);
    expect(mine.orgs.find((o) => o.id === g.orgIds[1])!.owner_user_id).toBeNull();
  });

  it("does NOT list a group the caller merely belongs to", async () => {
    // The gate that matters. This response names every organisation in the
    // group, so member-gating it would let anyone inside one club enumerate the
    // other clubs their federation pays for.
    const g = await seedGroup("pro", 2);
    const [{ id: memberId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`groups-route-member-${uniq()}@test.local`}, 'Member', true) returning id`;
    await sql`insert into org_members (org_id, user_id, role)
              values (${g.orgIds[0]}, ${memberId}, 'owner')`;

    caller.id = memberId;
    const body = await call();
    expect(body.data.find((x) => x.id === g.subId)).toBeUndefined();
  });

  it("reports paid seats and organisations as separate numbers", async () => {
    // A freed slot stays paid for until renewal, so quantity_paid legitimately
    // runs ahead of the org count — that is what makes re-adding an org free.
    // Collapsing them into one "3 of 3" would make a free re-add look like a
    // purchase, which is the opposite of what the customer was promised.
    const g = await seedGroup("pro", 2, { quantityPaid: 3 });
    caller.id = g.payerId;

    const mine = (await call()).data.find((x) => x.id === g.subId)!;
    expect(mine.quantity_paid).toBe(3);
    expect(mine.orgs).toHaveLength(2);
  });

  it("omits soft-deleted organisations, matching what is billed", async () => {
    const g = await seedGroup("pro", 2);
    await sql`update organizations set deleted_at = now() where id = ${g.orgIds[1]}`;
    caller.id = g.payerId;

    const mine = (await call()).data.find((x) => x.id === g.subId)!;
    expect(mine.orgs.map((o) => o.id)).toEqual([g.orgIds[0]]);
  });

  it("returns an empty group as a group, not as nothing", async () => {
    // A payer whose last org detached still owns the row, and the UI has to be
    // able to show it — a group that vanishes from the listing is one nobody
    // can cancel. `max_orgs` is null because there is no member org to resolve
    // a plan through, NOT because the plan is unlimited.
    const g = await seedGroup("pro", 0);
    caller.id = g.payerId;

    const mine = (await call()).data.find((x) => x.id === g.subId);
    expect(mine).toBeDefined();
    expect(mine!.orgs).toEqual([]);
    expect(mine!.max_orgs).toBeNull();
  });

  it("lists several groups for a payer who has detached one", async () => {
    const a = await seedGroup("pro", 2);
    const b = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
      values (${a.payerId}, 'community', 'active', 1) returning id`;
    caller.id = a.payerId;

    const ids = (await call()).data.map((x) => x.id);
    expect(ids).toContain(a.subId);
    expect(ids).toContain(b[0]!.id);
  });
});
