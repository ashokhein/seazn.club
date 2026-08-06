// POST /api/admin/competitions/[id]/discovery — doc 15 §3 curation.
//
// WHAT THIS FILE IS FOR: the audit row's SCOPE, which nothing pinned. The four
// `discovery_*` actions are allowlisted in the /admin adjustments panel because
// the route targets the COMPETITION'S ORG (`comp.org_id`), not the competition.
// admin-adjustments-log.test.ts seeds those rows by hand with a hardcoded "org"
// / orgId, so it pins the action STRINGS and nothing else: change this route's
// target to `id` and all four rows silently leave every org's panel — landing
// against a target_id no org page ever queries — with that suite still green.
// The competition id is a real uuid too, so the row still inserts and still
// reads as an audit trail; it is merely unreachable.
//
// So the row is driven through the REAL route against a REAL database, the way
// the sibling suspension test drives setOrgSuspension. Only `requireUser` is
// doubled (the config-snapshot route-test idiom — the real requireStaff /
// requireSuperadmin then run against a real seeded staff row), plus the two
// side-effect modules that have no business firing in a unit run: the discovery
// cache/revalidate pair, and `hasFeature`, whose Pro gate on `feature` is a
// different route contract and not what is under test here.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { DISCOVERY_AUDIT_ACTIONS } from "@/lib/admin";
import { adjustmentsForOrg } from "@/server/usecases/admin-adjustments-log";

const requireUserMock = vi.fn<() => Promise<{ id: string }>>();
vi.mock("@/lib/auth", () => ({
  requireUser: () => requireUserMock(),
}));

vi.mock("@/server/public-site/revalidate", () => ({
  invalidateDiscoveryCache: async () => {},
  fireDiscoveryRevalidate: () => {},
}));

vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  // The `feature` verb's Pro gate is a separate contract; granting it here keeps
  // all four verbs on the happy path so the scope assertion covers every one.
  hasFeature: async () => true,
}));

import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

const post = (id: string, body: unknown) =>
  POST(
    new Request(`http://test/api/admin/competitions/${id}/discovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

const orgIds: string[] = [];
const userIds: string[] = [];

async function makeSuperadmin(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, is_staff, staff_role)
    values (${`curator-${uniq()}@test.local`}, 'Curator', true, true, 'superadmin')
    returning id`;
  userIds.push(id);
  return id;
}

/** An org plus one competition inside it. The two ids are what the assertions
 *  discriminate between, so they must be genuinely different rows. */
async function makeOrgWithCompetition(): Promise<{ orgId: string; compId: string }> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Disc " + suffix}, ${"disc-" + suffix}) returning id`;
  orgIds.push(orgId);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, status)
    values (${orgId}, ${"Cup " + suffix}, ${"cup-" + suffix}, 'live') returning id`;
  return { orgId, compId };
}

afterAll(async () => {
  if (!HAS_DB) return;
  if (orgIds.length) {
    await sql`delete from staff_audit_log where target_id = any(${orgIds})`;
    await sql`delete from competitions where org_id = any(${orgIds})`;
    await sql`delete from organizations where id = any(${orgIds})`;
  }
  if (userIds.length) {
    await sql`delete from staff_audit_log where actor_id = any(${userIds})`;
    await sql`delete from users where id = any(${userIds})`;
  }
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("POST /api/admin/competitions/[id]/discovery — audit scope", () => {
  beforeEach(() => {
    requireUserMock.mockReset();
  });

  it("audits every curation verb against the competition's ORG, not the competition", async () => {
    requireUserMock.mockResolvedValue({ id: await makeSuperadmin() });
    const { orgId, compId } = await makeOrgWithCompetition();

    for (const verb of ["feature", "unfeature", "block", "unblock"] as const) {
      const res = await post(compId, { action: verb, reason: `${verb} reason` });
      expect(res.status, `${verb} did not succeed`).toBe(200);
    }

    // The rows exist, and every one of them is filed against the ORG. Reading
    // target_id straight out of the table is the point: this is the value the
    // panel's `target_id = ${orgId}` predicate matches on, and swapping
    // `comp.org_id` for `id` in the route changes exactly this column.
    const rows = await sql<{ action: string; target_type: string; target_id: string }[]>`
      select action, target_type, target_id from staff_audit_log
       where target_id in (${orgId}, ${compId}) and action like 'discovery\\_%'
       order by created_at`;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.target_type).toBe("org");
      expect(row.target_id, `${row.action} was filed against the wrong target`).toBe(orgId);
      expect(row.target_id).not.toBe(compId);
    }
    expect(rows.map((r) => r.action).sort()).toEqual([...DISCOVERY_AUDIT_ACTIONS].sort());

    // …and therefore they reach the org's panel. The negative half matters as
    // much: a competition id is a valid uuid, so a mis-scoped row still inserts
    // and still reads back — it is just unreachable from any org page.
    const entries = await adjustmentsForOrg(orgId);
    expect(entries.map((e) => e.action).sort()).toEqual([...DISCOVERY_AUDIT_ACTIONS].sort());
    for (const entry of entries) expect(entry.category).toBe("discovery");
    expect(await adjustmentsForOrg(compId)).toEqual([]);
  });
});
