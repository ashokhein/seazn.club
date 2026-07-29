// countOrgsWithoutGroup is the #232 P2 invariant guard: every live org must bill
// through a group (createOrgForUser always stamps subscription_id). The column
// is not NOT NULL — 68 billing-agnostic test fixtures insert bare orgs — so this
// count, surfaced by the daily reconcile cron, is how a real violation is caught.
// Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { countOrgsWithoutGroup, orgsWithoutGroup } from "../billing-groups";

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
    // A bare org — the invariant violation the cron must surface. Asserted by
    // MEMBERSHIP of this test's own id, not an exact count: vitest runs files
    // in parallel against one shared schema, so a sibling suite's fixture org
    // turns an exact count into a coin flip (#321).
    const s = uniq();
    const [{ id: bare }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${"Bare " + s}, ${"bare-" + s}) returning id`;
    expect(await orgsWithoutGroup()).toContain(bare);

    // A properly grouped org does NOT show up in the list.
    const [{ id: user }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`orph-${uniq()}@test.local`}, 'Orph', true) returning id`;
    const [{ id: sub }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
      values (${user}, 'community', 'active', 1) returning id`;
    const s2 = uniq();
    const [{ id: grouped }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by, subscription_id)
      values (${"Grp " + s2}, ${"grp-" + s2}, ${user}, ${sub}) returning id`;
    expect(await orgsWithoutGroup()).not.toContain(grouped);

    // Soft-deleting the bare org drops it from the list.
    await sql`update organizations set deleted_at = now() where id = ${bare}`;
    expect(await orgsWithoutGroup()).not.toContain(bare);

    // The count still tracks the list — loose, because it's the schema-wide
    // aggregate this file no longer asserts an exact value against.
    expect(await countOrgsWithoutGroup()).toBeGreaterThanOrEqual(
      (await orgsWithoutGroup()).length,
    );
  });

  it("names the orgs behind the count, so a test can assert on its OWN fixtures (#321)", async () => {
    const s = uniq();
    const [{ id: bare }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${"Bare " + s}, ${"bare-" + s}) returning id`;
    expect(await orgsWithoutGroup()).toContain(bare);
    await sql`update organizations set deleted_at = now() where id = ${bare}`;
    expect(await orgsWithoutGroup()).not.toContain(bare);
  });
});
