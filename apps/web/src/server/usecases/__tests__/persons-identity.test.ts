// W1 / #396 gap 8 — person identity guards. V345 puts a PARTIAL unique index on
// persons(org_id, user_id): one person row per (organisation, claimed login),
// while unclaimed persons (user_id null) stay unconstrained and one human may
// still hold a person row in several organisations.
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** Same insert shape as person-claims.test.ts — `users.id` is defaulted. */
async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

describe.skipIf(!HAS_DB)("persons identity guards (#396)", () => {
  it("rejects a second persons row with the same (org_id, user_id)", async () => {
    const { auth } = await seedOrg("pro");
    const userId = await makeUser("claimer");
    await sql`
      insert into persons (org_id, full_name, user_id)
      values (${auth.orgId}, 'Claimed Once', ${userId})`;
    await expect(
      sql`
        insert into persons (org_id, full_name, user_id)
        values (${auth.orgId}, 'Claimed Twice', ${userId})`,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("still allows many unclaimed persons — user_id null is not constrained", async () => {
    const { auth } = await seedOrg("pro");
    await sql`insert into persons (org_id, full_name) values (${auth.orgId}, 'Anon A')`;
    await sql`insert into persons (org_id, full_name) values (${auth.orgId}, 'Anon B')`;
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${auth.orgId} and user_id is null`;
    expect(Number(n)).toBe(2);
  });

  it("allows the same user_id in two different orgs", async () => {
    const a = await seedOrg("pro");
    const b = await seedOrg("pro");
    const userId = await makeUser("multiorg");
    await sql`
      insert into persons (org_id, full_name, user_id)
      values (${a.auth.orgId}, 'X', ${userId})`;
    await sql`
      insert into persons (org_id, full_name, user_id)
      values (${b.auth.orgId}, 'X', ${userId})`;
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons where user_id = ${userId}`;
    expect(Number(n)).toBe(2);
  });
});
