// #404 Task 6 — the duplicate queue. `listDuplicateCandidates` proposes pairs;
// the ORGANISER decides, so every candidate has to carry the evidence that put
// it there, and every pair the merge could never accept has to be suppressed
// before it is ever offered. The suppression rules are the load-bearing half:
// a queue that suggests a pair Task 3 refuses with a 422, or a pair whose
// differing DOBs say "two different humans", trains the organiser to click
// through the confirmation gate.
//
// Real Postgres required: the whole thing is one org-scoped self-join, and the
// name key is a Postgres expression that has to agree with `personKeyResolver`.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { listDuplicateCandidates, type Candidate } from "../person-duplicates";
import { makeUser, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

/** [survivor-side id, other id] per candidate, in rank order. */
const pairsOf = (items: Candidate[]): string[][] => items.map((c) => [c.a.id, c.b.id]);

const scoreOfPair = (items: Candidate[], aId: string, bId: string): number => {
  const hit = items.find((c) => c.a.id === aId && c.b.id === bId);
  if (!hit) throw new Error(`no candidate for ${aId}/${bId}`);
  return hit.score;
};

/** A person the public usecases cannot create: `lane` and `user_id` are set by
 *  registration and officiating, never by `createPerson`. */
async function insertPerson(
  orgId: string,
  fullName: string,
  opts: { lane?: "player" | "official"; userId?: string | null; dob?: string | null } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, lane, user_id, dob)
    values (${orgId}, ${fullName}, ${opts.lane ?? "player"}, ${opts.userId ?? null},
            ${opts.dob ?? null})
    returning id`;
  return row.id;
}

async function seedDivision(auth: AuthCtx): Promise<string> {
  const competition = await createCompetition(auth, {
    name: "Duplicates Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open " + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: DIVISION_CONFIG,
    eligibility: [],
  });
  return division.id;
}

describe.skipIf(!HAS_DB)("#404 duplicate candidates", () => {
  it("ranks a name+dob match above a name-only match, and ranks the same way twice", async () => {
    const { auth } = await seedOrg("pro");
    const dobA = await createPerson(auth, { full_name: "Grace Hopper", dob: "1906-12-09", consent: {} });
    const dobB = await createPerson(auth, { full_name: "Grace Hopper", dob: "1906-12-09", consent: {} });
    const nameA = await createPerson(auth, { full_name: "Ada Lovelace", consent: {} });
    const nameB = await createPerson(auth, { full_name: "Ada Lovelace", consent: {} });

    const { items } = await listDuplicateCandidates(auth, {});
    expect(pairsOf(items)).toEqual([
      [dobA.id, dobB.id],
      [nameA.id, nameB.id],
    ]);
    expect(scoreOfPair(items, dobA.id, dobB.id)).toBeGreaterThan(
      scoreOfPair(items, nameA.id, nameB.id),
    );
    // A shared DOB is evidence in its own right, on top of the name.
    const dobPair = items[0]!;
    expect(dobPair.evidence).toContainEqual({ kind: "dob", detail: "1906-12-09" });

    // The UI shows a and b side by side and merges b into a: an orientation that
    // flips between calls would move the survivor under the organiser's cursor.
    const again = await listDuplicateCandidates(auth, {});
    expect(pairsOf(again.items)).toEqual(pairsOf(items));
    expect(again.items.map((c) => c.score)).toEqual(items.map((c) => c.score));
  });

  it("suppresses a pair whose non-null dobs differ, however well the names match", async () => {
    const { auth } = await seedOrg("pro");
    // Same name, to the letter. Different birthdays: two humans, not one row twice.
    const older = await createPerson(auth, { full_name: "John Smith", dob: "1988-03-01", consent: {} });
    const younger = await createPerson(auth, { full_name: "John Smith", dob: "2001-11-22", consent: {} });
    // One dob known, one unknown is NOT a contradiction — that pair still shows.
    const known = await createPerson(auth, { full_name: "Mary Jones", dob: "1995-06-06", consent: {} });
    const unknown = await createPerson(auth, { full_name: "Mary Jones", consent: {} });

    const { items } = await listDuplicateCandidates(auth, {});
    expect(pairsOf(items)).toEqual([[known.id, unknown.id]]);
    expect(items.map((c) => c.a.id)).not.toContain(older.id);
    expect(items.map((c) => c.b.id)).not.toContain(younger.id);
  });

  it("raises the score when the two rows share an entrant, and says which one", async () => {
    const { auth } = await seedOrg("pro");
    const shareA = await createPerson(auth, { full_name: "Katherine Johnson", consent: {} });
    const shareB = await createPerson(auth, { full_name: "Katherine Johnson", consent: {} });
    const plainA = await createPerson(auth, { full_name: "Dorothy Vaughan", consent: {} });
    const plainB = await createPerson(auth, { full_name: "Dorothy Vaughan", consent: {} });
    const divisionId = await seedDivision(auth);
    await createEntrants(auth, divisionId, [
      {
        kind: "pair",
        display_name: "Computers",
        seed: 1,
        members: [
          { person_id: shareA.id, squad_number: 1, default_position_key: null, is_captain: true, roles: [] },
          { person_id: shareB.id, squad_number: 2, default_position_key: null, is_captain: false, roles: [] },
        ],
      },
    ]);

    const { items } = await listDuplicateCandidates(auth, {});
    expect(scoreOfPair(items, shareA.id, shareB.id)).toBeGreaterThan(
      scoreOfPair(items, plainA.id, plainB.id),
    );
    expect(pairsOf(items)[0]).toEqual([shareA.id, shareB.id]);
    const shared = items[0]!;
    expect(shared.evidence).toContainEqual({ kind: "shared_entrant", detail: "Computers" });
    const plain = items.find((c) => c.a.id === plainA.id)!;
    expect(plain.evidence.map((e) => e.kind)).not.toContain("shared_entrant");
  });

  it("never pairs an official with a player, and still pairs two officials", async () => {
    const { auth } = await seedOrg("pro");
    // Same human name across the two lanes is ordinary: an organiser who also
    // referees has a player row AND an official row, and merging them would
    // destroy the officiating identity V348 exists to keep separate.
    const player = await insertPerson(auth.orgId, "Sam Reeves", { lane: "player" });
    const official = await insertPerson(auth.orgId, "Sam Reeves", { lane: "official" });
    const refA = await insertPerson(auth.orgId, "Nina Whistle", { lane: "official" });
    const refB = await insertPerson(auth.orgId, "Nina Whistle", { lane: "official" });

    const { items } = await listDuplicateCandidates(auth, {});
    expect(pairsOf(items)).toEqual([[refA, refB]]);
    const flat = items.flatMap((c) => [c.a.id, c.b.id]);
    expect(flat).not.toContain(player);
    expect(flat).not.toContain(official);
  });

  it("excludes a tombstoned person on either side of the pair", async () => {
    const { auth } = await seedOrg("pro");
    // Three same-named rows, created oldest-first. The middle one is the
    // tombstone, so it would appear as `b` against the first and as `a`
    // against the third — a filter written on one side only still passes half.
    const first = await createPerson(auth, { full_name: "Ida Bell", consent: {} });
    const middle = await createPerson(auth, { full_name: "Ida Bell", consent: {} });
    const third = await createPerson(auth, { full_name: "Ida Bell", consent: {} });
    await sql`update persons set merged_into = ${first.id} where id = ${middle.id}`;

    const { items } = await listDuplicateCandidates(auth, {});
    expect(pairsOf(items)).toEqual([[first.id, third.id]]);
    expect(items.flatMap((c) => [c.a.id, c.b.id])).not.toContain(middle.id);
  });

  it("excludes a pair of rows claimed by two different accounts", async () => {
    const { auth } = await seedOrg("pro");
    const one = await makeUser("claimant-one");
    const two = await makeUser("claimant-two");
    const three = await makeUser("claimant-three");
    // Task 3 refuses this merge with a 422 — two accounts cannot become one
    // person — so offering it is a dead end the organiser cannot resolve.
    const claimedA = await insertPerson(auth.orgId, "Two Owners", { userId: one.id });
    const claimedB = await insertPerson(auth.orgId, "Two Owners", { userId: two.id });
    // Exactly ONE claim is the common, mergeable case: the imported row has no
    // account and absorbs into the claimed one.
    const claimed = await insertPerson(auth.orgId, "One Owner", { userId: three.id });
    const unclaimed = await insertPerson(auth.orgId, "One Owner", { userId: null });

    const { items } = await listDuplicateCandidates(auth, {});
    expect(pairsOf(items)).toEqual([[claimed, unclaimed]]);
    const flat = items.flatMap((c) => [c.a.id, c.b.id]);
    expect(flat).not.toContain(claimedA);
    expect(flat).not.toContain(claimedB);
  });

  it("carries name evidence on every candidate, normalised as the scheduler normalises it", async () => {
    const { auth } = await seedOrg("pro");
    // personKeyResolver folds case and collapses runs of whitespace; the queue
    // has to agree, or "same name" means two different things in one product.
    const padded = await insertPerson(auth.orgId, "  Ada   LOVELACE ");
    const plain = await insertPerson(auth.orgId, "ada lovelace");
    // Blank names normalise identically. Bucketing them would offer to fuse
    // every unnamed person in the org into one human.
    const blankA = await insertPerson(auth.orgId, "   ");
    const blankB = await insertPerson(auth.orgId, "");

    const { items } = await listDuplicateCandidates(auth, {});
    expect(pairsOf(items)).toEqual([[padded, plain]]);
    for (const candidate of items) {
      expect(candidate.evidence.length).toBeGreaterThan(0);
    }
    expect(items[0]!.evidence).toContainEqual({ kind: "name", detail: "ada lovelace" });
    const flat = items.flatMap((c) => [c.a.id, c.b.id]);
    expect(flat).not.toContain(blankA);
    expect(flat).not.toContain(blankB);
  });
});
