// PROMPT-65 §2 — player-owned photo: ownership = persons.user_id (claim),
// guardian gate mirrors consent, storage shared with the organiser path
// (uploadPersonPhotoBytes — mocked bucket). Real Postgres required.
import { describe, expect, it, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => ({
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://cdn.example");

import { sql } from "@/lib/db";
import { setMyPersonPhoto } from "../me";

const HAS_DB = !!process.env.DATABASE_URL;

async function seed(dob: string | null = null) {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Mp " + suffix}, ${"mp-" + suffix})
    returning id`;
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${suffix + "@example.test"}, ${"Player " + suffix}, true)
    returning id`;
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, consent, user_id, dob)
    values (${orgId}, 'Self Player', ${sql.json({})}, ${userId}, ${dob})
    returning id`;
  return { orgId, userId, personId };
}

const PNG = { contentType: "image/png", bytes: Buffer.from("png-bytes") };

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("setMyPersonPhoto (PROMPT-65 §2)", () => {
  it("owner uploads → photo_path set (hash path) and DELETE clears it", async () => {
    const { userId, personId } = await seed();
    const me = await setMyPersonPhoto(userId, personId, PNG);
    expect(me.photo).toMatch(/persons\/.+\.png/);
    const [row] = await sql<{ photo_path: string | null }[]>`
      select photo_path from persons where id = ${personId}`;
    expect(row.photo_path).toMatch(/^orgs\/.+\/persons\/.+\.png$/);

    const cleared = await setMyPersonPhoto(userId, personId, null);
    expect(cleared.photo).toBeNull();
  });

  it("a non-owner (different user) is 404 — unclaimed profiles are invisible", async () => {
    const { personId } = await seed();
    const other = await seed();
    await expect(setMyPersonPhoto(other.userId, personId, PNG)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("guardian gate: under-16 profiles are organiser-managed (403)", async () => {
    const young = new Date();
    young.setFullYear(young.getFullYear() - 12);
    const { userId, personId } = await seed(young.toISOString().slice(0, 10));
    await expect(setMyPersonPhoto(userId, personId, PNG)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects unsupported image types", async () => {
    const { userId, personId } = await seed();
    await expect(
      setMyPersonPhoto(userId, personId, { contentType: "image/gif", bytes: Buffer.from("x") }),
    ).rejects.toMatchObject({ status: 415 });
  });
});
