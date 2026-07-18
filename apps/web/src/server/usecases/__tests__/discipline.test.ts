// PROMPT-78 — discipline fold/detection/serving (SPEC-1). DB-backed; skipped
// without DATABASE_URL. Seeds a football division with raw SQL, drops
// attributed card events into the ledger, and asserts the recompute-on-read
// fold: accumulation buckets, dismissal, idempotency, void un-count, anonymous
// exclusion, and the derived serving counter.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";

// Observe the two SPEC-1 player notices without touching the rest of the email
// module (send() is a no-op without RESEND_API_KEY either way). Hoisted so the
// spies are live before ../discipline binds the senders at import.
const emailMock = vi.hoisted(() => ({
  confirmed: vi.fn().mockResolvedValue(true),
  served: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendSuspensionConfirmedEmail: emailMock.confirmed,
  sendSuspensionServedEmail: emailMock.served,
}));

import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  createManualSuspension,
  decideSuspension,
  detectSuspensions,
  getDisciplineRules,
  listSuspensions,
  putDisciplineRules,
} from "../discipline";
import { scoreEvent } from "../scoring";

const HAS_DB = !!process.env.DATABASE_URL;

// Full football config snapshot (createDivision would store this) — needed so
// the seam test can fold a real forfeit through the module.
const FOOTBALL_CFG = builtinModules.find((m) => m.key === "football")!.configSchema.parse({});

const RULES = {
  accumulation: [
    { key: "yellow_5", color: "yellow", count: 5, ban_matches: 1 },
    { key: "yellow_10", color: "yellow", count: 10, ban_matches: 2 },
  ],
  dismissal: [
    { key: "second_yellow", color: "second_yellow", ban_matches: 1 },
    { key: "red", color: "red", ban_matches: 1 },
  ],
};

interface Ctx {
  auth: AuthCtx;
  orgId: string;
  userId: string;
  divisionId: string;
  entrantA: string;
  entrantB: string;
  personX: string;
  personY: string;
  stageId: string;
}

async function seedFootballDivision(plan: "pro" | "community" = "pro"): Promise<Ctx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`disc-${suffix}@test.local`}, 'Disc', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Disc " + suffix}, ${"disc-" + suffix}, ${userId}) returning id`;
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
    values (${compId}, ${orgId}, 'Open', 'open', 'football', '11-a-side', ${sql.json(FOOTBALL_CFG as never)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name) values (${divisionId}, ${orgId}, 1, 'league', 'League')
    returning id`;
  const [{ id: entrantA }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed) values (${divisionId}, ${orgId}, 'team', 'A', 1) returning id`;
  const [{ id: entrantB }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed) values (${divisionId}, ${orgId}, 'team', 'B', 2) returning id`;
  const [{ id: personX }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, 'Xavier Smith') returning id`;
  const [{ id: personY }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, 'Yousef Kane') returning id`;
  await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantA}, ${personX}, ${orgId})`;
  await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantB}, ${personY}, ${orgId})`;
  return {
    auth: { orgId, via: "session", userId, role: "owner", keyId: null },
    orgId, userId, divisionId, entrantA, entrantB, personX, personY, stageId,
  };
}

/** Link a person to a claimed user account so the confirmed/served notices
 *  have an inbox to resolve (the senders join persons→users→email). */
async function claimPerson(personId: string, email: string): Promise<void> {
  const [{ id: uid }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, 'Claimed', true) returning id`;
  await sql`update persons set user_id = ${uid} where id = ${personId}`;
}

async function makeFixture(
  ctx: Ctx,
  seqInRound: number,
  home: string | null,
  away: string | null,
  status = "scheduled",
): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
    values (${ctx.stageId}, ${ctx.divisionId}, ${ctx.orgId}, 1, ${seqInRound}, ${home}, ${away}, ${status})
    returning id`;
  return id;
}

async function setRules(ctx: Ctx, rules: unknown = RULES, enabled = true): Promise<void> {
  await sql`
    insert into discipline_rules (org_id, division_id, enabled, rules)
    values (${ctx.orgId}, ${ctx.divisionId}, ${enabled}, ${sql.json(rules as never)})
    on conflict (division_id) do update set enabled = excluded.enabled, rules = excluded.rules`;
}

let seqByFixture = new Map<string, number>();
function nextSeq(fixtureId: string): number {
  const n = (seqByFixture.get(fixtureId) ?? 0) + 1;
  seqByFixture.set(fixtureId, n);
  return n;
}

async function insertCard(
  ctx: Ctx,
  fixtureId: string,
  by: string,
  person: string | null,
  color: string,
  recordedAt?: string,
): Promise<string> {
  const payload = { by, ...(person ? { person } : {}), color };
  const [{ id }] = await sql<{ id: string }[]>`
    insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
    values (${fixtureId}, ${ctx.orgId}, ${nextSeq(fixtureId)}, 'football.card', ${sql.json(payload)},
            coalesce(${recordedAt ?? null}::timestamptz, now()))
    returning id`;
  return id;
}

async function voidEvent(ctx: Ctx, fixtureId: string, targetId: string): Promise<void> {
  await sql`
    insert into score_events (fixture_id, org_id, seq, type, payload, voids_event_id)
    values (${fixtureId}, ${ctx.orgId}, ${nextSeq(fixtureId)}, 'core.void', ${sql.json({})}, ${targetId})`;
}

async function detect(ctx: Ctx): Promise<void> {
  await withTenant(ctx.orgId, (tx) => detectSuspensions(tx, ctx.divisionId));
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("discipline fold (SPEC-1, PROMPT-78)", () => {
  beforeEach(() => {
    emailMock.confirmed.mockClear();
    emailMock.served.mockClear();
  });

  it("(a) 5 yellows raise one pending yellow_5 row; detection is idempotent", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx);
    const fx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    for (let i = 0; i < 5; i++) await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "yellow");

    await detect(ctx);
    await detect(ctx);
    await detect(ctx);

    const rows = await listSuspensions(ctx.auth, ctx.divisionId);
    const acc = rows.filter((r) => r.source === "auto_accumulation");
    expect(acc).toHaveLength(1);
    expect(acc[0]!.status).toBe("pending");
    expect(acc[0]!.reason).toContain("yellow");
    const [meta] = await sql<{ rule_key: string; bucket: number }[]>`
      select rule_key, bucket from suspensions where id = ${acc[0]!.id}`;
    expect(meta).toEqual({ rule_key: "yellow_5", bucket: 1 });
  });

  it("(b) the 10th yellow raises a second row at bucket 2", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx);
    const fx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    for (let i = 0; i < 10; i++) await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "yellow");

    await detect(ctx);
    const acc = (await listSuspensions(ctx.auth, ctx.divisionId)).filter(
      (r) => r.source === "auto_accumulation",
    );
    expect(acc).toHaveLength(2);
    const meta = await sql<{ rule_key: string; bucket: number }[]>`
      select rule_key, bucket from suspensions where division_id = ${ctx.divisionId}
        and source = 'auto_accumulation' order by bucket`;
    expect(meta).toEqual([
      { rule_key: "yellow_5", bucket: 1 },
      { rule_key: "yellow_10", bucket: 2 },
    ]);
  });

  it("(c) a red card raises an auto_dismissal row", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx);
    const fx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    await insertCard(ctx, fx, ctx.entrantA, ctx.personX, "red");

    await detect(ctx);
    const dis = (await listSuspensions(ctx.auth, ctx.divisionId)).filter(
      (r) => r.source === "auto_dismissal",
    );
    expect(dis).toHaveLength(1);
    expect(dis[0]!.status).toBe("pending");
    const [meta] = await sql<{ rule_key: string; bucket: number }[]>`
      select rule_key, bucket from suspensions where id = ${dis[0]!.id}`;
    expect(meta).toEqual({ rule_key: "red", bucket: 1 });
  });

  it("(d) voiding a trigger deletes a pending row but only flags a confirmed one", async () => {
    // pending path: void a trigger yellow → total 4 → pending row deleted.
    const a = await seedFootballDivision();
    await setRules(a);
    const fxA = await makeFixture(a, 1, a.entrantA, a.entrantB);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertCard(a, fxA, a.entrantA, a.personX, "yellow"));
    await detect(a);
    expect((await listSuspensions(a.auth, a.divisionId)).filter((r) => r.source === "auto_accumulation")).toHaveLength(1);
    await voidEvent(a, fxA, ids[0]!);
    await detect(a);
    expect((await listSuspensions(a.auth, a.divisionId)).filter((r) => r.source === "auto_accumulation")).toHaveLength(0);

    // confirmed path: confirm the row, THEN void a trigger → row stays, flagged.
    const b = await seedFootballDivision();
    await setRules(b);
    const fxB = await makeFixture(b, 1, b.entrantA, b.entrantB);
    const bIds: string[] = [];
    for (let i = 0; i < 5; i++) bIds.push(await insertCard(b, fxB, b.entrantA, b.personX, "yellow"));
    await detect(b);
    const pending = (await listSuspensions(b.auth, b.divisionId)).find((r) => r.source === "auto_accumulation")!;
    await decideSuspension(b.auth, pending.id, { kind: "confirm" });
    await voidEvent(b, fxB, bIds[0]!);
    await detect(b);
    const after = (await listSuspensions(b.auth, b.divisionId)).find((r) => r.id === pending.id)!;
    expect(after.status).toBe("active");
    expect(after.triggerVoided).toBe(true);
  });

  it("(e) anonymous cards accumulate nothing", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx);
    const fx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    for (let i = 0; i < 6; i++) await insertCard(ctx, fx, ctx.entrantA, null, "yellow");

    await detect(ctx);
    expect(await listSuspensions(ctx.auth, ctx.divisionId)).toHaveLength(0);
  });

  it("(f) serving counts decided + forfeit-by, never abandoned/pre-ban/forfeit-by-opponent", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx, {
      accumulation: [{ key: "yellow_5", color: "yellow", count: 5, ban_matches: 3 }],
      dismissal: [],
    });
    const cardFx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    for (let i = 0; i < 5; i++) await insertCard(ctx, cardFx, ctx.entrantA, ctx.personX, "yellow");
    await detect(ctx);
    const pending = (await listSuspensions(ctx.auth, ctx.divisionId)).find((r) => r.source === "auto_accumulation")!;
    const confirmed = await decideSuspension(ctx.auth, pending.id, { kind: "confirm" });
    expect(confirmed.status).toBe("active");
    expect(confirmed.entrantId).toBe(ctx.entrantA);

    // Stamp a fixture's deciding event; "after"/"before" the ban's decided_at.
    const stamp = async (fixtureId: string, type: string, payload: object, when: "after" | "before") => {
      await sql`
        insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
        values (${fixtureId}, ${ctx.orgId}, ${nextSeq(fixtureId)}, ${type}, ${sql.json(payload as never)},
                ${when === "after" ? sql`now() + interval '1 hour'` : sql`now() - interval '1 day'`})`;
    };

    const fx1 = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB, "decided");
    await stamp(fx1, "core.note", { text: "d" }, "after");
    const fx2 = await makeFixture(ctx, 3, ctx.entrantB, ctx.entrantA, "decided");
    await stamp(fx2, "core.note", { text: "d" }, "after");
    const fx3 = await makeFixture(ctx, 4, ctx.entrantA, ctx.entrantB, "forfeited");
    await stamp(fx3, "core.forfeit", { by: ctx.entrantA, reason: "walkover" }, "after");
    const fx4 = await makeFixture(ctx, 5, ctx.entrantA, ctx.entrantB, "abandoned");
    await stamp(fx4, "core.abandon", { reason: "rain" }, "after");
    const fx5 = await makeFixture(ctx, 6, ctx.entrantA, ctx.entrantB, "decided");
    await stamp(fx5, "core.note", { text: "old" }, "before");
    const fx6 = await makeFixture(ctx, 7, ctx.entrantA, ctx.entrantB, "forfeited");
    await stamp(fx6, "core.forfeit", { by: ctx.entrantB, reason: "walkover" }, "after");

    const served = (await listSuspensions(ctx.auth, ctx.divisionId)).find((r) => r.id === pending.id)!;
    expect(served.matchesServed).toBe(3); // fx1 + fx2 + fx3 (forfeit-by-A)
    expect(served.status).toBe("served");
  });

  it("the scoring decided seam folds discipline without a discipline read", async () => {
    const ctx = await seedFootballDivision();
    await setRules(ctx);
    await sql`update divisions set status = 'active' where id = ${ctx.divisionId}`;
    const cardFx = await makeFixture(ctx, 1, ctx.entrantA, ctx.entrantB);
    for (let i = 0; i < 5; i++) await insertCard(ctx, cardFx, ctx.entrantA, ctx.personX, "yellow");

    // Decide a DIFFERENT fixture by forfeit — the seam re-folds the division.
    const decideFx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB);
    await scoreEvent(ctx.auth, decideFx, {
      expected_seq: 0,
      type: "core.forfeit",
      payload: { by: ctx.entrantB, reason: "walkover" },
    });

    // Read the ledger DIRECTLY (not through a discipline read function) — the
    // pending row must already exist, proving the seam created it.
    const [row] = await sql<{ rule_key: string; status: string }[]>`
      select rule_key, status from suspensions
      where division_id = ${ctx.divisionId} and source = 'auto_accumulation'`;
    expect(row).toEqual({ rule_key: "yellow_5", status: "pending" });
  });

  it("rules editor round-trips and manual bans confirm to active", async () => {
    const ctx = await seedFootballDivision();
    const got0 = await getDisciplineRules(ctx.auth, ctx.divisionId);
    expect(got0).not.toBeNull();
    expect(got0!.enabled).toBe(false);
    expect(got0!.sportColors.map((c) => c.key)).toContain("yellow");

    await putDisciplineRules(ctx.auth, ctx.divisionId, { enabled: true, rules: RULES });
    const got1 = await getDisciplineRules(ctx.auth, ctx.divisionId);
    expect(got1!.enabled).toBe(true);
    expect(got1!.rules.accumulation).toHaveLength(2);

    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
      personId: ctx.personX, matchesTotal: 2, reason: "violent conduct",
    });
    expect(manual.status).toBe("pending");
    expect(manual.source).toBe("manual");
    const active = await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });
    expect(active.status).toBe("active");
    expect(active.entrantId).toBe(ctx.entrantA);
  });

  it("RLS tenant isolation: org B reads neither org A's rules nor suspensions", async () => {
    const a = await seedFootballDivision();
    const b = await seedFootballDivision();
    await setRules(a); // discipline_rules row scoped to org A
    await sql`
      insert into suspensions
        (org_id, division_id, person_id, status, source, reason, matches_total, created_by)
      values (${a.orgId}, ${a.divisionId}, ${a.personX}, 'pending', 'manual', 'x', 1, ${a.userId})`;

    // Sanity: the raw superuser connection DOES see org A's rows, so the tenant
    // assertion below is meaningful (not vacuously zero). Point the reads at
    // `sql` instead of `tx` and this test would fail — the harness is honest.
    const [{ count: rawRules }] = await sql<{ count: number }[]>`
      select count(*)::int as count from discipline_rules where division_id = ${a.divisionId}`;
    const [{ count: rawSusp }] = await sql<{ count: number }[]>`
      select count(*)::int as count from suspensions where division_id = ${a.divisionId}`;
    expect({ rawRules, rawSusp }).toEqual({ rawRules: 1, rawSusp: 1 });

    // Through org B's tenant rail, RLS hides both of org A's rows.
    const seen = await withTenant(b.orgId, async (tx) => {
      const [{ rules }] = await tx<{ rules: number }[]>`
        select count(*)::int as rules from discipline_rules where division_id = ${a.divisionId}`;
      const [{ susp }] = await tx<{ susp: number }[]>`
        select count(*)::int as susp from suspensions where division_id = ${a.divisionId}`;
      return { rules, susp };
    });
    expect(seen).toEqual({ rules: 0, susp: 0 });
  });

  it("createManualSuspension rejects a division from another org (404)", async () => {
    const a = await seedFootballDivision();
    const b = await seedFootballDivision();
    // Org A's auth, org B's division id: the division-org guard rejects before
    // any insert, even though personX is a valid org-A person.
    await expect(
      createManualSuspension(a.auth, b.divisionId, {
        personId: a.personX, matchesTotal: 1, reason: "x",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("community orgs are gated on every authed entry point (PlusReveal 402)", async () => {
    const ctx = await seedFootballDivision("community");
    // GET rules signals the paywall (the sport HAS a card model, so it is not
    // the null "no discipline" case) — the console renders PlusReveal from it.
    await expect(getDisciplineRules(ctx.auth, ctx.divisionId)).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    await expect(
      putDisciplineRules(ctx.auth, ctx.divisionId, { enabled: true, rules: RULES }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    await expect(listSuspensions(ctx.auth, ctx.divisionId)).rejects.toBeInstanceOf(
      PaymentRequiredError,
    );
    await expect(
      createManualSuspension(ctx.auth, ctx.divisionId, {
        personId: ctx.personX, matchesTotal: 1, reason: "x",
      }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it("confirming a suspension fires the confirmed email to the claimed player", async () => {
    const ctx = await seedFootballDivision();
    const email = `claim-${randomUUID().slice(0, 8)}@test.local`;
    await claimPerson(ctx.personX, email);
    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
      personId: ctx.personX, matchesTotal: 2, reason: "violent conduct",
    });

    const active = await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });
    expect(active.status).toBe("active");
    // The confirmed sender fired exactly once, to this player's inbox. Remove the
    // `await emailConfirmed(...)` wiring in decideSuspension and this goes to 0.
    expect(emailMock.confirmed).toHaveBeenCalledTimes(1);
    expect(emailMock.confirmed.mock.calls[0]![0]).toBe(email);
    expect(emailMock.served).not.toHaveBeenCalled();
  });

  it("the active→served flip fires the served email once", async () => {
    const ctx = await seedFootballDivision();
    const email = `claim-${randomUUID().slice(0, 8)}@test.local`;
    await claimPerson(ctx.personX, email);
    const manual = await createManualSuspension(ctx.auth, ctx.divisionId, {
      personId: ctx.personX, matchesTotal: 1, reason: "violent conduct",
    });
    const active = await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });
    expect(active.entrantId).toBe(ctx.entrantA);

    // A decided fixture for the banned entrant, stamped after the ban's decided_at,
    // serves the one-match ban. The recompute-on-read flips active→served.
    const fx = await makeFixture(ctx, 2, ctx.entrantA, ctx.entrantB, "decided");
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload, recorded_at)
      values (${fx}, ${ctx.orgId}, ${nextSeq(fx)}, 'core.note', ${sql.json({ text: "d" })},
              now() + interval '1 hour')`;

    emailMock.served.mockClear();
    const served = (await listSuspensions(ctx.auth, ctx.divisionId)).find((r) => r.id === manual.id)!;
    expect(served.status).toBe("served");
    // The served sender fired exactly once on the flip. Remove `await emailServed(...)`
    // and this goes to 0; a second read must not re-fire it.
    expect(emailMock.served).toHaveBeenCalledTimes(1);
    expect(emailMock.served.mock.calls[0]![0]).toBe(email);
    await listSuspensions(ctx.auth, ctx.divisionId);
    expect(emailMock.served).toHaveBeenCalledTimes(1);
  });
});
