// Payments-hardening Task 10 (P2-10, decision §6.1): a Stripe-fee registration
// division must stop taking cards the moment the org loses the paid layer.
//
// An org can lose `registration.paid` WITHOUT touching Connect. Connect stays
// live (charges_enabled=true), so the pre-existing charges_enabled gate does
// NOT fire; money would keep landing on an entitlement the org no longer holds.
// The intake read + submit therefore also gate on the entitlement itself.
//
// V310 (D19) narrowed WHEN that happens without changing the gate. Charging an
// entry fee is now free on every plan, so a downgrade to community no longer
// revokes it — asserted directly below, because that is the behaviour change.
// The surviving revocation path is a staff `org_entitlement_overrides` deny
// (abuse, chargeback risk), and that is what the RED cases here use.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique
// (randomUUID). The Stripe seam is stubbed so the RED submit case fails by
// RESOLVING (no gate) rather than reaching the network.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: vi
          .fn()
          .mockResolvedValue({ id: "cs_test_intake", url: "https://checkout.stripe.test/s" }),
      },
    },
  }),
}));

import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  putRegistrationSettings,
  publicRegistrationInfo,
  submitRegistration,
} from "../registrations";

const HAS_DB = !!process.env.DATABASE_URL;

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

/** A Pro org (so the Stripe division can be saved) with Connect live. */
async function seedProOrg(): Promise<{ orgId: string; orgSlug: string; ownerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const orgSlug = "intake-org-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Intake Org " + suffix}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`with _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select created_by, 'pro', 'active' from organizations where id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  await sql`update organizations
            set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + suffix}
            where id = ${orgId}`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score',
            ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
            true)
    on conflict do nothing`;
  return { orgId, orgSlug, ownerId };
}

const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

async function rig(owner: AuthCtx) {
  const competition = await createCompetition(owner, {
    name: "Intake Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  return { competition, division };
}

const SETTINGS_BASE = {
  enabled: true,
  entrant_kind: "individual" as const,
  opens_at: null,
  closes_at: null,
  capacity: null,
  currency: "gbp",
  refund_lock_at: null,
  form_fields: [],
};

const SUBMIT_BASE = {
  display_name: "Alex Test",
  contact_email: "alex@test.local",
  dob: null,
  gender: null,
  guardian_name: null,
  guardian_consent: false,
  privacy_consent: true,
  answers: {},
  players: [],
};

/** Pro org → save a Stripe-fee division → lose `registration.paid`. Connect
 *  stays live; only the entitlement goes.
 *
 *  V310 CHANGED WHAT CAN TAKE IT AWAY. `registration.paid` is now true on every
 *  plan including community, so a plan downgrade no longer revokes it (that is
 *  asserted directly below). The surviving revocation path is a staff/admin
 *  `org_entitlement_overrides` deny — abuse, chargeback risk, an unresolved
 *  dispute — and that is what this rig now uses. The enforcement code in
 *  usecases/registrations.ts is unchanged and still the thing under test.
 *
 *  `withPass` buys an Event Pass on the competition BEFORE the deny lands, so
 *  the resolver's pass arm actually fires (lib/entitlements.ts:106 — the pass
 *  is only consulted while plan_key is 'community', which the downgrade above
 *  guarantees). It is off by default so the plain deny keeps its own coverage. */
async function revokedStripeRig(opts: { withPass?: boolean } = {}) {
  const { orgId, orgSlug, ownerId } = await seedProOrg();
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    payment_method: "stripe",
    fee_cents: 500,
  });
  // charges_enabled is deliberately left true: the point of this suite is that
  // the Connect flag alone is not the gate.
  await sql`update subscriptions set plan_key = 'community', status = 'canceled', updated_at = now()
            where id = (select subscription_id from organizations where id = ${orgId})`;
  if (opts.withPass) {
    await sql`insert into competition_passes (competition_id, org_id)
              values (${competition.id}, ${orgId})
              on conflict (competition_id) do nothing`;
  }
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value)
            values (${orgId}, 'registration.paid', false)
            on conflict (org_id, feature_key) do update set bool_value = false`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, orgSlug, ownerId, owner, competition, division };
}

/** Same shape, but ONLY the plan drops — no override. V310's new normal:
 *  paid entry is no longer a plan perk, so nothing here should close. */
async function downgradedStripeRig() {
  const { orgId, orgSlug, ownerId } = await seedProOrg();
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    payment_method: "stripe",
    fee_cents: 500,
  });
  await sql`update subscriptions set plan_key = 'community', status = 'canceled', updated_at = now()
            where id = (select subscription_id from organizations where id = ${orgId})`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, orgSlug, ownerId, owner, competition, division };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("revoked card intake gate (P2-10)", () => {
  it("closes a Stripe-fee division with payments_unavailable when registration.paid is revoked", async () => {
    const { orgSlug, competition, division } = await revokedStripeRig();
    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const d = info.divisions.find((x) => x.division_id === division.id)!;
    expect(d.payment_method).toBe("stripe");
    expect(d.open).toBe(false);
    expect(d.closed_reason).toBe("payments_unavailable");
  });

  // PRECEDENCE: an org_entitlement_overrides deny beats an Event Pass. Nothing
  // else in the repo pins this. The resolver builds `base` from the pass row
  // when the org is on community with a passed competition
  // (lib/entitlements.ts:106-114), then folds the override over it with
  // `ov.bool_value ?? base?.bool_value` (:145) — a non-null `false` override
  // short-circuits the ??, so the pass's `true` never survives. Without that
  // ordering a suspended org could buy a $29 pass and re-open the card intake
  // that staff just shut off.
  it("closes the division even with an Event Pass on the comp — a staff deny outranks the pass", async () => {
    const { orgId, orgSlug, competition, division } = await revokedStripeRig({ withPass: true });
    // Guard the guard, twice. The row must exist…
    const [pass] = await sql<{ pass_key: string }[]>`
      select pass_key from competition_passes where competition_id = ${competition.id}`;
    expect(pass?.pass_key).toBe("event_pass");
    // …and the resolver must actually be READING it for this org+comp, else the
    // assertion below would hold for the boring reason (community's own
    // registration.paid = true, denied) and pin nothing about the pass.
    // fee_percent is the pass-lifted key that proves the arm fires: community 8,
    // event_pass 5, and no override touches it.
    expect(await getLimit(orgId, "registration.fee_percent", competition.id)).toBe(5);
    expect(await getLimit(orgId, "registration.fee_percent")).toBe(8);

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const d = info.divisions.find((x) => x.division_id === division.id)!;
    expect(d.payment_method).toBe("stripe");
    expect(d.open).toBe(false);
    expect(d.closed_reason).toBe("payments_unavailable");
  });

  // V310 (D19): charging entry fees is free for everyone, so the plan downgrade
  // that used to close this division no longer does. The Event Pass case this
  // replaced is gone with it — the pass cannot "overlay" a key that community
  // already holds; what it buys now is the cheaper cut (8% → 5%), not the
  // ability. See pricing-matrix.test.ts for the ladder.
  it("keeps a downgraded org's Stripe-fee division OPEN — paid entry is free (V310)", async () => {
    const { orgSlug, competition, division } = await downgradedStripeRig();
    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const d = info.divisions.find((x) => x.division_id === division.id)!;
    expect(d.payment_method).toBe("stripe");
    expect(d.open).toBe(true);
    expect(d.closed_reason).toBeNull();
  });

  it("rejects submit with 402 when registration.paid is revoked", async () => {
    const { orgSlug, competition, division } = await revokedStripeRig();
    await expect(
      submitRegistration(
        orgSlug,
        competition.slug,
        { ...SUBMIT_BASE, division_id: division.id },
        "http://test.local",
      ),
    ).rejects.toMatchObject({ status: 402 });
  });

  it("lets a downgraded org's card submit through — no plan gate left", async () => {
    const { orgSlug, competition, division } = await downgradedStripeRig();
    const res = await submitRegistration(
      orgSlug,
      competition.slug,
      { ...SUBMIT_BASE, division_id: division.id },
      "http://test.local",
    );
    expect(res.registration.status).toBe("pending");
  });

  it("leaves an offline paid division untouched by the revoked entitlement", async () => {
    const { orgId, orgSlug, ownerId } = await seedProOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 1500,
    });
    await sql`update subscriptions set plan_key = 'community', status = 'canceled', updated_at = now()
              where id = (select subscription_id from organizations where id = ${orgId})`;
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value)
              values (${orgId}, 'registration.paid', false)
              on conflict (org_id, feature_key) do update set bool_value = false`;
    await invalidateOrgEntitlements(orgId);

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const d = info.divisions.find((x) => x.division_id === division.id)!;
    expect(d.payment_method).toBe("offline");
    expect(d.open).toBe(true);
    expect(d.closed_reason).toBeNull();

    // …and an offline submit still goes through — the gate rides the card method.
    const res = await submitRegistration(
      orgSlug,
      competition.slug,
      { ...SUBMIT_BASE, division_id: division.id },
      "http://test.local",
    );
    expect(res.registration.status).toBe("pending");
  });
});
