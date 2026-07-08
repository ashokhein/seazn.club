// Unit coverage for passwordless sign-in tokens (lib/login-link.ts): consume
// returns the user id and verifies the email, single-use, unknown/expired
// tokens are rejected, and issuing a new link invalidates the previous one.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { createLoginLink, consumeLoginLink } from "@/lib/login-link";

const HAS_DB = !!process.env.DATABASE_URL;

async function makeUser(verified = false): Promise<string> {
  const email = `magic-${randomUUID().slice(0, 8)}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, 'Magic', ${verified})
    returning id`;
  return id;
}

describe.skipIf(!HAS_DB)("login-link (passwordless sign-in tokens)", () => {
  const created: string[] = [];
  const track = async (verified = false) => {
    const id = await makeUser(verified);
    created.push(id);
    return id;
  };

  afterAll(async () => {
    if (!HAS_DB) return;
    if (created.length) await sql`delete from users where id in ${sql(created)}`;
    await sql.end();
  });

  it("consume returns the user id and marks the email verified", async () => {
    const userId = await track(false);
    const token = await createLoginLink(userId);
    expect(await consumeLoginLink(token)).toBe(userId);
    const [{ email_verified }] = await sql<{ email_verified: boolean }[]>`
      select email_verified from users where id = ${userId}`;
    expect(email_verified).toBe(true);
  });

  it("is single-use", async () => {
    const userId = await track();
    const token = await createLoginLink(userId);
    expect(await consumeLoginLink(token)).toBe(userId);
    expect(await consumeLoginLink(token)).toBeNull();
  });

  it("rejects an unknown token", async () => {
    expect(await consumeLoginLink(`nope-${randomUUID()}`)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const userId = await track();
    const token = `expired-${randomUUID()}`;
    await sql`
      insert into login_links (user_id, token, expires_at)
      values (${userId}, ${token}, now() - interval '1 minute')`;
    expect(await consumeLoginLink(token)).toBeNull();
  });

  it("issuing a new link invalidates the previous unused one", async () => {
    const userId = await track();
    const first = await createLoginLink(userId);
    const second = await createLoginLink(userId);
    expect(await consumeLoginLink(first)).toBeNull();
    expect(await consumeLoginLink(second)).toBe(userId);
  });
});
