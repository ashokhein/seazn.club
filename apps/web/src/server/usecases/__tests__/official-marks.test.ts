// PROMPT-80 — organiser marks (SPEC-3). DB-backed; skipped without DATABASE_URL.
// Seeds an org + a football division + an accepted, decided assignment, then
// asserts: the mark window (pending/scheduled → 403), upsert (one row, second
// mark wins), org isolation (org B summary excludes org A's marks), the
// official-facing global average (null at 2, value at 3 across two orgs), and
// the Pro gate (community → 402).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  deleteMark,
  myMarksAverage,
  orgMarksSummary,
  putMark,
} from "../official-marks";

const HAS_DB = !!process.env.DATABASE_URL;

interface OrgCtx {
  auth: AuthCtx;
  orgId: string;
  userId: string;
  divisionId: string;
  stageId: string;
  entrantA: string;
  entrantB: string;
}

async function seedOrg(plan: "pro" | "community" = "pro"): Promise<OrgCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`mk-${suffix}@test.local`}, 'Mk', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Mk " + suffix}, ${"mk-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  if (plan === "pro") {
    await sql`
      insert into subscriptions (org_id, plan_key, status) values (${orgId}, 'pro', 'active')
      on conflict (org_id) do update set plan_key = 'pro'`;
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', '1.0.0', ${sql.json({ groups: [], lineup: { size: 11, benchMax: 12 } })})
    on conflict (key) do nothing`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, created_by)
    values (${orgId}, 'Cup', ${"cup-" + suffix}, 'public', ${userId}) returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
    values (${compId}, ${orgId}, 'Open', 'open', 'football', '11-a-side', ${sql.json({})}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name)
    values (${divisionId}, ${orgId}, 1, 'league', 'League') returning id`;
  const [{ id: entrantA }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${orgId}, 'team', 'Alpha', 1) returning id`;
  const [{ id: entrantB }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${orgId}, 'team', 'Bravo', 2) returning id`;
  return {
    auth: { orgId, via: "session", userId, role: "owner", keyId: null },
    orgId, userId, divisionId, stageId, entrantA, entrantB,
  };
}

/** An official (optionally linked to a claimed person/user for the global
 *  average test) in this org. */
async function makeOfficial(ctx: OrgCtx, userId?: string): Promise<string> {
  let personId: string | null = null;
  if (userId) {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id) values (${ctx.orgId}, 'Ref Person', ${userId})
      returning id`;
    personId = id;
  }
  const [{ id }] = await sql<{ id: string }[]>`
    insert into officials (org_id, person_id, display_name, role_keys)
    values (${ctx.orgId}, ${personId}, 'The Ref', ${sql.json(["referee"])}) returning id`;
  return id;
}

/** A fixture + a fixture_officials assignment; returns the surrogate id. */
async function makeAssignment(
  ctx: OrgCtx,
  officialId: string,
  opts: { status?: string; response?: string } = {},
): Promise<{ fixtureOfficialId: string; fixtureId: string }> {
  const status = opts.status ?? "decided";
  const response = opts.response ?? "accepted";
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
                          home_entrant_id, away_entrant_id, status)
    values (${ctx.stageId}, ${ctx.divisionId}, ${ctx.orgId}, 1, 1,
            ${ctx.entrantA}, ${ctx.entrantB}, ${status}) returning id`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixture_officials (fixture_id, official_id, org_id, role_key, source, response)
    values (${fixtureId}, ${officialId}, ${ctx.orgId}, 'referee', 'manual', ${response})
    returning id`;
  return { fixtureOfficialId: id, fixtureId };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("official marks (SPEC-3, PROMPT-80)", () => {
  it("rejects a mark when the response is pending or the fixture undecided (403)", async () => {
    const ctx = await seedOrg();
    const off = await makeOfficial(ctx);
    // accepted but still scheduled → window closed.
    const scheduled = await makeAssignment(ctx, off, { status: "scheduled", response: "accepted" });
    await expect(putMark(ctx.auth, scheduled.fixtureOfficialId, { mark: 4 })).rejects.toMatchObject({
      status: 403,
    });
    // decided but response pending → window closed.
    const pending = await makeAssignment(ctx, off, { status: "decided", response: "pending" });
    await expect(putMark(ctx.auth, pending.fixtureOfficialId, { mark: 4 })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("upserts one row per assignment — the second mark wins", async () => {
    const ctx = await seedOrg();
    const off = await makeOfficial(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, off);
    await putMark(ctx.auth, fixtureOfficialId, { mark: 3, comment: "ok" });
    await putMark(ctx.auth, fixtureOfficialId, { mark: 5, comment: "great" });
    const rows = await sql<{ mark: number; comment: string }[]>`
      select mark, comment from official_marks where fixture_official_id = ${fixtureOfficialId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ mark: 5, comment: "great" });

    const summary = await orgMarksSummary(ctx.auth, off);
    expect(summary).toMatchObject({ average: 5, count: 1 });
    expect(summary.recent[0]).toMatchObject({ mark: 5, comment: "great" });

    await deleteMark(ctx.auth, fixtureOfficialId);
    expect(await orgMarksSummary(ctx.auth, off)).toMatchObject({ average: null, count: 0 });
  });

  it("org B's summary never sees org A's marks (RLS)", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const offA = await makeOfficial(a);
    const asgA = await makeAssignment(a, offA);
    await putMark(a.auth, asgA.fixtureOfficialId, { mark: 2 });

    // Sanity: the raw superuser connection DOES see org A's mark, so the tenant
    // assertion below is meaningful (not vacuously zero).
    const [{ count: raw }] = await sql<{ count: number }[]>`
      select count(*)::int as count from official_marks where official_id = ${offA}`;
    expect(raw).toBe(1);

    // Through org B's tenant rail, RLS hides org A's row entirely.
    const seen = await withTenant(b.orgId, async (tx) => {
      const [r] = await tx<{ c: number }[]>`
        select count(*)::int as c from official_marks where official_id = ${offA}`;
      return r!.c;
    });
    expect(seen).toBe(0);
    // And org B's summary for org A's official reports empty.
    expect(await orgMarksSummary(b.auth, offA)).toMatchObject({ average: null, count: 0 });
  });

  it("the official-facing global average is null at 2 marks, a value at 3 across two orgs", async () => {
    // One user claimed as an official in two different orgs.
    const suffix = randomUUID().slice(0, 8);
    const [{ id: refUser }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`ref-${suffix}@test.local`}, 'Ref', true) returning id`;
    const a = await seedOrg();
    const b = await seedOrg();
    const offA = await makeOfficial(a, refUser);
    const offB = await makeOfficial(b, refUser);

    // Two marks in org A → still under the D4 floor.
    const a1 = await makeAssignment(a, offA);
    const a2 = await makeAssignment(a, offA);
    await putMark(a.auth, a1.fixtureOfficialId, { mark: 4 });
    await putMark(a.auth, a2.fixtureOfficialId, { mark: 4 });
    expect(await myMarksAverage(refUser)).toBeNull();

    // A third mark in org B crosses the floor; the average spans both orgs.
    const b1 = await makeAssignment(b, offB);
    await putMark(b.auth, b1.fixtureOfficialId, { mark: 1 });
    expect(await myMarksAverage(refUser)).toEqual({ average: 3, count: 3 });
  });

  it("community orgs are gated on every marks entry point (PlusReveal 402)", async () => {
    const ctx = await seedOrg("community");
    const off = await makeOfficial(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, off);
    await expect(putMark(ctx.auth, fixtureOfficialId, { mark: 3 })).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    await expect(deleteMark(ctx.auth, fixtureOfficialId)).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    await expect(orgMarksSummary(ctx.auth, off)).rejects.toBeInstanceOf(PaymentRequiredError);
  });
});
