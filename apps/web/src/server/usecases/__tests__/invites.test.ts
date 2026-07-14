// Invite creation semantics (team settings "invite by email" + persistent
// invite links): email invites are forced single-use with a 7-day expiry;
// link invites honour expires_in_days (the old route hardcoded a 1-hour TTL,
// which made links vanish from the Team panel within the hour); the
// courtside-QR default (no expiry args → 1 hour) is preserved.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { acceptInvite, loadInvite } from "@/lib/invites";
import { createInvite, EMAIL_INVITE_TTL_DAYS } from "../invites";

const HAS_DB = !!process.env.DATABASE_URL;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Wide-but-safe window: wall clock may tick between the insert and the assert.
const TOLERANCE_MS = 5 * 60 * 1000;

async function makeUser(email: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${email}, 'user') returning id`;
  return id;
}

async function seedOrg(): Promise<{ orgId: string; ownerId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name)
    values (${`owner-${suffix}@test.local`}, 'owner') returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Org " + suffix}, ${"org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  return { orgId, ownerId };
}

function expectExpiryNear(expiresAt: string | null, expectedFromNowMs: number) {
  expect(expiresAt).not.toBeNull();
  const delta = new Date(expiresAt!).getTime() - Date.now();
  expect(delta).toBeGreaterThan(expectedFromNowMs - TOLERANCE_MS);
  expect(delta).toBeLessThan(expectedFromNowMs + TOLERANCE_MS);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("createInvite (team invites)", () => {
  it("link invite honours expires_in_days and keeps unlimited uses", async () => {
    const { orgId, ownerId } = await seedOrg();
    const invite = await createInvite(orgId, ownerId, {
      role: "viewer",
      max_uses: 0,
      expires_in_days: 30,
    });
    expect(invite.email).toBeNull();
    expect(invite.max_uses).toBe(0);
    expectExpiryNear(invite.expires_at, 30 * DAY_MS);
  });

  it("no expiry args → legacy one-hour TTL (courtside QR default)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const invite = await createInvite(orgId, ownerId, {
      role: "scorer",
      max_uses: 1,
    });
    expectExpiryNear(invite.expires_at, HOUR_MS);
  });

  it("expires_in_days: null → never expires", async () => {
    const { orgId, ownerId } = await seedOrg();
    const invite = await createInvite(orgId, ownerId, {
      role: "viewer",
      max_uses: 0,
      expires_in_days: null,
    });
    expect(invite.expires_at).toBeNull();
  });

  it("email invite: address stored lowercased, single-use forced, 7-day expiry", async () => {
    const { orgId, ownerId } = await seedOrg();
    const invite = await createInvite(orgId, ownerId, {
      role: "admin",
      max_uses: 0, // deliberately unlimited — email invites must override this
      email: "  New.Member@Club.ORG ",
    });
    expect(invite.email).toBe("new.member@club.org");
    expect(invite.max_uses).toBe(1);
    expectExpiryNear(invite.expires_at, EMAIL_INVITE_TTL_DAYS * DAY_MS);
  });

  it("email invite: only the invited address may accept (403, use not burnt)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const suffix = randomUUID().slice(0, 8);
    const invited = `invited-${suffix}@club.org`;
    const invite = await createInvite(orgId, ownerId, {
      role: "viewer",
      max_uses: 1,
      email: invited,
    });

    const stranger = await makeUser(`stranger-${suffix}@test.local`);
    const row = await loadInvite(invite.token);
    try {
      await acceptInvite(row!, stranger);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(403);
    }
    expect((await loadInvite(invite.token))!.used_count).toBe(0);
    const [member] = await sql`
      select 1 from org_members where org_id = ${orgId} and user_id = ${stranger}`;
    expect(member).toBeUndefined();
  });

  it("email invite: the invited address joins (case-insensitive match)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const suffix = randomUUID().slice(0, 8);
    const invite = await createInvite(orgId, ownerId, {
      role: "viewer",
      max_uses: 1,
      email: `invited-${suffix}@club.org`,
    });
    // Address case differs from the stored (lowercased) invite email.
    const invitee = await makeUser(`Invited-${suffix}@Club.ORG`);
    const outcome = await acceptInvite((await loadInvite(invite.token))!, invitee);
    expect(outcome).toBe("joined");
    const [member] = await sql<{ role: string }[]>`
      select role from org_members where org_id = ${orgId} and user_id = ${invitee}`;
    expect(member?.role).toBe("viewer");
  });

  it("default_scope on a non-scorer invite is rejected (400)", async () => {
    const { orgId, ownerId } = await seedOrg();
    try {
      await createInvite(orgId, ownerId, {
        role: "viewer",
        max_uses: 1,
        default_scope: { type: "division", id: randomUUID() },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
    }
  });
});
