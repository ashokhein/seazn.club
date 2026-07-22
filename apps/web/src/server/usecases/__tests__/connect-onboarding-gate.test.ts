// Phase 2 cleanup — the Connect onboarding gate's dead Event Pass escape.
//
// `createConnectOnboardingLink` used to run
//
//     const [anyPass] = await sql`select 1 from competition_passes …`;
//     if (!anyPass) await requireFeature(orgId, "registration.paid");
//
// which was dead code twice over. `registration.paid` is TRUE on the community
// matrix since V310 (D19), so the plan row already satisfies the gate and the
// escape can never be what lets an org through; and the one thing that CAN
// still deny it — an org_entitlement_overrides row, written when staff suspend
// paid intake for abuse or chargeback risk — beats a pass everywhere else in
// the app (lib/entitlements.ts folds the override over the pass with
// `ov.bool_value ?? base`, so a non-null false short-circuits). Skipping the
// gate on the mere PRESENCE of a pass row therefore turned a staff deny into
// something an org could walk around for $29.
//
// Connect is org-level plumbing — one Express account for the whole org — so
// this gate is deliberately org-wide and NOT competition-scoped. That is also
// why the pass-scoping guard does not list it: `registration.paid` is not a
// lifted key. Nothing else would force this, hence these two cases.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// The gate runs before getStripe(); the stub only keeps a stray network call
// from ever being possible if that order regresses.
vi.mock("@/lib/stripe", () => ({
  getStripe: () => {
    throw new Error("getStripe() must not be reached in this suite");
  },
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createConnectOnboardingLink } from "../stripe-connect";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** A COMMUNITY org owner, optionally holding an Event Pass and/or carrying a
 *  staff deny on `registration.paid`. */
async function seedOrg(opts: { withPass?: boolean; denied?: boolean } = {}): Promise<AuthCtx> {
  const s = uniq();
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`cngate-${s}@test.local`}, 'Connect Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"CnGate " + s}, ${"cngate-" + s}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'community', 'active')
            on conflict (org_id) do update set plan_key = 'community', status = 'active'`;
  if (opts.withPass) {
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility)
      values (${orgId}, 'Passed Cup', ${"cngate-cup-" + s}, 'unlisted') returning id`;
    await sql`insert into competition_passes (competition_id, org_id)
              values (${compId}, ${orgId}) on conflict (competition_id) do nothing`;
  }
  if (opts.denied) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value)
              values (${orgId}, 'registration.paid', false)
              on conflict (org_id, feature_key) do update set bool_value = false`;
  }
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
}

const link = (auth: AuthCtx) =>
  createConnectOnboardingLink(auth, auth.orgId, "https://test.local", "/settings/connect");

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("Connect onboarding gate is org-wide, and a pass is not a bypass", () => {
  it("lets a plain community org through — registration.paid is free (V310)", async () => {
    // 422 is the ToS gate immediately AFTER the entitlement gate, so reaching
    // it proves the entitlement gate did not fire. Asserting "does not throw"
    // would be wrong: onboarding legitimately stops here without tosAgreed.
    await expect(link(await seedOrg())).rejects.toMatchObject({ status: 422 });
  });

  it("still denies an org under a staff override, even when it holds an Event Pass", async () => {
    // RED before the cleanup: the `anyPass` row short-circuited the gate, so
    // this resolved past 402 and hit the ToS 422 instead.
    await expect(link(await seedOrg({ withPass: true, denied: true }))).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    // …and the deny is what does it, not the pass — same org shape without the
    // override goes through.
    await expect(link(await seedOrg({ withPass: true }))).rejects.toMatchObject({ status: 422 });
  });
});
