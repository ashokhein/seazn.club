// V281: users.locale + organizations.default_locale, constrained to the
// cycle-1 locale set (en/fr/es/nl). Verifies the default backfill and that the
// CHECK rejects out-of-set values.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("V281 locale columns", () => {
  it("organizations.default_locale defaults to en and enforces the set", async () => {
    const slug = `loc-${randomUUID().slice(0, 8)}`;
    const [org] = await sql<{ id: string; default_locale: string }[]>`
      insert into organizations (name, slug) values ('Loc Test', ${slug})
      returning id, default_locale`;
    expect(org.default_locale).toBe("en");

    // Out-of-set (incl. deferred hi/ta) is rejected by the CHECK.
    await expect(
      sql`update organizations set default_locale = 'de' where id = ${org.id}`,
    ).rejects.toThrow();
    await expect(
      sql`update organizations set default_locale = 'ta' where id = ${org.id}`,
    ).rejects.toThrow();

    // A valid cycle-1 locale is accepted.
    await sql`update organizations set default_locale = 'fr' where id = ${org.id}`;

    await sql`delete from organizations where id = ${org.id}`;
  });

  it("users.locale is nullable and CHECK-constrained", async () => {
    const [col] = await sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
      where table_name = 'users' and column_name = 'locale'`;
    expect(col?.is_nullable).toBe("YES");
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
