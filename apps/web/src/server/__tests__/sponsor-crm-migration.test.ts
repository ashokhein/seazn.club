// V283: sponsor CRM tables + blob backfill. Proves the tier/status CHECKs
// hold and that the migration's backfill block is idempotent — a second run
// against a scope that already has rows inserts nothing (the not-exists
// guard keys on scope, not on sponsor identity).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

function backfillSql(): string {
  const delta = readFileSync(
    join(process.cwd(), "..", "..", "db", "migration", "deltas", "V283__sponsor_crm.sql"),
    "utf8",
  );
  const m = delta.match(/-- backfill:begin([\s\S]*)-- backfill:end/);
  if (!m) throw new Error("backfill block missing from V283");
  return m[1]!;
}

describe.skipIf(!HAS_DB)("V283 sponsor CRM", () => {
  it("rejects out-of-set tier and status", async () => {
    const slug = `sp-${randomUUID().slice(0, 8)}`;
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values ('Sponsor Test', ${slug})
      returning id`;

    await expect(
      sql`insert into sponsors (org_id, name, tier) values (${org.id}, 'X', 'platinum')`,
    ).rejects.toThrow();
    await expect(
      sql`insert into sponsors (org_id, name, status) values (${org.id}, 'X', 'archived')`,
    ).rejects.toThrow();
    const [row] = await sql<{ tier: string; status: string; click_count: number }[]>`
      insert into sponsors (org_id, name) values (${org.id}, 'Acme')
      returning tier, status, click_count`;
    expect(row).toMatchObject({ tier: "partner", status: "active", click_count: 0 });

    await sql`delete from organizations where id = ${org.id}`;
  });

  it("backfills blob sponsors once per scope (idempotent re-run)", async () => {
    const slug = `sp-${randomUUID().slice(0, 8)}`;
    const branding = {
      colors: { primary: "#112233" },
      sponsors: [
        { name: "Alpha", url: "https://alpha.example" },
        { name: "Beta", logo: "sponsors/beta.png" },
      ],
    };
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, branding)
      values ('Backfill Test', ${slug}, ${sql.json(branding as never)})
      returning id`;
    const [comp] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, branding)
      values (${org.id}, 'Backfill Cup', ${`${slug}-cup`},
              ${sql.json({ sponsors: [{ name: "Gamma" }] } as never)})
      returning id`;

    const block = backfillSql();
    await sql.unsafe(block);
    await sql.unsafe(block); // idempotent: second run adds nothing

    const rows = await sql<
      { name: string; competition_id: string | null; tier: string; display_order: number }[]
    >`
      select name, competition_id, tier, display_order from sponsors
      where org_id = ${org.id} order by competition_id nulls first, display_order`;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ name: "Alpha", competition_id: null, tier: "partner", display_order: 0 });
    expect(rows[1]).toMatchObject({ name: "Beta", competition_id: null, display_order: 1 });
    expect(rows[2]).toMatchObject({ name: "Gamma", competition_id: comp.id, display_order: 0 });

    // The blob itself is untouched (read-shim source, never rewritten).
    const [after] = await sql<{ branding: { sponsors?: unknown[]; colors?: unknown } }[]>`
      select branding from organizations where id = ${org.id}`;
    expect(after.branding.sponsors).toHaveLength(2);
    expect(after.branding.colors).toEqual({ primary: "#112233" });

    await sql`delete from organizations where id = ${org.id}`;
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end();
});
