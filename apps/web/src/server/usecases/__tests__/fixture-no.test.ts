// Per-division fixture ordinals (v3/01 §2, PROMPT-30): V263 adds
// fixtures.fixture_no, backfilled and auto-assigned by a BEFORE INSERT
// trigger so every insert path (stage generation, ladder challenges,
// history restores) numbers rows without app changes. URLs use
// /o/../f/[no]; numbers are per-division ordinals, not permalinks —
// regeneration may renumber.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedDivision(): Promise<{ divisionId: string; stageId: string; orgId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Fno " + suffix}, ${"fno-" + suffix})
    returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, status)
    values (${orgId}, ${"Cup " + suffix}, ${"cup-" + suffix}, 'draft')
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', '{}', true)
    on conflict do nothing`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key,
                           config, module_version)
    values (${compId}, ${orgId}, 'Open', 'open', 'generic', 'score', '{}', '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name, config)
    values (${divisionId}, ${orgId}, 1, 'league', 'Stage 1', '{}')
    returning id`;
  return { divisionId, stageId, orgId };
}

function fixtureRow(divisionId: string, stageId: string, seq: number) {
  return {
    id: randomUUID(),
    stage_id: stageId,
    division_id: divisionId,
    round_no: 1,
    seq_in_round: seq,
    ext_key: `t-${seq}-${randomUUID().slice(0, 6)}`,
    status: "scheduled",
  };
}

describe.skipIf(!HAS_DB)("fixture_no trigger (V263)", () => {
  it("auto-numbers multi-row inserts 1..n per division", async () => {
    const { divisionId, stageId } = await seedDivision();
    const rows = [1, 2, 3].map((s) => fixtureRow(divisionId, stageId, s));
    await sql`insert into fixtures ${sql(rows)}`;
    const got = await sql<{ fixture_no: number }[]>`
      select fixture_no from fixtures where division_id = ${divisionId}
      order by fixture_no`;
    expect(got.map((r) => r.fixture_no)).toEqual([1, 2, 3]);
  });

  it("continues numbering after existing rows and per-division independently", async () => {
    const a = await seedDivision();
    const b = await seedDivision();
    await sql`insert into fixtures ${sql([fixtureRow(a.divisionId, a.stageId, 1)])}`;
    await sql`insert into fixtures ${sql([fixtureRow(a.divisionId, a.stageId, 2)])}`;
    await sql`insert into fixtures ${sql([fixtureRow(b.divisionId, b.stageId, 1)])}`;
    const [an] = await sql<{ max: number }[]>`
      select max(fixture_no)::int as max from fixtures where division_id = ${a.divisionId}`;
    const [bn] = await sql<{ max: number }[]>`
      select max(fixture_no)::int as max from fixtures where division_id = ${b.divisionId}`;
    expect(an!.max).toBe(2);
    expect(bn!.max).toBe(1);
  });

  it("preserves an explicit fixture_no and rejects duplicates", async () => {
    const { divisionId, stageId } = await seedDivision();
    const row = { ...fixtureRow(divisionId, stageId, 1), fixture_no: 14 };
    await sql`insert into fixtures ${sql([row])}`;
    const [got] = await sql<{ fixture_no: number }[]>`
      select fixture_no from fixtures where id = ${row.id}`;
    expect(got!.fixture_no).toBe(14);
    const dup = { ...fixtureRow(divisionId, stageId, 2), fixture_no: 14 };
    await expect(sql`insert into fixtures ${sql([dup])}`).rejects.toThrow(/fixtures_division_no_key/);
  });

  it("slug_history lookup table exists with the coalesce unique key", async () => {
    const entityId = randomUUID();
    await sql`
      insert into slug_history (entity_type, parent_id, old_slug, entity_id)
      values ('org', null, ${"old-org-" + entityId.slice(0, 8)}, ${entityId})`;
    await expect(sql`
      insert into slug_history (entity_type, parent_id, old_slug, entity_id)
      values ('org', null, ${"old-org-" + entityId.slice(0, 8)}, ${randomUUID()})`,
    ).rejects.toThrow(/slug_history_lookup_key/);
  });
});

afterAll(async () => {
  await sql.end();
});
