// v17 SPEC-4 §7 — an Event Pass stops applying once its competition is over.
//
// Two layers are proven here:
//   1. isPassLocked (pure) — the lock predicate, no DB.
//   2. The TS resolver (DB-backed) — a community org's pass lifts a LIVE
//      competition and falls back to Community caps once that competition is
//      archived or long-ended. Asserted through the real hasFeature/getLimit,
//      not a raw row read.
//
// The SQL side of the same lock is proven in entitlements-sql-parity.test.ts.
// Real Postgres required for layer 2; skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import {
  getLimit,
  hasFeature,
  invalidateOrgEntitlements,
  isPassLocked,
  passLockReason,
  PASS_END_GRACE_DAYS,
} from "@/lib/entitlements";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const daysFromToday = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};

// ---------------------------------------------------------------------------
// 1. isPassLocked — pure predicate (SPEC-4 §7, mapped to reality)
// ---------------------------------------------------------------------------
describe("isPassLocked", () => {
  it("locks a terminal competition (archived or completed)", () => {
    expect(isPassLocked("archived", null)).toBe(true);
    expect(isPassLocked("archived", daysFromToday(30))).toBe(true);
    // A FINISHED competition (usecases/competitions.ts sets 'completed') is the
    // primary terminal case SPEC-4 §7 targets.
    expect(isPassLocked("completed", null)).toBe(true);
    expect(isPassLocked("completed", daysFromToday(30))).toBe(true);
  });

  it("does NOT lock an active competition (draft/published/live)", () => {
    for (const status of ["draft", "published", "live"]) {
      expect(isPassLocked(status, null)).toBe(false);
      expect(isPassLocked(status, daysFromToday(30))).toBe(false);
    }
  });

  it("locks a competition ended beyond the grace window", () => {
    expect(isPassLocked("live", daysFromToday(-(PASS_END_GRACE_DAYS + 1)))).toBe(true);
  });

  it("keeps a competition inside the grace window unlocked", () => {
    expect(isPassLocked("live", daysFromToday(-3))).toBe(false);
    // Exactly grace days ago: ends_on + 7 == today, not < today, so NOT locked.
    expect(isPassLocked("live", daysFromToday(-PASS_END_GRACE_DAYS))).toBe(false);
  });

  it("does not lock a future or null ends_on on an active competition", () => {
    expect(isPassLocked("live", daysFromToday(30))).toBe(false);
    expect(isPassLocked("live", null)).toBe(false);
  });

  it("accepts a YYYY-MM-DD string for ends_on", () => {
    const past = daysFromToday(-(PASS_END_GRACE_DAYS + 1)).toISOString().slice(0, 10);
    expect(isPassLocked("live", past)).toBe(true);
    const future = daysFromToday(30).toISOString().slice(0, 10);
    expect(isPassLocked("live", future)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1b. passLockReason — the reason isPassLocked collapses to a boolean.
//     v17 gap #301: the UI needs to NAME why a pass stopped applying (a
//     finished competition vs one that simply ran past its end date), and
//     that reason must come from the SAME arms isPassLocked already computes,
//     never a second hand-written copy.
// ---------------------------------------------------------------------------
describe("passLockReason", () => {
  it("names a terminal status regardless of ends_on", () => {
    expect(passLockReason("archived", null)).toBe("terminal");
    expect(passLockReason("archived", daysFromToday(30))).toBe("terminal");
    expect(passLockReason("completed", null)).toBe("terminal");
    expect(passLockReason("completed", daysFromToday(30))).toBe("terminal");
  });

  it("names past_ends_on once an active competition is beyond the grace window", () => {
    expect(passLockReason("live", daysFromToday(-(PASS_END_GRACE_DAYS + 1)))).toBe(
      "past_ends_on",
    );
  });

  it("is null while active and not past the grace window", () => {
    for (const status of ["draft", "published", "live"]) {
      expect(passLockReason(status, null)).toBeNull();
      expect(passLockReason(status, daysFromToday(30))).toBeNull();
    }
    expect(passLockReason("live", daysFromToday(-3))).toBeNull();
    // Exactly grace days ago: not yet past the boundary.
    expect(passLockReason("live", daysFromToday(-PASS_END_GRACE_DAYS))).toBeNull();
  });

  it("accepts a YYYY-MM-DD string, matching isPassLocked", () => {
    const past = daysFromToday(-(PASS_END_GRACE_DAYS + 1)).toISOString().slice(0, 10);
    expect(passLockReason("live", past)).toBe("past_ends_on");
  });

  it("is the single source isPassLocked wraps — boolean and reason never disagree", () => {
    const cases: [string, number | null][] = [
      ["archived", null],
      ["completed", 10],
      ["live", -(PASS_END_GRACE_DAYS + 1)],
      ["live", -3],
      ["live", 30],
      ["draft", null],
    ];
    for (const [status, days] of cases) {
      const endsOn = days === null ? null : daysFromToday(days);
      expect(isPassLocked(status, endsOn)).toBe(passLockReason(status, endsOn) !== null);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. TS resolver — the lock through hasFeature/getLimit
// ---------------------------------------------------------------------------
// `realtime` is the probe key the parity suite uses: community false, event_pass
// true — so a pass LIFT and its removal are both visible.
async function seedCommunityOrg(): Promise<string> {
  const s = uniq();
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`passlock-${s}@test.local`}, 'Pass Lock Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"PassLock " + s}, ${"passlock-" + s}, ${ownerId}) returning id`;
  await sql`
    with _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select o.created_by, 'community', 'active' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  return orgId;
}

/** A competition with an explicit lifecycle. ends_on may be null. */
async function seedCompetition(
  orgId: string,
  label: string,
  status: string,
  endsInDays: number | null,
): Promise<string> {
  const endsOn = endsInDays === null ? null : daysFromToday(endsInDays).toISOString().slice(0, 10);
  const [{ id }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, status, ends_on)
    values (${orgId}, ${label + " " + uniq()}, ${label + "-" + uniq()}, ${status}, ${endsOn})
    returning id`;
  return id;
}

async function addPass(orgId: string, competitionId: string): Promise<void> {
  await sql`
    insert into competition_passes (competition_id, org_id)
    values (${competitionId}, ${orgId})`;
  await invalidateOrgEntitlements(orgId);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("Event Pass lifecycle lock (TS resolver)", () => {
  let orgId: string;
  beforeEach(async () => {
    orgId = await seedCommunityOrg();
    await invalidateOrgEntitlements(orgId);
  });

  it("applies the pass on a LIVE competition", async () => {
    const compId = await seedCompetition(orgId, "live", "live", 30);
    await addPass(orgId, compId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);
  });

  it("stops applying once the competition is ARCHIVED", async () => {
    const compId = await seedCompetition(orgId, "arch", "live", 30);
    await addPass(orgId, compId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);

    // Pass lifts the entrants cap 64 -> 128 while live.
    expect(await getLimit(orgId, "entrants.per_division.max", compId)).toBe(128);

    await sql`update competitions set status = 'archived' where id = ${compId}`;
    await invalidateOrgEntitlements(orgId);
    // Falls back to Community caps — the pass no longer lifts anything.
    expect(await hasFeature(orgId, "realtime", compId)).toBe(false);
    // Community entrants cap (64), not the pass's raised cap (128).
    expect(await getLimit(orgId, "entrants.per_division.max", compId)).toBe(64);
  });

  it("stops applying once the competition is COMPLETED (finished)", async () => {
    const compId = await seedCompetition(orgId, "done", "live", 30);
    await addPass(orgId, compId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);

    await sql`update competitions set status = 'completed' where id = ${compId}`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(false);
    expect(await getLimit(orgId, "entrants.per_division.max", compId)).toBe(64);
  });

  it("stops applying once the competition ended beyond the grace window", async () => {
    const compId = await seedCompetition(orgId, "ended", "live", -(PASS_END_GRACE_DAYS + 1));
    await addPass(orgId, compId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(false);
  });

  it("still applies while inside the ended-grace window", async () => {
    const compId = await seedCompetition(orgId, "grace", "live", -3);
    await addPass(orgId, compId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);
  });

  // Acceptance §14: the pass is bound to the competition ID, never the name. A
  // rename cannot relock/unlock, and a brand-new competition (new id) with the
  // same name has NO pass row of its own.
  it("does not follow a rename onto a fresh competition of the same name", async () => {
    const compId = await seedCompetition(orgId, "year1", "live", 30);
    await addPass(orgId, compId);
    const [{ name }] = await sql<{ name: string }[]>`
      select name from competitions where id = ${compId}`;
    // Rename does not touch eligibility.
    await sql`update competitions set name = ${name + " (Year 2)"} where id = ${compId}`;
    await invalidateOrgEntitlements(orgId);
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);

    // A genuinely new competition reusing the same display name has no pass.
    const [{ id: freshId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, status)
      values (${orgId}, ${name}, ${"fresh-" + uniq()}, 'live') returning id`;
    expect(await hasFeature(orgId, "realtime", freshId)).toBe(false);
  });
});
