// V355 — an ABANDONED fixture that still produced a verdict is a result.
//
// `fixtureStatusFromFold` (server/engine-db/append-event.ts) short-circuits on
// `core.abandon` BEFORE it looks at the outcome, so a DLS-awarded cricket match
// or a leader-awarded football match writes a real `fixtures.outcome` under
// status `abandoned`. V354's `division_has_results` matched only
// ('decided','finalized','forfeited'), so archiving such a division refunded
// the quota slot — the exact evasion V354 exists to close.
//
// `outcome is not null` alone is the WRONG widening: a cricket abandon folds to
// a `no_result` OUTCOME, so keying on non-null would start charging a slot for a
// rained-off match with no verdict. Only `kind <> 'no_result'` is a verdict.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateDivision } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { archiveDivision, createDivision } from "@/server/usecases/divisions";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** Pinned by override, not inherited: community's live
 *  `divisions.per_competition.max` moved 2 → 4 (V270 → V319), so a suite that
 *  reads the live matrix stops testing the boundary the day pricing changes. */
const DIVISION_QUOTA = 2;

async function seedCommunityCompetition(): Promise<{ auth: AuthCtx; competitionId: string }> {
  const { auth } = await seedOrg("community");
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${auth.orgId}, 'divisions.per_competition.max', ${DIVISION_QUOTA}, 'abandoned-outcome probe')`;
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, {
    name: `Aband ${randomUUID().slice(0, 6)}`,
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

/** One fixture in its own stage at the given status/outcome. Plain `sql` (not
 *  withTenant) so the pair is written directly rather than folded — the point
 *  is precisely the (abandoned, non-null outcome) pair the fold produces. */
async function recordFixture(
  divisionId: string,
  status: string,
  outcome: unknown = null,
): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from stages where division_id = ${divisionId}`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name)
    values (${divisionId}, ${n + 1}, 'league', ${`League ${n + 1}`})
    returning id`;
  await sql`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, status, outcome)
    values (${stageId}, ${divisionId}, 1, 1, ${status},
            ${outcome === null ? null : sql.json(outcome as never)})`;
}

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

/** Seeds a comp at the pinned ceiling, plays `b` as described, archives it, and
 *  reports whether the freed-up slot let a third division be created. */
async function slotFreedAfterArchive(status: string, outcome: unknown): Promise<boolean> {
  const { auth, competitionId } = await seedCommunityCompetition();
  await createDivision(auth, competitionId, divisionInput("A"));
  const b = await createDivision(auth, competitionId, divisionInput("B"));
  await recordFixture(b.id, status, outcome);
  await closeRegistration(b.id);
  await archiveDivision(auth, b.id);
  try {
    await createDivision(auth, competitionId, divisionInput("C"));
    return true;
  } catch (error) {
    expect(error).toMatchObject({ status: 402, featureKey: "divisions.per_competition.max" });
    return false;
  }
}

const WIN = { kind: "win", winner: randomUUID(), loser: randomUUID(), method: "dls" };
const AWARD = { kind: "award", winner: randomUUID() };

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("abandoned-with-a-verdict spends the quota slot (V355)", () => {
  it("charges the slot for an abandoned fixture that awarded a win (DLS)", async () => {
    expect(await slotFreedAfterArchive("abandoned", WIN)).toBe(false);
  });

  it("leaves the slot free for an abandoned fixture with a no_result outcome", async () => {
    expect(await slotFreedAfterArchive("abandoned", { kind: "no_result" })).toBe(true);
  });

  it("leaves the slot free for an abandoned fixture with no outcome at all", async () => {
    expect(await slotFreedAfterArchive("abandoned", null)).toBe(true);
  });

  it("still charges the slot for a plainly decided fixture", async () => {
    expect(await slotFreedAfterArchive("decided", WIN)).toBe(false);
  });
});

/** One division, reused across cases: the stages cascade takes the fixtures
 *  with them, so each case starts from an empty ledger without spending a
 *  quota slot per row. */
async function clearFixtures(divisionId: string): Promise<void> {
  await sql`delete from stages where division_id = ${divisionId}`;
}

describe.skipIf(!HAS_DB)("division_has_results over every (status, outcome) pair", () => {
  it("is true for each non-no_result verdict, false for no_result and null", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("P"));
    const cases: [string, unknown, boolean][] = [
      // The V355 arm: abandon short-circuits the fold, so every verdict kind
      // except no_result can legitimately land under `abandoned`.
      ["abandoned", WIN, true],
      ["abandoned", AWARD, true],
      ["abandoned", { kind: "draw" }, true],
      ["abandoned", { kind: "tie" }, true],
      ["abandoned", { kind: "no_result" }, false],
      ["abandoned", null, false],
      // V354's arms, unchanged.
      ["decided", WIN, true],
      ["finalized", WIN, true],
      ["forfeited", AWARD, true],
      ["scheduled", null, false],
      ["in_play", null, false],
      ["cancelled", null, false],
    ];
    for (const [status, outcome, expected] of cases) {
      await clearFixtures(d.id);
      await recordFixture(d.id, status, outcome);
      const label = `${status}/${(outcome as { kind?: string } | null)?.kind ?? "null"}`;
      expect([label, await divisionHasResults(d.id)]).toEqual([label, expected]);
    }
  });
});
