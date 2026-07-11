// Embed door (v3/10 #4): private divisions 404, link-only render, free orgs
// are not_entitled, Pro orgs pass. Real Postgres.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { embedDivisionData } from "@/server/embed-data";

const HAS_DB = !!process.env.DATABASE_URL;

async function seed(visibility: string, plan: string) {
  const s = randomUUID().slice(0, 8);
  // divisions.sport_key FKs the sports catalog — make sure it exists on a
  // fresh test DB (no sync:sports run).
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Emb " + s}, ${"emb-" + s}) returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${orgId}, ${plan}, 'active') on conflict (org_id) do nothing`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + s}, ${"comp-" + s}, ${visibility}) returning id`;
  const [{ id: divId }] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${orgId}, ${compId}, 'Div', 'div', 'generic', 'score', '{}', '1.0.0') returning id`;
  return { orgId, divId };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("embedDivisionData", () => {
  it("private division → not_found (never a side door)", async () => {
    const { divId } = await seed("private", "pro");
    expect(await embedDivisionData(divId)).toEqual({ ok: false, reason: "not_found" });
  });

  it("link-only division on Pro → ok", async () => {
    const { divId } = await seed("unlisted", "pro");
    const res = await embedDivisionData(divId);
    expect(res.ok).toBe(true);
  });

  it("public division on Community → not_entitled", async () => {
    const { divId } = await seed("public", "community");
    expect(await embedDivisionData(divId)).toEqual({ ok: false, reason: "not_entitled" });
  });

  it("garbage id → not_found", async () => {
    expect(await embedDivisionData("nope")).toEqual({ ok: false, reason: "not_found" });
  });
});
