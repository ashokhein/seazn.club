// A finished competition does not grow (#376 branch, part D).
//
// `assertCompetitionNotFrozen` checks the over-quota freeze and says NOTHING
// about status, so a `completed` or `archived` competition still accepted new
// divisions. Not a quota leak — the per-competition cap still binds — but it
// made "completed" mean nothing, and it contradicted the very same competition
// being refused an Event Pass on the same seam.
//
// TERMINAL ONLY. `passLockReason` has two blocking-shaped arms and only one of
// them may block a WRITE: `past_ends_on` is routinely a stale end date on a
// competition still being played, which is why the pass chip points that
// organiser at the settings form rather than at next season. Blocking it would
// freeze a live competition over a typo. The pass line and the write line share
// a vocabulary, not a threshold — so the `past_ends_on` case below is the load-
// bearing one, and it is written to be genuinely long past grace (7 days) so a
// guard that merely tested `passLockReason(...) !== null` would red on it.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements, passLockReason } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateDivision } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { archiveDivision, createDivision, restoreDivision } from "@/server/usecases/divisions";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** Deliberately roomy. This suite tests the STATUS gate, never the quota
 *  boundary, and community's `divisions.per_competition.max` has already moved
 *  once (V270 set 2, V319 raised it to 4). Pinning by override means a future
 *  pricing change cannot turn one of these into a 402 that the assertions —
 *  which key on 409 / COMPETITION_ENDED — would misread. */
const DIVISION_QUOTA = 4;

async function seedCommunityCompetition(): Promise<{ auth: AuthCtx; competitionId: string }> {
  const { auth } = await seedOrg("community");
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${auth.orgId}, 'divisions.per_competition.max', ${DIVISION_QUOTA}, 'ended-competition probe')`;
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, {
    name: `Ended ${randomUUID().slice(0, 6)}`,
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

/** Plain `sql` (not withTenant) — the lifecycle transition has its own use case
 *  with its own guards; this suite only needs the row in that state. */
async function setCompetitionStatus(competitionId: string, status: string): Promise<void> {
  await sql`update competitions set status = ${status} where id = ${competitionId}`;
}

async function setCompetitionEndsOn(competitionId: string, endsOn: string): Promise<void> {
  await sql`update competitions set ends_on = ${endsOn} where id = ${competitionId}`;
}

/** Registration must be closed before archive (v3/09 §4) — an explicit
 *  disabled row, so the guard is genuinely satisfied rather than absent. */
async function closeRegistration(divisionId: string): Promise<void> {
  await sql`
    insert into registration_settings (division_id, enabled) values (${divisionId}, false)
    on conflict (division_id) do update set enabled = false, closes_at = null`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("a terminal competition accepts no new divisions", () => {
  it("refuses a create on a completed competition", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await setCompetitionStatus(competitionId, "completed");

    await expect(createDivision(auth, competitionId, divisionInput("A"))).rejects.toMatchObject({
      status: 409,
      code: "COMPETITION_ENDED",
    });
  });

  it("refuses a create on an archived competition", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await setCompetitionStatus(competitionId, "archived");

    await expect(createDivision(auth, competitionId, divisionInput("A"))).rejects.toMatchObject({
      status: 409,
      code: "COMPETITION_ENDED",
    });
  });

  // The arm that must NOT block, and the reason this task is not "reuse
  // isPassLocked". Asserted long past grace so a guard written against the
  // wrong threshold cannot pass this by accident.
  it("ALLOWS a create on a competition merely past its end date", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await setCompetitionEndsOn(competitionId, "2020-01-01");
    // Pin the premise: this row really is in the arm we are refusing to block.
    // Without this the test would still pass if `ends_on` silently failed to
    // write, and would then be asserting nothing at all.
    expect(passLockReason("draft", "2020-01-01")).toBe("past_ends_on");

    const d = await createDivision(auth, competitionId, divisionInput("A"));
    expect(d.id).toBeTruthy();
  });

  it("refuses a restore into a completed competition", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("A"));
    await closeRegistration(d.id);
    await archiveDivision(auth, d.id);
    await setCompetitionStatus(competitionId, "completed");

    await expect(restoreDivision(auth, d.id)).rejects.toMatchObject({
      status: 409,
      code: "COMPETITION_ENDED",
    });
  });
});
