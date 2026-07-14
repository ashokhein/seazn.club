// PROMPT-52 public reads: waitlist count on the division card and "#N in
// line" on the token-gated status page. New file — the PR #72 suite
// (registrations.test.ts) is normative and stays byte-identical; its seeding
// helpers are mirrored here rather than imported so neither suite can
// destabilise the other. Real Postgres, skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  publicRegistrationInfo,
  publicRegistrationStatus,
  putRegistrationSettings,
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

async function seedOrg(): Promise<{ orgId: string; orgSlug: string; ownerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const orgSlug = "p52-org-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"P52 Org " + suffix}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`insert into subscriptions (org_id, plan_key, status)
            values (${orgId}, 'pro', 'active')
            on conflict (org_id) do update set plan_key = 'pro', status = 'active'`;
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

async function rig(owner: AuthCtx, capacity: number | null) {
  const competition = await createCompetition(owner, {
    name: "P52 Cup " + randomUUID().slice(0, 6),
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
  await putRegistrationSettings(owner, division.id, {
    enabled: true, entrant_kind: "individual", fee_cents: 0, currency: "usd",
    form_fields: [], opens_at: null, closes_at: null, capacity, refund_lock_at: null,
  });
  return { competition, division };
}

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

const submit = (orgSlug: string, compSlug: string, divisionId: string, name: string) =>
  submitRegistration(orgSlug, compSlug, {
    ...SUBMIT_BASE, division_id: divisionId, display_name: name,
    contact_email: `${name.toLowerCase().replace(/ /g, ".")}@test.local`,
  }, "http://test.local");

describe.skipIf(!HAS_DB)("PROMPT-52 public waitlist reads", () => {
  it("exposes waitlisted count on PublicDivisionInfo and #N on the status page", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner, 1);

    await submit(orgSlug, competition.slug, division.id, "Holder One");
    const w1 = await submit(orgSlug, competition.slug, division.id, "First Wait");
    const w2 = await submit(orgSlug, competition.slug, division.id, "Second Wait");

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions).toHaveLength(1);
    expect(info.divisions[0]!.waitlisted).toBe(2);

    const s1 = await publicRegistrationStatus(w1.registration.id, w1.access_token);
    const s2 = await publicRegistrationStatus(w2.registration.id, w2.access_token);
    expect(s1.status).toBe("waitlisted");
    expect(s1.position).toBe(1);
    expect(s2.position).toBe(2);
  });

  it("position is null once not waitlisted, and count is 0 with free capacity", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner, 5);

    const r = await submit(orgSlug, competition.slug, division.id, "In Room");
    const s = await publicRegistrationStatus(r.registration.id, r.access_token);
    expect(s.status).not.toBe("waitlisted");
    expect(s.position).toBeNull();

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions[0]!.waitlisted).toBe(0);
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
