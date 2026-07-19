// Engine rejections carry raw UUIDs (the engine is pure and knows no names);
// scoreEvent swaps person/entrant ids for display names before the message
// reaches a pad. Real Postgres required.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { humanizeEngineMessage } from "../scoring";

const HAS_DB = !!process.env.DATABASE_URL;

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Hz " + suffix}, ${"hz-" + suffix}) returning id`;
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, consent)
    values (${orgId}, 'Alex Morgan', '{}') returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}')
    on conflict (key) do nothing`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, 'Hz Cup', ${"hz-cup-" + suffix}, 'private') returning id`;
  const [{ id: divId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, module_version, variant_key, config)
    values (${compId}, 'Hz Div', 'hz-div', 'generic', '1.0.0', 'score', '{}') returning id`;
  const [{ id: entrantId }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name)
    values (${divId}, 'team', 'Lions U12') returning id`;
  return { orgId, personId, entrantId };
}

describe.skipIf(!HAS_DB)("humanizeEngineMessage", () => {
  it("swaps person and entrant UUIDs for display names; unknown ids survive", async () => {
    const { orgId, personId, entrantId } = await seed();
    const ghost = randomUUID();
    const msg = `scorer "${personId}" is not on the pitch for "${entrantId}" (ref ${ghost})`;
    const out = await humanizeEngineMessage(orgId, msg);
    expect(out).toBe(`scorer Alex Morgan is not on the pitch for Lions U12 (ref ${ghost})`);
  });

  it("does not leak names across orgs", async () => {
    const a = await seed();
    const b = await seed();
    // Org B asks about org A's person — RLS keeps the UUID opaque.
    const out = await humanizeEngineMessage(b.orgId, `scorer "${a.personId}" missing`);
    expect(out).toContain(a.personId);
    expect(out).not.toContain("Alex Morgan");
  });

  it("returns the message untouched when it carries no UUIDs", async () => {
    const { orgId } = await seed();
    const msg = 'goal not allowed in phase "done"';
    expect(await humanizeEngineMessage(orgId, msg)).toBe(msg);
  });
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});
