// #404 Task 5 — a merge can CREATE person-overlap in a board that was legal
// when it was published: two entrants holding the two duplicates, scheduled at
// the same time on different courts, become one human on two courts. The
// organiser has to be told.
//
// It must NOT be blocked by what it reveals (spec §5, the W4 delta rule):
// refusing would leave the duplicate in place AND the board still wrong. So the
// re-verify is a REPORT that runs after the merge transaction has committed —
// which is what the second test here pins.
//
// Real Postgres required: the board, its entrants and the repointed
// entrant_members rows are all database state.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { mergePersons } from "../person-merge";
import { publishSchedule } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const rnd = () => randomUUID().slice(0, 8);
const MS_PER_MIN = 60_000;
/** Fixed instant so a run is never near a DST edge or a day boundary. */
const T0 = new Date("2026-09-05T10:00:00.000Z");

async function person(orgId: string, fullName: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, ${fullName}) returning id`;
  return row!.id;
}

interface BoardRow {
  id: string;
  home_entrant_id: string;
  away_entrant_id: string;
}

/**
 * A four-entrant league with two fixtures on the timetable that share no
 * entrant — the board is legal before the merge whatever the gap is, because
 * rest defaults to 0 and the two cards sit on different courts.
 *
 * `minutesApart` 0 puts them on top of each other, which is what a merge turns
 * into one human on two courts.
 */
async function seedBoard(
  auth: AuthCtx,
  opts: { minutesApart: number; publish: boolean },
): Promise<{ divisionId: string; first: BoardRow; second: BoardRow }> {
  const comp = await createCompetition(auth, {
    name: "Reverify Cup " + rnd(),
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
    ["A", "B", "C", "D"].map((name, i) => ({
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
  await generateStageFixtures(auth, stage!.id);

  const rows = await sql<BoardRow[]>`
    select id, home_entrant_id, away_entrant_id from fixtures
    where division_id = ${division.id} order by round_no, seq_in_round, id`;
  const first = rows[0]!;
  // The other card must share NO entrant with the first, or the pair is already
  // an overlap before anything is merged and the test proves nothing.
  const second = rows.find(
    (r) =>
      r.home_entrant_id !== first.home_entrant_id &&
      r.home_entrant_id !== first.away_entrant_id &&
      r.away_entrant_id !== first.home_entrant_id &&
      r.away_entrant_id !== first.away_entrant_id,
  )!;
  expect(second, "no disjoint second fixture in the generated league").toBeTruthy();

  const second_at = new Date(T0.getTime() + opts.minutesApart * MS_PER_MIN);
  await sql`update fixtures set scheduled_at = ${T0}, court_label = 'Court 1' where id = ${first.id}`;
  await sql`update fixtures set scheduled_at = ${second_at}, court_label = 'Court 2' where id = ${second.id}`;

  if (opts.publish) await publishSchedule(auth, division.id);
  return { divisionId: division.id, first, second };
}

async function joinEntrant(entrantId: string, personId: string): Promise<void> {
  await sql`insert into entrant_members (entrant_id, person_id) values (${entrantId}, ${personId})`;
}

describe.skipIf(!HAS_DB)("#404 re-verify published boards after a merge", () => {
  it("reports the person overlap the merge created on a published board", async () => {
    const { auth } = await seedOrg("pro");
    const { divisionId, first, second } = await seedBoard(auth, { minutesApart: 0, publish: true });
    const survivor = await person(auth.orgId, "Sam Doe");
    const absorbed = await person(auth.orgId, "Sam Doe");
    await joinEntrant(first.home_entrant_id, survivor);
    await joinEntrant(second.home_entrant_id, absorbed);

    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    const board = res.revealed.find((r) => r.division_id === divisionId);
    expect(board, "the published board was not re-verified").toBeTruthy();
    const overlap = board!.conflicts.filter(
      (c) => c.reason === "person_overlap" && (c.detail ?? "").includes(survivor),
    );
    expect(overlap.length, `no person_overlap naming ${survivor}`).toBeGreaterThan(0);
    // The two cards are the pair the organiser has to move.
    expect(new Set(overlap.map((c) => c.fixtureId))).toEqual(new Set([first.id, second.id]));
  });

  it("still commits the merge that revealed it", async () => {
    const { auth } = await seedOrg("pro");
    const { first, second } = await seedBoard(auth, { minutesApart: 0, publish: true });
    const survivor = await person(auth.orgId, "Ida Cross");
    const absorbed = await person(auth.orgId, "Ida Cross");
    await joinEntrant(first.home_entrant_id, survivor);
    await joinEntrant(second.home_entrant_id, absorbed);

    // No throw: a merge is never refused by what re-verifying reveals (§5) —
    // refusing would leave the duplicate in place and the board still wrong.
    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    const [tomb] = await sql<{ merged_into: string | null }[]>`
      select merged_into from persons where id = ${absorbed}`;
    expect(tomb!.merged_into, "the merge rolled back").toBe(survivor);
    const [ledger] = await sql<{ id: string }[]>`
      select id from person_merges where id = ${res.merge_id}`;
    expect(ledger, "no ledger row — the merge rolled back").toBeTruthy();
  });

  it("reveals nothing when the two cards do not overlap", async () => {
    const { auth } = await seedOrg("pro");
    const { first, second } = await seedBoard(auth, { minutesApart: 240, publish: true });
    const survivor = await person(auth.orgId, "Nell Fair");
    const absorbed = await person(auth.orgId, "Nell Fair");
    await joinEntrant(first.home_entrant_id, survivor);
    await joinEntrant(second.home_entrant_id, absorbed);

    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    expect(res.revealed).toEqual([]);
  });

  it("does not report a board that was never published", async () => {
    const { auth } = await seedOrg("pro");
    const { first, second } = await seedBoard(auth, { minutesApart: 0, publish: false });
    const survivor = await person(auth.orgId, "Ola Draft");
    const absorbed = await person(auth.orgId, "Ola Draft");
    await joinEntrant(first.home_entrant_id, survivor);
    await joinEntrant(second.home_entrant_id, absorbed);

    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    // Same overlapping cards as the first test — the only difference is that
    // the division is still in setup, so no organiser has published it.
    expect(res.revealed).toEqual([]);
  });

  it("commits the merge even when re-verifying the board throws", async () => {
    const { auth } = await seedOrg("pro");
    const { divisionId, first, second } = await seedBoard(auth, { minutesApart: 0, publish: true });
    const survivor = await person(auth.orgId, "Rex Broke");
    const absorbed = await person(auth.orgId, "Rex Broke");
    await joinEntrant(first.home_entrant_id, survivor);
    await joinEntrant(second.home_entrant_id, absorbed);
    // A settings row `loadSettings` cannot parse: the report path throws before
    // it reaches the verifier. The merge has already committed by then, and a
    // failed REPORT may never undo a completed write.
    await sql`
      insert into schedule_settings (division_id, org_id, config)
      values (${divisionId}, ${auth.orgId}, ${sql.json({ matchMinutes: "banana" } as never)})
      on conflict (division_id) do update set config = excluded.config`;

    const res = await mergePersons(auth, survivor, absorbed, { confirmedBy: auth.userId! });

    expect(res.revealed).toEqual([]);
    const [tomb] = await sql<{ merged_into: string | null }[]>`
      select merged_into from persons where id = ${absorbed}`;
    expect(tomb!.merged_into, "a failed report rolled the merge back").toBe(survivor);
  });
});
