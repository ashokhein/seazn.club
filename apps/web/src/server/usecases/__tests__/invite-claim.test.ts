// Email-invite auto-login/auto-join (claimEmailInvite): the pure DB core behind
// POST /api/invites/[token]/claim. It signs in + joins a NEW or UNVERIFIED
// invitee in one step, but refuses to auto-login a VERIFIED account (a forwarded
// invite must never take over a real account) — that case returns needs_signin
// so the route falls back to normal sign-in. Cookie/session minting lives in the
// route; this core is DB-only so it is testable here.
// Real Postgres required; skipped without DATABASE_URL. inviteLanding is pure and
// always runs.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { claimEmailInvite, inviteLanding, loadInvite } from "@/lib/invites";
import { createInvite } from "../invites";

const HAS_DB = !!process.env.DATABASE_URL;

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

/** Create a personal email invite for a fresh address; returns token + email. */
async function emailInvite(
  orgId: string,
  ownerId: string,
  role: "admin" | "viewer" | "scorer" = "viewer",
): Promise<{ token: string; email: string }> {
  const email = `invitee-${randomUUID().slice(0, 8)}@club.org`;
  const invite = await createInvite(orgId, ownerId, { role, max_uses: 1, email });
  return { token: invite.token, email };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("inviteLanding (pure)", () => {
  it("scorer role lands on /my-matches", () => {
    expect(inviteLanding("scorer", "joined")).toBe("/my-matches");
  });
  it("a scope added to an existing member lands on /my-matches", () => {
    expect(inviteLanding("viewer", "scope_added")).toBe("/my-matches");
  });
  it("a plain join lands on /dashboard", () => {
    expect(inviteLanding("viewer", "joined")).toBe("/dashboard");
    expect(inviteLanding("admin", "joined")).toBe("/dashboard");
  });
});

describe.skipIf(!HAS_DB)("claimEmailInvite", () => {
  it("brand-new email: creates a verified account and joins in one step", async () => {
    const { orgId, ownerId } = await seedOrg();
    const { token, email } = await emailInvite(orgId, ownerId, "admin");

    const result = await claimEmailInvite(token);

    expect(result.needs_signin).toBe(false);
    if (result.needs_signin) return; // narrow
    expect(result.org_id).toBe(orgId);
    expect(result.role).toBe("admin");
    expect(result.outcome).toBe("joined");

    const [u] = await sql<{ email_verified: boolean }[]>`
      select email_verified from users where id = ${result.user_id}`;
    expect(u.email_verified).toBe(true);
    const [m] = await sql<{ role: string }[]>`
      select role from org_members where org_id = ${orgId} and user_id = ${result.user_id}`;
    expect(m?.role).toBe("admin");
    // The address the account was created under is the invited one (lowercased).
    const [byEmail] = await sql<{ id: string }[]>`
      select id from users where email = ${email.toLowerCase()}`;
    expect(byEmail.id).toBe(result.user_id);
  });

  it("existing UNVERIFIED account: signs in + joins, flips email_verified", async () => {
    const { orgId, ownerId } = await seedOrg();
    const { token, email } = await emailInvite(orgId, ownerId, "viewer");
    // Inert account: exists but never confirmed an inbox — nothing to steal.
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${email.toLowerCase()}, 'Invitee', false) returning id`;

    const result = await claimEmailInvite(token);

    expect(result.needs_signin).toBe(false);
    if (result.needs_signin) return;
    expect(result.user_id).toBe(userId);
    expect(result.outcome).toBe("joined");
    const [u] = await sql<{ email_verified: boolean }[]>`
      select email_verified from users where id = ${userId}`;
    expect(u.email_verified).toBe(true);
    const [m] = await sql`
      select 1 from org_members where org_id = ${orgId} and user_id = ${userId}`;
    expect(m).toBeDefined();
  });

  it("existing VERIFIED account: refuses to auto-login (needs_signin, no join)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const { token, email } = await emailInvite(orgId, ownerId, "viewer");
    // A real account with data: a forwarded invite must NOT hand a session to it.
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${email.toLowerCase()}, 'Real Person', true) returning id`;

    const result = await claimEmailInvite(token);

    expect(result.needs_signin).toBe(true);
    // No join, and the single use is NOT burnt — they can still sign in to accept.
    const [m] = await sql`
      select 1 from org_members where org_id = ${orgId} and user_id = ${userId}`;
    expect(m).toBeUndefined();
    expect((await loadInvite(token))!.used_count).toBe(0);
  });

  it("shareable link (no bound email): not claimable, needs_signin", async () => {
    const { orgId, ownerId } = await seedOrg();
    const link = await createInvite(orgId, ownerId, { role: "viewer", max_uses: 0 });

    const result = await claimEmailInvite(link.token);

    expect(result.needs_signin).toBe(true);
    expect((await loadInvite(link.token))!.used_count).toBe(0);
  });

  it("revoked invite: throws, and creates no account for the address", async () => {
    const { orgId, ownerId } = await seedOrg();
    const { token, email } = await emailInvite(orgId, ownerId, "viewer");
    await sql`update org_invites set revoked = true where token = ${token}`;

    await expect(claimEmailInvite(token)).rejects.toBeInstanceOf(HttpError);
    const rows = await sql`select 1 from users where email = ${email.toLowerCase()}`;
    expect(rows.length).toBe(0);
  });
});
