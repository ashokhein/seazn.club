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
  timezone: null,
  locale: null,
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

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
async function seedOrgWithPlan(plan: string): Promise<OrgMembership> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await sql<
    {
      id: string;
      name: string;
      slug: string;
      created_by: string | null;
      created_at: string;
    }[]
  >`
    insert into organizations (name, slug)
    values (${"Me Route Org " + suffix}, ${"me-route-org-" + suffix})
    returning id, name, slug, created_by, created_at`;
  await setOrgPlan(org!.id, plan);
  return {
    ...org!,
    logo_url: null,
    logo_storage_path: null,
    payment_instructions: null,
    branding: null,
    default_payment_method: "offline",
    timezone: null,
    role: "owner",
  };
}

beforeEach(() => {
  requireUserMock.mockReset();
  resolveActiveOrgMock.mockReset();
});

// Identity endpoints must never be cacheable — an intermediary caching a 200
// would leak one user's identity to another, and a cached 401 would blind the
// post-login identify (task-8 review F3). Explicit on EVERY status, not left
// to framework defaults + external CDN rules.
const NO_STORE = "private, no-store";

describe.skipIf(!HAS_DB)("GET /api/users/me", () => {
  it("401s when not authenticated, with Cache-Control: private, no-store", async () => {
    requireUserMock.mockRejectedValueOnce(new AuthError("Not authenticated"));
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(false);
  });

  it("200s with the minimized { id, org } payload — no email — and no-store", async () => {
    const org = await seedOrgWithPlan("pro");
    requireUserMock.mockResolvedValueOnce(fakeUser);
    resolveActiveOrgMock.mockResolvedValueOnce(org);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        id: string;
        org: { id: string; name: string; plan: string } | null;
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.id).toBe(fakeUser.id);
    expect(json.data.org).toEqual({ id: org.id, name: org.name, plan: "pro" });
    // Data minimization (task-8 review F3): nothing consumes email — the
    // identify payload is {userId, orgId, orgName, plan} — so it must not
    // ride along on an endpoint fetched on every anonymous navigation.
    expect(json.data).not.toHaveProperty("email");
    expect(Object.keys(json.data).sort()).toEqual(["id", "org"]);
  });

  it("200s with org: null (and no email) when the user belongs to no org", async () => {
    requireUserMock.mockResolvedValueOnce(fakeUser);
    resolveActiveOrgMock.mockResolvedValueOnce(null);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    const json = (await res.json()) as { ok: boolean; data: { org: unknown } };
    expect(json.ok).toBe(true);
    expect(json.data.org).toBeNull();
    expect(json.data).not.toHaveProperty("email");
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
