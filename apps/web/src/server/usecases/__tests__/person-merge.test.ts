// #404 Task 3 — the safe merge. The merge that shipped before this ended with
// `delete from persons where id = duplicateId`; six dependent tables are
// `on delete cascade`, so that one statement destroyed the absorbed person's
// discipline history, stats, club membership, account claim and RSVPs. The
// first test here is the regression proof for that defect: it fails hard
// against the old code.
//
// Real Postgres required — partial unique indexes, the jsonb snapshot and the
// stats recompute are all database behaviour, not logic that can be faked.
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
import { GENERIC_CONFIG, seedOrg, makeUser } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const rnd = () => randomUUID().slice(0, 8);

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

/** A generic division carrying one real fixture — enough to hang a suspension,
 *  an availability RSVP and an entrant roster off. */
async function seedDivision(auth: AuthCtx, entrantCount = 2) {
  const comp = await createCompetition(auth, {
    name: "Merge Cup " + rnd(),
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
  await createEntrants(
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
  return { division, fixture: fixtures[0]! };
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

describe.skipIf(!HAS_DB)("#404 mergePersons", () => {
  it("destroys nothing: suspensions, club membership, the claim and the RSVP all move", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixture } = await seedDivision(auth);
    const survivor = await person(auth.orgId);
    const absorbed = await person(auth.orgId);

    const [team] = await sql<{ id: string }[]>`
      insert into teams (org_id, name) values (${auth.orgId}, ${"Riverside " + rnd()}) returning id`;
    await sql`
      insert into team_members (team_id, person_id, org_id, squad_number)
      values (${team!.id}, ${absorbed}, ${auth.orgId}, 9)`;
    const [suspension] = await sql<{ id: string }[]>`
      insert into suspensions (org_id, division_id, person_id, source, reason, matches_total)
      values (${auth.orgId}, ${division.id}, ${absorbed}, 'manual', 'two yellows', 2)
      returning id`;
    const [claim] = await sql<{ id: string }[]>`
      insert into person_claims (org_id, person_id, email, token_hash, expires_at)
      values (${auth.orgId}, ${absorbed}, ${`claim-${rnd()}@test.local`}, ${randomUUID()},
              now() + interval '7 days')
      returning id`;
    await sql`
      insert into fixture_availability (fixture_id, person_id, org_id, status)
      values (${fixture.id}, ${absorbed}, ${auth.orgId}, 'in')`;

    await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    const [kept] = await sql<{ person_id: string; reason: string }[]>`
      select person_id, reason from suspensions where id = ${suspension!.id}`;
    expect(kept, "the suspension was cascade-deleted").toBeTruthy();
    expect([kept!.person_id, kept!.reason]).toEqual([survivor, "two yellows"]);

    const [member] = await sql<{ person_id: string; squad_number: number }[]>`
      select person_id, squad_number from team_members where team_id = ${team!.id}`;
    expect(member, "the club membership was cascade-deleted").toBeTruthy();
    expect([member!.person_id, member!.squad_number]).toEqual([survivor, 9]);

    const [moved] = await sql<{ person_id: string }[]>`
      select person_id from person_claims where id = ${claim!.id}`;
    expect(moved, "the account claim was cascade-deleted").toBeTruthy();
    expect(moved!.person_id).toBe(survivor);

    const [rsvp] = await sql<{ person_id: string; status: string }[]>`
      select person_id, status from fixture_availability where fixture_id = ${fixture.id}`;
    expect(rsvp, "the RSVP was cascade-deleted").toBeTruthy();
    expect([rsvp!.person_id, rsvp!.status]).toEqual([survivor, "in"]);
  });

  it("resolves consent to the stricter value per flag, whichever side holds it", async () => {
    const { auth } = await seedOrg("pro");
    const merge = async (survivorConsent: Record<string, boolean>, absorbedConsent: Record<string, boolean>) => {
      const survivor = await person(auth.orgId, { consent: survivorConsent });
      const absorbed = await person(auth.orgId, { consent: absorbedConsent });
      const result = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });
      const [row] = await sql<{ consent: Record<string, unknown> }[]>`
        select consent from persons where id = ${survivor}`;
      return { returned: result.survivor.consent, stored: row!.consent };
    };

    // Restrictive flag on the ABSORBED row — a "survivor wins" merge widens it.
    const a = await merge({ public_name: true, public_photo: true }, { public_name: false, public_photo: true });
    expect(a.stored).toEqual({ public_name: false, public_photo: true });
    expect(a.returned).toEqual({ public_name: false, public_photo: true });

    // ...and the mirror image, which a "survivor wins" merge happens to pass.
    const b = await merge({ public_name: false, public_photo: true }, { public_name: true, public_photo: true });
    expect(b.stored).toEqual({ public_name: false, public_photo: true });
    expect(b.returned).toEqual({ public_name: false, public_photo: true });
  });

  it("merges an entrant membership field-wise, strongest value winning", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      name: "Merge Cup " + rnd(),
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
    const survivor = await person(auth.orgId);
    const absorbed = await person(auth.orgId);
    const [entrant] = await createEntrants(auth, division.id, [
      {
        kind: "pair",
        display_name: "Pair " + rnd(),
        seed: 1,
        members: [
          { person_id: survivor, squad_number: null, default_position_key: null, is_captain: false, roles: ["gk"] },
          { person_id: absorbed, squad_number: 7, default_position_key: null, is_captain: true, roles: ["cap"] },
        ],
      },
    ]);

    await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    const rows = await sql<
      { person_id: string; is_captain: boolean; squad_number: number | null; roles: string[] }[]
    >`select person_id, is_captain, squad_number, roles from entrant_members
        where entrant_id = ${entrant!.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.person_id).toBe(survivor);
    expect(rows[0]!.is_captain).toBe(true);
    expect(rows[0]!.squad_number).toBe(7);
    expect([...rows[0]!.roles].sort()).toEqual(["cap", "gk"]);
  });

  it("recomputes player stats instead of picking a row", async () => {
    const { auth } = await seedOrg("pro");
    // football, not generic: generic declares no playerStats model, so
    // recomputePlayerStats returns before it touches the table and "recomputed,
    // never picked" would be unfalsifiable.
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
    const third = await person(auth.orgId, { full_name: "Bea Winger" });
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
      { kind: "team", display_name: "Reds", seed: 1, members: roster([survivor, third]) },
      { kind: "team", display_name: "Blues", seed: 2, members: roster([keeper]) },
    ]);
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    await startDivision(auth, division.id);
    const fixture = fixtures[0]!;
    const rosters = new Map([
      [entrants[0]!.id, [survivor, third]],
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

    // Stale cached rows a "pick one" merge would keep. `third` is the tell that
    // the whole division was refolded rather than two rows being deleted.
    const stale = (personId: string, goals: number) => sql`
      insert into player_stat_snapshots (division_id, person_id, org_id, sport_key, stats, computed_through_seq)
      values (${division.id}, ${personId}, ${auth.orgId}, 'football', ${sql.json({ goals } as never)}, 0)`;
    await stale(survivor, 7);
    await stale(absorbed, 99);
    await stale(third, 42);

    await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    const rows = await sql<{ person_id: string; stats: Record<string, number> }[]>`
      select person_id, stats from player_stat_snapshots where division_id = ${division.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.person_id).toBe(survivor);
    expect(rows[0]!.stats.goals).toBe(1);

    const fresh = await withTenant(auth.orgId, (tx) => recomputePlayerStats(tx, division.id));
    expect(fresh.rows.map((r) => [r.personId, r.stats.goals])).toEqual([[survivor, 1]]);
  });

  it("keeps the survivor's open claim and revokes the absorbed one", async () => {
    const { auth } = await seedOrg("pro");
    const survivor = await person(auth.orgId);
    const absorbed = await person(auth.orgId);
    const open = async (personId: string) => {
      const [row] = await sql<{ id: string }[]>`
        insert into person_claims (org_id, person_id, email, token_hash, expires_at)
        values (${auth.orgId}, ${personId}, ${`claim-${rnd()}@test.local`}, ${randomUUID()},
                now() + interval '7 days')
        returning id`;
      return row!.id;
    };
    const survivorClaim = await open(survivor);
    const absorbedClaim = await open(absorbed);

    // The partial unique `(person_id) where claimed_at is null and revoked_at
    // is null` throws 23505 if both open claims land on the survivor.
    await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    const rows = await sql<{ id: string; person_id: string; revoked_at: Date | null }[]>`
      select id, person_id, revoked_at from person_claims where id in ${sql([survivorClaim, absorbedClaim])}`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(survivorClaim)!.person_id).toBe(survivor);
    expect(byId.get(survivorClaim)!.revoked_at).toBeNull();
    expect(byId.get(absorbedClaim)!.person_id).toBe(survivor);
    expect(byId.get(absorbedClaim)!.revoked_at).not.toBeNull();
  });

  it("refuses a person from another organisation", async () => {
    const { auth } = await seedOrg("pro");
    const other = await seedOrg("pro");
    const survivor = await person(auth.orgId);
    const foreign = await person(other.auth.orgId);
    await expectHttp(
      mergePersons(auth, survivor, foreign, { confirmedBy: auth.userId! }),
      422,
      "MERGE_CROSS_ORG",
    );
    const [still] = await sql<{ merged_into: string | null }[]>`
      select merged_into from persons where id = ${foreign}`;
    expect(still!.merged_into).toBeNull();
  });

  it("refuses two rows carrying two different accounts, naming both", async () => {
    const { auth } = await seedOrg("pro");
    const one = await makeUser("merge-a");
    const two = await makeUser("merge-b");
    // official lane: the player-lane identity index forbids two live rows for
    // one account, so two *different* accounts is the only player-lane shape.
    const survivor = await person(auth.orgId, { user_id: one.id });
    const absorbed = await person(auth.orgId, { user_id: two.id });
    const err = await expectHttp(
      mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! }),
      422,
      "MERGE_TWO_ACCOUNTS",
    );
    expect(err.extra?.user_ids).toEqual([one.id, two.id]);
  });

  // The queue never proposes a cross-lane pair (`listDuplicateCandidates`
  // requires `b.lane = a.lane`), but the queue is not the only door: `listPersons`
  // has no lane filter, so the People table lists both lanes and the hand-picked
  // merge in `persons-panel.tsx` can pair any two rows the organiser clicks.
  // Officials mint unconditionally and cannot dedupe (#402), so folding one into
  // a player left the `officials` row pointing at a tombstone that `officials.ts`
  // still left-joins — with nothing recorded for the reversal to put back.
  it("refuses to merge across lanes, and writes nothing", async () => {
    const { auth } = await seedOrg("pro");
    const player = await person(auth.orgId, { lane: "player" });
    const official = await person(auth.orgId, { lane: "official" });
    const err = await expectHttp(
      mergePersons(auth, player, official, { confirmedBy: auth.userId! }),
      422,
      "MERGE_CROSS_LANE",
    );
    expect(err.extra?.lanes).toEqual(["player", "official"]);
    // …in both directions, so the refusal is about the PAIR, not about which
    // side the organiser happened to pick as the survivor.
    await expectHttp(
      mergePersons(auth, official, player, { confirmedBy: auth.userId! }),
      422,
      "MERGE_CROSS_LANE",
    );
    const rows = await sql<{ merged_into: string | null }[]>`
      select merged_into from persons where id in ${sql([player, official])}`;
    expect(rows.every((r) => r.merged_into === null)).toBe(true);
    // Scoped to THIS pair: `sql` here is the unscoped client, so an unqualified
    // count would tally every other test's merges and pass for the wrong reason.
    const [ledger] = await sql<{ n: string }[]>`
      select count(*)::text as n from person_merges
       where survivor_id in ${sql([player, official])} or absorbed_id in ${sql([player, official])}`;
    expect(ledger!.n, "a refused cross-lane merge wrote a ledger row").toBe("0");
  });

  it("allows one account held twice", async () => {
    const { auth } = await seedOrg("pro");
    const { id: userId } = await makeUser("merge-same");
    // Two official-lane rows for one account are legitimate and long-standing
    // (#402): officials mint unconditionally and cannot dedupe at invite time.
    // The player lane cannot be seeded this way — persons_org_user_lane_uq.
    const survivor = await person(auth.orgId, { user_id: userId, lane: "official" });
    const absorbed = await person(auth.orgId, { user_id: userId, lane: "official" });
    const [official] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name)
      values (${auth.orgId}, ${absorbed}, 'Alex Morgan') returning id`;

    const result = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });
    expect(result.survivor.id).toBe(survivor);

    const [row] = await sql<{ person_id: string }[]>`
      select person_id from officials where id = ${official!.id}`;
    expect(row!.person_id).toBe(survivor);
  });

  it("refuses a differing dob unless the organiser hand-picked the pair", async () => {
    const { auth } = await seedOrg("pro");
    const seedPair = async () => ({
      survivor: await person(auth.orgId, { dob: "1990-05-05" }),
      absorbed: await person(auth.orgId, { dob: "1991-06-06" }),
    });
    const suggested = await seedPair();
    await expectHttp(
      mergePersons(auth, suggested.survivor, suggested.absorbed, { confirmedBy: auth.userId! }),
      422,
      "MERGE_DOB_MISMATCH",
    );

    const handPicked = await seedPair();
    const result = await mergePersons(auth, handPicked.survivor, handPicked.absorbed, {
      confirmedBy: auth.userId!,
      allowDobMismatch: true,
    });
    expect(result.survivor.id).toBe(handPicked.survivor);
    const [tombstone] = await sql<{ merged_into: string | null }[]>`
      select merged_into from persons where id = ${handPicked.absorbed}`;
    expect(tombstone!.merged_into).toBe(handPicked.survivor);
  });

  it("flattens a chain so merged_into always names a live person", async () => {
    const { auth } = await seedOrg("pro");
    const a = await person(auth.orgId);
    const b = await person(auth.orgId);
    const c = await person(auth.orgId);
    await mergePersons(auth, b, a, { confirmedBy: auth.userId! });
    const second = await mergePersons(auth, c, b, { confirmedBy: auth.userId! });

    const rows = await sql<{ id: string; merged_into: string | null }[]>`
      select id, merged_into from persons where id in ${sql([a, b])}`;
    const byId = new Map(rows.map((r) => [r.id, r.merged_into]));
    expect(byId.get(a)).toBe(c);
    expect(byId.get(b)).toBe(c);

    // A's row has to be in the second snapshot or the reversal cannot put the
    // chain back the way it was.
    const [merge] = await sql<{ snapshot: Record<string, { id: string }[]> }[]>`
      select snapshot from person_merges where id = ${second.merge_id}`;
    expect(merge!.snapshot.persons!.map((p) => p.id)).toContain(a);
  });

  it("tombstones the absorbed row instead of deleting it", async () => {
    const { auth } = await seedOrg("pro");
    const survivor = await person(auth.orgId, { full_name: "Alex Morgan" });
    const absorbed = await person(auth.orgId, { full_name: "Alex Morgan" });
    await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });
    const [row] = await sql<{ full_name: string; merged_into: string | null }[]>`
      select full_name, merged_into from persons where id = ${absorbed}`;
    expect(row, "the absorbed row was deleted").toBeTruthy();
    expect([row!.full_name, row!.merged_into]).toEqual(["Alex Morgan", survivor]);
  });

  it("writes an audited person_merges row naming every table it snapshotted", async () => {
    const { auth } = await seedOrg("pro");
    const survivor = await person(auth.orgId);
    const absorbed = await person(auth.orgId);
    const result = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    const [row] = await sql<
      {
        org_id: string;
        survivor_id: string;
        absorbed_id: string;
        actor_user_id: string | null;
        snapshot: Record<string, { id?: string }[]>;
        reversed_at: Date | null;
      }[]
    >`select org_id, survivor_id, absorbed_id, actor_user_id, snapshot, reversed_at
        from person_merges where id = ${result.merge_id}`;
    expect(row).toBeTruthy();
    expect([row!.org_id, row!.survivor_id, row!.absorbed_id]).toEqual([auth.orgId, survivor, absorbed]);
    expect(row!.actor_user_id).toBe(auth.userId);
    expect(row!.reversed_at).toBeNull();
    expect(row!.snapshot.persons!.map((p) => p.id).sort()).toEqual([survivor, absorbed].sort());
    // Every table a repoint can touch has a key, so a reversal never has to
    // guess whether "absent" means "no rows" or "not captured".
    expect(Object.keys(row!.snapshot).sort()).toEqual(
      [
        "entrant_members",
        "fixture_availability",
        "lineups",
        "officials",
        "person_claims",
        "persons",
        "player_profiles",
        "player_stat_snapshots",
        "suspensions",
        "team_members",
      ].sort(),
    );
  });

  it("refuses to merge a tombstone on either side", async () => {
    const { auth } = await seedOrg("pro");
    const survivor = await person(auth.orgId);
    const absorbed = await person(auth.orgId);
    const third = await person(auth.orgId);
    await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    await expectHttp(
      mergePersons(auth, third, absorbed, { confirmedBy: auth.userId! }),
      409,
      "MERGE_TOMBSTONE",
    );
    await expectHttp(
      mergePersons(auth, absorbed, third, { confirmedBy: auth.userId! }),
      409,
      "MERGE_TOMBSTONE",
    );
  });
});

// ---------------------------------------------------------------------------
// #404 Task 8b — the account link. Found by Task 8's screenshots: `mergePersons`
// wrote exactly one column back to the surviving row (`consent`), so merging a
// CLAIMED record into an unclaimed one repointed `person_claims` while leaving
// `persons.user_id` on the tombstone. The player then signs in and finds no
// record at all — the claim points at the survivor, the survivor is unlinked.
//
// The genuinely ambiguous case (two DIFFERENT accounts) is already a 422, so
// carrying the link across when the survivor has none is never a guess about
// which human this is.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("#404 the account link follows the human", () => {
  it("carries the absorbed row's account onto an unclaimed survivor, off the tombstone", async () => {
    const { auth } = await seedOrg("pro");
    const { id: userId } = await makeUser("merge-claimed");
    const name = `Robin Vale ${rnd()}`;
    const survivor = await person(auth.orgId, { full_name: name });
    const absorbed = await person(auth.orgId, { full_name: name, user_id: userId });

    const result = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });
    // The wire result, not just the row: this is what the roster redraws from.
    expect(result.survivor.user_id).toBe(userId);

    const rows = await sql<{ id: string; user_id: string | null }[]>`
      select id, user_id from persons where id in ${sql([survivor, absorbed])}`;
    expect(rows.find((r) => r.id === survivor)!.user_id).toBe(userId);
    // And the tombstone lets it go — one account may not be held by two rows,
    // and the live one is the survivor.
    expect(rows.find((r) => r.id === absorbed)!.user_id).toBeNull();
  });

  it("leaves one account held twice exactly where it was", async () => {
    const { auth } = await seedOrg("pro");
    const { id: userId } = await makeUser("merge-both");
    // Official lane: two live player-lane rows for one account are barred by
    // persons_org_user_lane_uq, so this is the only shape the pair can take.
    const survivor = await person(auth.orgId, { user_id: userId, lane: "official" });
    const absorbed = await person(auth.orgId, { user_id: userId, lane: "official" });

    const result = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });
    expect(result.survivor.user_id).toBe(userId);

    // Nothing to carry, so nothing moves: the tombstone keeps what it had.
    const [tomb] = await sql<{ user_id: string | null; merged_into: string | null }[]>`
      select user_id, merged_into from persons where id = ${absorbed}`;
    expect(tomb!.user_id).toBe(userId);
    expect(tomb!.merged_into).toBe(survivor);
  });

  it("still refuses two different accounts, and moves neither link", async () => {
    const { auth } = await seedOrg("pro");
    const one = await makeUser("merge-x");
    const two = await makeUser("merge-y");
    const survivor = await person(auth.orgId, { user_id: one.id });
    const absorbed = await person(auth.orgId, { user_id: two.id });

    await expectHttp(
      mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! }),
      422,
      "MERGE_TWO_ACCOUNTS",
    );

    const rows = await sql<{ id: string; user_id: string | null }[]>`
      select id, user_id from persons where id in ${sql([survivor, absorbed])}`;
    expect(rows.find((r) => r.id === survivor)!.user_id).toBe(one.id);
    expect(rows.find((r) => r.id === absorbed)!.user_id).toBe(two.id);
  });

  it("gives the account back to the absorbed row when the merge is reversed", async () => {
    const { auth } = await seedOrg("pro");
    const { id: userId } = await makeUser("merge-undo");
    const name = `Sasha Quinn ${rnd()}`;
    const survivor = await person(auth.orgId, { full_name: name });
    const absorbed = await person(auth.orgId, { full_name: name, user_id: userId });

    const { merge_id } = await mergePersons(auth, survivor, absorbed, {
      confirmedBy: auth.userId!,
    });
    await reverseMerge(auth, merge_id, { confirmedBy: auth.userId! });

    const rows = await sql<{ id: string; user_id: string | null; merged_into: string | null }[]>`
      select id, user_id, merged_into from persons where id in ${sql([survivor, absorbed])}`;
    const back = rows.find((r) => r.id === absorbed)!;
    expect(back.user_id).toBe(userId);
    expect(back.merged_into).toBeNull();
    expect(rows.find((r) => r.id === survivor)!.user_id).toBeNull();
  });
});
