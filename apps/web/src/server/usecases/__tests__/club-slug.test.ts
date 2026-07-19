// Club slug hygiene (W1 §Task 3): createClub auto-slugs from the name and
// suffixes collisions ("-2"); patchClub re-slugs only on an explicit `slug` set
// and 409s on a duplicate. Each test seeds a fresh org (unique orgId → unique
// entitlement cache key). Real Postgres.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createClub, patchClub } from "../clubs";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Slug " + suffix}, ${"slug-" + suffix})
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

describe.skipIf(!HAS_DB)("club slugs", () => {
  it("auto-generates a unique slug on create", async () => {
    const auth = await seedOrg();
    const a = await createClub(auth, { name: "Riverside FC" });
    const b = await createClub(auth, { name: "Riverside FC 2" });
    expect(a.slug).toBe("riverside-fc");
    expect(b.slug).toBe("riverside-fc-2");
  });
  it("409s on explicit duplicate slug via patch", async () => {
    const auth = await seedOrg();
    const a = await createClub(auth, { name: "Alpha" });
    const b = await createClub(auth, { name: "Beta" });
    await expect(patchClub(auth, b.id, { slug: a.slug! })).rejects.toMatchObject({ status: 409 });
  });
});
