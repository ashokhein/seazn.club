// PROMPT-53 claim lifecycle: invite → resolve → claim; expired/revoked/
// claimed tokens fail with distinct codes; re-invite revokes the prior open
// claim (the one-open-claim partial unique never trips); unlink detaches the
// login and closes claim rows without deleting the audit trail.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  acceptResolvedClaim,
  createClaimInvite,
  revokeClaimInvite,
  getOpenClaim,
  resolveClaimToken,
  claimPerson,
  unlinkPerson,
} from "../person-claims";
import { createOfficial, inviteOfficial } from "../officials";
import { createPerson } from "../persons";

const HAS_DB = !!process.env.DATABASE_URL;

async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

async function seedOrg(): Promise<{ orgId: string; ownerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Claim Org " + suffix}, ${"claim-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  return { orgId, ownerId };
}

const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

async function rig() {
  const { orgId, ownerId } = await seedOrg();
  const owner = asOwner(orgId, ownerId);
  const person = await createPerson(owner, {
    full_name: "Sam Player",
    consent: {},
  } as never);
  return { orgId, ownerId, owner, person };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("person claims (PROMPT-53)", () => {
  it("invite → resolve → claim links the user; token stored hashed", async () => {
    const { owner, person } = await rig();
    const invite = await createClaimInvite(owner, person.id, "sam@test.local");
    expect(invite.secret.startsWith("pc_")).toBe(true);
    expect(invite.person_name).toBe("Sam Player");

    // Raw secret never lands in the DB — only its sha256.
    const stored = await sql<{ token_hash: string }[]>`
      select token_hash from person_claims where id = ${invite.id}`;
    expect(stored[0].token_hash).not.toContain(invite.secret);

    const resolved = await resolveClaimToken(invite.secret);
    expect(resolved.person_id).toBe(person.id);
    expect(resolved.email).toBe("sam@test.local");

    const playerId = await makeUser("sam");
    await claimPerson(invite.secret, playerId, "sam@test.local");
    const [linked] = await sql<{ user_id: string | null }[]>`
      select user_id from persons where id = ${person.id}`;
    expect(linked.user_id).toBe(playerId);

    // The used token is dead with the CLAIMED code.
    await expect(resolveClaimToken(invite.secret)).rejects.toMatchObject({
      status: 409,
      code: "CLAIM_CLAIMED",
    });
  });

  it("inviting an already-claimed person → 409 ALREADY_CLAIMED", async () => {
    const { owner, person } = await rig();
    const invite = await createClaimInvite(owner, person.id, "sam@test.local");
    await claimPerson(invite.secret, await makeUser("sam"), "sam@test.local");
    await expect(createClaimInvite(owner, person.id, "again@test.local")).rejects.toMatchObject({
      status: 409,
      code: "ALREADY_CLAIMED",
    });
  });

  it("expired token → CLAIM_EXPIRED; claim refused", async () => {
    const { owner, person } = await rig();
    const invite = await createClaimInvite(owner, person.id, "sam@test.local");
    await sql`update person_claims set expires_at = now() - interval '1 minute'
              where id = ${invite.id}`;
    await expect(resolveClaimToken(invite.secret)).rejects.toMatchObject({
      status: 401,
      code: "CLAIM_EXPIRED",
    });
    await expect(
      claimPerson(invite.secret, await makeUser("sam"), "sam@test.local"),
    ).rejects.toMatchObject({
      code: "CLAIM_EXPIRED",
    });
  });

  it("revoked token → CLAIM_REVOKED; garbage token → CLAIM_INVALID", async () => {
    const { owner, person } = await rig();
    const invite = await createClaimInvite(owner, person.id, "sam@test.local");
    await revokeClaimInvite(owner, person.id);
    await expect(resolveClaimToken(invite.secret)).rejects.toMatchObject({
      status: 401,
      code: "CLAIM_REVOKED",
    });
    await expect(resolveClaimToken("pc_not-a-real-token")).rejects.toMatchObject({
      code: "CLAIM_INVALID",
    });
  });

  it("re-invite revokes the prior open claim (one open claim per person)", async () => {
    const { owner, person } = await rig();
    const first = await createClaimInvite(owner, person.id, "one@test.local");
    const second = await createClaimInvite(owner, person.id, "two@test.local");
    await expect(resolveClaimToken(first.secret)).rejects.toMatchObject({
      code: "CLAIM_REVOKED",
    });
    await expect(resolveClaimToken(second.secret)).resolves.toMatchObject({
      person_id: person.id,
    });
    const open = await getOpenClaim(owner, person.id);
    expect(open?.id).toBe(second.id);
    expect(open && "secret" in open).toBe(false);
  });

  it("racing accepts: exactly one wins, the loser gets CLAIM_CLAIMED", async () => {
    const { owner, person } = await rig();
    const invite = await createClaimInvite(owner, person.id, "sam@test.local");
    const [a, b] = [await makeUser("a"), await makeUser("b")];
    const results = await Promise.allSettled([
      claimPerson(invite.secret, a, "sam@test.local"),
      claimPerson(invite.secret, b, "sam@test.local"),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    expect(wins).toBe(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((loser.reason as HttpError).code).toBe("CLAIM_CLAIMED");
  });

  it("strict match: a different signed-in address is refused; case doesn't matter", async () => {
    const { owner, person } = await rig();
    const invite = await createClaimInvite(owner, person.id, "sam@test.local");
    await expect(
      claimPerson(invite.secret, await makeUser("impostor"), "impostor@test.local"),
    ).rejects.toMatchObject({
      status: 403,
      code: "CLAIM_EMAIL_MISMATCH",
    });
    // The person is untouched by the refused attempt…
    const [row] = await sql<{ user_id: string | null }[]>`
      select user_id from persons where id = ${person.id}`;
    expect(row.user_id).toBeNull();
    // …and the right address still claims, case-insensitively.
    await claimPerson(invite.secret, await makeUser("sam"), "SAM@Test.Local");
  });

  it("unlink detaches the login, closes claims, keeps the audit rows", async () => {
    const { owner, person } = await rig();
    const invite = await createClaimInvite(owner, person.id, "sam@test.local");
    await claimPerson(invite.secret, await makeUser("sam"), "sam@test.local");
    await unlinkPerson(owner, person.id);

    const [row] = await sql<{ user_id: string | null }[]>`
      select user_id from persons where id = ${person.id}`;
    expect(row.user_id).toBeNull();

    // Audit trail intact: the claim row shows claimed AND later revoked.
    const claims = await sql<{ claimed_at: string | null; revoked_at: string | null }[]>`
      select claimed_at, revoked_at from person_claims where person_id = ${person.id}`;
    expect(claims).toHaveLength(1);
    expect(claims[0].claimed_at).not.toBeNull();
    expect(claims[0].revoked_at).not.toBeNull();

    // And the person can be invited again after unlink.
    const again = await createClaimInvite(owner, person.id, "back@test.local");
    await expect(resolveClaimToken(again.secret)).resolves.toMatchObject({
      person_id: person.id,
    });
  });

  it("api-key auth cannot mint or revoke claim invites", async () => {
    const { orgId, person, owner } = await rig();
    const keyAuth: AuthCtx = { orgId, via: "api_key", userId: null, role: null, keyId: "k1" };
    await expect(createClaimInvite(keyAuth, person.id, "x@test.local")).rejects.toMatchObject({
      status: 403,
    });
    await expect(revokeClaimInvite(keyAuth, person.id)).rejects.toMatchObject({ status: 403 });
    // owner path still fine
    await expect(createClaimInvite(owner, person.id, "x@test.local")).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// #402 — the failure mode the V345 revert cited by name.
//
// `acceptResolvedClaim` runs a bare `update persons set user_id`. Under
// persons_org_user_lane_uq that raises 23505 for a user who already holds a
// PLAYER person in the org and claims a second one. The lane column removed the
// player-vs-official collision entirely, so what is left is precisely the
// duplicate #402 exists to eliminate — it must surface as a clean 409 pointing
// at the merge route (#404), never a 500 carrying a constraint name.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("duplicate player link (#402)", () => {
  it("a second player-lane claim in one org is a 409, not a constraint 500", async () => {
    const { owner, orgId, person: first } = await rig();
    const claimantEmail = `dup-${randomUUID().slice(0, 8)}@test.local`;
    const userId = await makeUser("claimant");

    // The user already holds a player person here — the state a duplicate hits.
    await sql`update persons set user_id = ${userId} where id = ${first.id}`;

    const second = await createPerson(owner, {
      full_name: "Duplicate Of Them",
      consent: {},
    } as never);
    const invite = await createClaimInvite(owner, second.id, claimantEmail);
    const claim = await resolveClaimToken(invite.secret);

    await expect(acceptResolvedClaim(claim, userId)).rejects.toMatchObject({
      status: 409,
      code: "PERSON_ALREADY_LINKED",
    });

    // The first link is untouched, and the duplicate stays unclaimed.
    const rows = await sql<{ id: string; user_id: string | null }[]>`
      select id, user_id from persons
       where org_id = ${orgId} and id in (${first.id}, ${second.id})`;
    expect(rows.find((r) => r.id === first.id)?.user_id).toBe(userId);
    expect(rows.find((r) => r.id === second.id)?.user_id).toBeNull();
    const [{ n }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${orgId} and user_id = ${userId} and lane = 'player'`;
    expect(Number(n)).toBe(1);
  });

  // ACCEPTED BEHAVIOUR, NOT A BUG — do not "fix" this by relaxing the guard.
  //
  // `createOfficial({ person_id })` binds an official role to an EXISTING person
  // without moving it out of the player lane (only inviteOfficial mints a
  // lane='official' row). So a human who is an official through a player-lane
  // person, and who already holds their own player-lane person in the same org,
  // hits persons_org_user_lane_uq on the claim: two player-lane rows for one
  // account is exactly the duplicate identity #402 exists to prevent.
  //
  // Failing closed with a 409 beats silently minting a second identity or
  // fusing two records. The recovery route is #404's duplicate review + merge
  // tool, which the 409's code points the organiser at.
  it("an official bound to a PLAYER-lane person is refused a second claim (accepted, see #404)", async () => {
    const { owner, orgId, person: own } = await rig();
    const userId = await makeUser("official-and-player");

    // The human's own player-lane person, already linked to their account.
    await sql`update persons set user_id = ${userId} where id = ${own.id}`;

    // A SECOND person for the same human, bound as an official via person_id —
    // still lane='player', because createOfficial does not move the lane.
    const officialPerson = await createPerson(owner, {
      full_name: "Same Human, Official Hat",
      consent: {},
    } as never);
    const official = await createOfficial(owner, {
      display_name: "Same Human, Official Hat",
      person_id: officialPerson.id,
      role_keys: ["referee"],
    });
    expect(official.person_id).toBe(officialPerson.id);
    const [lane] = await sql<{ lane: string }[]>`
      select lane from persons where id = ${officialPerson.id}`;
    expect(lane.lane).toBe("player"); // the premise: NOT moved to the official lane

    const invite = await createClaimInvite(
      owner,
      officialPerson.id,
      `official-${randomUUID().slice(0, 8)}@test.local`,
    );
    const claim = await resolveClaimToken(invite.secret);

    await expect(acceptResolvedClaim(claim, userId)).rejects.toMatchObject({
      status: 409,
      code: "PERSON_ALREADY_LINKED",
    });

    // Nothing was merged and nothing was minted: one player-lane person for the
    // account, and the official's person is still waiting for #404.
    const [{ n: linked }] = await sql<{ n: string }[]>`
      select count(*)::text as n from persons
       where org_id = ${orgId} and user_id = ${userId} and lane = 'player'`;
    expect(Number(linked)).toBe(1);
    const [after] = await sql<{ user_id: string | null }[]>`
      select user_id from persons where id = ${officialPerson.id}`;
    expect(after.user_id).toBeNull();
  });

  // REGRESSION (smoke.ts:3507 "off accept-by-id links the second org without
  // the emailed token" + "off official <id> claimed=true").
  //
  // One org may carry the same human on the officials roster twice, and
  // `inviteOfficial` mints a FRESH lane='official' person for every officials
  // row whose person_id is null — it has no way to dedupe, because at invite
  // time the person is unclaimed and the user is unknown. So the second claim
  // legitimately produces a second official-lane person for one user in one
  // org. persons_org_user_lane_uq must not forbid that: #402 needs uniqueness
  // in the PLAYER lane only, which is the lane `resolvePlayerPerson` upserts
  // on. A lane-wide index turned this long-standing flow into a 409.
  it("a second officiating claim in one org links its own official-lane person", async () => {
    const { owner, orgId } = await rig();
    const refEmail = `ref-${randomUUID().slice(0, 8)}@test.local`;
    const refUser = await makeUser("ref");

    // Exactly the smoke sequence: create → invite → claim, twice, one org.
    const first = await createOfficial(owner, {
      display_name: "Ria Ref",
      role_keys: ["referee"],
    });
    expect(first.person_id).toBeNull(); // the premise: no person bound at create
    const inviteOne = await inviteOfficial(owner, first.id, refEmail);
    await claimPerson(inviteOne.secret, refUser, refEmail);

    const second = await createOfficial(owner, {
      display_name: "Ria Ref Two",
      role_keys: ["referee"],
    });
    const inviteTwo = await inviteOfficial(owner, second.id, refEmail);
    await expect(claimPerson(inviteTwo.secret, refUser, refEmail)).resolves.toMatchObject({
      person_id: inviteTwo.official.person_id!,
    });

    // Two DISTINCT official-lane persons, both linked to the one account.
    expect(inviteTwo.official.person_id).not.toBe(inviteOne.official.person_id);
    const linked = await sql<{ id: string; lane: string }[]>`
      select id, lane from persons
       where org_id = ${orgId} and user_id = ${refUser} order by created_at`;
    expect(linked.map((r) => r.lane)).toEqual(["official", "official"]);
    expect(linked.map((r) => r.id)).toEqual([
      inviteOne.official.person_id,
      inviteTwo.official.person_id,
    ]);

    // …and both officials rows read as claimed, the exact join the smoke's
    // checkOfficialClaimed runs.
    const claimed = await sql<{ id: string; claimed: boolean }[]>`
      select o.id, (p.user_id is not null) as claimed
        from officials o join persons p on p.id = o.person_id
       where o.id in (${first.id}, ${second.id})`;
    expect(claimed).toHaveLength(2);
    expect(claimed.every((r) => r.claimed)).toBe(true);
  });
});
