// listTeams must be org-scoped: team_display_v is a plain view (no
// security_invoker) so it bypasses the caller's RLS on `teams` — the usecase
// filters by org_id explicitly. This guards against a cross-org team leak in
// the enroll-an-existing-team picker. Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { listTeams } from "../teams";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Tm " + suffix}, ${"tm-" + suffix})
    returning id`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

async function seedTeam(auth: AuthCtx, name: string): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    const [club] = await tx<{ id: string }[]>`
      insert into clubs (org_id, name) values (${auth.orgId}, ${"Club " + name}) returning id`;
    await tx`insert into teams (org_id, name, club_id) values (${auth.orgId}, ${name}, ${club!.id})`;
  });
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("listTeams org scoping", () => {
  it("returns only the caller's org teams, never another org's", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await seedTeam(a, "A Team");
    await seedTeam(b, "B Team");

    const aTeams = await listTeams(a);
    const bTeams = await listTeams(b);

    expect(aTeams.map((t) => t.name)).toEqual(["A Team"]);
    expect(bTeams.map((t) => t.name)).toEqual(["B Team"]);
    // Explicit: A must never see B's team (the leak we fixed).
    expect(aTeams.some((t) => t.name === "B Team")).toBe(false);
  });
});
