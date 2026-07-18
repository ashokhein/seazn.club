// PROMPT-57 (design v11) — official onboarding: invite goes through the SHARED
// person-claim rail (no parallel token system), claim links the login, the /me
// lane gates on the link, response transitions are guarded and survive
// re-apply, and blackout dates are unique per (official, date). Real Postgres
// required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { claimPerson } from "../person-claims";
import { patchFixture } from "../fixtures";
import {
  createOfficial,
  inviteOfficial,
  listOfficialsForConsole,
  patchFixtureOfficials,
} from "../officials";
import {
  acceptMyOfficiatingClaim,
  deleteMyBlackout,
  getMyOfficiating,
  listPendingOfficiatingClaims,
  setMyBlackout,
  setMyOfficiatingResponse,
} from "../me-officiating";

const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function makeUser(name: string): Promise<{ id: string; email: string }> {
  const email = `${name}-${randomUUID().slice(0, 8)}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${name}, true)
    returning id`;
  return { id, email };
}

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const owner = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"V11 " + suffix}, ${"v11-" + suffix}, ${owner.id}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${owner.id}, 'owner')`;
  if (plan !== "community") {
    await sql`
      insert into subscriptions (org_id, plan_key, status)
      values (${orgId}, ${plan}, 'active')
      on conflict (org_id) do update set plan_key = ${plan}`;
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: owner.id, role: "owner", keyId: null } };
}

/** Division with FUTURE fixtures — the /me lane and re-accept both filter on
 *  matchday, so dates must be ahead of now. */
async function seedFutureDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    name: "V11 Cup", visibility: "public", branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((name, i) => ({
      kind: "individual" as const, display_name: name, seed: i + 1, members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: "league", name: "League", config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const t0 = Date.now() + 7 * 86_400_000;
  for (let i = 0; i < fixtures.length; i++) {
    await sql`
      update fixtures
      set scheduled_at = ${new Date(t0 + i * 30 * 60_000).toISOString()},
          court_label = 'Court 1'
      where id = ${fixtures[i]!.id}`;
  }
  return { division, fixtures };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("official onboarding (PROMPT-57)", () => {
  it("invite mints through the shared person-claim rail and claim links the login", async () => {
    const { auth } = await seedOrg();
    const ref = await makeUser("ref");
    const official = await createOfficial(auth, { display_name: "Priya", role_keys: ["referee"] });
    expect(official.person_id).toBeNull();

    const invited = await inviteOfficial(auth, official.id, ref.email);
    // person created + linked, email stamped
    expect(invited.official.person_id).not.toBeNull();
    expect(invited.official.email).toBe(ref.email);
    // the claim lives in person_claims — the SHARED rail, not a new table
    const [claimRow] = await sql<{ person_id: string }[]>`
      select person_id from person_claims where id = ${invited.claim.id}`;
    expect(claimRow!.person_id).toBe(invited.official.person_id);

    // pure player check BEFORE claiming: no officiating lane
    expect((await getMyOfficiating(ref.id)).is_official).toBe(false);

    await claimPerson(invited.secret, ref.id, ref.email);
    const mine = await getMyOfficiating(ref.id);
    expect(mine.is_official).toBe(true);

    // console read shows the linked state
    const console_ = await listOfficialsForConsole(auth);
    expect(console_.find((o) => o.id === official.id)).toMatchObject({
      claimed: true,
      invite_pending: false,
    });
  });

  it("shows outstanding duties even when the scheduled time has passed; finished matches drop off", async () => {
    const { auth } = await seedOrg();
    const ref = await makeUser("ref");
    const { fixtures } = await seedFutureDivision(auth);
    const official = await createOfficial(auth, { display_name: "Ref R", role_keys: ["referee"] });
    const invited = await inviteOfficial(auth, official.id, ref.email);
    await claimPerson(invited.secret, ref.id, ref.email);

    const pastScheduled = fixtures[0]!.id;
    const pastInPlay = fixtures[1]!.id;
    const done = fixtures[2]!.id;
    for (const id of [pastScheduled, pastInPlay, done]) {
      await patchFixtureOfficials(auth, id, {
        set: [{ official_id: official.id, role_key: "referee", locked: false }],
      });
    }
    // scheduled time already passed but still not played (outstanding duty);
    // an in-play match (must always show); a finished/decided match.
    await sql`update fixtures set scheduled_at = ${new Date(Date.now() - 2 * 86_400_000).toISOString()}, status = 'scheduled' where id = ${pastScheduled}`;
    await sql`update fixtures set scheduled_at = ${new Date(Date.now() - 3 * 3_600_000).toISOString()}, status = 'in_play' where id = ${pastInPlay}`;
    await sql`update fixtures set scheduled_at = ${new Date(Date.now() - 5 * 86_400_000).toISOString()}, status = 'decided' where id = ${done}`;

    const mine = await getMyOfficiating(ref.id);
    const ids = mine.assignments.map((a) => a.fixture_id);
    const completedIds = mine.completed.map((a) => a.fixture_id);
    expect(ids).toContain(pastScheduled); // outstanding, past-dated → shows
    expect(ids).toContain(pastInPlay); // in_play → always shows
    expect(ids).not.toContain(done); // finished → out of outstanding
    expect(completedIds).toContain(done); // finished → in the completed panel
  });

  it("guards response transitions and scopes writes to the assigned official", async () => {
    const { auth } = await seedOrg();
    const ref = await makeUser("ref");
    const stranger = await makeUser("stranger");
    const { fixtures } = await seedFutureDivision(auth);
    const official = await createOfficial(auth, { display_name: "Ref R", role_keys: ["referee"] });
    const invited = await inviteOfficial(auth, official.id, ref.email);
    await claimPerson(invited.secret, ref.id, ref.email);

    const fixtureId = fixtures[0]!.id;
    await patchFixtureOfficials(auth, fixtureId, {
      set: [{ official_id: official.id, role_key: "referee", locked: false }],
    });

    // fresh assignment is pending, visible in the lane
    const before = await getMyOfficiating(ref.id);
    const assignment = before.assignments.find((a) => a.fixture_id === fixtureId);
    expect(assignment).toMatchObject({ response: "pending" });

    // a stranger may not write
    await expect(
      setMyOfficiatingResponse(stranger.id, fixtureId, { response: "accepted" }),
    ).rejects.toMatchObject({ status: 403 });

    // pending → declined (+reason)
    const declined = await setMyOfficiatingResponse(ref.id, fixtureId, {
      response: "declined",
      decline_reason: "family wedding",
    });
    expect(declined).toMatchObject({ response: "declined", decline_reason: "family wedding" });
    // the flag reaches the organiser's read cache
    const [cached] = await sql<{ officials: { response: string; decline_reason: string }[] }[]>`
      select officials from fixtures where id = ${fixtureId}`;
    expect(cached!.officials[0]).toMatchObject({
      response: "declined",
      decline_reason: "family wedding",
    });

    // declined → accepted (matchday is in the future)
    await setMyOfficiatingResponse(ref.id, fixtureId, { response: "accepted" });
    // accepted → declined is illegal (ask the organiser)
    await expect(
      setMyOfficiatingResponse(ref.id, fixtureId, { response: "declined" }),
    ).rejects.toMatchObject({ status: 422 });

    // re-applying the SAME assignment must not reset the response
    await patchFixtureOfficials(auth, fixtureId, {
      set: [{ official_id: official.id, role_key: "referee", locked: false }],
    });
    const [kept] = await sql<{ response: string }[]>`
      select response from fixture_officials
      where fixture_id = ${fixtureId} and official_id = ${official.id}`;
    expect(kept!.response).toBe("accepted");
  });

  it("blackouts are unique per (official, date) and delete clears them", async () => {
    const { auth } = await seedOrg();
    const ref = await makeUser("ref");
    const official = await createOfficial(auth, { display_name: "Ref B", role_keys: ["referee"] });
    const invited = await inviteOfficial(auth, official.id, ref.email);
    await claimPerson(invited.secret, ref.id, ref.email);

    await setMyBlackout(ref.id, "2027-01-10", "away");
    await setMyBlackout(ref.id, "2027-01-10", "away all day"); // upsert, not a dup
    const rows = await sql<{ note: string }[]>`
      select note from official_availability
      where official_id = ${official.id} and date = '2027-01-10'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toBe("away all day");

    await deleteMyBlackout(ref.id, "2027-01-10");
    const after = await sql`
      select 1 from official_availability
      where official_id = ${official.id} and date = '2027-01-10'`;
    expect(after).toHaveLength(0);

    // an unlinked user has no blackout scope
    const stranger = await makeUser("stranger");
    await expect(setMyBlackout(stranger.id, "2027-01-10")).rejects.toMatchObject({ status: 403 });
  });

  it("rescheduling a fixture with a responded official runs the change-notice path", async () => {
    const { auth } = await seedOrg();
    const ref = await makeUser("ref");
    const { fixtures } = await seedFutureDivision(auth);
    const official = await createOfficial(auth, { display_name: "Ref M", role_keys: ["referee"] });
    const invited = await inviteOfficial(auth, official.id, ref.email);
    await claimPerson(invited.secret, ref.id, ref.email);
    const fixtureId = fixtures[0]!.id;
    await patchFixtureOfficials(auth, fixtureId, {
      set: [{ official_id: official.id, role_key: "referee", locked: false }],
    });
    await setMyOfficiatingResponse(ref.id, fixtureId, { response: "accepted" });

    // The move assembles official-assignment-changed notices in-tx (fires the
    // v11 query) and must not disturb the response or the schedule write.
    const moved = await patchFixture(auth, fixtureId, {
      scheduled_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    });
    expect(moved.scheduled_at).not.toBeNull();
    const [row] = await sql<{ response: string }[]>`
      select response from fixture_officials
      where fixture_id = ${fixtureId} and official_id = ${official.id}`;
    expect(row!.response).toBe("accepted");
  });

  it("migration backfills pre-existing assignments to accepted (no false flags)", () => {
    // The backfill runs once at migrate time; guard the statement itself so a
    // refactor can't silently drop it and light up every console red.
    const delta = readFileSync(
      join(__dirname, "../../../../../../db/migration/deltas/V284__official_onboarding.sql"),
      "utf8",
    );
    expect(delta).toMatch(/update fixture_officials set response = 'accepted'/);
    expect(delta).toMatch(/default 'pending'/);
  });

  it("pending invites list across multiple orgs, accept-by-id links + consumes exactly one (v11.1)", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const [{ name: orgNameA }] = await sql<{ name: string }[]>`
      select name from organizations where id = ${orgA.auth.orgId}`;
    const [{ name: orgNameB }] = await sql<{ name: string }[]>`
      select name from organizations where id = ${orgB.auth.orgId}`;
    const ref = await makeUser("multiorg-ref");

    const officialA = await createOfficial(orgA.auth, { display_name: "Ref A-side", role_keys: ["referee"] });
    const officialB = await createOfficial(orgB.auth, { display_name: "Ref B-side", role_keys: ["umpire"] });
    const invitedA = await inviteOfficial(orgA.auth, officialA.id, ref.email);
    const invitedB = await inviteOfficial(orgB.auth, officialB.id, ref.email);

    // A pure player claim (no officials row) must never surface here.
    const bystander = await seedOrg();
    const [{ id: playerPersonId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${bystander.auth.orgId}, 'Just A Player') returning id`;
    const [{ id: playerClaimId }] = await sql<{ id: string }[]>`
      insert into person_claims (org_id, person_id, email, token_hash, invited_by, expires_at)
      values (${bystander.auth.orgId}, ${playerPersonId}, ${ref.email}, ${randomUUID()}, ${bystander.auth.userId}, now() + interval '14 days')
      returning id`;

    // before claiming anything: NOT is_official, but both officiating
    // invites are pending — the player-claim row does NOT show up.
    expect((await getMyOfficiating(ref.id)).is_official).toBe(false);
    const pending = await listPendingOfficiatingClaims(ref.email);
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.org_name).sort()).toEqual([orgNameA, orgNameB].sort());
    expect(pending.every((p) => !("token" in p) && !("email" in p))).toBe(true);

    // case-insensitive email match, same as the token path.
    expect(await listPendingOfficiatingClaims(ref.email.toUpperCase())).toHaveLength(2);

    // a stranger sharing no claim sees nothing.
    const stranger = await makeUser("stranger-off");
    expect(await listPendingOfficiatingClaims(stranger.email)).toHaveLength(0);

    // wrong email → refused with the GENERIC not-found response, nothing
    // consumed. (review fix 2026-07-17: ownership must be proven before any
    // state — claimed/expired/revoked/not-officiating — is revealed; a
    // non-owner must not be able to tell a pending claim from a bogus id.)
    const impostor = await makeUser("impostor-off");
    await expect(
      acceptMyOfficiatingClaim(invitedA.claim.id, impostor.id, impostor.email),
    ).rejects.toMatchObject({ status: 404, code: "CLAIM_INVALID" });

    // accept org A by id — links + consumes ONLY that claim; org B stays pending.
    const acceptedA = await acceptMyOfficiatingClaim(invitedA.claim.id, ref.id, ref.email);
    expect(acceptedA).toMatchObject({ org_name: orgNameA, official_name: "Ref A-side" });
    const afterA = await listPendingOfficiatingClaims(ref.email);
    expect(afterA).toHaveLength(1);
    expect(afterA[0]!.org_name).toBe(orgNameB);
    const mineAfterA = await getMyOfficiating(ref.id);
    expect(mineAfterA.is_official).toBe(true); // linked via org A even though org B is still pending

    // re-accepting the now-claimed id (as the real owner) 409s, doesn't
    // silently no-op — this differentiation is fine because ownership is
    // proven (ref.email matches).
    await expect(
      acceptMyOfficiatingClaim(invitedA.claim.id, ref.id, ref.email),
    ).rejects.toMatchObject({ status: 409, code: "CLAIM_CLAIMED" });

    // a NON-owner probing that same now-claimed id gets the identical
    // generic 404 — never CLAIM_CLAIMED. No state leak either direction.
    await expect(
      acceptMyOfficiatingClaim(invitedA.claim.id, impostor.id, impostor.email),
    ).rejects.toMatchObject({ status: 404, code: "CLAIM_INVALID" });

    // accept org B by id — the second org links too (multi-org proof).
    await acceptMyOfficiatingClaim(invitedB.claim.id, ref.id, ref.email);
    expect(await listPendingOfficiatingClaims(ref.email)).toHaveLength(0);
    const consoleA = await listOfficialsForConsole(orgA.auth);
    const consoleB = await listOfficialsForConsole(orgB.auth);
    expect(consoleA.find((o) => o.id === officialA.id)).toMatchObject({ claimed: true });
    expect(consoleB.find((o) => o.id === officialB.id)).toMatchObject({ claimed: true });

    // a bare player claim (no officials row), accepted by its real owner,
    // 404s with its OWN code — that flow stays on the token-based /claim
    // page, not the officiating accept-by-id route.
    await expect(
      acceptMyOfficiatingClaim(playerClaimId, ref.id, ref.email),
    ).rejects.toMatchObject({ status: 404, code: "CLAIM_NOT_OFFICIATING" });

    // expired claims never surface as pending, and their real owner is
    // refused with CLAIM_EXPIRED (ownership proven, state may differentiate)…
    const officialC = await createOfficial(orgA.auth, { display_name: "Ref Expired", role_keys: ["referee"] });
    const invitedC = await inviteOfficial(orgA.auth, officialC.id, "expired@example.com");
    await sql`update person_claims set expires_at = now() - interval '1 minute' where id = ${invitedC.claim.id}`;
    const expiredUser = await makeUser("expired-ref");
    expect(await listPendingOfficiatingClaims("expired@example.com")).toHaveLength(0);
    await expect(
      acceptMyOfficiatingClaim(invitedC.claim.id, expiredUser.id, "expired@example.com"),
    ).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });
    // …but a non-owner probing the SAME expired claim gets the identical
    // generic 404 as any other non-owner attempt — expiry is state, and
    // state never leaks past ownership.
    await expect(
      acceptMyOfficiatingClaim(invitedC.claim.id, impostor.id, impostor.email),
    ).rejects.toMatchObject({ status: 404, code: "CLAIM_INVALID" });

    // revoked claims never surface as pending either.
    const officialE = await createOfficial(orgA.auth, { display_name: "Ref Revoked", role_keys: ["referee"] });
    const invitedE = await inviteOfficial(orgA.auth, officialE.id, "revoked@example.com");
    await sql`update person_claims set revoked_at = now() where id = ${invitedE.claim.id}`;
    expect(await listPendingOfficiatingClaims("revoked@example.com")).toHaveLength(0);

    // the token flow still works after the shared-core refactor.
    const officialD = await createOfficial(orgA.auth, { display_name: "Ref Token", role_keys: ["referee"] });
    const invitedD = await inviteOfficial(orgA.auth, officialD.id, "token-ref@example.com");
    const tokenUser = await makeUser("token-ref");
    await claimPerson(invitedD.secret, tokenUser.id, "token-ref@example.com");
    expect((await getMyOfficiating(tokenUser.id)).is_official).toBe(true);
  });
});
