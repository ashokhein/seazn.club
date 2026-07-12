// Platform fee default (spec §1): admin-set platform_settings row → env → 5.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { cacheDelPattern } from "@/lib/cache";
import { platformFeeDefault, setPlatformFeeDefault } from "@/lib/platform-settings";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("platform fee default", () => {
  it("reads the seeded default, honours admin writes, validates range", async () => {
    const [{ id: actor }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`fee-admin-${randomUUID().slice(0, 8)}@test.local`}, 'Fee Admin', true)
      returning id`;

    expect(await platformFeeDefault()).toBe(5);

    await setPlatformFeeDefault(7, actor);
    expect(await platformFeeDefault()).toBe(7); // cache invalidated on write

    await expect(setPlatformFeeDefault(101, actor)).rejects.toMatchObject({ status: 422 });
    await expect(setPlatformFeeDefault(-1, actor)).rejects.toMatchObject({ status: 422 });

    const [row] = await sql<{ updated_by: string }[]>`
      select updated_by from platform_settings where key = 'platform_fee_percent'`;
    expect(row.updated_by).toBe(actor);

    await setPlatformFeeDefault(5, actor); // restore for sibling suites
  });

  it("falls back to env/5 on a garbage row", async () => {
    // Cache is Redis-backed and fail-open — absent REDIS_URL (test env) every
    // read hits Postgres, so garbage → fallback is directly observable.
    await sql`update platform_settings set value = '"nonsense"' where key = 'platform_fee_percent'`;
    await cacheDelPattern("platform:fee_percent"); // no-op locally, correct in prod

    const prev = process.env.PLATFORM_FEE_PERCENT;
    process.env.PLATFORM_FEE_PERCENT = "12";
    expect(await platformFeeDefault()).toBe(12);
    delete process.env.PLATFORM_FEE_PERCENT;
    expect(await platformFeeDefault()).toBe(5);
    if (prev !== undefined) process.env.PLATFORM_FEE_PERCENT = prev;

    await sql`update platform_settings set value = '5'::jsonb where key = 'platform_fee_percent'`;
  });
});
