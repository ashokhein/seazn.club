import "server-only";
// Scorer role machinery (doc 13, PROMPT-18): scoped-assignment resolution
// (fixture ⊂ division ⊂ competition), the requireScorable gate, assignment
// writes, and the "My matches" read. Enforcement lives here in the use-case
// layer — never UI-only (doc 13 §3).
import { sql } from "@/lib/db";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { ScorerScopeType } from "@/lib/types";

export interface FixtureScope {
  id: string;
  org_id: string;
  division_id: string;
  competition_id: string;
  status: string;
  scorer_can_finalize: boolean;
  scorer_can_enter_lineups: boolean;
}

/** Fixture + the scope ids and scorer capability flags in one superuser read
 *  (auth-path helper; RLS-bounded reads happen in the use-cases proper). */
export async function fixtureScope(fixtureId: string): Promise<FixtureScope | null> {
  const [row] = await sql<FixtureScope[]>`
    select f.id, f.org_id, f.division_id, d.competition_id, f.status,
           d.scorer_can_finalize, d.scorer_can_enter_lineups
    from fixtures f join divisions d on d.id = f.division_id
    where f.id = ${fixtureId} limit 1`;
  return row ?? null;
}

/** Does any assignment cover this fixture (doc 13 §3 resolution)? */
export async function scorerCovers(
  orgId: string,
  userId: string,
  scope: Pick<FixtureScope, "id" | "division_id" | "competition_id">,
): Promise<boolean> {
  const rows = await sql`
    select 1 from scorer_assignments
    where org_id = ${orgId} and user_id = ${userId}
      and ((scope_type = 'fixture'     and scope_id = ${scope.id})
        or (scope_type = 'division'    and scope_id = ${scope.division_id})
        or (scope_type = 'competition' and scope_id = ${scope.competition_id}))
    limit 1`;
  return rows.length > 0;
}

/** Roles whose scoring rights come from assignments, not the role itself:
 *  scorers always; viewers additively (an accepted umpire invite keeps their
 *  role and adds the assignment). The scorer capability config gates bind
 *  both — only editors bypass them. */
export function scoresViaAssignment(role: string | null): boolean {
  return role === "scorer" || role === "viewer";
}

/**
 * THE scorer gate (doc 13 §2/§3): editor roles and write-scoped API keys
 * pass; scorers — and viewers, whose umpire invites grant assignments on top
 * of their read role — pass iff a covering assignment exists. Everyone else
 * is 403. Returns the fixture scope so callers can apply the capability
 * config without a second lookup.
 */
export async function requireScorable(auth: AuthCtx, fixtureId: string): Promise<FixtureScope> {
  const scope = await fixtureScope(fixtureId);
  if (!scope || scope.org_id !== auth.orgId) throw new HttpError(404, "fixture not found");
  if (auth.via === "api_key") return scope; // scope checked at key auth (write)
  if (auth.role === "owner" || auth.role === "admin") return scope;
  if (scoresViaAssignment(auth.role)) {
    if (auth.userId && (await scorerCovers(auth.orgId, auth.userId, scope))) return scope;
    if (auth.role === "scorer") throw new HttpError(403, "You are not assigned to this fixture");
  }
  throw new HttpError(403, "Your role cannot record scores");
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

const SCOPE_TABLE: Record<ScorerScopeType, "competitions" | "divisions" | "fixtures"> = {
  competition: "competitions",
  division: "divisions",
  fixture: "fixtures",
};

/** Create an assignment (idempotent on the unique key). Validates the scope
 *  target exists in the org — RLS bounds the lookup. */
export async function createAssignment(
  orgId: string,
  userId: string,
  scope: { type: ScorerScopeType; id: string },
  createdBy: string | null,
): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const table = SCOPE_TABLE[scope.type];
    const [target] = await tx`select 1 from ${tx(table)} where id = ${scope.id}`;
    if (!target) throw new HttpError(422, `${scope.type} not found in this organization`);
    await tx`
      insert into scorer_assignments (org_id, user_id, scope_type, scope_id, created_by)
      values (${orgId}, ${userId}, ${scope.type}, ${scope.id}, ${createdBy})
      on conflict (org_id, user_id, scope_type, scope_id) do nothing`;
  });
}

// ---------------------------------------------------------------------------
// My matches (doc 13 §3/§6): every fixture covered by the user's assignments,
// across all their orgs. Superuser read — assignments span orgs and the
// public read views don't carry private divisions.
// ---------------------------------------------------------------------------

export interface AssignedFixture {
  id: string;
  fixture_no: number;
  org_id: string;
  org_name: string;
  org_slug: string;
  competition_id: string;
  competition_name: string;
  competition_slug: string;
  division_id: string;
  division_name: string;
  division_slug: string;
  division_status: string;
  sport_key: string;
  module_version: string;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_name: string | null;
  away_name: string | null;
  scheduled_at: string | null;
  venue: string | null;
  court_label: string | null;
  status: string;
}

const SCORABLE_STATUSES = ["scheduled", "in_play"];

/** Assigned fixtures, soonest first. `date` (YYYY-MM-DD) filters to one day;
 *  otherwise: unscheduled + everything from the start of today onward. */
export async function listAssignedFixtures(
  userId: string,
  date?: string,
): Promise<AssignedFixture[]> {
  const dayFrom = date ? new Date(`${date}T00:00:00Z`) : null;
  const dayTo = dayFrom ? new Date(dayFrom.getTime() + 24 * 60 * 60 * 1000) : null;
  return sql<AssignedFixture[]>`
    select distinct on (f.scheduled_at, f.id)
           f.id, f.fixture_no, f.org_id, o.name as org_name, o.slug as org_slug,
           c.id as competition_id, c.name as competition_name, c.slug as competition_slug,
           d.id as division_id, d.name as division_name, d.slug as division_slug,
           d.status as division_status,
           d.sport_key, d.module_version, f.round_no,
           f.home_entrant_id, f.away_entrant_id,
           he.display_name as home_name, ae.display_name as away_name,
           f.scheduled_at, f.venue, f.court_label, f.status
    from scorer_assignments sa
    join fixtures f on (
         (sa.scope_type = 'fixture'     and f.id = sa.scope_id)
      or (sa.scope_type = 'division'    and f.division_id = sa.scope_id)
      or (sa.scope_type = 'competition' and f.division_id in
            (select id from divisions where competition_id = sa.scope_id))
    ) and f.org_id = sa.org_id
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = f.org_id
    left join entrants he on he.id = f.home_entrant_id
    left join entrants ae on ae.id = f.away_entrant_id
    where sa.user_id = ${userId}
      and f.status in ${sql(SCORABLE_STATUSES)}
      and (
        (${date ?? null}::text is null
          and (f.scheduled_at is null or f.scheduled_at >= date_trunc('day', now())))
        or (${date ?? null}::text is not null
          and f.scheduled_at >= ${dayFrom ?? null} and f.scheduled_at < ${dayTo ?? null})
      )
    order by f.scheduled_at nulls last, f.id
    limit 200`;
}

/** True when the user holds ONLY scorer memberships (doc 13 §4 — their
 *  post-login landing is "My matches", not the org dashboard). */
export async function isScorerOnly(userId: string): Promise<boolean> {
  const rows = await sql<{ role: string }[]>`
    select distinct role from org_members where user_id = ${userId}`;
  return rows.length > 0 && rows.every((r) => r.role === "scorer");
}
