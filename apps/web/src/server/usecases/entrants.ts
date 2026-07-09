import "server-only";
// Entrant use-cases (doc 08 §3): registration (single + bulk), withdraw/seed/
// member management. Cross-org person references die at the RLS boundary — a
// person the tenant can't see doesn't exist.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { withinLimit } from "@/lib/entitlements";
import { resolveModule } from "@/server/engine-db/registry";
import { loadTeamSquad } from "./teams";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { z } from "zod";
import type { CreateEntrant, PatchEntrant, EntrantMemberInput } from "@/server/api-v1/schemas";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";

type Tx = postgres.TransactionSql;
type MemberInput = z.infer<typeof EntrantMemberInput>;

/** Drop position/role keys the target division's sport doesn't define, keeping
 *  the member. Returns the cleaned roster plus a count of dropped keys so the
 *  caller can tell the organiser "N settings didn't carry over". */
function filterRosterForSport(
  members: MemberInput[],
  sportKey: string,
  moduleVersion: string,
): { members: MemberInput[]; dropped: number } {
  const mod = resolveModule(sportKey, moduleVersion);
  const positions = new Set((mod.positions?.groups ?? []).map((g) => g.key));
  const roles = new Set((mod.positions?.roles ?? []).map((r) => r.key));
  let dropped = 0;
  const cleaned = members.map((m) => {
    let position = m.default_position_key ?? null;
    if (position != null && !positions.has(position)) {
      position = null;
      dropped += 1;
    }
    const src = m.roles ?? [];
    const keptRoles = src.filter((r) => roles.has(r));
    dropped += src.length - keptRoles.length;
    return { ...m, default_position_key: position, roles: keptRoles };
  });
  return { members: cleaned, dropped };
}

/** Load an entrant's roster in the CreateEntrant member shape, for copying. */
async function loadRosterForCopy(tx: Tx, entrantId: string): Promise<MemberInput[]> {
  const rows = await tx<MemberInput[]>`
    select person_id, squad_number, default_position_key, is_captain, roles
    from entrant_members where entrant_id = ${entrantId}`;
  return rows;
}

export interface EntrantRow {
  id: string;
  division_id: string;
  kind: string;
  team_id: string | null;
  display_name: string;
  seed: number | null;
  status: string;
  created_at: string;
}

export interface EntrantWithMembers extends EntrantRow {
  members: unknown[];
}

/** A created entrant, plus (response-only) how many roster keys were dropped
 *  because the target sport doesn't define them. Not a persisted column. */
export interface CreatedEntrant extends EntrantRow {
  roster_keys_dropped?: number;
}

const COLS = [
  "id", "division_id", "kind", "team_id", "display_name", "seed", "status", "created_at",
] as const;

async function insertMembers(tx: Tx, entrantId: string, members: MemberInput[]): Promise<void> {
  if (members.length === 0) return;
  // Every referenced person must be visible under this tenant's RLS.
  const ids = [...new Set(members.map((m) => m.person_id))];
  const visible = await tx<{ id: string }[]>`select id from persons where id in ${tx(ids)}`;
  if (visible.length !== ids.length) {
    const seen = new Set(visible.map((r) => r.id));
    const missing = ids.filter((id) => !seen.has(id));
    throw new HttpError(422, `unknown person(s): ${missing.join(", ")}`);
  }
  for (const m of members) {
    await tx`
      insert into entrant_members (entrant_id, person_id, squad_number,
                                   default_position_key, is_captain, roles)
      values (${entrantId}, ${m.person_id}, ${m.squad_number ?? null},
              ${m.default_position_key ?? null}, ${m.is_captain},
              ${tx.json(m.roles as never)})`;
  }
}

async function withMembers(tx: Tx, entrant: EntrantRow): Promise<EntrantWithMembers> {
  const members = await tx<Record<string, unknown>[]>`
    select em.person_id, p.full_name, em.squad_number, em.default_position_key,
           em.is_captain, em.roles
    from entrant_members em join persons p on p.id = em.person_id
    where em.entrant_id = ${entrant.id}
    order by em.squad_number nulls last, p.full_name`;
  return { ...entrant, members };
}

export async function listEntrants(
  auth: AuthCtx,
  divisionId: string,
  filter: { clubId?: string; teamId?: string } = {},
): Promise<EntrantRow[]> {
  const { clubId, teamId } = filter;
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // ?club_id= facet (Jul3/01 §6): a read-side grouping over teams.club_id.
    // ?team_id= narrows to a single team (used by the enroll-existing flow).
    return tx<EntrantRow[]>`
      select ${tx(COLS)} from entrants
      where division_id = ${divisionId}
      ${clubId ? tx`and team_id in (select id from teams where club_id = ${clubId})` : tx``}
      ${teamId ? tx`and team_id = ${teamId}` : tx``}
      order by seed nulls last, created_at, id`;
  });
}

/** Register one entrant or a bulk batch (doc 08 §3 "+ bulk import").
 *  Enrolling an existing team (team_id set) snapshots the display name from the
 *  team, enforces one-entry-per-division (409), and can copy a prior roster. */
export async function createEntrants(
  auth: AuthCtx,
  divisionId: string,
  inputs: CreateEntrant[],
): Promise<CreatedEntrant[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<
      { status: string; competition_id: string; sport_key: string; module_version: string }[]
    >`select status, competition_id, sport_key, module_version
      from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    await assertCompetitionNotFrozen(auth.orgId, division.competition_id, tx);

    // Doc 10 §1: `entrants.per_division.max` (16/64/256) — the whole batch
    // must fit; count in the same tx as the inserts (doc 10 §2 rule 1).
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${divisionId}`;
    const quota = await withinLimit(auth.orgId, "entrants.per_division.max", n + inputs.length);
    if (!quota.ok) throw new PaymentRequiredError("entrants.per_division.max");

    const rows: CreatedEntrant[] = [];
    for (const input of inputs) {
      // Snapshot the name from the team so a later rename never rewrites
      // historical standings (which read entrants.display_name / snapshots).
      let displayName = input.display_name ?? null;
      if (input.team_id) {
        const [team] = await tx<{ name: string }[]>`
          select name from teams where id = ${input.team_id}`;
        if (!team) throw new HttpError(404, "team not found");
        displayName = team.name;
      }
      if (displayName == null) throw new HttpError(422, "display_name is required");

      // Resolve the roster to store, in precedence order: members supplied on
      // the request → a copied prior entrant → the team's persistent squad.
      // Copied/seeded rosters are filtered to the target sport.
      let members = input.members;
      let dropped = 0;
      if (input.copy_roster_from_entrant_id) {
        const [source] = await tx<{ team_id: string | null }[]>`
          select team_id from entrants where id = ${input.copy_roster_from_entrant_id}`;
        if (!source) throw new HttpError(404, "roster source entrant not found");
        if (!input.team_id || source.team_id !== input.team_id) {
          throw new HttpError(422, "roster source must be an entrant of the same team");
        }
        const raw = await loadRosterForCopy(tx, input.copy_roster_from_entrant_id);
        const filtered = filterRosterForSport(raw, division.sport_key, division.module_version);
        members = filtered.members;
        dropped = filtered.dropped;
      } else if (input.team_id && members.length === 0) {
        // No explicit roster and no copy source → seed from the team's squad.
        const squad = await loadTeamSquad(tx, input.team_id);
        if (squad.length > 0) {
          const filtered = filterRosterForSport(squad, division.sport_key, division.module_version);
          members = filtered.members;
          dropped = filtered.dropped;
        }
      }

      let row: EntrantRow;
      try {
        [row] = await tx<EntrantRow[]>`
          insert into entrants (division_id, kind, team_id, display_name, seed)
          values (${divisionId}, ${input.kind}, ${input.team_id ?? null},
                  ${displayName}, ${input.seed ?? null})
          returning ${tx(COLS)}`;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new HttpError(409, "this team is already entered in this division");
        }
        throw err;
      }
      await insertMembers(tx, row.id, members);
      rows.push(dropped > 0 ? { ...row, roster_keys_dropped: dropped } : row);
    }
    return rows;
  });
}

export interface DivisionRosterRow {
  person_id: string;
  entrant_id: string;
  entrant_name: string;
}

/** Every (person → team entrant) membership in a division. Powers the
 *  same-division double-roster warning: a person on two teams here is flagged
 *  (advisory, not blocked). */
export async function divisionRoster(
  auth: AuthCtx,
  divisionId: string,
): Promise<DivisionRosterRow[]> {
  return withTenant(auth.orgId, (tx) => tx<DivisionRosterRow[]>`
    select em.person_id, e.id as entrant_id, e.display_name as entrant_name
    from entrants e
    join entrant_members em on em.entrant_id = e.id
    where e.division_id = ${divisionId}
      and e.status in ('registered','confirmed')`);
}

export async function getEntrant(auth: AuthCtx, id: string): Promise<EntrantWithMembers> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<EntrantRow[]>`select ${tx(COLS)} from entrants where id = ${id}`;
    if (!row) throw new HttpError(404, "entrant not found");
    return withMembers(tx, row);
  });
}

export async function patchEntrant(
  auth: AuthCtx,
  id: string,
  patch: PatchEntrant,
): Promise<EntrantWithMembers> {
  return withTenant(auth.orgId, async (tx) => {
    const { members, ...fields } = patch;
    let row: EntrantRow | undefined;
    if (Object.keys(fields).length > 0) {
      const cols = Object.keys(fields);
      [row] = await tx<EntrantRow[]>`
        update entrants set ${tx(fields as never, ...(cols as never[]))}
        where id = ${id} returning ${tx(COLS)}`;
    } else {
      [row] = await tx<EntrantRow[]>`select ${tx(COLS)} from entrants where id = ${id}`;
    }
    if (!row) throw new HttpError(404, "entrant not found");
    if (members) {
      // Full roster replacement — simple and idempotent.
      await tx`delete from entrant_members where entrant_id = ${id}`;
      await insertMembers(tx, id, members);
    }
    return withMembers(tx, row);
  });
}
