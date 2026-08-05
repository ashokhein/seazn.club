// The read side of the V354 slot rule (#376 part D, task 8): the two questions
// the console has to answer out loud — "will archiving this cost me a slot?"
// and "how many of my slots are held by divisions I cannot see?".
//
// Both are answered by `division_has_results(...)`, the SAME SQL function the
// quota count in `createDivision` uses. This suite's job is to prove they
// cannot drift: the disclosure is only worth shipping if it predicts the
// charge, and a warning that says "this is free" while the quota bills for it
// is worse than the silence it replaces. So the last case does not assert on
// the helper at all — it asserts that a non-zero count is followed by a real
// 402 from `createDivision`, and that a zero count is followed by a create
// that succeeds.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateDivision } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { waiveDivisionSlot } from "@/server/usecases/admin-divisions";
import { archiveDivision, createDivision, restoreDivision } from "@/server/usecases/divisions";
import {
  archivedSlotHoldersInCompetition,
  archivedSlotsExplainRefusal,
  divisionConsumesSlotOnArchive,
} from "@/server/usecases/division-slots";
import { GENERIC_CONFIG, makeUser, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** Pinned by override, not read from the live matrix — the same reasoning as
 *  division-slot-consumption.test.ts: community's real cap has already moved
 *  twice (V270 → 2, V319 → 4) and a suite that inherits it stops testing the
 *  boundary the day pricing changes again. */
const DIVISION_QUOTA = 2;

async function seedCommunityCompetition(): Promise<{ auth: AuthCtx; competitionId: string }> {
  const { auth } = await seedOrg("community");
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${auth.orgId}, 'divisions.per_competition.max', ${DIVISION_QUOTA}, 'slot-disclosure probe')`;
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, {
    name: `Disclose ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  return { auth, competitionId: comp.id };
}

function divisionInput(name: string): CreateDivision {
  return {
    name,
    slug: `${name.toLowerCase()}-${randomUUID().slice(0, 6)}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  } as CreateDivision;
}

/** A decided fixture in its own stage, written directly — the fold is not
 *  under test here, the predicate is. */
async function recordDecidedFixture(divisionId: string): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from stages where division_id = ${divisionId}`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name)
    values (${divisionId}, ${n + 1}, 'league', ${`League ${n + 1}`})
    returning id`;
  await sql`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, status)
    values (${stageId}, ${divisionId}, 1, 1, 'decided')`;
}

/** Archive refuses while registration is open (v3/09 §4) — an explicit
 *  disabled row so the guard is satisfied rather than merely absent. */
async function closeRegistration(divisionId: string): Promise<void> {
  await sql`
    insert into registration_settings (division_id, enabled) values (${divisionId}, false)
    on conflict (division_id) do update set enabled = false, closes_at = null`;
}

/** Move the pinned cap after seeding — the only way to reach a competition
 *  that holds MORE slots than its cap allows, and a state real orgs land in by
 *  downgrading a plan (or by a paid pass expiring). Every division below is
 *  still created through `createDivision`, so nothing here fabricates a state
 *  the product cannot produce. */
async function setDivisionQuota(auth: AuthCtx, cap: number): Promise<void> {
  await sql`
    update org_entitlement_overrides set int_value = ${cap}
    where org_id = ${auth.orgId} and feature_key = 'divisions.per_competition.max'`;
  await invalidateOrgEntitlements(auth.orgId);
}

async function makeStaffUser(): Promise<{ id: string }> {
  const user = await makeUser("staff");
  await sql`update users set is_staff = true, staff_role = 'support' where id = ${user.id}`;
  return user;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("divisionConsumesSlotOnArchive", () => {
  it("is false for a division with nothing played", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("Quiet"));

    expect(await divisionConsumesSlotOnArchive(auth, d.id)).toBe(false);
  });

  it("is true once a result is recorded", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("Played"));
    await recordDecidedFixture(d.id);

    expect(await divisionConsumesSlotOnArchive(auth, d.id)).toBe(true);
  });

  // The waiver is part of the ANSWER, not a separate concern: the question is
  // "will archiving cost me a slot", and after support has handed the slot
  // back the honest answer is no even though the fixtures are still there.
  it("is false again once staff waive the slot", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const staff = await makeStaffUser();
    const d = await createDivision(auth, competitionId, divisionInput("Waived"));
    await recordDecidedFixture(d.id);
    await waiveDivisionSlot(staff.id, d.id);

    expect(await divisionConsumesSlotOnArchive(auth, d.id)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("archivedSlotHoldersInCompetition", () => {
  it("is zero for a competition whose divisions are all visible", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("Live"));
    await recordDecidedFixture(d.id);

    expect(await archivedSlotHoldersInCompetition(auth, competitionId)).toBe(0);
  });

  it("counts an archived division that was played", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("Retired"));
    await recordDecidedFixture(d.id);
    await closeRegistration(d.id);
    await archiveDivision(auth, d.id);

    expect(await archivedSlotHoldersInCompetition(auth, competitionId)).toBe(1);
  });

  // The mistake case the slot rule keeps free — and therefore the case the
  // paywall must NOT blame on archiving.
  it("does not count an archived division that was never played", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("Mistake"));
    await closeRegistration(d.id);
    await archiveDivision(auth, d.id);

    expect(await archivedSlotHoldersInCompetition(auth, competitionId)).toBe(0);
  });

  it("does not count an archived division whose slot staff waived", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const staff = await makeStaffUser();
    const d = await createDivision(auth, competitionId, divisionInput("Forgiven"));
    await recordDecidedFixture(d.id);
    await closeRegistration(d.id);
    await archiveDivision(auth, d.id);
    await waiveDivisionSlot(staff.id, d.id);

    expect(await archivedSlotHoldersInCompetition(auth, competitionId)).toBe(0);
  });

  // The parity assertion. Two competitions at the same visible division count
  // and the same pinned quota; the only difference is whether the archived
  // division was played. The helper's answer must predict the server's.
  it("predicts the 402: a non-zero count refuses, a zero count creates", async () => {
    const played = await seedCommunityCompetition();
    const unplayed = await seedCommunityCompetition();

    for (const [rig, play] of [
      [played, true],
      [unplayed, false],
    ] as const) {
      await createDivision(rig.auth, rig.competitionId, divisionInput("Keep"));
      const gone = await createDivision(rig.auth, rig.competitionId, divisionInput("Gone"));
      if (play) await recordDecidedFixture(gone.id);
      await closeRegistration(gone.id);
      await archiveDivision(rig.auth, gone.id);
    }

    expect(await archivedSlotHoldersInCompetition(played.auth, played.competitionId)).toBe(1);
    await expect(
      createDivision(played.auth, played.competitionId, divisionInput("Next")),
    ).rejects.toMatchObject({ status: 402, featureKey: "divisions.per_competition.max" });

    expect(await archivedSlotHoldersInCompetition(unplayed.auth, unplayed.competitionId)).toBe(0);
    const next = await createDivision(
      unplayed.auth,
      unplayed.competitionId,
      divisionInput("Next"),
    );
    expect(next.id).toBeTruthy();
  });
});

// The count alone is not the explanation (#376 part C review). "There are
// archived divisions holding slots" and "the archived divisions are why you
// were refused" are different claims, and the console showed the first while
// asserting the second. Every case below pairs the predicate with what
// `createDivision` actually does in the same state, so the sentence can never
// blame a cause the charge does not have.
describe.skipIf(!HAS_DB)("archivedSlotsExplainRefusal", () => {
  it("is true when releasing the archived slot would let the create through", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await createDivision(auth, competitionId, divisionInput("Live"));
    const gone = await createDivision(auth, competitionId, divisionInput("Gone"));
    await recordDecidedFixture(gone.id);
    await closeRegistration(gone.id);
    await archiveDivision(auth, gone.id);

    // One visible division against a cap of two: without the archived holder
    // this create fits, so the archived holder IS the marginal cause.
    expect(await archivedSlotsExplainRefusal(auth, competitionId)).toBe(true);
    await expect(
      createDivision(auth, competitionId, divisionInput("Next")),
    ).rejects.toMatchObject({ status: 402, featureKey: "divisions.per_competition.max" });
  });

  // The arm the console had no answer for. The refusal is real, and archiving
  // has nothing to do with it: the visible divisions alone fill the cap, so
  // handing every archived slot back would change nothing.
  it("is false when the visible divisions alone fill the limit", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await setDivisionQuota(auth, 3);
    const gone = await createDivision(auth, competitionId, divisionInput("Gone"));
    await recordDecidedFixture(gone.id);
    await closeRegistration(gone.id);
    await archiveDivision(auth, gone.id);
    await createDivision(auth, competitionId, divisionInput("Live 1"));
    await createDivision(auth, competitionId, divisionInput("Live 2"));
    await setDivisionQuota(auth, DIVISION_QUOTA);

    // Two visible divisions against a cap of two, plus one archived holder.
    expect(await archivedSlotHoldersInCompetition(auth, competitionId)).toBe(1);
    expect(await archivedSlotsExplainRefusal(auth, competitionId)).toBe(false);
    await expect(
      createDivision(auth, competitionId, divisionInput("Next")),
    ).rejects.toMatchObject({ status: 402, featureKey: "divisions.per_competition.max" });
  });

  // Refused, with nothing archived at all — the ordinary "you are at your
  // limit". The reader must not be sent looking for divisions that do not
  // exist.
  it("is false when the competition has archived nothing", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await createDivision(auth, competitionId, divisionInput("Live 1"));
    await createDivision(auth, competitionId, divisionInput("Live 2"));

    expect(await archivedSlotsExplainRefusal(auth, competitionId)).toBe(false);
    await expect(
      createDivision(auth, competitionId, divisionInput("Next")),
    ).rejects.toMatchObject({ status: 402, featureKey: "divisions.per_competition.max" });
  });

  // After a waiver there is no refusal to explain at all — the create goes
  // through — so the predicate must not still be pointing at the archive.
  it("is false once staff waive the archived slot, and the create succeeds", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const staff = await makeStaffUser();
    await createDivision(auth, competitionId, divisionInput("Live"));
    const gone = await createDivision(auth, competitionId, divisionInput("Forgiven"));
    await recordDecidedFixture(gone.id);
    await closeRegistration(gone.id);
    await archiveDivision(auth, gone.id);
    await waiveDivisionSlot(staff.id, gone.id);

    expect(await archivedSlotsExplainRefusal(auth, competitionId)).toBe(false);
    const next = await createDivision(auth, competitionId, divisionInput("Next"));
    expect(next.id).toBeTruthy();
  });

  // Every case above pairs the predicate with `createDivision`. The predicate
  // is applied to the RESTORE path too, and restore does not count the same
  // way: its quota query carries `and d.id <> ${id}` so the row being
  // un-archived is not charged as both an existing holder and the `+ 1`. That
  // clause is not decoration — it was missing once on this branch and refused
  // restores that fitted. The two cases below drive the real `restoreDivision`,
  // so the sentence the paywall prints is checked against the refusal that
  // surface actually produces rather than against its sibling's.
  it("is true on the restore path when the OTHER archived slots are the cause", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await setDivisionQuota(auth, 3);
    await createDivision(auth, competitionId, divisionInput("Live"));
    const first = await createDivision(auth, competitionId, divisionInput("Gone 1"));
    await recordDecidedFixture(first.id);
    await closeRegistration(first.id);
    await archiveDivision(auth, first.id);
    const second = await createDivision(auth, competitionId, divisionInput("Gone 2"));
    await recordDecidedFixture(second.id);
    await closeRegistration(second.id);
    await archiveDivision(auth, second.id);
    await setDivisionQuota(auth, DIVISION_QUOTA);

    // One visible division and two archived holders against a cap of two.
    // Restoring `first` is refused only because `second` is still holding a
    // slot, so the archived divisions ARE the marginal cause and the paywall
    // may say so.
    expect(await archivedSlotHoldersInCompetition(auth, competitionId)).toBe(2);
    expect(await archivedSlotsExplainRefusal(auth, competitionId)).toBe(true);
    await expect(restoreDivision(auth, first.id)).rejects.toMatchObject({
      status: 402,
      featureKey: "divisions.per_competition.max",
    });
  });

  // The restore-path twin of "the visible divisions alone fill the limit", and
  // the arm where a self-counting restore would be at its most convincing: the
  // one archived holder in the competition is the very row being restored, so
  // it is the obvious thing to blame — and it is not the cause. Two visible
  // divisions already fill a cap of two; handing that archived slot back would
  // change nothing about this refusal.
  it("is false on the restore path when the visible divisions alone fill the limit", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await setDivisionQuota(auth, 3);
    const gone = await createDivision(auth, competitionId, divisionInput("Gone"));
    await recordDecidedFixture(gone.id);
    await closeRegistration(gone.id);
    await archiveDivision(auth, gone.id);
    await createDivision(auth, competitionId, divisionInput("Live 1"));
    await createDivision(auth, competitionId, divisionInput("Live 2"));
    await setDivisionQuota(auth, DIVISION_QUOTA);

    expect(await archivedSlotHoldersInCompetition(auth, competitionId)).toBe(1);
    expect(await archivedSlotsExplainRefusal(auth, competitionId)).toBe(false);
    await expect(restoreDivision(auth, gone.id)).rejects.toMatchObject({
      status: 402,
      featureKey: "divisions.per_competition.max",
    });
  });

  // The self-counting guard itself, and the only shape that can be one: both
  // cases above assert a REFUSAL, and counting the restored row twice can only
  // make the count larger, so neither of them can fail when `and d.id <> ${id}`
  // is dropped — the mutation was measured, and both stayed green. A restore
  // that must SUCCEED is the arm that moves: one visible division and one
  // archived holder against a cap of two, where the holder is the row being
  // restored. It fits exactly, and charging it as both an existing holder and
  // the `+ 1` turns it into a 402 the org can do nothing about.
  it("allows a restore that fits, without charging the restored row twice", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await createDivision(auth, competitionId, divisionInput("Live"));
    const gone = await createDivision(auth, competitionId, divisionInput("Gone"));
    await recordDecidedFixture(gone.id);
    await closeRegistration(gone.id);
    await archiveDivision(auth, gone.id);

    const back = await restoreDivision(auth, gone.id);
    expect(back.archived_at).toBeNull();
  });
});
