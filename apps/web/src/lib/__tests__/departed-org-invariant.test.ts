// THE invariant, in one place: no mutating entry point may leave a DEPARTED
// org's subscription row looking LIVE.
//
// A cancelled subscription keeps its stripe_subscription_id for ever, so
// liveness is decided by the STATUS column alone on such a row. Any write that
// puts trialing/active/past_due there resurrects the org into a billing
// relationship it no longer has, and it is then locked out on every side:
// assertCheckoutAllowed 409s it, compToPro/extendTrial 400, downgradeToCommunity
// 400, and a dated comp can never lapse. Only manual SQL frees it.
//
// This defect has landed three times, each fix closing one writer and exposing
// the next — so this suite is parameterised over the writers rather than
// hand-written per case. ADDING A NEW WRITER MEANS ADDING ONE ENTRY TO `WRITERS`.
// The assertion uses the real hasLiveSubscription against the re-read row, so it
// cannot drift from the production predicate.
//
// Real Postgres required; skipped without DATABASE_URL. Stripe is never reached:
// every writer here takes its non-live arm for a departed org, which is exactly
// the property under test.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { downgradeToCommunity, hasLiveSubscription } from "@/lib/billing";
import { adminDowngrade, compToPro, extendTrial } from "@/server/usecases/admin-plan";

const HAS_DB = !!process.env.DATABASE_URL;

/** Every entry point that can write to a departed org's subscription row. */
const WRITERS: { name: string; run: (orgId: string, actorId: string) => Promise<unknown> }[] = [
  { name: "compToPro", run: (o, a) => compToPro(a, o, null, "win-back comp") },
  {
    name: "compToPro (dated)",
    run: (o, a) => compToPro(a, o, new Date(Date.now() + 30 * 86_400_000), "win-back comp"),
  },
  { name: "extendTrial", run: (o, a) => extendTrial(a, o, 7, "win-back trial") },
  { name: "adminDowngrade", run: (o, a) => adminDowngrade(a, o, "comp withdrawn") },
  { name: "downgradeToCommunity", run: (o) => downgradeToCommunity(o) },
];

/** A departed org: Pro once, subscription cancelled, dead id still on the row. */
async function seedDepartedOrg(): Promise<{ orgId: string; actorId: string }> {
  const s = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Dep " + s}, ${"dep-" + s}) returning id`;
  await sql`
    insert into subscriptions (org_id, plan_key, status, stripe_subscription_id)
    values (${orgId}, 'community', 'canceled', ${"sub_dead_" + s})`;
  const [{ id: actorId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, is_staff, staff_role)
    values (${"staffdep-" + s + "@test.local"}, 'Staff', true, 'superadmin') returning id`;
  return { orgId, actorId };
}

async function readRow(orgId: string) {
  const [row] = await sql<{ stripe_subscription_id: string | null; status: string | null }[]>`
    select stripe_subscription_id, status from subscriptions where org_id = ${orgId}`;
  return row;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("no writer may resurrect liveness on a departed org", () => {
  for (const writer of WRITERS) {
    it(`${writer.name} leaves the departed row not-live`, async () => {
      const { orgId, actorId } = await seedDepartedOrg();
      // Guard the guard: the seed must actually BE departed, or every assertion
      // below passes vacuously on a row that was never live-capable.
      const before = await readRow(orgId);
      expect(before.stripe_subscription_id).not.toBeNull();
      expect(hasLiveSubscription(before)).toBe(false);

      await writer.run(orgId, actorId);

      const after = await readRow(orgId);
      // The dead id must still be there — otherwise "not live" is trivially true
      // for the wrong reason and this suite would stop testing the status write.
      expect(after.stripe_subscription_id).toBe(before.stripe_subscription_id);
      expect(hasLiveSubscription(after)).toBe(false);
    });

    // Lock-out is the user-visible harm: once a row looks live, the OTHER staff
    // actions start refusing it. Running a second writer after the first proves
    // the org is still reachable rather than stranded behind a 400.
    it(`${writer.name} does not lock the org out of a subsequent staff action`, async () => {
      const { orgId, actorId } = await seedDepartedOrg();
      await writer.run(orgId, actorId);
      await expect(compToPro(actorId, orgId, null, "still reachable")).resolves.toBeUndefined();
      await expect(downgradeToCommunity(orgId)).resolves.toBeUndefined();
      expect(hasLiveSubscription(await readRow(orgId))).toBe(false);
    });
  }
});
