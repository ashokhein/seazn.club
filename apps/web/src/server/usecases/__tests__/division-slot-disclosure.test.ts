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
import { archiveDivision, createDivision } from "@/server/usecases/divisions";
import {
  archivedSlotHoldersInCompetition,
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
