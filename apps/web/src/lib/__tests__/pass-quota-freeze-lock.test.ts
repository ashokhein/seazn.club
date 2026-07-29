// v17 gap #347 — the two ENFORCEMENT sites must ask the same question the
// RESOLVER asks: "is this competition's Event Pass still applying?", not "does
// a competition_passes row exist?".
//
// `competitions.ts`'s assertActiveQuota and `entitlement-freeze.ts`'s candidate
// loader + count both exempted a competition on bare row existence. Both also
// filter on ACTIVE_COMPETITION_STATUSES (draft/published/live), which
// incidentally covers the lock rule's `terminal` arm — an archived/completed
// competition is excluded anyway — but covers NOTHING of the `past_ends_on`
// arm. Nothing retires a `live` competition past its end date, so a competition
// still marked `live` whose ends_on passed more than PASS_END_GRACE_DAYS ago
// kept its exemption FOR EVER: permanently outside `competitions.max_active`
// and permanently immune to freezing, on a pass `passLockReason` (TS) and V338
// (SQL) had both already stopped honouring. One $29 pass bought a free active
// slot in perpetuity.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements, PASS_END_GRACE_DAYS } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { frozenCompetitionIds } from "@/server/usecases/entitlement-freeze";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** A UTC-midnight 'YYYY-MM-DD' STRING `offsetDays` from today.
 *
 *  A STRING, never a `new Date()`-derived Date: a Date carries a time of day,
 *  so "N days ago" lands ~20h off the boundary the rule compares against, and
 *  the strict `<` the rule is built on becomes indistinguishable from a buggy
 *  `<=`. That is exactly how a mutation shipped green in #346. */
const utcDayString = (offsetDays: number): string => {
  const now = new Date();
  const ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(ms + offsetDays * 86_400_000).toISOString().slice(0, 10);
};

/** Community org with an explicit subscriptions row. A raw
 *  `insert into organizations` does NOT create one (only lib/auth.ts does), and
 *  the pass arm only fires while the resolved plan is 'community'. */
async function seedCommunityOrg(): Promise<{ orgId: string; auth: AuthCtx }> {
  const s = uniq();
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`quota-${s}@test.local`}, 'Quota Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Quota Org " + s}, ${"quota-org-" + s}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active'
      from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, auth: { orgId, via: "session", userId: ownerId, role: "owner", keyId: null } };
}

/** `n` plain ACTIVE (live) competitions, no pass, created just now — so they
 *  are all more recently active than the passed competition below, and the
 *  freeze selector picks the passed one when the org is one over quota. */
async function seedPlainActive(orgId: string, n: number): Promise<void> {
  if (n <= 0) return;
  const s = uniq();
  await sql`
    insert into competitions (org_id, name, slug, status)
    select ${orgId}, 'Plain ' || g || ' ' || ${s}, ${"plain-" + s + "-"} || g, 'live'
    from generate_series(1, ${n}) g`;
}

/** One `live` competition carrying an Event Pass, with an explicit ends_on.
 *  created_at is pinned in the past so it is the LEAST recently active
 *  candidate — the one the freeze selector must pick first. */
async function seedPassedCompetition(orgId: string, endsOn: string): Promise<string> {
  const s = uniq();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, status, ends_on, created_at)
    values (${orgId}, ${"Passed " + s}, ${"passed-" + s}, 'live', ${endsOn}::date,
            timestamptz '2020-01-01 00:00:00+00')
    returning id`;
  await sql`insert into competition_passes (competition_id, org_id) values (${id}, ${orgId})`;
  await invalidateOrgEntitlements(orgId);
  return id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("an Event Pass exempts its competition only while the pass APPLIES (#347)", () => {
  let orgId: string;
  let auth: AuthCtx;
  let limit: number;

  beforeEach(async () => {
    ({ orgId, auth } = await seedCommunityOrg());
    // Read the ceiling rather than hard-coding it — the community cap has moved
    // three times (V112 2, V270 1, V311 5, V319 10) and this suite is about the
    // predicate, not the number.
    const resolved = await getLimit(orgId, "competitions.max_active");
    expect(resolved).not.toBeNull();
    limit = resolved as number;
  });

  const create = (name: string) =>
    createCompetition(auth, { name: `${name} ${uniq()}`, visibility: "private", branding: {} });

  it("REGRESSION (#347): a pass on a LONG-ENDED live competition stops buying it out of the quota", async () => {
    await seedPlainActive(orgId, limit - 1);
    await seedPassedCompetition(orgId, utcDayString(-(PASS_END_GRACE_DAYS + 1)));
    // The org now holds exactly `limit` active competitions, one of them a
    // `live` row whose pass the resolver stopped honouring a day ago. It must
    // COUNT, so the next create is one too many.
    await expect(create("one too many")).rejects.toMatchObject({ status: 402 });
  });

  it("a pass EXACTLY on the grace boundary still buys the competition out (strict <)", async () => {
    await seedPlainActive(orgId, limit - 1);
    await seedPassedCompetition(orgId, utcDayString(-PASS_END_GRACE_DAYS));
    // ends_on + grace lands exactly ON today: still applying, so the passed
    // competition is exempt and the org is one under its ceiling. This is the
    // guard against "fix" it by counting every passed competition.
    await expect(create("still fine")).resolves.toBeTruthy();
  });

  it("REGRESSION (#347): a locked pass no longer makes its competition unfreezable", async () => {
    await seedPlainActive(orgId, limit);
    const compId = await seedPassedCompetition(orgId, utcDayString(-(PASS_END_GRACE_DAYS + 1)));
    // limit + 1 active competitions: exactly one must freeze, and the passed
    // one is the least recently active, so it is that one.
    expect([...(await frozenCompetitionIds(orgId))]).toContain(compId);
  });

  it("a pass ON the boundary still keeps its competition out of the freeze set", async () => {
    await seedPlainActive(orgId, limit);
    const compId = await seedPassedCompetition(orgId, utcDayString(-PASS_END_GRACE_DAYS));
    // Still applying ⇒ neither counted nor a freeze candidate: the org sits at
    // exactly `limit` countable competitions, so nothing freezes at all.
    const frozen = [...(await frozenCompetitionIds(orgId))];
    expect(frozen).not.toContain(compId);
    expect(frozen).toEqual([]);
  });
});
