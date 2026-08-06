// A division's quota slot is spent by RECORDED RESULTS, not by existence
// (V354). `divisions.per_competition.max` used to count only
// `archived_at is null`, so create → play → archive → create was unlimited
// divisions inside one competition however small the plan's ceiling — archive
// was a delete that skipped delete's own DIVISION_HAS_RESULTS guard AND
// refunded the slot.
//
// The slot rule is deliberately NARROWER than delete's: delete refuses
// anything that has left `setup` because it destroys data; the slot charges
// only for a real result, so archiving a division published with the wrong
// sport stays free.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateDivision } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { waiveDivisionSlot } from "@/server/usecases/admin-divisions";
import { archiveDivision, createDivision, restoreDivision } from "@/server/usecases/divisions";
import { GENERIC_CONFIG, makeUser, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** The quota this suite's arithmetic is written against. The plan matrix has
 *  already moved once (V270 gave community 2 per competition, V319 raised it
 *  to 4), so the number is PINNED by override rather than inherited — a suite
 *  that reads the live matrix silently stops testing the boundary the day
 *  pricing changes, which is exactly how this task's brief came to quote 2. */
const DIVISION_QUOTA = 2;

/** A community org pinned to DIVISION_QUOTA per competition, with one comp. */
async function seedCommunityCompetition(): Promise<{ auth: AuthCtx; competitionId: string }> {
  const { auth } = await seedOrg("community");
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${auth.orgId}, 'divisions.per_competition.max', ${DIVISION_QUOTA}, 'slot-consumption probe')`;
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Slot ${randomUUID().slice(0, 6)}`,
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

/** One fixture in its own stage, written at the given status. Plain `sql`
 *  (not withTenant) so the status is set directly rather than folded. */
async function recordFixtureWithStatus(divisionId: string, status: string): Promise<string> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from stages where division_id = ${divisionId}`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name)
    values (${divisionId}, ${n + 1}, 'league', ${`League ${n + 1}`})
    returning id`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, status)
    values (${stageId}, ${divisionId}, 1, 1, ${status})
    returning id`;
  return id;
}

const recordDecidedFixture = (divisionId: string) => recordFixtureWithStatus(divisionId, "decided");

async function setDivisionStatus(divisionId: string, status: string): Promise<void> {
  await sql`update divisions set status = ${status} where id = ${divisionId}`;
}

/** Registration must be closed before archive (v3/09 §4) — an explicit
 *  disabled row, so the guard is genuinely satisfied rather than absent. */
async function closeRegistration(divisionId: string): Promise<void> {
  await sql`
    insert into registration_settings (division_id, enabled) values (${divisionId}, false)
    on conflict (division_id) do update set enabled = false, closes_at = null`;
}

async function divisionHasResults(divisionId: string): Promise<boolean> {
  const [{ v }] = await sql<{ v: boolean }[]>`
    select division_has_results(${divisionId}) as v`;
  return v;
}

/** `makeUser` mints an ordinary user; the real waiver refuses a non-staff
 *  actor, so the read side below is exercised through a genuine staff caller. */
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

describe.skipIf(!HAS_DB)("a division's quota slot (V354)", () => {
  // The evasion, exactly, at the pinned ceiling of 2.
  it("does not refund the slot when a division with results is archived", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const a = await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await recordDecidedFixture(b.id);
    await closeRegistration(b.id);
    await archiveDivision(auth, b.id);

    await expect(createDivision(auth, competitionId, divisionInput("C"))).rejects.toMatchObject({
      status: 402,
      featureKey: "divisions.per_competition.max",
    });
    expect(a.id).toBeTruthy();
  });

  // The mistake case the rule must keep free.
  it("still refunds the slot when an UNPLAYED division is archived", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await closeRegistration(b.id);
    await archiveDivision(auth, b.id);

    const c = await createDivision(auth, competitionId, divisionInput("C"));
    expect(c.id).toBeTruthy();
  });

  // Narrower than delete's predicate, on purpose: publishing is not usage.
  it("does not spend the slot for a published division with no results", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await setDivisionStatus(b.id, "scheduled");
    await closeRegistration(b.id);
    await archiveDivision(auth, b.id);

    const c = await createDivision(auth, competitionId, divisionInput("C"));
    expect(c.id).toBeTruthy();
  });

  it("counts only decided, finalized and forfeited fixtures as results", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("A"));
    await recordFixtureWithStatus(d.id, "scheduled");
    expect(await divisionHasResults(d.id)).toBe(false);
    await recordFixtureWithStatus(d.id, "forfeited");
    expect(await divisionHasResults(d.id)).toBe(true);
  });

  // The slot a resulted archived division holds is ITS OWN — restoring it must
  // not be charged for it twice. Reds if restoreDivision's count forgets to
  // exclude the row it is about to un-archive.
  it("restores a resulted archived division that still fits the quota", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await recordDecidedFixture(b.id);
    await closeRegistration(b.id);
    await archiveDivision(auth, b.id);

    const restored = await restoreDivision(auth, b.id);
    expect(restored.archived_at).toBeNull();
  });

  it("frees the slot again once staff waive it", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const staff = await makeStaffUser();
    await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await recordDecidedFixture(b.id);
    await closeRegistration(b.id);
    await archiveDivision(auth, b.id);
    await waiveDivisionSlot(staff.id, b.id);

    const c = await createDivision(auth, competitionId, divisionInput("C"));
    expect(c.id).toBeTruthy();
  });
});
