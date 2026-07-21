// Scoped API keys end-to-end through the auth door (v3/08 §2, PROMPT-37):
// read key 403s on a manage route, pinned key 403s outside its competition,
// per-key rate limit 429s after the burst. Real Postgres; no Redis — the
// limiter's in-process window makes the 429 observable.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { requireOrgAuth } from "@/server/api-v1/auth";
import { createApiKey } from "@/server/usecases/api-keys";
import type { AuthCtx } from "@/server/api-v1/auth";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

interface Seed {
  orgId: string;
  compA: string;
  compB: string;
  session: AuthCtx;
}

async function seedOrg(): Promise<Seed> {
  const s = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Keys " + s}, ${"keys-" + s}) returning id`;
  // Community org with api.access + api.write overrides — exercises the
  // override path and puts the key on the 60 rpm (free) budget. This suite
  // is about scope authorization at the auth door, not entitlement gating
  // (that's covered by the api.write matrix row, V290), so manage/write
  // scopes are unblocked here via override.
  await setOrgPlan(orgId, "community");
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, 'api.access', true, 'test')
    on conflict (org_id, feature_key) do update set bool_value = true`;
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, 'api.write', true, 'test')
    on conflict (org_id, feature_key) do update set bool_value = true`;
  const mk = async (name: string) => {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug)
      values (${orgId}, ${name + " " + s}, ${name.toLowerCase() + "-" + s}) returning id`;
    return id;
  };
  const compA = await mk("Alpha");
  const compB = await mk("Beta");
  const session: AuthCtx = {
    orgId,
    via: "session",
    userId: null,
    role: "owner",
    keyId: null,
  };
  return { orgId, compA, compB, session };
}

function keyedRequest(secret: string, method: string, path: string): Request {
  return new Request(`https://test.local/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}` },
  });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("scoped API keys at the auth door", () => {
  it("read key: GET passes, manage-scoped POST is 403 with an actionable message", async () => {
    const { orgId, session } = await seedOrg();
    const { secret } = await createApiKey(session, {
      name: "reader",
      scopes: ["read"],
    });

    const ctx = await requireOrgAuth(keyedRequest(secret, "GET", "/competitions"), orgId, "read");
    expect(ctx.via).toBe("api_key");

    await expect(
      requireOrgAuth(keyedRequest(secret, "POST", "/competitions"), orgId, "write"),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("'manage' scope"),
    });
  });

  it("unlisted route is default-denied even for a manage key", async () => {
    const { orgId, session } = await seedOrg();
    const { secret } = await createApiKey(session, {
      name: "manager",
      scopes: ["manage"],
    });
    await expect(
      requireOrgAuth(keyedRequest(secret, "POST", "/orgs/x/api-keys"), orgId, "write"),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("cannot access"),
    });
  });

  it("legacy write scope still authenticates as manage", async () => {
    const { orgId, session } = await seedOrg();
    const { secret } = await createApiKey(session, {
      name: "legacy",
      scopes: ["write"],
    });
    const ctx = await requireOrgAuth(keyedRequest(secret, "POST", "/competitions"), orgId, "write");
    expect(ctx.via).toBe("api_key");
  });

  it("pinned key works inside its competition, 403s outside and on org-wide routes", async () => {
    const { orgId, compA, compB, session } = await seedOrg();
    const { secret } = await createApiKey(session, {
      name: "vendor",
      scopes: ["read"],
      competition_id: compA,
    });

    const ok = await requireOrgAuth(
      keyedRequest(secret, "GET", `/competitions/${compA}`),
      orgId,
      "read",
    );
    expect(ok.orgId).toBe(orgId);

    await expect(
      requireOrgAuth(keyedRequest(secret, "GET", `/competitions/${compB}`), orgId, "read"),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("pinned"),
    });

    // Org-wide collection: unpinnable → 403.
    await expect(
      requireOrgAuth(keyedRequest(secret, "GET", "/competitions"), orgId, "read"),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("org-wide"),
    });
  });

  it.skipIf(!!process.env.REDIS_URL)(
    "free-plan key rate limit trips 429 after 60 requests in the window",
    async () => {
      const { orgId, compA, session } = await seedOrg();
      const { secret } = await createApiKey(session, {
        name: "bursty",
        scopes: ["read"],
        competition_id: compA,
      });
      for (let i = 0; i < 60; i++) {
        await requireOrgAuth(keyedRequest(secret, "GET", `/competitions/${compA}`), orgId, "read");
      }
      await expect(
        requireOrgAuth(keyedRequest(secret, "GET", `/competitions/${compA}`), orgId, "read"),
      ).rejects.toMatchObject({ status: 429 });
    },
    30_000,
  );
});
