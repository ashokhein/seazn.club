// #382 — division scheduling is open to every plan; multi-division stays paid.
//
// `hasFeature` returns `row?.bool_value === true` (entitlements.ts), so a
// MISSING row is false. Event Pass carried no row at all for board, constraints
// or multi_division, which is why V353 INSERTS for it rather than flipping.
//
// Both resolution paths are exercised, because they are genuinely different
// reads and a matrix row can serve one and not the other:
//   - the org's own plan (`subscriptions.plan_key`), and
//   - a competition pass overlaid on a community org (`competition_passes`),
//     which is how an Event Pass is actually held in production.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/` — CI's Postgres job selects
// `src/server src/lib` and `src/app`; from elsewhere the whole
// `describe.skipIf(!HAS_DB)` body would run in no job at all and report green.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;

/** Every plan key the matrix carries. */
const PLANS = ["community", "pro", "pro_plus", "event_pass", "event_pass_l"] as const;

async function seedOrg(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Sched " + suffix}, ${"sched-" + suffix})
    returning id`;
  return org!.id;
}

/** An org whose own subscription sits on `plan`. */
async function seedOrgOnPlan(plan: string): Promise<string> {
  const orgId = await seedOrg();
  if (plan !== "community") await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
  return orgId;
}

/** A COMMUNITY org holding `passKey` on one competition — the production shape
 *  of an Event Pass. Returns the competition the pass lifts. */
async function seedOrgWithPass(passKey: string): Promise<{ orgId: string; competitionId: string }> {
  const orgId = await seedOrg();
  const [comp] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug)
    values (${orgId}, 'Passed Cup', ${"passed-" + randomUUID().slice(0, 8)})
    returning id`;
  await sql`
    insert into competition_passes (competition_id, org_id, pass_key)
    values (${comp!.id}, ${orgId}, ${passKey})`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, competitionId: comp!.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("scheduling entitlements after V353 (#382)", () => {
  it("opens board and constraints to every plan (#382)", async () => {
    for (const plan of PLANS) {
      const orgId = await seedOrgOnPlan(plan);
      expect(await hasFeature(orgId, "scheduling.board"), `${plan} board`).toBe(true);
      expect(await hasFeature(orgId, "scheduling.constraints"), `${plan} constraints`).toBe(true);
    }
  });

  it("opens board and constraints on a competition an Event Pass lifts", async () => {
    // The pass path is a different read: `resolve` joins `competition_passes`
    // and overlays the PASS row on the plan row. A community org that bought a
    // pass must reach the board on that competition too — and, since V353 opens
    // the base plan, everywhere else as well.
    for (const passKey of ["event_pass", "event_pass_l"]) {
      const { orgId, competitionId } = await seedOrgWithPass(passKey);
      expect(await hasFeature(orgId, "scheduling.board", competitionId), passKey).toBe(true);
      expect(await hasFeature(orgId, "scheduling.constraints", competitionId), passKey).toBe(true);
    }
  });

  it("keeps multi-division as the only scheduling paywall", async () => {
    expect(await hasFeature(await seedOrgOnPlan("community"), "scheduling.multi_division")).toBe(
      false,
    );
    for (const plan of ["pro", "pro_plus", "event_pass", "event_pass_l"]) {
      expect(
        await hasFeature(await seedOrgOnPlan(plan), "scheduling.multi_division"),
        plan,
      ).toBe(true);
    }
  });

  it("an Event Pass lifts multi-division on the competition it covers", async () => {
    for (const passKey of ["event_pass", "event_pass_l"]) {
      const { orgId, competitionId } = await seedOrgWithPass(passKey);
      expect(
        await hasFeature(orgId, "scheduling.multi_division", competitionId),
        passKey,
      ).toBe(true);
      // …and NOT org-wide: the community base still denies it off the pass.
      expect(await hasFeature(orgId, "scheduling.multi_division"), `${passKey} org-wide`).toBe(
        false,
      );
    }
  });

  it("every plan carries an explicit row, so no grant rests on a missing row", async () => {
    // A missing row reads as false. The matrix must state board/constraints for
    // every plan key rather than leaning on a default that does not exist.
    const rows = await sql<{ plan_key: string; feature_key: string; bool_value: boolean }[]>`
      select plan_key, feature_key, bool_value from plan_entitlements
       where feature_key in ('scheduling.board', 'scheduling.constraints')`;
    for (const plan of PLANS) {
      for (const key of ["scheduling.board", "scheduling.constraints"]) {
        const row = rows.find((r) => r.plan_key === plan && r.feature_key === key);
        expect(row, `${plan} ${key} row`).toBeDefined();
        expect(row!.bool_value, `${plan} ${key} value`).toBe(true);
      }
    }
  });
});
