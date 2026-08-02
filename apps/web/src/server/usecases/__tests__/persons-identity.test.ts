// W1 / #396 gap 8 — person identity guards. V345 puts a PARTIAL unique index on
// persons(org_id, user_id): one person row per (organisation, claimed login),
// while unclaimed persons (user_id null) stay unconstrained and one human may
// still hold a person row in several organisations.
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  confirmRegistration,
  putRegistrationSettings,
  submitRegistration,
} from "../registrations";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** Same insert shape as person-claims.test.ts — `users.id` is defaulted. */
async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

describe.skipIf(!HAS_DB)("persons identity guards (#396)", () => {
  it("rejects a second persons row with the same (org_id, user_id)", async () => {
    const { auth } = await seedOrg("pro");
    const userId = await makeUser("claimer");
    await sql`
      insert into persons (org_id, full_name, user_id)
      values (${auth.orgId}, 'Claimed Once', ${userId})`;
    await expect(
      sql`
        insert into persons (org_id, full_name, user_id)
        values (${auth.orgId}, 'Claimed Twice', ${userId})`,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("still allows many unclaimed persons — user_id null is not constrained", async () => {
    const { auth } = await seedOrg("pro");
    await sql`insert into persons (org_id, full_name) values (${auth.orgId}, 'Anon A')`;
    await sql`insert into persons (org_id, full_name) values (${auth.orgId}, 'Anon B')`;
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${auth.orgId} and user_id is null`;
    expect(Number(n)).toBe(2);
  });

  it("allows the same user_id in two different orgs", async () => {
    const a = await seedOrg("pro");
    const b = await seedOrg("pro");
    const userId = await makeUser("multiorg");
    await sql`
      insert into persons (org_id, full_name, user_id)
      values (${a.auth.orgId}, 'X', ${userId})`;
    await sql`
      insert into persons (org_id, full_name, user_id)
      values (${b.auth.orgId}, 'X', ${userId})`;
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons where user_id = ${userId}`;
    expect(Number(n)).toBe(2);
  });
});

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
