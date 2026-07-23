// countOrgsWithoutGroup is the #232 P2 invariant guard: every live org must bill
// through a group (createOrgForUser always stamps subscription_id). The column
// is not NOT NULL — 68 billing-agnostic test fixtures insert bare orgs — so this
// count, surfaced by the daily reconcile cron, is how a real violation is caught.
// Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { countOrgsWithoutGroup } from "../billing-groups";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("countOrgsWithoutGroup", () => {
  it("counts a live org with no billing group; ignores grouped and soft-deleted ones", async () => {
    const before = await countOrgsWithoutGroup();

    // A bare org — the invariant violation the cron must surface.
    const s = uniq();
    const [{ id: bare }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${"Bare " + s}, ${"bare-" + s}) returning id`;
    expect(await countOrgsWithoutGroup()).toBe(before + 1);

    // A properly grouped org does NOT add to the count.
    const [{ id: user }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`orph-${uniq()}@test.local`}, 'Orph', true) returning id`;
    const [{ id: sub }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
      values (${user}, 'community', 'active', 1) returning id`;
    const s2 = uniq();
    await sql`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${"Grp " + s2}, ${"grp-" + s2}, ${user}, ${sub})`;
    expect(await countOrgsWithoutGroup()).toBe(before + 1);

    // Soft-deleting the bare org drops it from the count.
    await sql`update organizations set deleted_at = now() where id = ${bare}`;
    expect(await countOrgsWithoutGroup()).toBe(before);
  });
});
