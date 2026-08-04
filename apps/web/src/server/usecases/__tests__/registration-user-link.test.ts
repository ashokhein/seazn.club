// #402 — the registrant's session, and the person it resolves to.
//
// Two halves, deliberately in one file because the second depends on what the
// first writes:
//
//  1. CAPTURE. `registrations.user_id` is written ONLY when the submitter is
//     signed in AND affirmed "I'm registering myself" AND left every guardian
//     field empty. Being signed in is never enough on its own — a guardian, a
//     spouse and a team captain are all signed in too, and inferring the link
//     would merge them into one person exactly as `contact_email` would
//     (persons-identity.test.ts pins that same harm in its email form).
//  2. RESOLVE. Given that link, `materialise` upserts into the PLAYER lane on
//     (org_id, user_id, 'player'), so one human entering two divisions gets one
//     persons row. Everything without a link keeps today's plain insert.
//
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

/** Registration-open division. Deliberately a local copy of the helper in
 *  persons-identity.test.ts — the two suites stay independent. */
async function seedOpenDivision(
  auth: AuthCtx,
  entrantKind: "individual" | "team" = "individual",
): Promise<{ divisionId: string; orgSlug: string; compSlug: string }> {
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${auth.orgId}`;
  const competition = await createCompetition(auth, {
    name: "Identity Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open " + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await putRegistrationSettings(auth, division.id, {
    enabled: true,
    entrant_kind: entrantKind,
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

async function makeUser(): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, password_hash)
    values (${`u-${randomUUID().slice(0, 8)}@test.local`}, 'Session User', 'x')
    returning id`;
  return u.id;
}

async function submitAs(
  div: { divisionId: string; orgSlug: string; compSlug: string },
  over: Partial<Parameters<typeof submitRegistration>[2]>,
  sessionUserId: string | null,
) {
  return submitRegistration(
    div.orgSlug,
    div.compSlug,
    {
      division_id: div.divisionId,
      display_name: "Sam Player",
      contact_email: `sam-${randomUUID().slice(0, 8)}@test.local`,
      dob: null,
      gender: null,
      guardian_name: null,
      guardian_consent: false,
      privacy_consent: true,
      registering_self: false,
      answers: {},
      players: [],
      ...over,
    },
    "http://test.local",
    { sessionUserId },
  );
}

async function linkedUser(registrationId: string): Promise<string | null> {
  const [row] = await sql<{ user_id: string | null }[]>`
    select user_id from registrations where id = ${registrationId}`;
  return row.user_id;
}

async function personCount(orgId: string): Promise<number> {
  const [{ n }] = await sql<{ n: string }[]>`
    select count(*)::text as n from persons where org_id = ${orgId}`;
  return Number(n);
}

describe.skipIf(!HAS_DB)("registration session capture (#402)", () => {
  it("signed out ⇒ user_id null", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const res = await submitAs(div, {}, null);
    expect(await linkedUser(res.registration.id)).toBeNull();
  });

  it("signed in but NOT affirmed ⇒ user_id null (opt-in, never inferred)", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();
    const res = await submitAs(div, {}, userId);
    expect(await linkedUser(res.registration.id)).toBeNull();
  });

  it("signed in and affirmed ⇒ user_id captured", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();
    const res = await submitAs(div, { registering_self: true }, userId);
    expect(await linkedUser(res.registration.id)).toBe(userId);
  });

  it("affirmed BUT guardian_name present ⇒ user_id null (server-side veto)", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();
    const res = await submitAs(
      div,
      { registering_self: true, guardian_name: "Grace Guardian" },
      userId,
    );
    expect(await linkedUser(res.registration.id)).toBeNull();
  });

  it("affirmed BUT guardian_consent true ⇒ user_id null (server-side veto)", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();
    const res = await submitAs(
      div,
      { registering_self: true, guardian_consent: true },
      userId,
    );
    expect(await linkedUser(res.registration.id)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("person resolution by (org_id, user_id, 'player') (#402)", () => {
  it("THE headline: one signed-in registrant, two divisions ⇒ ONE persons row", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const userId = await makeUser();
    const before = await personCount(auth.orgId);

    const a = await submitAs(divA, { registering_self: true }, userId);
    const b = await submitAs(divB, { registering_self: true }, userId);
    const ca = await confirmRegistration(auth, a.registration.id);
    const cb = await confirmRegistration(auth, b.registration.id);

    expect(await personCount(auth.orgId)).toBe(before + 1);

    const members = await sql<{ person_id: string }[]>`
      select person_id from entrant_members
       where entrant_id in (${ca.entrant_id as string}, ${cb.entrant_id as string})`;
    expect(members).toHaveLength(2);
    expect(members[0].person_id).toBe(members[1].person_id);
  });

  it("the resolved person keeps its OWN data — a later entry never overwrites it", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const userId = await makeUser();

    const a = await submitAs(
      divA,
      { registering_self: true, display_name: "Original Name", dob: "1990-01-01" },
      userId,
    );
    await confirmRegistration(auth, a.registration.id);
    const b = await submitAs(
      divB,
      { registering_self: true, display_name: "Typo Nmae", dob: "1991-02-02" },
      userId,
    );
    await confirmRegistration(auth, b.registration.id);

    const [person] = await sql<{ full_name: string; dob: string | null }[]>`
      select full_name, dob from persons
       where org_id = ${auth.orgId} and user_id = ${userId} and lane = 'player'`;
    expect(person.full_name).toBe("Original Name");
    expect(person.dob).toBe("1990-01-01");
  });

  it("anonymous registrations still mint a fresh person each time", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const before = await personCount(auth.orgId);
    const one = await submitAs(div, { display_name: "Anon A" }, null);
    const two = await submitAs(div, { display_name: "Anon B" }, null);
    await confirmRegistration(auth, one.registration.id);
    await confirmRegistration(auth, two.registration.id);
    expect(await personCount(auth.orgId)).toBe(before + 2);
  });

  it("a signed-in guardian entering two children still gets TWO persons", async () => {
    const { auth } = await seedOrg("pro");
    const div = await seedOpenDivision(auth);
    const userId = await makeUser();
    const email = `guardian-${randomUUID().slice(0, 8)}@test.local`;
    const before = await personCount(auth.orgId);

    for (const [name, dob] of [
      ["Ada Child", "2014-03-02"],
      ["Bob Child", "2016-09-11"],
    ] as const) {
      const r = await submitAs(
        div,
        {
          display_name: name,
          contact_email: email,
          dob,
          registering_self: true, // even if the form said yes
          guardian_name: "Grace Guardian",
          guardian_consent: true,
        },
        userId, // ...and even signed in as one parent
      );
      await confirmRegistration(auth, r.registration.id);
    }

    // The permanent anti-merge guard, now in its user_id form.
    expect(await personCount(auth.orgId)).toBe(before + 2);
  });

  it("team roster: only the declared `self` entry resolves; the rest insert fresh", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth, "team");
    const divB = await seedOpenDivision(auth, "team");
    const userId = await makeUser();

    const players = [
      { name: "Cap Tain", self: true },
      { name: "Team Mate One" },
      { name: "Team Mate Two" },
    ];
    const a = await submitAs(divA, { registering_self: true, players }, userId);
    const b = await submitAs(divB, { registering_self: true, players }, userId);
    const ca = await confirmRegistration(auth, a.registration.id);
    const cb = await confirmRegistration(auth, b.registration.id);

    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${auth.orgId} and user_id = ${userId} and lane = 'player'`;
    expect(Number(n)).toBe(1);

    const rows = await sql<{ entrant_id: string; person_id: string }[]>`
      select entrant_id, person_id from entrant_members
       where entrant_id in (${ca.entrant_id as string}, ${cb.entrant_id as string})`;
    expect(rows).toHaveLength(6);
    // The captain's person is the only one appearing on BOTH entrants; the two
    // team-mates are typed names with no identity of their own and insert fresh.
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.person_id, (counts.get(r.person_id) ?? 0) + 1);
    expect([...counts.values()].filter((c) => c === 2)).toHaveLength(1);
    expect(counts.size).toBe(5);
    const [captain] = await sql<{ id: string }[]>`
      select id from persons
       where org_id = ${auth.orgId} and user_id = ${userId} and lane = 'player'`;
    expect(counts.get(captain.id)).toBe(2);
  });

  it("two concurrent affirmed registrations ⇒ still ONE persons row", async () => {
    const { auth } = await seedOrg("pro");
    const divA = await seedOpenDivision(auth);
    const divB = await seedOpenDivision(auth);
    const userId = await makeUser();
    const before = await personCount(auth.orgId);

    const a = await submitAs(divA, { registering_self: true }, userId);
    const b = await submitAs(divB, { registering_self: true }, userId);
    await Promise.all([
      confirmRegistration(auth, a.registration.id),
      confirmRegistration(auth, b.registration.id),
    ]);

    expect(await personCount(auth.orgId)).toBe(before + 1);
  });
});
