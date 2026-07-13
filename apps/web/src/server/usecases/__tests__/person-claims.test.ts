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
  createClaimInvite,
  revokeClaimInvite,
  getOpenClaim,
  resolveClaimToken,
  claimPerson,
  unlinkPerson,
} from "../person-claims";
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
    await claimPerson(invite.secret, playerId);
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
    await claimPerson(invite.secret, await makeUser("sam"));
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
    await expect(claimPerson(invite.secret, await makeUser("sam"))).rejects.toMatchObject({
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
      claimPerson(invite.secret, a),
      claimPerson(invite.secret, b),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    expect(wins).toBe(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((loser.reason as HttpError).code).toBe("CLAIM_CLAIMED");
  });

  it("unlink detaches the login, closes claims, keeps the audit rows", async () => {
    const { owner, person } = await rig();
    const invite = await createClaimInvite(owner, person.id, "sam@test.local");
    await claimPerson(invite.secret, await makeUser("sam"));
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
