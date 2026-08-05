import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { makeUser, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("#404 V349 schema", () => {
  let orgId: string;
  beforeEach(async () => {
    const { auth } = await seedOrg("pro");
    orgId = auth.orgId;
  });
  afterAll(async () => {
    if (orgId) await sql`delete from person_merges where org_id = ${orgId}`;
  });

  const person = async (userId: string | null, mergedInto: string | null = null) => {
    const [row] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id, lane, merged_into)
      values (${orgId}, 'Alex Morgan', ${userId}, 'player', ${mergedInto})
      returning id`;
    return row!.id;
  };

  it("a tombstoned person frees the identity slot", async () => {
    // Without `and merged_into is null` in the index predicate the second
    // insert throws 23505 and a merged duplicate blocks the human's next
    // registration forever.
    const { id: userId } = await makeUser("merge");
    const survivor = await person(userId);
    await expect(person(userId, survivor)).resolves.toBeTruthy();
  });

  it("refuses a second live merge for one absorbed person", async () => {
    const a = await person(null);
    const b = await person(null);
    const c = await person(null);
    const insert = (survivor: string) => sql`
      insert into person_merges (org_id, survivor_id, absorbed_id, snapshot)
      values (${orgId}, ${survivor}, ${a}, '{}'::jsonb)`;
    await insert(b);
    await expect(insert(c)).rejects.toThrow(/person_merges_absorbed_live_uq|duplicate key/);
  });

  it("allows a fresh merge once the prior one is reversed", async () => {
    const a = await person(null);
    const b = await person(null);
    const c = await person(null);
    await sql`insert into person_merges (org_id, survivor_id, absorbed_id, snapshot, reversed_at)
              values (${orgId}, ${b}, ${a}, '{}'::jsonb, now())`;
    await expect(sql`
      insert into person_merges (org_id, survivor_id, absorbed_id, snapshot)
      values (${orgId}, ${c}, ${a}, '{}'::jsonb)`).resolves.toBeTruthy();
  });

  it("refuses a merge of a person into itself", async () => {
    const a = await person(null);
    await expect(sql`
      insert into person_merges (org_id, survivor_id, absorbed_id, snapshot)
      values (${orgId}, ${a}, ${a}, '{}'::jsonb)`).rejects.toThrow();
  });
});
