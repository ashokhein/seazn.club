import "server-only";
// Entrant use-cases (doc 08 §3): registration (single + bulk), withdraw/seed/
// member management. Cross-org person references die at the RLS boundary — a
// person the tenant can't see doesn't exist.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { withinLimit } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { z } from "zod";
import type { CreateEntrant, PatchEntrant, EntrantMemberInput } from "@/server/api-v1/schemas";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";

type Tx = postgres.TransactionSql;
type MemberInput = z.infer<typeof EntrantMemberInput>;

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
  clubId?: string,
): Promise<EntrantRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // ?club_id= facet (Jul3/01 §6): a read-side grouping over teams.club_id.
    return tx<EntrantRow[]>`
      select ${tx(COLS)} from entrants
      where division_id = ${divisionId}
      ${clubId ? tx`and team_id in (select id from teams where club_id = ${clubId})` : tx``}
      order by seed nulls last, created_at, id`;
  });
}

/** Register one entrant or a bulk batch (doc 08 §3 "+ bulk import"). */
export async function createEntrants(
  auth: AuthCtx,
  divisionId: string,
  inputs: CreateEntrant[],
): Promise<EntrantRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ status: string; competition_id: string }[]>`
      select status, competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    await assertCompetitionNotFrozen(auth.orgId, division.competition_id, tx);

    // Doc 10 §1: `entrants.per_division.max` (16/64/256) — the whole batch
    // must fit; count in the same tx as the inserts (doc 10 §2 rule 1).
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from entrants where division_id = ${divisionId}`;
    const quota = await withinLimit(auth.orgId, "entrants.per_division.max", n + inputs.length);
    if (!quota.ok) throw new PaymentRequiredError("entrants.per_division.max");

    const rows: EntrantRow[] = [];
    for (const input of inputs) {
      const [row] = await tx<EntrantRow[]>`
        insert into entrants (division_id, kind, team_id, display_name, seed)
        values (${divisionId}, ${input.kind}, ${input.team_id ?? null},
                ${input.display_name}, ${input.seed ?? null})
        returning ${tx(COLS)}`;
      await insertMembers(tx, row.id, input.members);
      rows.push(row);
    }
    return rows;
  });
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
