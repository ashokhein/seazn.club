// #404 Task 3b — a merged person's history has to follow the survivor across a
// refold. `recomputePlayerStats` folds `score_events` and reads the person id
// out of the event PAYLOAD (`football.goal` carries `scorer`), so a tombstoned
// person's id is still in every historical event: a refold rebuilds a snapshot
// row for the tombstone and the survivor never inherits those goals. Every
// stats read refolds, so nothing the merge transaction does can hold — the
// relabel lives in the fold, and it happens BEFORE the engine's summation so
// two histories combine through the engine's own arithmetic.
//
// Real Postgres required: the tombstone column, RLS tenancy and the snapshot
// table are all database behaviour.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { putLineup } from "../fixtures";
import { mergePersons } from "../person-merge";
import { recomputePlayerStats } from "../player-stats";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const rnd = () => randomUUID().slice(0, 8);

async function person(orgId: string, fullName: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, consent)
    values (${orgId}, ${fullName}, ${sql.json({} as never)})
    returning id`;
  return row!.id;
}

/**
 * Football (NOT generic — generic declares no `playerStats` model, so
 * `recomputePlayerStats` returns before it ever touches the snapshot table and
 * every assertion below would be unfalsifiable). `reds` all start, so scorer
 * attribution accepts any of them.
 */
async function seedFootball(auth: AuthCtx, reds: string[]) {
  const comp = await createCompetition(auth, {
    name: "Merge Stats Cup " + rnd(),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open " + rnd(),
    sport_key: "football",
    variant_key: "default",
    config: {},
    eligibility: [],
  });
  const keeper = await person(auth.orgId, "Cy Keeper");
  const roster = (people: string[]) =>
    people.map((id, i) => ({
      person_id: id,
      squad_number: i + 1,
      default_position_key: null,
      is_captain: i === 0,
      roles: [],
    }));
  const entrants = await createEntrants(auth, division.id, [
    { kind: "team", display_name: "Reds", seed: 1, members: roster(reds) },
    { kind: "team", display_name: "Blues", seed: 2, members: roster([keeper]) },
  ]);
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  const fixture = fixtures[0]!;
  const rosters = new Map([
    [entrants[0]!.id, reds],
    [entrants[1]!.id, [keeper]],
  ]);
  for (const entrantId of [fixture.home_entrant_id, fixture.away_entrant_id]) {
    if (!entrantId) continue;
    await putLineup(auth, fixture.id, entrantId, {
      slots: rosters.get(entrantId)!.map((id, i) => ({
        person_id: id,
        slot: "starting" as const,
        position_key: null,
        order_no: i + 1,
        roles: [],
      })),
    });
  }
  await scoreEvent(auth, fixture.id, { expected_seq: 0, type: "core.start", payload: {} });
  let seq = 1;
  const goal = async (scorer: string) => {
    await scoreEvent(auth, fixture.id, {
      expected_seq: seq,
      type: "football.goal",
      payload: { by: entrants[0]!.id, scorer },
    });
    seq += 1;
  };
  return { division, goal };
}

/** What the cache holds, which is what every stats read serves. */
async function snapshot(divisionId: string) {
  return sql<{ person_id: string; stats: Record<string, number> }[]>`
    select person_id, stats from player_stat_snapshots where division_id = ${divisionId}`;
}

describe.skipIf(!HAS_DB)("player stats follow a merge survivor (#404)", () => {
  it("Case A: an absorbed person's goals are re-keyed to the survivor on refold", async () => {
    const { auth } = await seedOrg("pro");
    const absorbed = await person(auth.orgId, "Ada Striker");
    const survivor = await person(auth.orgId, "Ada Striker");
    const { division, goal } = await seedFootball(auth, [absorbed, survivor]);
    // only the ABSORBED person ever scores — the survivor has no history of
    // her own, so a fold that keys on the payload id files both goals under a
    // tombstone.
    await goal(absorbed);
    await goal(absorbed);

    await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });
    const fresh = await withTenant(auth.orgId, (tx) => recomputePlayerStats(tx, division.id));

    expect(fresh.rows.map((r) => [r.personId, r.stats.goals])).toEqual([[survivor, 2]]);
    const rows = await snapshot(division.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.person_id).toBe(survivor);
    expect(rows[0]!.stats.goals).toBe(2);
  });

  it("Case B: two histories SUM through the engine, they do not replace each other", async () => {
    const { auth } = await seedOrg("pro");
    const absorbed = await person(auth.orgId, "Ada Striker");
    const survivor = await person(auth.orgId, "Ada Striker");
    const { division, goal } = await seedFootball(auth, [absorbed, survivor]);
    // Both ids appear, in the SAME fixture ledger: the relabel has to happen
    // before `sumPlayerStats` so the engine adds them and re-derives `points`.
    // Relabelling after the sum would mean re-implementing that arithmetic.
    await goal(absorbed);
    await goal(absorbed);
    await goal(survivor);

    await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });
    const fresh = await withTenant(auth.orgId, (tx) => recomputePlayerStats(tx, division.id));

    expect(fresh.rows).toHaveLength(1);
    expect(fresh.rows[0]!.personId).toBe(survivor);
    expect(fresh.rows[0]!.stats.goals).toBe(3); // not 2 and not 1
    expect(fresh.rows[0]!.stats.points).toBe(3); // derived AFTER the sum
    const rows = await snapshot(division.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stats.goals).toBe(3);
  });

  it("Case C: the row lands on a LIVE person even when merged_into chains", async () => {
    const { auth } = await seedOrg("pro");
    const a = await person(auth.orgId, "Ada Striker");
    const b = await person(auth.orgId, "Ada Striker");
    const c = await person(auth.orgId, "Ada Striker");
    const { division, goal } = await seedFootball(auth, [a, b, c]);
    await goal(a);
    await goal(b);
    await goal(c);

    await mergePersons(auth, b, a, { confirmedBy: auth.userId! });
    await mergePersons(auth, c, b, { confirmedBy: auth.userId! });

    // Task 3 flattens on merge, so a→c directly. Assert that rather than
    // assume it: if flattening ever regresses, the fold must still not key a
    // row to a tombstone.
    const flat = await sql<{ merged_into: string | null }[]>`
      select merged_into from persons where id = ${a}`;
    expect(flat[0]!.merged_into).toBe(c);

    const merged = await withTenant(auth.orgId, (tx) => recomputePlayerStats(tx, division.id));
    expect(merged.rows.map((r) => [r.personId, r.stats.goals])).toEqual([[c, 3]]);

    // Now force the un-flattened shape (a → b → c) and prove the walk follows
    // it to the live person instead of stopping on the intermediate tombstone.
    await sql`update persons set merged_into = ${b} where id = ${a}`;
    const chained = await withTenant(auth.orgId, (tx) => recomputePlayerStats(tx, division.id));
    expect(chained.rows.map((r) => [r.personId, r.stats.goals])).toEqual([[c, 3]]);
    const rows = await snapshot(division.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.person_id).toBe(c);
  });
});
