import "server-only";
// Officiating lane in /me (PROMPT-57 / design v11): cross-org reads and writes
// for claimed officials, mirroring the player module (me.ts). Superuser
// queries — an official is usually NOT an org member, so the tenant door never
// opens for them; every function pins rows through persons.user_id = me and
// officials.person_id = that person.
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { refreshOfficialsCache } from "./officials";
import { acceptResolvedClaim, resolveClaimById } from "./person-claims";

// refreshOfficialsCache is typed for the tenant tx; it only uses the tagged
// template + .json, which the superuser `sql` shares — safe structural cast.
const superuser = sql as unknown as postgres.TransactionSql;

export type OfficiatingResponse = "pending" | "accepted" | "declined";

export interface MyOfficiatingAssignment {
  fixture_id: string;
  fixture_no: number;
  /** Surrogate id of the fixture_officials assignment row (V293). The match
   *  report endpoints key on this single uuid — the lane's report CTA needs it
   *  per completed assignment (a fixture can carry several officials). */
  fixture_official_id: string;
  official_id: string;
  org_name: string;
  org_slug: string;
  competition_name: string;
  competition_slug: string;
  competition_visibility: string;
  division_name: string;
  division_slug: string;
  sport_key: string;
  home_name: string | null;
  away_name: string | null;
  scheduled_at: string | null;
  /** Venue zone (schedule_settings.tz of the fixture's division); null → UTC. */
  venue_tz: string | null;
  venue: string | null;
  court_label: string | null;
  fixture_status: string;
  role_key: string;
  response: OfficiatingResponse;
  decline_reason: string | null;
  responded_at: string | null;
  /** Match-report state for this assignment (SPEC-3), for the lane's report CTA
   *  chip. Null when nothing filed / not reportable. */
  report_status: "draft" | "submitted" | null;
}

export interface MyBlackout {
  date: string;
  note: string | null;
}

export interface MyOfficiating {
  /** The signed-in person is linked to at least one officials row. */
  is_official: boolean;
  /** Outstanding duties: still scheduled or in_play (any date). */
  assignments: MyOfficiatingAssignment[];
  /** Finished matches (decided/finalized/abandoned/forfeited/cancelled), most
   *  recent first — surfaced behind a "completed" disclosure in the lane. */
  completed: MyOfficiatingAssignment[];
  blackouts: MyBlackout[];
}

const FINISHED_STATUSES = ["decided", "finalized", "abandoned", "forfeited", "cancelled"] as const;

/** Everything the /me officiating lane renders. Lane shows only when the
 *  person is linked to an officials row — a pure player gets is_official
 *  false and no lane. */
export async function getMyOfficiating(userId: string): Promise<MyOfficiating> {
  const [linked] = await sql<{ has: boolean }[]>`
    select exists(
      select 1 from officials o join persons p on p.id = o.person_id
      where p.user_id = ${userId}) as has`;
  if (!linked?.has) return { is_official: false, assignments: [], completed: [], blackouts: [] };

  const assignments = await sql<MyOfficiatingAssignment[]>`
    select fo.fixture_id, fo.id as fixture_official_id, f.fixture_no, o.id as official_id,
           org.name as org_name, org.slug as org_slug,
           c.name as competition_name, c.slug as competition_slug,
           c.visibility as competition_visibility,
           d.name as division_name, d.slug as division_slug, d.sport_key,
           h.display_name as home_name, a.display_name as away_name,
           f.scheduled_at, ss.tz as venue_tz, f.venue, f.court_label,
           f.status as fixture_status,
           fo.role_key, fo.response, fo.decline_reason, fo.responded_at,
           mr.status as report_status
    from persons p
    join officials o on o.person_id = p.id
    join fixture_officials fo on fo.official_id = o.id
    join fixtures f on f.id = fo.fixture_id
    left join match_reports mr on mr.fixture_official_id = fo.id
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    join organizations org on org.id = f.org_id
    left join schedule_settings ss on ss.division_id = d.id
    left join entrants h on h.id = f.home_entrant_id
    left join entrants a on a.id = f.away_entrant_id
    where p.user_id = ${userId}
      -- Outstanding duties only. The status gate already drops finished
      -- matches (decided/finalized/abandoned/forfeited/cancelled), so NO date
      -- floor: a match still 'scheduled' or 'in_play' is a pending duty even if
      -- its scheduled time has already passed (an in_play match must always
      -- show). A previous scheduled_at-in-the-future filter wrongly hid these.
      and f.status in ('scheduled', 'in_play')
    order by f.scheduled_at nulls last, f.id, fo.role_key
    limit 100`;

  // Finished matches — most recent first — for the collapsed "completed" panel.
  const completed = await sql<MyOfficiatingAssignment[]>`
    select fo.fixture_id, fo.id as fixture_official_id, f.fixture_no, o.id as official_id,
           org.name as org_name, org.slug as org_slug,
           c.name as competition_name, c.slug as competition_slug,
           c.visibility as competition_visibility,
           d.name as division_name, d.slug as division_slug, d.sport_key,
           h.display_name as home_name, a.display_name as away_name,
           f.scheduled_at, ss.tz as venue_tz, f.venue, f.court_label,
           f.status as fixture_status,
           fo.role_key, fo.response, fo.decline_reason, fo.responded_at,
           mr.status as report_status
    from persons p
    join officials o on o.person_id = p.id
    join fixture_officials fo on fo.official_id = o.id
    join fixtures f on f.id = fo.fixture_id
    left join match_reports mr on mr.fixture_official_id = fo.id
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    join organizations org on org.id = f.org_id
    left join schedule_settings ss on ss.division_id = d.id
    left join entrants h on h.id = f.home_entrant_id
    left join entrants a on a.id = f.away_entrant_id
    where p.user_id = ${userId}
      and f.status = any(${[...FINISHED_STATUSES]})
    order by f.scheduled_at desc nulls last, f.id, fo.role_key
    limit 50`;

  const blackouts = await sql<MyBlackout[]>`
    select oa.date::text as date, min(oa.note) as note
    from official_availability oa
    join officials o on o.id = oa.official_id
    join persons p on p.id = o.person_id
    where p.user_id = ${userId} and oa.date >= current_date
    group by oa.date
    order by oa.date`;

  return { is_official: true, assignments, completed, blackouts };
}

export interface PendingOfficiatingClaim {
  /** person_claims.id — the accept endpoint takes this, never the token. */
  id: string;
  org_name: string;
  official_name: string;
}

/**
 * Pending officiating invites addressed to this email, across EVERY org
 * (v11.1): officials belong to multiple organisations, and each invite is
 * its own one-claim-per-org-membership token — a ref who officiates for
 * three leagues gets three separate invites. This runs regardless of
 * is_official (a brand-new official has no linked row yet, and must still
 * see their very first invite here). Never returns the token — only enough
 * to render "<Org> set up an officiating profile for <Name>" + an id to
 * accept by.
 */
export async function listPendingOfficiatingClaims(email: string): Promise<PendingOfficiatingClaim[]> {
  return sql<PendingOfficiatingClaim[]>`
    select pc.id, org.name as org_name, o.display_name as official_name
    from person_claims pc
    join officials o on o.person_id = pc.person_id
    join organizations org on org.id = pc.org_id
    where lower(pc.email) = lower(${email})
      and pc.claimed_at is null and pc.revoked_at is null and pc.expires_at > now()
    order by pc.created_at desc`;
}

/**
 * Accept a pending officiating invite by id (v11.1 "Pending invites" card) —
 * no token in the URL; the session's verified login email does the same job
 * the emailed token normally proves. Ownership is proven FIRST, inside
 * resolveClaimById's lookup itself (scoped to userEmail) — a non-owner (or a
 * bogus id) gets the generic 404 CLAIM_INVALID with no hint of the claim's
 * real state (review fix 2026-07-17: state used to differentiate before the
 * email check, which let anyone holding an id learn whether it was pending/
 * claimed/expired/revoked without proving ownership). Only once ownership is
 * proven does this check officiating-ness (a bare player claim 404s here
 * too, with its own CLAIM_NOT_OFFICIATING code — that flow stays on
 * /claim/[token]) and route through the exact same accept core the token
 * flow uses (acceptResolvedClaim) — no parallel claim mechanism.
 */
export async function acceptMyOfficiatingClaim(
  claimId: string,
  userId: string,
  userEmail: string,
): Promise<{ org_name: string; official_name: string }> {
  const claim = await resolveClaimById(claimId, userEmail);
  if (!claim.is_official) {
    throw new HttpError(404, "This invite is not an officiating invite", "CLAIM_NOT_OFFICIATING");
  }
  const accepted = await acceptResolvedClaim(claim, userId);
  return { org_name: accepted.org_name, official_name: accepted.person_name };
}

/** My official rows (id + org) — the write scope for responses/blackouts. */
async function myOfficials(userId: string): Promise<{ id: string; org_id: string }[]> {
  return sql<{ id: string; org_id: string }[]>`
    select o.id, o.org_id from officials o
    join persons p on p.id = o.person_id
    where p.user_id = ${userId}`;
}

export interface ResponseInput {
  response: "accepted" | "declined";
  decline_reason?: string | null;
}

/**
 * Accept / decline an assignment. Guard: only the assigned official's own
 * person may write. Transitions (spec): pending→accepted, pending→declined,
 * plus re-accept of a prior decline before matchday. Same-state writes are
 * idempotent no-ops. An accepted assignment cannot be self-declined — the
 * organiser re-picks manually (decline is a flag, never an auto-reassign).
 */
export async function setMyOfficiatingResponse(
  userId: string,
  fixtureId: string,
  input: ResponseInput,
): Promise<{ fixture_id: string; response: OfficiatingResponse; decline_reason: string | null }> {
  const rows = await sql<{
    official_id: string; role_key: string; response: OfficiatingResponse;
    fixture_status: string; scheduled_at: string | null;
  }[]>`
    select fo.official_id, fo.role_key, fo.response,
           f.status as fixture_status, f.scheduled_at
    from fixture_officials fo
    join officials o on o.id = fo.official_id
    join persons p on p.id = o.person_id
    join fixtures f on f.id = fo.fixture_id
    where fo.fixture_id = ${fixtureId} and p.user_id = ${userId}`;
  if (rows.length === 0) {
    throw new HttpError(403, "This match isn't assigned to you", "NOT_YOUR_ASSIGNMENT");
  }
  const fixture = rows[0]!;
  if (fixture.fixture_status === "finalized" || fixture.fixture_status === "cancelled") {
    throw new HttpError(422, `This match is ${fixture.fixture_status} — responses are closed`);
  }

  const next = input.response;
  for (const row of rows) {
    if (row.response === next) continue; // idempotent
    if (row.response === "accepted" && next === "declined") {
      throw new HttpError(
        422,
        "You already accepted this assignment — ask the organiser to release you",
        "RESPONSE_LOCKED",
      );
    }
    if (row.response === "declined" && next === "accepted") {
      const at = fixture.scheduled_at ? new Date(fixture.scheduled_at).getTime() : null;
      if (at !== null && at <= Date.now()) {
        throw new HttpError(422, "Matchday has passed — this decline can't be reversed", "RESPONSE_LOCKED");
      }
    }
  }

  const reason = next === "declined" ? (input.decline_reason?.trim() || null) : null;
  await sql`
    update fixture_officials fo
    set response = ${next}, responded_at = now(), decline_reason = ${reason}
    from officials o, persons p
    where fo.fixture_id = ${fixtureId}
      and o.id = fo.official_id and p.id = o.person_id and p.user_id = ${userId}
      and fo.response <> ${next}`;
  await refreshOfficialsCache(superuser, [fixtureId]);
  return { fixture_id: fixtureId, response: next, decline_reason: reason };
}

/** Mark a blackout date on EVERY officials row linked to me — "can't do
 *  Sunday" is a fact about the person, not one org. Upsert on note. */
export async function setMyBlackout(
  userId: string,
  date: string,
  note?: string | null,
): Promise<MyBlackout> {
  const mine = await myOfficials(userId);
  if (mine.length === 0) {
    throw new HttpError(403, "No officiating profile is linked to your account", "NOT_AN_OFFICIAL");
  }
  for (const o of mine) {
    await sql`
      insert into official_availability (org_id, official_id, date, note)
      values (${o.org_id}, ${o.id}, ${date}, ${note?.trim() || null})
      on conflict (official_id, date) do update set note = excluded.note`;
  }
  return { date, note: note?.trim() || null };
}

/** Clear a blackout date across all my officials rows (idempotent). */
export async function deleteMyBlackout(userId: string, date: string): Promise<void> {
  const mine = await myOfficials(userId);
  if (mine.length === 0) {
    throw new HttpError(403, "No officiating profile is linked to your account", "NOT_AN_OFFICIAL");
  }
  await sql`
    delete from official_availability
    where date = ${date} and official_id in ${sql(mine.map((o) => o.id))}`;
}
