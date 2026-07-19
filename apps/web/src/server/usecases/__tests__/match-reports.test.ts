// PROMPT-80 — official match reports + the SPEC-1 bridge. DB-backed; skipped
// without DATABASE_URL. Reports run on the cross-org superuser rail (the
// official is not an org member), so these tests assert: claimed-official
// identity (404), the window incl. abandoned, draft round-trip, submit
// immutability (409), organiser fixtureReports (submitted only), and the soft
// bridge — pending suspension on a named red card, dark on missing person /
// discipline / table.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";

// Spy the report_submitted email at the module boundary — submit fires it
// fire-and-forget, so the mock is invoked synchronously inside the awaited
// usecase (conv_vitest email-spy pattern). Above the usecase import so the
// binding is the spy.
const emailMock = vi.hoisted(() => ({ report: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendReportSubmittedEmail: emailMock.report,
}));

import {
  __setBridgeProbeForTests,
  fixtureReports,
  getMyReport,
  myFixtureSquad,
  putMyReport,
  submitMyReport,
  type ReportIncident,
} from "../match-reports";

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
    values (${`rep-${suffix}@test.local`}, 'Rep', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Rep " + suffix}, ${"rep-" + suffix}, ${userId}) returning id`;
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

/** A user + a person in this org linked to it + an official on that person —
 *  the claimed-official identity a report write proves. Returns both ids. */
async function makeClaimedOfficial(ctx: OrgCtx): Promise<{ userId: string; officialId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`ref-${suffix}@test.local`}, 'Ref', true) returning id`;
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id) values (${ctx.orgId}, 'Ref Person', ${userId})
    returning id`;
  const [{ id: officialId }] = await sql<{ id: string }[]>`
    insert into officials (org_id, person_id, display_name, role_keys)
    values (${ctx.orgId}, ${personId}, 'The Ref', ${sql.json(["referee"])}) returning id`;
  return { userId, officialId };
}

async function makePlayer(ctx: OrgCtx): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${ctx.orgId}, 'Player Nine') returning id`;
  return id;
}

/** Roster a fresh person onto an entrant (entrant_members) so myFixtureSquad
 *  can surface them in the report person picker. */
async function rosterMember(ctx: OrgCtx, entrantId: string, name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${ctx.orgId}, ${name}) returning id`;
  await sql`insert into entrant_members (entrant_id, person_id) values (${entrantId}, ${id})`;
  return id;
}

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

async function pendingReportSuspensions(divisionId: string): Promise<
  { person_id: string; reason: string; status: string; bucket: number }[]
> {
  return sql`
    select person_id, reason, status, bucket from suspensions
    where division_id = ${divisionId} and source = 'report' order by bucket`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("match reports (SPEC-3, PROMPT-80)", () => {
  beforeEach(() => emailMock.report.mockClear());

  it("404s when the assignment isn't the caller's claimed official", async () => {
    const ctx = await seedOrg();
    const ref = await makeClaimedOfficial(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);
    // A different (unrelated) logged-in user.
    const [{ id: stranger }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`x-${randomUUID().slice(0, 8)}@test.local`}, 'X', true) returning id`;
    await expect(getMyReport(stranger, fixtureOfficialId)).rejects.toMatchObject({ status: 404 });
    await expect(
      putMyReport(stranger, fixtureOfficialId, { body: "hi", incidents: [] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("blocks a report before the fixture ends, allows it once abandoned", async () => {
    const ctx = await seedOrg();
    const ref = await makeClaimedOfficial(ctx);
    const scheduled = await makeAssignment(ctx, ref.officialId, { status: "scheduled" });
    await expect(
      putMyReport(ref.userId, scheduled.fixtureOfficialId, { body: "x", incidents: [] }),
    ).rejects.toMatchObject({ status: 403 });

    const abandoned = await makeAssignment(ctx, ref.officialId, { status: "abandoned" });
    const saved = await putMyReport(ref.userId, abandoned.fixtureOfficialId, {
      body: "rain stopped play",
      incidents: [],
    });
    expect(saved.status).toBe("draft");
    expect(saved.body).toBe("rain stopped play");
  });

  it("round-trips a draft and makes a submitted report immutable (409)", async () => {
    const ctx = await seedOrg();
    const ref = await makeClaimedOfficial(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);

    expect(await getMyReport(ref.userId, fixtureOfficialId)).toBeNull();
    await putMyReport(ref.userId, fixtureOfficialId, {
      body: "clean game",
      incidents: [{ kind: "injury", note: "twisted ankle 40'" }],
    });
    const got = await getMyReport(ref.userId, fixtureOfficialId);
    expect(got).toMatchObject({ status: "draft", body: "clean game" });
    expect(got!.incidents).toEqual([{ kind: "injury", note: "twisted ankle 40'" }]);

    const submitted = await submitMyReport(ref.userId, fixtureOfficialId);
    expect(submitted.status).toBe("submitted");
    expect(submitted.submittedAt).not.toBeNull();

    // Editing after submit → 409; resubmitting → 409.
    await expect(
      putMyReport(ref.userId, fixtureOfficialId, { body: "changed", incidents: [] }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(submitMyReport(ref.userId, fixtureOfficialId)).rejects.toMatchObject({ status: 409 });
  });

  it("organiser fixtureReports returns submitted reports only", async () => {
    const ctx = await seedOrg();
    const ref1 = await makeClaimedOfficial(ctx);
    const ref2 = await makeClaimedOfficial(ctx);
    const a1 = await makeAssignment(ctx, ref1.officialId);
    // Two officials on the SAME fixture: a submitted one and a draft one.
    const [{ id: foId2 }] = await sql<{ id: string }[]>`
      insert into fixture_officials (fixture_id, official_id, org_id, role_key, source, response)
      values (${a1.fixtureId}, ${ref2.officialId}, ${ctx.orgId}, 'assistant', 'manual', 'accepted')
      returning id`;

    await putMyReport(ref1.userId, a1.fixtureOfficialId, { body: "ref one", incidents: [] });
    await submitMyReport(ref1.userId, a1.fixtureOfficialId);
    await putMyReport(ref2.userId, foId2, { body: "ref two draft", incidents: [] });

    const reports = await fixtureReports(ctx.auth, a1.fixtureId);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: "submitted", body: "ref one", officialName: "The Ref" });
  });

  it("bridges a named red card into a pending report-suspension (SPEC-1)", async () => {
    const ctx = await seedOrg("pro"); // pro → discipline.enforced true (V293)
    const ref = await makeClaimedOfficial(ctx);
    const player = await makePlayer(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);

    const incidents: ReportIncident[] = [
      { kind: "red_card", person_id: player, entrant_id: ctx.entrantA, note: "violent conduct, 88'" },
      { kind: "injury", note: "keeper concussion" },
    ];
    await putMyReport(ref.userId, fixtureOfficialId, { body: "eventful", incidents });
    await submitMyReport(ref.userId, fixtureOfficialId);

    const rows = await pendingReportSuspensions(ctx.divisionId);
    expect(rows).toHaveLength(1); // only the red card, not the injury
    expect(rows[0]).toMatchObject({
      person_id: player,
      reason: "violent conduct, 88'",
      status: "pending",
      bucket: 0,
    });
  });

  it("does not bridge an anonymous incident nor when the org lacks discipline.enforced", async () => {
    // (a) red card with no person → no row.
    const pro = await seedOrg("pro");
    const refP = await makeClaimedOfficial(pro);
    const anon = await makeAssignment(pro, refP.officialId);
    await putMyReport(refP.userId, anon.fixtureOfficialId, {
      body: "b",
      incidents: [{ kind: "red_card", note: "no name" }],
    });
    await submitMyReport(refP.userId, anon.fixtureOfficialId);
    expect(await pendingReportSuspensions(pro.divisionId)).toHaveLength(0);

    // (b) community org (discipline.enforced false) → report files, no bridge.
    const comm = await seedOrg("community");
    const refC = await makeClaimedOfficial(comm);
    const player = await makePlayer(comm);
    const asg = await makeAssignment(comm, refC.officialId);
    await putMyReport(refC.userId, asg.fixtureOfficialId, {
      body: "b",
      incidents: [{ kind: "red_card", person_id: player, note: "sent off" }],
    });
    const submitted = await submitMyReport(refC.userId, asg.fixtureOfficialId);
    expect(submitted.status).toBe("submitted");
    expect(await pendingReportSuspensions(comm.divisionId)).toHaveLength(0);
  });

  it("ships dark: submit succeeds with no error when the suspensions table is absent", async () => {
    const ctx = await seedOrg("pro");
    const ref = await makeClaimedOfficial(ctx);
    const player = await makePlayer(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);
    await putMyReport(ref.userId, fixtureOfficialId, {
      body: "b",
      incidents: [{ kind: "red_card", person_id: player, note: "sent off" }],
    });

    // Simulate the pre-V293 world where the SPEC-1 table doesn't exist yet: the
    // bridge's existence probe reports absent. Injected via the module seam so
    // we never rename the shared `suspensions` table — a rename would flake a
    // thread-parallel discipline.test.ts run against the one local DB. Restore
    // the real probe unconditionally.
    __setBridgeProbeForTests(async () => false);
    try {
      const submitted = await submitMyReport(ref.userId, fixtureOfficialId);
      expect(submitted.status).toBe("submitted");
      // Dark: despite a named red card + discipline.enforced, no suspension row.
      expect(await pendingReportSuspensions(ctx.divisionId)).toHaveLength(0);
    } finally {
      __setBridgeProbeForTests(null);
    }
  });

  it("myFixtureSquad returns both entrants' members for the caller (404 for a stranger)", async () => {
    const ctx = await seedOrg();
    const ref = await makeClaimedOfficial(ctx);
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);
    const pA = await rosterMember(ctx, ctx.entrantA, "Home Player");
    const pB = await rosterMember(ctx, ctx.entrantB, "Away Player");

    const squad = await myFixtureSquad(ref.userId, fixtureOfficialId);
    const ids = squad.map((m) => m.person_id);
    expect(ids).toContain(pA);
    expect(ids).toContain(pB);
    expect(squad.find((m) => m.person_id === pA)).toMatchObject({
      full_name: "Home Player",
      entrant_name: "Alpha",
    });

    const [{ id: stranger }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`x-${randomUUID().slice(0, 8)}@test.local`}, 'X', true) returning id`;
    await expect(myFixtureSquad(stranger, fixtureOfficialId)).rejects.toMatchObject({ status: 404 });
  });

  it("emails owner + admins on submit with the fixture line, official name and incident count", async () => {
    const ctx = await seedOrg();
    // Add a second org member as admin — both should be notified.
    const [{ id: adminId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`admin-${randomUUID().slice(0, 8)}@test.local`}, 'Admin', true) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${ctx.orgId}, ${adminId}, 'admin')`;

    const ref = await makeClaimedOfficial(ctx);
    const player = await rosterMember(ctx, ctx.entrantA, "Home Player");
    const { fixtureOfficialId } = await makeAssignment(ctx, ref.officialId);
    await putMyReport(ref.userId, fixtureOfficialId, {
      body: "eventful",
      incidents: [{ kind: "red_card", person_id: player, note: "sent off" }],
    });
    await submitMyReport(ref.userId, fixtureOfficialId);

    expect(emailMock.report).toHaveBeenCalledTimes(2); // owner + admin
    const recipients = emailMock.report.mock.calls.map((c) => c[0] as string);
    expect(recipients.every((r) => r.endsWith("@test.local"))).toBe(true);
    const args = emailMock.report.mock.calls[0]![1] as Record<string, unknown>;
    expect(args).toMatchObject({
      fixtureLine: "Alpha vs Bravo",
      officialName: "The Ref",
      incidentCount: 1,
    });
    expect(args.orgSlug).toBeTruthy();
  });
});
