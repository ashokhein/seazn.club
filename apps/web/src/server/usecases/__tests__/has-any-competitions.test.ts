// hasAnyCompetitions gates the product tour's auto-start (nav.tsx): the
// tour's centered "welcome" card would otherwise land on top of the
// org-home empty-state CTA on a brand-new org (design/fix-ui/02-console-org.md
// "product tour modal fully covers the org-home empty-state CTA"). Real
// Postgres required — org-scoping goes through withTenant/RLS.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { hasAnyCompetitions } from "../competitions";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Tour " + suffix}, ${"tour-" + suffix})
    returning id`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("hasAnyCompetitions", () => {
  it("is false for a brand-new org with zero competitions", async () => {
    const auth = await seedOrg();
    expect(await hasAnyCompetitions(auth)).toBe(false);
  });

  it("is true once the org has a competition", async () => {
    const auth = await seedOrg();
    await sql`
      insert into competitions (org_id, name, slug)
      values (${auth.orgId}, 'Summer League', 'summer-league')`;
    expect(await hasAnyCompetitions(auth)).toBe(true);
  });

  it("never counts another org's competitions", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await sql`
      insert into competitions (org_id, name, slug)
      values (${b.orgId}, 'Winter Cup', 'winter-cup')`;
    expect(await hasAnyCompetitions(a)).toBe(false);
    expect(await hasAnyCompetitions(b)).toBe(true);
  });
});
