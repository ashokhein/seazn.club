// The staff escape hatch for V354's slot rule.
//
// A division's quota slot is spent by RECORDED RESULTS and the rule has NO
// timer, by design: any window long enough to close the archive-and-recreate
// loop is short enough to punish an honest mistake. So an org that burns a slot
// by genuine accident — one stray recorded result on a division it then
// archives — gets a SUPPORT PATH rather than a loophole. Staff-only, and
// audited, because it moves an entitlement boundary for a paying customer.
//
// The staff assertion lives in the USE CASE, not only at the route: this is the
// one admin action whose refusal is part of the contract under test, and a
// route-only guard can only be exercised through a Next request. Non-staff is
// 403 (the caller IS authenticated and is being refused), not `requireStaff`'s
// 401.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateDivision } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { archiveDivision, createDivision } from "@/server/usecases/divisions";
import { waiveDivisionSlot } from "@/server/usecases/admin-divisions";
import { adjustmentsForOrg } from "@/server/usecases/admin-adjustments-log";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** The quota this suite's arithmetic is written against — PINNED by override,
 *  not inherited. The plan matrix has already moved once (V270 gave community
 *  2 per competition, V319 raised it to 4); a suite that reads the live matrix
 *  silently stops testing the boundary the day pricing changes. Same pin as
 *  `division-slot-consumption.test.ts`. */
const DIVISION_QUOTA = 2;

/** A community org pinned to DIVISION_QUOTA per competition, with one comp. */
async function seedCommunityCompetition(): Promise<{ auth: AuthCtx; competitionId: string }> {
  const { auth } = await seedOrg("community");
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${auth.orgId}, 'divisions.per_competition.max', ${DIVISION_QUOTA}, 'slot-waiver probe')`;
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Waiver ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  return { auth, competitionId: comp.id };
}

/** `_seed.makeUser` mints an ordinary user; the waiver needs `is_staff`. */
async function makeStaffUser(): Promise<{ id: string }> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, is_staff, staff_role)
    values (${`staff-${randomUUID().slice(0, 8)}@test.local`}, 'Staff', true, true, 'support')
    returning id`;
  return { id };
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

/** One decided fixture in its own stage. Plain `sql` so the status is set
 *  directly rather than folded. */
async function recordDecidedFixture(divisionId: string): Promise<void> {
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name)
    values (${divisionId}, 1, 'league', 'League 1')
    returning id`;
  await sql`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, status)
    values (${stageId}, ${divisionId}, 1, 1, 'decided')`;
}

/** Registration must be closed before archive (v3/09 §4). */
async function closeRegistration(divisionId: string): Promise<void> {
  await sql`
    insert into registration_settings (division_id, enabled) values (${divisionId}, false)
    on conflict (division_id) do update set enabled = false, closes_at = null`;
}

async function waiverColumns(divisionId: string): Promise<{
  slot_waived_at: Date | null;
  slot_waived_by: string | null;
}> {
  const [row] = await sql<{ slot_waived_at: Date | null; slot_waived_by: string | null }[]>`
    select slot_waived_at, slot_waived_by from divisions where id = ${divisionId}`;
  return row!;
}

async function waiverAuditRows(divisionId: string): Promise<
  { actor_id: string; target_type: string; target_id: string; division_id: string | null }[]
> {
  return sql<
    { actor_id: string; target_type: string; target_id: string; division_id: string | null }[]
  >`
    select actor_id, target_type, target_id, detail->>'division_id' as division_id
    from staff_audit_log
    where action = 'division_slot_waived' and detail->>'division_id' = ${divisionId}`;
}

/** A division that is genuinely holding a slot: one recorded result, then
 *  archived. Exactly the population `slotConsumingDivisions` offers the button
 *  on, and the only state the waiver is allowed to act on. */
async function consumingDivision(
  auth: AuthCtx,
  competitionId: string,
  name: string,
): Promise<{ id: string }> {
  const d = await createDivision(auth, competitionId, divisionInput(name));
  await recordDecidedFixture(d.id);
  await closeRegistration(d.id);
  await archiveDivision(auth, d.id);
  return d;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("staff slot waiver (V354)", () => {
  it("frees a consumed slot and records who did it", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const staff = await makeStaffUser();
    await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await recordDecidedFixture(b.id);
    await closeRegistration(b.id);
    await archiveDivision(auth, b.id);

    // Pre-state: the slot is genuinely spent, so the success below is not
    // vacuous — without this the "C succeeds" assertion could pass on an org
    // that never hit the ceiling at all.
    await expect(createDivision(auth, competitionId, divisionInput("X"))).rejects.toMatchObject({
      status: 402,
      featureKey: "divisions.per_competition.max",
    });

    await waiveDivisionSlot(staff.id, b.id);

    const row = await waiverColumns(b.id);
    expect(row.slot_waived_at).not.toBeNull();
    expect(row.slot_waived_by).toBe(staff.id);

    // Audited, through the same `logStaffAction` sink every other staff action
    // uses. Target is the ORG — the waiver moves the org's entitlement
    // boundary — with the division carried in `detail`.
    const audit = await waiverAuditRows(b.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_id).toBe(staff.id);
    expect(audit[0]!.target_type).toBe("org");
    expect(audit[0]!.target_id).toBe(auth.orgId);

    const c = await createDivision(auth, competitionId, divisionInput("C"));
    expect(c.id).toBeTruthy();
  });

  it("refuses a non-staff caller and writes nothing", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("A"));

    await expect(waiveDivisionSlot(auth.userId!, d.id)).rejects.toMatchObject({ status: 403 });

    const row = await waiverColumns(d.id);
    expect(row.slot_waived_at).toBeNull();
    expect(row.slot_waived_by).toBeNull();
    expect(await waiverAuditRows(d.id)).toHaveLength(0);
  });

  it("404s on an unknown division, before writing anything", async () => {
    const staff = await makeStaffUser();
    const ghost = randomUUID();
    await expect(waiveDivisionSlot(staff.id, ghost)).rejects.toMatchObject({ status: 404 });
    expect(await waiverAuditRows(ghost)).toHaveLength(0);
  });

  // Auditing an entitlement move is only worth doing if a human can FIND the
  // row afterwards. `/admin/orgs/[id]`'s adjustments panel is an ALLOWLIST
  // (`ADJUSTMENT_ACTIONS`), so a row written with an unlisted action is
  // invisible there. Driven through the real writer rather than a seeded
  // staff_audit_log row: that also pins the target_type/target_id shape the
  // log's own scope filter depends on.
  it("surfaces the waiver in the org's adjustments log", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const staff = await makeStaffUser();
    const b = await consumingDivision(auth, competitionId, "B");

    await waiveDivisionSlot(staff.id, b.id);

    const entries = await adjustmentsForOrg(auth.orgId);
    const entry = entries.find((e) => e.action === "division_slot_waived");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ actorId: staff.id, category: "cap", reversible: false });
    expect(entry!.detail.division_id).toBe(b.id);
    // The panel renders `reason` as its subject column and nothing else from
    // `detail`, so a waiver whose reason is null shows an em dash — findable
    // but not identifiable, which answers "did staff move this org's cap"
    // while leaving "which division" unanswerable from the UI.
    expect(entry!.reason).toBe("B");
  });

  // No timer, no undo, and the button is offered only where a slot is really
  // held — so a waiver on anything else is a staff member acting on stale
  // information. Succeeding writes both columns and an audit row that records
  // nothing real, which is worse than a refusal.
  it("409s when the division is not consuming a slot, and writes nothing", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const staff = await makeStaffUser();

    // Live, with a recorded result: the results half of the predicate holds,
    // the archived half does not.
    const live = await createDivision(auth, competitionId, divisionInput("Live"));
    await recordDecidedFixture(live.id);

    // Archived, never played: the mirror image — archived but uncharged.
    const unplayed = await createDivision(auth, competitionId, divisionInput("Unplayed"));
    await closeRegistration(unplayed.id);
    await archiveDivision(auth, unplayed.id);

    for (const id of [live.id, unplayed.id]) {
      await expect(waiveDivisionSlot(staff.id, id)).rejects.toMatchObject({
        status: 409,
        code: "DIVISION_SLOT_NOT_CONSUMED",
      });
      const row = await waiverColumns(id);
      expect(row.slot_waived_at).toBeNull();
      expect(row.slot_waived_by).toBeNull();
      expect(await waiverAuditRows(id)).toHaveLength(0);
    }
  });

  // A second waiver is NOT idempotent success: the slot is already back, so
  // the caller is looking at a stale page and should be told. Falls out of the
  // same predicate (`slot_waived_at is null`), and must not restamp the first
  // waiver's actor or write a second audit row.
  it("409s a second waiver instead of restamping it", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const first = await makeStaffUser();
    const second = await makeStaffUser();
    const b = await consumingDivision(auth, competitionId, "B");

    await waiveDivisionSlot(first.id, b.id);
    const after = await waiverColumns(b.id);

    await expect(waiveDivisionSlot(second.id, b.id)).rejects.toMatchObject({
      status: 409,
      code: "DIVISION_SLOT_NOT_CONSUMED",
    });

    const still = await waiverColumns(b.id);
    expect(still.slot_waived_by).toBe(first.id);
    expect(still.slot_waived_at).toEqual(after.slot_waived_at);
    expect(await waiverAuditRows(b.id)).toHaveLength(1);
  });
});
