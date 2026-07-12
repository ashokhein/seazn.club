// GET /api/users/me (task-8): a whoami endpoint the client-side analytics
// bootstrap fetches instead of the root layout reading cookies() directly
// (see analytics-bootstrap.tsx / task-8-report.md). requireUser and
// resolveActiveOrg are stubbed — real cookie/JWT auth skipped, same
// convention as app/api/orgs/[id]/__tests__/route.test.ts; the plan_key
// lookup runs for real against the migrated test Postgres via a seeded
// subscriptions row.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { AuthError } from "@/lib/errors";
import type { OrgMembership, User } from "@/lib/types";

const HAS_DB = !!process.env.DATABASE_URL;

const fakeUser: User = {
  id: randomUUID(),
  display_name: "Me Route Test",
  email: "me-route-test@test.local",
  avatar_url: null,
};

const requireUserMock = vi.fn<() => Promise<User>>();
const resolveActiveOrgMock = vi.fn<(user: User) => Promise<OrgMembership | null>>();

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: () => requireUserMock(),
    resolveActiveOrg: (user: User) => resolveActiveOrgMock(user),
  };
});

import { GET } from "../route";

async function seedOrgWithPlan(plan: string): Promise<OrgMembership> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await sql<
    { id: string; name: string; slug: string; created_by: string | null; created_at: string }[]
  >`
    insert into organizations (name, slug)
    values (${"Me Route Org " + suffix}, ${"me-route-org-" + suffix})
    returning id, name, slug, created_by, created_at`;
  await sql`
    insert into subscriptions (org_id, plan_key, status)
    values (${org!.id}, ${plan}, 'active')`;
  return {
    ...org!,
    logo_url: null,
    logo_storage_path: null,
    payment_instructions: null,
    branding: null,
    role: "owner",
  };
}

beforeEach(() => {
  requireUserMock.mockReset();
  resolveActiveOrgMock.mockReset();
});

describe.skipIf(!HAS_DB)("GET /api/users/me", () => {
  it("401s when not authenticated", async () => {
    requireUserMock.mockRejectedValueOnce(new AuthError("Not authenticated"));
    const res = await GET();
    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(false);
  });

  it("200s with { id, email, org } for an authenticated user with an active org", async () => {
    const org = await seedOrgWithPlan("pro");
    requireUserMock.mockResolvedValueOnce(fakeUser);
    resolveActiveOrgMock.mockResolvedValueOnce(org);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { id: string; email: string; org: { id: string; name: string; plan: string } | null };
    };
    expect(json.ok).toBe(true);
    expect(json.data.id).toBe(fakeUser.id);
    expect(json.data.email).toBe(fakeUser.email);
    expect(json.data.org).toEqual({ id: org.id, name: org.name, plan: "pro" });
  });

  it("200s with org: null when the user belongs to no org", async () => {
    requireUserMock.mockResolvedValueOnce(fakeUser);
    resolveActiveOrgMock.mockResolvedValueOnce(null);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { org: unknown } };
    expect(json.ok).toBe(true);
    expect(json.data.org).toBeNull();
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
