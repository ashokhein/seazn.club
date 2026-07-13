import "server-only";
// Player home (PROMPT-53, doc 16 §1.3): cross-org "me" reads and writes for
// claimed players. Superuser queries mirroring listAssignedFixtures — a
// claimed player is usually NOT an org member, so the tenant door never
// opens for them; every function pins rows through persons.user_id = me.
// dob never leaves this module — only the derived consent_locked flag does.
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { consentLocked } from "@/lib/guardian";
import type { AuthCtx } from "@/server/api-v1/auth";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";

export type AvailabilityStatus = "in" | "out" | "maybe";

export interface MyFixture {
  id: string;
  fixture_no: number;
  person_id: string;
  person_name: string;
  org_name: string;
  org_slug: string;
  competition_name: string;
  competition_slug: string;
  competition_visibility: string;
  division_name: string;
  division_slug: string;
  sport_key: string;
  round_no: number;
  entrant_name: string | null;
  opponent_name: string | null;
  scheduled_at: string | null;
  venue: string | null;
  court_label: string | null;
  status: string;
  availability: { status: AvailabilityStatus; note: string | null } | null;
  checked_in_at: string | null;
}

export interface MyResult {
  id: string;
  fixture_no: number;
  competition_name: string;
  competition_slug: string;
  competition_visibility: string;
  division_name: string;
  division_slug: string;
  org_name: string;
  org_slug: string;
  entrant_name: string | null;
  opponent_name: string | null;
  scheduled_at: string | null;
  summary: string | null;
  outcome: unknown;
}

export interface MyTeam {
  entrant_id: string;
  entrant_name: string;
  division_name: string;
  competition_name: string;
  org_name: string;
  sport_key: string;
}

const ROSTERED = ["registered", "confirmed"];

// The membership chain every /me read hangs off: my persons → their entrant
// memberships → fixtures where that entrant plays. Fragment inlined per query
// (postgres.js has no composable fragments with bindings across helpers).

export async function listMyFixtures(userId: string): Promise<{
  upcoming: MyFixture[];
  results: MyResult[];
  teams: MyTeam[];
}> {
  const upcoming = await sql<MyFixture[]>`
    select distinct on (f.scheduled_at, f.id, p.id)
           f.id, f.fixture_no, p.id as person_id, p.full_name as person_name,
           o.name as org_name, o.slug as org_slug,
           c.name as competition_name, c.slug as competition_slug,
           c.visibility as competition_visibility,
           d.name as division_name, d.slug as division_slug, d.sport_key,
           f.round_no, e.display_name as entrant_name,
           opp.display_name as opponent_name,
           f.scheduled_at, f.venue, f.court_label, f.status,
           case when fa.status is null then null
                else jsonb_build_object('status', fa.status, 'note', fa.note) end
             as availability,
           fa.checked_in_at
    from persons p
    join entrant_members em on em.person_id = p.id
    join entrants e on e.id = em.entrant_id and e.status in ${sql(ROSTERED)}
    join fixtures f on (f.home_entrant_id = e.id or f.away_entrant_id = e.id)
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = f.org_id
    left join entrants opp on opp.id =
      case when f.home_entrant_id = e.id then f.away_entrant_id else f.home_entrant_id end
    left join fixture_availability fa on fa.fixture_id = f.id and fa.person_id = p.id
    where p.user_id = ${userId}
      and f.status in ('scheduled', 'in_play')
      and (f.scheduled_at is null or f.scheduled_at >= date_trunc('day', now()))
    order by f.scheduled_at nulls last, f.id, p.id
    limit 100`;

  const results = await sql<MyResult[]>`
    select distinct on (f.scheduled_at, f.id)
           f.id, f.fixture_no,
           c.name as competition_name, c.slug as competition_slug,
           c.visibility as competition_visibility,
           d.name as division_name, d.slug as division_slug,
           o.name as org_name, o.slug as org_slug,
           e.display_name as entrant_name, opp.display_name as opponent_name,
           f.scheduled_at, m.summary, f.outcome
    from persons p
    join entrant_members em on em.person_id = p.id
    join entrants e on e.id = em.entrant_id and e.status in ${sql(ROSTERED)}
    join fixtures f on (f.home_entrant_id = e.id or f.away_entrant_id = e.id)
    left join match_states m on m.fixture_id = f.id
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = f.org_id
    left join entrants opp on opp.id =
      case when f.home_entrant_id = e.id then f.away_entrant_id else f.home_entrant_id end
    where p.user_id = ${userId} and f.status = 'finalized'
    order by f.scheduled_at desc nulls last, f.id
    limit 10`;

  const teams = await sql<MyTeam[]>`
    select distinct e.id as entrant_id, e.display_name as entrant_name,
           d.name as division_name, c.name as competition_name,
           o.name as org_name, d.sport_key
    from persons p
    join entrant_members em on em.person_id = p.id
    join entrants e on e.id = em.entrant_id and e.status in ${sql(ROSTERED)}
    join divisions d on d.id = e.division_id
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = d.org_id
    where p.user_id = ${userId}
    order by o.name, c.name, d.name`;

  return { upcoming, results, teams };
}

interface MyFixturePerson {
  person_id: string;
  org_id: string;
  fixture_status: string;
}

/** MY person on this fixture (either side's roster), or null. */
async function myPersonOnFixture(userId: string, fixtureId: string): Promise<MyFixturePerson | null> {
  const [row] = await sql<MyFixturePerson[]>`
    select p.id as person_id, f.org_id, f.status as fixture_status
    from fixtures f
    join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
      and e.status in ${sql(ROSTERED)}
    join entrant_members em on em.entrant_id = e.id
    join persons p on p.id = em.person_id and p.user_id = ${userId}
    where f.id = ${fixtureId}
    limit 1`;
  return row ?? null;
}

export interface AvailabilityRow {
  fixture_id: string;
  person_id: string;
  status: AvailabilityStatus;
  note: string | null;
  checked_in_at: string | null;
  updated_at: string;
}

const FA_COLS = ["fixture_id", "person_id", "status", "note", "checked_in_at", "updated_at"] as const;

/** RSVP (in/out/maybe + note). Player-only door: the fixture must involve a
 *  roster containing one of MY claimed persons. */
export async function setMyAvailability(
  userId: string,
  fixtureId: string,
  input: { status: AvailabilityStatus; note?: string | null },
): Promise<AvailabilityRow> {
  const mine = await myPersonOnFixture(userId, fixtureId);
  if (!mine) throw new HttpError(403, "This match doesn't involve any of your player profiles", "NOT_YOUR_FIXTURE");
  if (mine.fixture_status === "finalized" || mine.fixture_status === "cancelled") {
    throw new HttpError(422, `This match is ${mine.fixture_status} — availability is closed`);
  }
  const [row] = await sql<AvailabilityRow[]>`
    insert into fixture_availability (fixture_id, person_id, org_id, status, note)
    values (${fixtureId}, ${mine.person_id}, ${mine.org_id}, ${input.status}, ${input.note ?? null})
    on conflict (fixture_id, person_id) do update
      set status = excluded.status, note = excluded.note, updated_at = now()
    returning ${sql(FA_COLS)}`;
  return row;
}

/**
 * QR self check-in: stamp presence. A fresh row defaults the RSVP to 'in'
 * (turning up answers the question); an existing answer is never clobbered.
 * Returns null when the caller has no claimed person on the fixture — the
 * route turns that into the claim-first interstitial.
 */
export async function checkInToFixture(
  userId: string,
  fixtureId: string,
): Promise<AvailabilityRow | null> {
  const mine = await myPersonOnFixture(userId, fixtureId);
  if (!mine) return null;
  if (mine.fixture_status === "finalized" || mine.fixture_status === "cancelled") {
    throw new HttpError(422, `This match is ${mine.fixture_status} — check-in is closed`);
  }
  const [row] = await sql<AvailabilityRow[]>`
    insert into fixture_availability (fixture_id, person_id, org_id, status, checked_in_at)
    values (${fixtureId}, ${mine.person_id}, ${mine.org_id}, 'in', now())
    on conflict (fixture_id, person_id) do update
      set checked_in_at = now(), updated_at = now()
    returning ${sql(FA_COLS)}`;
  return row;
}

export interface FixtureAvailability {
  person_id: string;
  status: AvailabilityStatus;
  note: string | null;
  checked_in_at: string | null;
}

/** Organiser-side read for the lineup picker (PROMPT-53): every RSVP/check-in
 *  on the fixture, keyed by person. Tenant-bounded — unlike the /me reads. */
export async function listFixtureAvailability(
  auth: AuthCtx,
  fixtureId: string,
): Promise<Record<string, FixtureAvailability>> {
  return withTenant(auth.orgId, async (tx) => {
    const rows = await tx<FixtureAvailability[]>`
      select person_id, status, note, checked_in_at
      from fixture_availability where fixture_id = ${fixtureId}`;
    return Object.fromEntries(rows.map((r) => [r.person_id, r]));
  });
}

/** Does any claimed player profile point at this login? Drives the console
 *  nav's "Player home" door for dual-role users (organiser + player). */
export async function hasClaimedProfile(userId: string): Promise<boolean> {
  const [row] = await sql<{ has: boolean }[]>`
    select exists(select 1 from persons where user_id = ${userId}) as has`;
  return row?.has === true;
}

/** True when the user's ONLY relationship to the platform is a claimed
 *  player profile (no org memberships). Their landing is /me — never the
 *  org dashboard, and never an auto-provisioned "My organization" (the
 *  scorer-only rule, doc 13 §4, extended to players). */
export async function isPlayerOnly(userId: string): Promise<boolean> {
  const [row] = await sql<{ player_only: boolean }[]>`
    select exists(select 1 from persons where user_id = ${userId})
       and not exists(select 1 from org_members where user_id = ${userId})
       as player_only`;
  return row?.player_only === true;
}

export interface MyPerson {
  id: string;
  full_name: string;
  org_name: string;
  consent: { public_name?: boolean; public_photo?: boolean };
  consent_locked: boolean;
}

/** My claimed persons across all orgs, with consent state. dob stays server-side. */
export async function listMyPersons(userId: string): Promise<MyPerson[]> {
  const rows = await sql<
    (Omit<MyPerson, "consent_locked"> & { dob: string | null })[]
  >`
    select p.id, p.full_name, o.name as org_name, p.consent, p.dob
    from persons p join organizations o on o.id = p.org_id
    where p.user_id = ${userId}
    order by o.name, p.full_name`;
  return rows.map(({ dob, ...p }) => ({
    ...p,
    consent: (p.consent ?? {}) as MyPerson["consent"],
    consent_locked: consentLocked(dob),
  }));
}

/**
 * Player-owned consent flags (doc 06 §4.7 handover): merge into
 * persons.consent, then revalidate every division the person is rostered in
 * so the public card and entrant lists flip immediately. Guardian gate:
 * under-16 by dob → 403, organiser-set values hold.
 */
export async function setMyConsent(
  userId: string,
  personId: string,
  patch: { public_name?: boolean; public_photo?: boolean },
): Promise<MyPerson> {
  const [person] = await sql<{ id: string; dob: string | null }[]>`
    select id, dob from persons where id = ${personId} and user_id = ${userId}`;
  if (!person) throw new HttpError(404, "player profile not found");
  if (consentLocked(person.dob)) {
    throw new HttpError(403, "An organiser manages consent for under-16 players", "CONSENT_LOCKED");
  }
  const clean: Record<string, boolean> = {};
  if (typeof patch.public_name === "boolean") clean.public_name = patch.public_name;
  if (typeof patch.public_photo === "boolean") clean.public_photo = patch.public_photo;
  await sql`
    update persons set consent = coalesce(consent, '{}'::jsonb) || ${sql.json(clean)}
    where id = ${personId}`;

  const memberships = await sql<{ division_id: string; competition_id: string }[]>`
    select distinct e.division_id, d.competition_id
    from entrant_members em
    join entrants e on e.id = em.entrant_id
    join divisions d on d.id = e.division_id
    where em.person_id = ${personId}`;
  for (const m of memberships) fireDivisionRevalidate(m.division_id, m.competition_id);

  const [me] = await listMyPersons(userId).then((all) => all.filter((p) => p.id === personId));
  return me;
}
