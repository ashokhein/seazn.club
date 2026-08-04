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
