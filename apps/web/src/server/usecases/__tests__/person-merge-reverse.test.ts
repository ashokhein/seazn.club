// #404 Task 4 — reversal (spec §4.4). The undo window is unbounded (Art. 16
// rectification has no expiry), so the snapshot written by `mergePersons` has
// to be replayable backwards *exactly*: the round-trip test below is the whole
// point of the wave. It compares whole row SETS, not counts — a count-only
// assertion passes while every value is wrong.
//
// Real Postgres required: partial unique indexes, jsonb round-tripping and the
// stats refold are database behaviour, not logic that can be faked.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { putLineup } from "../fixtures";
import { mergePersons, reverseMerge } from "../person-merge";
import { recomputePlayerStats } from "../player-stats";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const rnd = () => randomUUID().slice(0, 8);

/** Every table the reversal has to put back. `player_stat_snapshots` is
 *  deliberately absent: it is a disposable cache refolded from the ledger, so
 *  comparing it would pin a stale value rather than the restored state. */
const DEPENDENT = [
  "entrant_members",
  "player_profiles",
  "lineups",
  "team_members",
  "fixture_availability",
  "person_claims",
  "suspensions",
  "officials",
] as const;

interface PersonOpts {
  full_name?: string;
  user_id?: string | null;
  dob?: string | null;
  consent?: Record<string, unknown>;
  lane?: "player" | "official";
}

async function person(orgId: string, opts: PersonOpts = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id, dob, consent, lane)
    values (${orgId}, ${opts.full_name ?? "Alex Morgan"}, ${opts.user_id ?? null},
            ${opts.dob ?? null}, ${sql.json((opts.consent ?? {}) as never)},
            ${opts.lane ?? "player"})
    returning id`;
  return row!.id;
}

async function seedDivision(auth: AuthCtx, entrantCount = 2) {
  const comp = await createCompetition(auth, {
    name: "Reverse Cup " + rnd(),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open " + rnd(),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].slice(0, entrantCount).map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { division, entrants, fixture: fixtures[0]! };
}

/** Whole rows, key-sorted and stringified so two captures compare by VALUE and
 *  in a stable order — Dates become ISO strings, jsonb stays structural. */
function normalise(rows: Record<string, unknown>[]): string[] {
  return rows
    .map((r) =>
      JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)))),
    )
    .sort();
}

/** The full observable state of a pair of people: both `persons` rows and every
 *  dependent row on either side. */
async function capture(ids: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  out.persons = normalise(
    await sql<Record<string, unknown>[]>`select * from persons where id in ${sql(ids)}`,
  );
  for (const table of DEPENDENT) {
    out[table] = normalise(
      await sql<Record<string, unknown>[]>`
        select * from ${sql(table)} where person_id in ${sql(ids)}`,
    );
  }
  return out;
}

async function expectHttp(p: Promise<unknown>, status: number, code: string): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected ${status} ${code}, got success`).toBeInstanceOf(HttpError);
  const http = err as HttpError;
  expect([http.status, http.code]).toEqual([status, code]);
  return http;
}

const claim = async (orgId: string, personId: string) => {
  const [row] = await sql<{ id: string }[]>`
    insert into person_claims (org_id, person_id, email, token_hash, expires_at)
    values (${orgId}, ${personId}, ${`claim-${rnd()}@test.local`}, ${randomUUID()},
            now() + interval '7 days')
    returning id`;
  return row!.id;
};

describe.skipIf(!HAS_DB)("#404 reverseMerge", () => {
  it("round trip: every person and every dependent row comes back exactly as it was", async () => {
    const { auth } = await seedOrg("pro");
    const { division, entrants, fixture } = await seedDivision(auth, 2);
    const e1 = entrants[0]!.id;
    const e2 = entrants[1]!.id;
    // Official lane on both sides so the officials repoint actually fires — it
    // is guarded on lane, and a player-lane pair would leave that table inert.
    const survivor = await person(auth.orgId, {
      lane: "official",
      consent: { public_name: true, public_photo: true },
    });
    const absorbed = await person(auth.orgId, {
      lane: "official",
      consent: { public_name: false, public_photo: true },
    });

    // entrant_members: one colliding pair (field-wise merge) + one pure repoint.
    await sql`
      insert into entrant_members (entrant_id, person_id, org_id, squad_number, is_captain, roles)
      values (${e1}, ${survivor}, ${auth.orgId}, null, false, ${sql.json(["gk"] as never)}),
             (${e1}, ${absorbed}, ${auth.orgId}, 7, true, ${sql.json(["cap"] as never)}),
             (${e2}, ${absorbed}, ${auth.orgId}, 3, false, ${sql.json([] as never)})`;
    // lineups: a collision — one human cannot appear twice, the absorbed row goes.
    await sql`
      insert into lineups (fixture_id, entrant_id, person_id, org_id, slot, order_no)
      values (${fixture.id}, ${e1}, ${survivor}, ${auth.orgId}, 'starting', 1),
             (${fixture.id}, ${e1}, ${absorbed}, ${auth.orgId}, 'bench', 2)`;
    // player_profiles: same sport on both, so the absorbed profile is dropped.
    await sql`
      insert into player_profiles (person_id, sport_key, org_id, attributes)
      values (${survivor}, 'generic', ${auth.orgId}, ${sql.json({ foot: "left" } as never)}),
             (${absorbed}, 'generic', ${auth.orgId}, ${sql.json({ foot: "right" } as never)})`;
    // team_members: one colliding team + one the absorbed row holds alone.
    const teams = await sql<{ id: string }[]>`
      insert into teams (org_id, name)
      values (${auth.orgId}, ${"Riverside " + rnd()}), (${auth.orgId}, ${"Northside " + rnd()})
      returning id`;
    await sql`
      insert into team_members (team_id, person_id, org_id, squad_number)
      values (${teams[0]!.id}, ${survivor}, ${auth.orgId}, 4),
             (${teams[0]!.id}, ${absorbed}, ${auth.orgId}, 9),
             (${teams[1]!.id}, ${absorbed}, ${auth.orgId}, 11)`;
    // fixture_availability: the newer RSVP wins, so the SURVIVOR's row is the
    // one the merge drops — the reversal has to reconstruct it, not just move it.
    await sql`
      insert into fixture_availability (fixture_id, person_id, org_id, status, updated_at)
      values (${fixture.id}, ${survivor}, ${auth.orgId}, 'in', now() - interval '1 hour'),
             (${fixture.id}, ${absorbed}, ${auth.orgId}, 'out', now())`;
    // person_claims: two open claims — the absorbed one is revoked, not deleted.
    await claim(auth.orgId, survivor);
    await claim(auth.orgId, absorbed);
    // suspensions: a manual row that just moves, plus an auto pair that collides
    // on (division, rule_key, bucket) so one row is deleted outright.
    const auto = (personId: string) => sql`
      insert into suspensions (org_id, division_id, person_id, source, rule_key, bucket,
                               reason, matches_total)
      values (${auth.orgId}, ${division.id}, ${personId}, 'auto_accumulation', 'yellow5', 1,
              '5th yellow card', 1)`;
    await auto(survivor);
    await auto(absorbed);
    await sql`
      insert into suspensions (org_id, division_id, person_id, source, reason, matches_total)
      values (${auth.orgId}, ${division.id}, ${absorbed}, 'manual', 'violent conduct', 3)`;
    // officials: both lanes are official, so the absorbed row repoints.
    await sql`
      insert into officials (org_id, person_id, display_name)
      values (${auth.orgId}, ${survivor}, 'Alex Morgan'),
             (${auth.orgId}, ${absorbed}, 'A. Morgan')`;

    const before = await capture([survivor, absorbed]);
    const { merge_id } = await mergePersons(auth, survivor, absorbed, {
      confirmedBy: auth.userId!,
    });

    // Guard against a vacuous round trip: if the merge changed nothing, the
    // reversal proves nothing either.
    const merged = await capture([survivor, absorbed]);
    expect(merged, "the merge moved nothing — the round trip would be vacuous").not.toEqual(before);

    await reverseMerge(auth, merge_id, { confirmedBy: auth.userId! });

    expect(await capture([survivor, absorbed])).toEqual(before);
  });

  it("restores the absorbed person's own consent flags, undoing the resolution", async () => {
    const { auth } = await seedOrg("pro");
    const survivor = await person(auth.orgId, { consent: { public_name: true, public_photo: true } });
    const absorbed = await person(auth.orgId, { consent: { public_name: false, public_photo: true } });

    const { merge_id } = await mergePersons(auth, survivor, absorbed, {
      confirmedBy: auth.userId!,
    });
    const [afterMerge] = await sql<{ consent: Record<string, unknown> }[]>`
      select consent from persons where id = ${survivor}`;
    expect(afterMerge!.consent).toEqual({ public_name: false, public_photo: true });

    await reverseMerge(auth, merge_id, { confirmedBy: auth.userId! });

    const rows = await sql<{ id: string; consent: Record<string, unknown> }[]>`
      select id, consent from persons where id in ${sql([survivor, absorbed])}`;
    const byId = new Map(rows.map((r) => [r.id, r.consent]));
    expect(byId.get(survivor), "the restrictive resolution was left on the survivor").toEqual({
      public_name: true,
      public_photo: true,
    });
    expect(byId.get(absorbed)).toEqual({ public_name: false, public_photo: true });
  });

  it("refuses to reverse an already-reversed merge", async () => {
    const { auth } = await seedOrg("pro");
    const survivor = await person(auth.orgId);
    const absorbed = await person(auth.orgId);
    const { merge_id } = await mergePersons(auth, survivor, absorbed, {
      confirmedBy: auth.userId!,
    });
    await reverseMerge(auth, merge_id, { confirmedBy: auth.userId! });

    await expectHttp(
      reverseMerge(auth, merge_id, { confirmedBy: auth.userId! }),
      409,
      "MERGE_ALREADY_REVERSED",
    );
  });

  it("leaves rows created after the merge with the survivor", async () => {
    const { auth } = await seedOrg("pro");
    const { division, entrants } = await seedDivision(auth, 2);
    const survivor = await person(auth.orgId);
    const absorbed = await person(auth.orgId);
    await sql`
      insert into entrant_members (entrant_id, person_id, org_id, squad_number)
      values (${entrants[0]!.id}, ${absorbed}, ${auth.orgId}, 3)`;

    const { merge_id } = await mergePersons(auth, survivor, absorbed, {
      confirmedBy: auth.userId!,
    });

    // Created AFTER the merge: never snapshotted, so nothing to move back.
    await sql`
      insert into entrant_members (entrant_id, person_id, org_id, squad_number)
      values (${entrants[1]!.id}, ${survivor}, ${auth.orgId}, 8)`;
    const [late] = await sql<{ id: string }[]>`
      insert into suspensions (org_id, division_id, person_id, source, reason, matches_total)
      values (${auth.orgId}, ${division.id}, ${survivor}, 'manual', 'later card', 1)
      returning id`;

    await reverseMerge(auth, merge_id, { confirmedBy: auth.userId! });

    const members = await sql<{ entrant_id: string; person_id: string; squad_number: number }[]>`
      select entrant_id, person_id, squad_number from entrant_members
       where person_id in ${sql([survivor, absorbed])}`;
    const byEntrant = new Map(members.map((m) => [m.entrant_id, m]));
    expect(byEntrant.get(entrants[0]!.id), "the snapshotted row did not move back").toMatchObject({
      person_id: absorbed,
      squad_number: 3,
    });
    expect(byEntrant.get(entrants[1]!.id), "a post-merge row was dragged back").toMatchObject({
      person_id: survivor,
      squad_number: 8,
    });
    expect(members).toHaveLength(2);

    const [kept] = await sql<{ person_id: string }[]>`
      select person_id from suspensions where id = ${late!.id}`;
    expect(kept, "a post-merge suspension was deleted by the reversal").toBeTruthy();
    expect(kept!.person_id).toBe(survivor);
  });

  it("restores a flattened chain: reversing B into C leaves A pointing at B", async () => {
    const { auth } = await seedOrg("pro");
    const a = await person(auth.orgId);
    const b = await person(auth.orgId);
    const c = await person(auth.orgId);
    await mergePersons(auth, b, a, { confirmedBy: auth.userId! });
    const second = await mergePersons(auth, c, b, { confirmedBy: auth.userId! });

    await reverseMerge(auth, second.merge_id, { confirmedBy: auth.userId! });

    const rows = await sql<{ id: string; merged_into: string | null }[]>`
      select id, merged_into from persons where id in ${sql([a, b, c])}`;
    const byId = new Map(rows.map((r) => [r.id, r.merged_into]));
    expect(byId.get(a), "the flattened tombstone was not restored to B").toBe(b);
    expect(byId.get(b)).toBe(null);
    expect(byId.get(c)).toBe(null);
  });

  it("stamps reversed_at/reversed_by and keeps the person_merges row", async () => {
    const { auth } = await seedOrg("pro");
    const survivor = await person(auth.orgId);
    const absorbed = await person(auth.orgId);
    const { merge_id } = await mergePersons(auth, survivor, absorbed, {
      confirmedBy: auth.userId!,
    });

    await reverseMerge(auth, merge_id, { confirmedBy: auth.userId! });

    const [row] = await sql<
      {
        survivor_id: string;
        absorbed_id: string;
        snapshot: Record<string, unknown[]>;
        reversed_at: Date | null;
        reversed_by: string | null;
      }[]
    >`select survivor_id, absorbed_id, snapshot, reversed_at, reversed_by
        from person_merges where id = ${merge_id}`;
    expect(row, "the person_merges row was deleted").toBeTruthy();
    expect([row!.survivor_id, row!.absorbed_id]).toEqual([survivor, absorbed]);
    expect(row!.snapshot.persons, "the snapshot was dropped").toBeTruthy();
    expect(row!.reversed_at).toBeInstanceOf(Date);
    expect(row!.reversed_by).toBe(auth.userId);

    // The absorbed person is live again, so a fresh merge of the same pair is
    // allowed — person_merges_absorbed_live_uq must not block it.
    const again = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });
    expect(again.merge_id).not.toBe(merge_id);
  });

  it("re-keys player stats back to the original person after a reversal", async () => {
    const { auth } = await seedOrg("pro");
    // football, not generic: generic declares no playerStats model, so the fold
    // returns before it touches the table and the assertion is unfalsifiable.
    const comp = await createCompetition(auth, {
      name: "Stats Cup " + rnd(),
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
    const survivor = await person(auth.orgId, { full_name: "Ada Striker" });
    const absorbed = await person(auth.orgId, { full_name: "Ada Striker" });
    const keeper = await person(auth.orgId, { full_name: "Cy Keeper" });
    const roster = (people: string[]) =>
      people.map((id, i) => ({
        person_id: id,
        squad_number: i + 1,
        default_position_key: null,
        is_captain: i === 0,
        roles: [],
      }));
    const entrants = await createEntrants(auth, division.id, [
      { kind: "team", display_name: "Reds", seed: 1, members: roster([survivor, absorbed]) },
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
      [entrants[0]!.id, [survivor, absorbed]],
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
    await scoreEvent(auth, fixture.id, {
      expected_seq: 1,
      type: "football.goal",
      payload: { by: entrants[0]!.id, scorer: survivor },
    });
    await scoreEvent(auth, fixture.id, {
      expected_seq: 2,
      type: "football.goal",
      payload: { by: entrants[0]!.id, scorer: absorbed },
    });

    const { merge_id } = await mergePersons(auth, survivor, absorbed, {
      confirmedBy: auth.userId!,
    });
    const afterMerge = await sql<{ person_id: string; stats: Record<string, number> }[]>`
      select person_id, stats from player_stat_snapshots where division_id = ${division.id}`;
    expect(afterMerge.map((r) => [r.person_id, r.stats.goals])).toEqual([[survivor, 2]]);

    await reverseMerge(auth, merge_id, { confirmedBy: auth.userId! });

    const goals = async () => {
      const rows = await sql<{ person_id: string; stats: Record<string, number> }[]>`
        select person_id, stats from player_stat_snapshots where division_id = ${division.id}`;
      return new Map(rows.map((r) => [r.person_id, r.stats.goals]));
    };
    const stored = await goals();
    expect([...stored.entries()].sort()).toEqual([[survivor, 1], [absorbed, 1]].sort());

    // ...and a fresh fold agrees, which is what proves the relabel is reading a
    // cleared `merged_into` rather than a cached row the reversal happened to write.
    const fresh = await withTenant(auth.orgId, (tx) => recomputePlayerStats(tx, division.id));
    expect(fresh.rows.map((r) => [r.personId, r.stats.goals]).sort()).toEqual(
      [
        [survivor, 1],
        [absorbed, 1],
      ].sort(),
    );
  });
});
