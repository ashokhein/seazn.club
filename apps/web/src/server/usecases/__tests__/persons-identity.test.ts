// W1 / #396 gap 8 — person identity guards.
//
// The planned V345 partial unique index on persons(org_id, user_id) was
// WITHDRAWN (owner decision, 2026-08-02): one user legitimately holds several
// person rows in one org — a player person and an official person — and /me
// resolves entitlements per person row (me.test.ts:162). The invariant question
// is filed on #404, where the merge tool lives.
//
// What remains is the guard that must never regress: contact_email is NOT an
// identity key. A guardian registering two children shares one address, and
// linking on it would merge siblings — worse than the bug it would fix.
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createOfficial, inviteOfficial } from "../officials";
import {
  confirmRegistration,
  putRegistrationSettings,
  submitRegistration,
} from "../registrations";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Guardian anti-merge — the other side of the identity coin.
//
// V345 constrains the ONE key that is deterministic enough to enforce
// (org_id, user_id). `contact_email` is NOT that key and must never become
// one: a guardian registers every child they have under a single address, so
// joining on it would fuse two siblings into one person row and corrupt their
// stats, discipline record, photo and consent all at once (design §4.2, §1.1).
// This suite drives the REAL confirm/materialise path and pins the row count.
// It passes today and is meant to pass forever — a failure here means someone
// taught registration to merge on contact details.
// ---------------------------------------------------------------------------

/** Registration-open individual division. Same shape as the `rig` +
 *  free-flow settings block in registrations.test.ts. */
async function seedOpenDivision(auth: AuthCtx): Promise<{
  divisionId: string;
  orgSlug: string;
  compSlug: string;
}> {
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${auth.orgId}`;
  const competition = await createCompetition(auth, {
    name: "Guardian Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    currency: "usd",
    form_fields: [],
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
  });
  return { divisionId: division.id, orgSlug, compSlug: competition.slug };
}

/** The real public submit → organiser confirm → `materialise` path. Never
 *  hand-inserts a persons row: a hand-rolled insert would prove nothing. */
async function registerAndConfirm(
  auth: AuthCtx,
  div: { divisionId: string; orgSlug: string; compSlug: string },
  input: { display_name: string; contact_email: string; dob: string; guardian_name: string },
): Promise<{ entrant_id: string }> {
  const res = await submitRegistration(
    div.orgSlug,
    div.compSlug,
    {
      division_id: div.divisionId,
      display_name: input.display_name,
      contact_email: input.contact_email,
      dob: input.dob,
      gender: null,
      guardian_name: input.guardian_name,
      guardian_consent: true,
      privacy_consent: true,
      answers: {},
      players: [],
    },
    "http://test.local",
  );
  const confirmed = await confirmRegistration(auth, res.registration.id);
  expect(confirmed.status).toBe("confirmed");
  expect(confirmed.entrant_id).not.toBeNull();
  return { entrant_id: confirmed.entrant_id as string };
}

async function personCount(orgId: string): Promise<number> {
  const [{ n }] = await sql<{ n: string }[]>`
    select count(*)::text as n from persons where org_id = ${orgId}`;
  return Number(n);
}

describe.skipIf(!HAS_DB)("guardian anti-merge (permanent regression guard, #396)", () => {
  it("one guardian, two children, one contact_email ⇒ TWO persons rows", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const email = `guardian-${randomUUID().slice(0, 8)}@test.local`;
    const before = await personCount(auth.orgId);

    const one = await registerAndConfirm(auth, div, {
      display_name: "Ada Guardianchild",
      contact_email: email,
      dob: "2014-03-02",
      guardian_name: "Grace Guardian",
    });
    const two = await registerAndConfirm(auth, div, {
      display_name: "Bob Guardianchild",
      contact_email: email,
      dob: "2016-09-11",
      guardian_name: "Grace Guardian",
    });

    // THE guard. Never weaken this to >= or to a name check.
    expect(await personCount(auth.orgId)).toBe(before + 2);

    const rows = await sql<{ id: string; full_name: string; dob: string | null }[]>`
      select id, full_name, dob from persons where org_id = ${auth.orgId} order by full_name`;
    expect(rows.map((r) => r.full_name)).toContain("Ada Guardianchild");
    expect(rows.map((r) => r.full_name)).toContain("Bob Guardianchild");
    // Each sibling keeps their own date of birth — a merge would lose one.
    expect(rows.find((r) => r.full_name === "Ada Guardianchild")?.dob).toBe("2014-03-02");
    expect(rows.find((r) => r.full_name === "Bob Guardianchild")?.dob).toBe("2016-09-11");

    // `confirmRegistration` returns the entrant, not the person, so identity is
    // asserted through the membership link instead.
    const members = await sql<{ entrant_id: string; person_id: string }[]>`
      select entrant_id, person_id from entrant_members
       where entrant_id in (${one.entrant_id}, ${two.entrant_id})`;
    expect(members).toHaveLength(2);
    expect(members[0].person_id).not.toBe(members[1].person_id);
  });
});

// ---------------------------------------------------------------------------
// #402 — the lane discriminator that finally makes the withdrawn V345 index
// landable. `(org_id, user_id)` is NOT unique (a player person and an official
// person for one human), but `(org_id, user_id, lane)` is. These four tests pin
// each edge of that claim: duplicates rejected, BOTH lanes accepted, anonymous
// rows unconstrained, and inviteOfficial minting into the official lane so
// registration's player-lane resolve can never grab an official's row.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("persons lane identity (#402)", () => {
  it("rejects a second player-lane person for the same user in one org", async () => {
    const { auth } = await seedOrg("pro");
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, display_name, password_hash)
      values (${`lane-${randomUUID().slice(0, 8)}@test.local`}, 'Lane Tester', 'x')
      returning id`;

    await sql`
      insert into persons (org_id, full_name, user_id, lane)
      values (${auth.orgId}, 'Lane Tester', ${user.id}, 'player')`;

    await expect(
      sql`insert into persons (org_id, full_name, user_id, lane)
          values (${auth.orgId}, 'Lane Tester Again', ${user.id}, 'player')`,
    ).rejects.toThrow(/persons_org_user_lane_uq/);
  });

  it("accepts the same user in BOTH lanes — the case that killed V345", async () => {
    const { auth } = await seedOrg("pro");
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, display_name, password_hash)
      values (${`dual-${randomUUID().slice(0, 8)}@test.local`}, 'Dual Role', 'x')
      returning id`;

    await sql`insert into persons (org_id, full_name, user_id, lane)
              values (${auth.orgId}, 'Dual Role', ${user.id}, 'player')`;
    await sql`insert into persons (org_id, full_name, user_id, lane)
              values (${auth.orgId}, 'Dual Role', ${user.id}, 'official')`;

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${auth.orgId} and user_id = ${user.id}`;
    expect(Number(n)).toBe(2);
  });

  it("leaves anonymous persons unconstrained — many null user_ids in one org", async () => {
    const { auth } = await seedOrg("pro");
    await sql`insert into persons (org_id, full_name) values (${auth.orgId}, 'Anon One')`;
    await sql`insert into persons (org_id, full_name) values (${auth.orgId}, 'Anon Two')`;
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${auth.orgId} and user_id is null`;
    expect(Number(n)).toBeGreaterThanOrEqual(2);
  });

  it("inviteOfficial mints an official-lane person", async () => {
    const { auth } = await seedOrg("pro");
    // inviteOfficial(auth, officialId, email) — it does not create the official,
    // it ensures a person for one that already exists with person_id null.
    const official = await createOfficial(auth, {
      display_name: "Ref Without Account",
      role_keys: ["referee"],
    });
    expect(official.person_id).toBeNull();
    await inviteOfficial(auth, official.id, `ref-${randomUUID().slice(0, 8)}@test.local`);
    const [row] = await sql<{ lane: string }[]>`
      select p.lane from persons p
        join officials o on o.person_id = p.id
       where o.id = ${official.id}`;
    expect(row.lane).toBe("official");
  });
});
