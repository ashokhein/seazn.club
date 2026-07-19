// Payments-hardening Task 10 (P2-10, decision §6.1): a Stripe-fee registration
// division must stop taking cards the moment the org loses the paid layer.
//
// An org can drop to community WITHOUT touching Connect — a lost subscription
// dispute, a canceled sub, or past_due grace expiry (Task 9 resolves the last
// one as community at read time). Connect stays live (charges_enabled=true),
// so the pre-existing charges_enabled gate does NOT fire; money would keep
// landing on an entitlement the org no longer holds. The intake read + submit
// now also gate on the `registration.paid` entitlement — scoped by competition
// so an Event Pass keeps that one comp OPEN.
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
import { invalidateOrgEntitlements } from "@/lib/entitlements";
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
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'pro', 'active')
            on conflict (org_id) do update set plan_key = 'pro', status = 'active'`;
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

/** Pro org → save a Stripe-fee division → drop to community. Connect stays
 *  live; only the entitlement lapses. Optionally buy an Event Pass on the comp. */
async function downgradedStripeRig(opts: { withPass?: boolean } = {}) {
  const { orgId, orgSlug, ownerId } = await seedProOrg();
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    payment_method: "stripe",
    fee_cents: 500,
  });
  // The downgrade — lost dispute / canceled sub / grace expiry all resolve to
  // community. charges_enabled is deliberately left true.
  await sql`update subscriptions set plan_key = 'community', status = 'canceled', updated_at = now()
            where org_id = ${orgId}`;
  if (opts.withPass) {
    await sql`insert into competition_passes (competition_id, org_id)
              values (${competition.id}, ${orgId})`;
  }
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

describe.skipIf(!HAS_DB)("post-downgrade card intake gate (P2-10)", () => {
  it("closes a Stripe-fee division with payments_unavailable when registration.paid is gone", async () => {
    const { orgSlug, competition, division } = await downgradedStripeRig();
    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const d = info.divisions.find((x) => x.division_id === division.id)!;
    expect(d.payment_method).toBe("stripe");
    expect(d.open).toBe(false);
    expect(d.closed_reason).toBe("payments_unavailable");
  });

  it("keeps the division OPEN when an Event Pass overlays registration.paid on the comp", async () => {
    const { orgSlug, competition, division } = await downgradedStripeRig({ withPass: true });
    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const d = info.divisions.find((x) => x.division_id === division.id)!;
    expect(d.open).toBe(true);
    expect(d.closed_reason).toBeNull();
  });

  it("rejects submit with 402 on a downgraded Stripe-fee division", async () => {
    const { orgSlug, competition, division } = await downgradedStripeRig();
    await expect(
      submitRegistration(
        orgSlug,
        competition.slug,
        { ...SUBMIT_BASE, division_id: division.id },
        "http://test.local",
      ),
    ).rejects.toMatchObject({ status: 402 });
  });

  it("leaves an offline paid division untouched by the lapsed entitlement", async () => {
    const { orgId, orgSlug, ownerId } = await seedProOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      payment_method: "offline",
      fee_cents: 1500,
    });
    await sql`update subscriptions set plan_key = 'community', status = 'canceled', updated_at = now()
              where org_id = ${orgId}`;
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
