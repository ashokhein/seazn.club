import "server-only";
// Officials use-cases (Jul3/02 §4): CRUD + import, auto-propose / apply,
// manual per-fixture set/lock, phased sourcing. The pure pass lives in
// @seazn/engine/officials; fixture_officials is the write source and
// fixtures.officials the denormalized read cache.
import type postgres from "postgres";
import {
  AssignPolicy,
  OfficialSourcing,
  assignOfficials,
  resolveOfficialSourcing,
  type AssignResult,
  type FixtureOfficial,
  type OfficialFixture,
  type OfficialSpec,
} from "@seazn/engine/officials";
import { z } from "zod";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { parseUpload } from "./import-parse";

type Tx = postgres.TransactionSql;

export interface OfficialRow {
  id: string;
  person_id: string | null;
  entrant_id: string | null;
  display_name: string;
  role_keys: string[];
  home_pool_id: string | null;
  max_per_day: number | null;
  created_at: string;
}

const COLS = [
  "id", "person_id", "entrant_id", "display_name", "role_keys",
  "home_pool_id", "max_per_day", "created_at",
] as const;

export const CreateOfficialInput = z.object({
  display_name: z.string().min(1).max(200),
  person_id: z.string().uuid().optional(),
  entrant_id: z.string().uuid().optional(),
  role_keys: z.array(z.string().min(1)).min(1).default(["referee"]),
  home_pool_id: z.string().uuid().nullable().optional(),
  max_per_day: z.number().int().positive().nullable().optional(),
});
export type CreateOfficialInput = z.infer<typeof CreateOfficialInput>;

export const PatchOfficialInput = CreateOfficialInput.partial();
export type PatchOfficialInput = z.infer<typeof PatchOfficialInput>;

// Jul3/02 §5: judge + referee (multi-role officials) are Pro.
async function assertRolesAllowed(orgId: string, roleKeys?: string[]): Promise<void> {
  if (roleKeys && roleKeys.length > 1) {
    await requireFeature(orgId, "officials.roles_multi");
  }
}

export async function listOfficials(auth: AuthCtx): Promise<OfficialRow[]> {
  return withTenant(auth.orgId, (tx) => tx<OfficialRow[]>`
    select ${tx(COLS)} from officials order by display_name, id`);
}

export async function createOfficial(auth: AuthCtx, input: CreateOfficialInput): Promise<OfficialRow> {
  await assertRolesAllowed(auth.orgId, input.role_keys);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<OfficialRow[]>`
      insert into officials (org_id, person_id, entrant_id, display_name,
                             role_keys, home_pool_id, max_per_day)
      values (${auth.orgId}, ${input.person_id ?? null}, ${input.entrant_id ?? null},
              ${input.display_name}, ${tx.json(input.role_keys as never)},
              ${input.home_pool_id ?? null}, ${input.max_per_day ?? null})
      returning ${tx(COLS)}`;
    return row!;
  });
}

export async function patchOfficial(
  auth: AuthCtx,
  id: string,
  patch: PatchOfficialInput,
): Promise<OfficialRow> {
  await assertRolesAllowed(auth.orgId, patch.role_keys);
  return withTenant(auth.orgId, async (tx) => {
    const cols = Object.keys(patch);
    if (cols.length === 0) throw new HttpError(400, "empty patch");
    const values = {
      ...patch,
      ...(patch.role_keys ? { role_keys: tx.json(patch.role_keys as never) } : {}),
    };
    const [row] = await tx<OfficialRow[]>`
      update officials set ${tx(values as never, ...(cols as never[]))}
      where id = ${id} returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "official not found");
    return row;
  });
}

export async function deleteOfficial(auth: AuthCtx, id: string): Promise<void> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      delete from officials where id = ${id} returning id`;
    if (!row) throw new HttpError(404, "official not found");
  });
}

/** Bulk officials import (Jul3/02 §4) — reuses the Jul3/01 parser: columns
 *  Name, Roles (comma/space separated), MaxPerDay. Simple direct creates,
 *  idempotent on folded display_name. */
export async function importOfficials(
  auth: AuthCtx,
  filename: string,
  contentType: string | null,
  buffer: Buffer,
): Promise<{ created: number; skipped: number }> {
  const table = await parseUpload(filename, contentType, buffer);
  const [header, ...data] = table;
  if (!header) throw new HttpError(422, "The file has no header row");
  const norm = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const nameCol = norm.findIndex((h) => ["name", "official", "displayname"].includes(h));
  const rolesCol = norm.findIndex((h) => ["roles", "role", "rolekeys"].includes(h));
  const capCol = norm.findIndex((h) => ["maxperday", "cap", "max"].includes(h));
  if (nameCol < 0) throw new HttpError(422, "No Name column found");

  return withTenant(auth.orgId, async (tx) => {
    const existing = await tx<{ display_name: string }[]>`select display_name from officials`;
    const seen = new Set(existing.map((r) => r.display_name.trim().toLowerCase()));
    let created = 0;
    let skipped = 0;
    for (const cells of data) {
      const name = cells[nameCol]?.trim();
      if (!name) continue;
      if (seen.has(name.toLowerCase())) {
        skipped++;
        continue;
      }
      const roles =
        rolesCol >= 0 && cells[rolesCol]?.trim()
          ? cells[rolesCol]!.split(/[,;\s]+/).filter(Boolean).map((r) => r.toLowerCase())
          : ["referee"];
      if (roles.length > 1) await requireFeature(auth.orgId, "officials.roles_multi");
      const cap = capCol >= 0 ? Number.parseInt(cells[capCol] ?? "", 10) : Number.NaN;
      await tx`
        insert into officials (org_id, display_name, role_keys, max_per_day)
        values (${auth.orgId}, ${name}, ${tx.json(roles as never)},
                ${Number.isInteger(cap) && cap > 0 ? cap : null})`;
      seen.add(name.toLowerCase());
      created++;
    }
    return { created, skipped };
  });
}

// ---------------------------------------------------------------------------
// Engine input assembly + auto / apply (Jul3/02 §4)
// ---------------------------------------------------------------------------

const DEFAULT_MATCH_MINUTES = 30;

async function engineInput(
  tx: Tx,
  divisionId: string,
): Promise<{ fixtures: OfficialFixture[]; officials: OfficialSpec[]; locked: FixtureOfficial[] }> {
  const [settings] = await tx<{ config: { matchMinutes?: number } }[]>`
    select config from schedule_settings where division_id = ${divisionId}`;
  const matchMinutes = settings?.config?.matchMinutes ?? DEFAULT_MATCH_MINUTES;

  const fixtureRows = await tx<{
    id: string; scheduled_at: string; court_label: string | null; pool_id: string | null;
    stage_id: string; division_id: string; home_entrant_id: string | null; away_entrant_id: string | null;
  }[]>`
    select id, scheduled_at, court_label, pool_id, stage_id, division_id,
           home_entrant_id, away_entrant_id
    from fixtures
    where division_id = ${divisionId} and scheduled_at is not null
      and status <> 'decided'
    order by scheduled_at, id`;
  const fixtures: OfficialFixture[] = fixtureRows.map((f) => {
    const start = new Date(f.scheduled_at).getTime();
    return {
      id: f.id,
      startAt: start,
      endAt: start + matchMinutes * 60_000,
      court: f.court_label ?? undefined,
      poolId: f.pool_id ?? undefined,
      divisionId: f.division_id,
      stageId: f.stage_id,
      entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
    };
  });

  // Officials + the entrant map that powers team-ref-self and plays-while-
  // reffing (Jul3/02 §3): the team-as-ref entrant plus every entrant the
  // official's person is rostered into.
  const officialRows = await tx<(OfficialRow & { person_entrants: string[] | null })[]>`
    select ${tx(COLS)},
           case when person_id is not null then
             (select array_agg(em.entrant_id) from entrant_members em
              where em.person_id = officials.person_id)
           end as person_entrants
    from officials order by display_name, id`;
  const officials: OfficialSpec[] = officialRows.map((o) => {
    const entrantIds = [
      ...(o.entrant_id ? [o.entrant_id] : []),
      ...(o.person_entrants ?? []),
    ];
    return {
      id: o.id,
      roleKeys: o.role_keys,
      homePoolId: o.home_pool_id ?? undefined,
      maxPerDay: o.max_per_day ?? undefined,
      entrantIds: entrantIds.length > 0 ? entrantIds : undefined,
      homeDivisionId: divisionId,
    };
  });

  const lockedRows = await tx<{ fixture_id: string; official_id: string; role_key: string }[]>`
    select fo.fixture_id, fo.official_id, fo.role_key
    from fixture_officials fo
    join fixtures f on f.id = fo.fixture_id
    where f.division_id = ${divisionId} and fo.locked`;
  const locked: FixtureOfficial[] = lockedRows.map((r) => ({
    fixtureId: r.fixture_id,
    officialId: r.official_id,
    roleKey: r.role_key,
    locked: true,
  }));
  return { fixtures, officials, locked };
}

export const AutoAssignInput = z.object({
  policy: AssignPolicy,
  rng_seed: z.string().default("officials"),
});
export type AutoAssignInput = z.infer<typeof AutoAssignInput>;

/** POST /divisions/{id}/officials/auto — propose only, writes nothing. */
export async function autoAssignOfficials(
  auth: AuthCtx,
  divisionId: string,
  input: AutoAssignInput,
): Promise<AssignResult> {
  await requireFeature(auth.orgId, "officials.auto");
  if (input.policy.roles.length > 1) {
    await requireFeature(auth.orgId, "officials.roles_multi");
  }
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const { fixtures, officials, locked } = await engineInput(tx, divisionId);
    return assignOfficials({
      fixtures,
      officials,
      locked,
      policy: input.policy,
      rngSeed: input.rng_seed,
    });
  });
}

export const ApplyAssignmentsInput = z.object({
  assignments: z.array(
    z.object({
      fixture_id: z.string().uuid(),
      official_id: z.string().uuid(),
      role_key: z.string().min(1),
      locked: z.boolean().default(false),
    }),
  ),
});
export type ApplyAssignmentsInput = z.infer<typeof ApplyAssignmentsInput>;

/** POST /divisions/{id}/officials/apply — transactional persist: replaces the
 *  division's UNLOCKED assignments with the given set (locked rows survive),
 *  refreshes the fixtures.officials cache, emits `officials_assigned`. */
export async function applyOfficialAssignments(
  auth: AuthCtx,
  divisionId: string,
  input: ApplyAssignmentsInput,
): Promise<{ applied: number }> {
  await requireFeature(auth.orgId, "officials.auto");
  return withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");

    const fixtureIds = [...new Set(input.assignments.map((a) => a.fixture_id))];
    if (fixtureIds.length > 0) {
      const owned = await tx<{ id: string }[]>`
        select id from fixtures where division_id = ${divisionId} and id in ${tx(fixtureIds)}`;
      if (owned.length !== fixtureIds.length) {
        throw new HttpError(422, "assignment references a fixture outside this division");
      }
    }

    const touched = await tx<{ fixture_id: string }[]>`
      delete from fixture_officials
      where not locked and fixture_id in (select id from fixtures where division_id = ${divisionId})
      returning fixture_id`;
    let applied = 0;
    for (const a of input.assignments) {
      await tx`
        insert into fixture_officials (fixture_id, official_id, role_key, source, locked)
        values (${a.fixture_id}, ${a.official_id}, ${a.role_key}, 'auto', ${a.locked})
        on conflict (fixture_id, role_key, official_id) do nothing`;
      applied++;
    }
    const allTouched = [...new Set([...touched.map((t) => t.fixture_id), ...fixtureIds])];
    await refreshOfficialsCache(tx, allTouched);

    const [{ seq }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${divisionId}`;
    await tx`
      insert into division_events (division_id, seq, type, payload, actor_id)
      values (${divisionId}, ${seq + 1}, 'officials_assigned',
              ${tx.json({ applied } as never)}, ${auth.userId})`;
    return { applied };
  });
}

export const PatchFixtureOfficialsInput = z.object({
  set: z.array(
    z.object({
      official_id: z.string().uuid(),
      role_key: z.string().min(1),
      locked: z.boolean().default(false),
    }),
  ),
});
export type PatchFixtureOfficialsInput = z.infer<typeof PatchFixtureOfficialsInput>;

/** PATCH /fixtures/{id}/officials — manual set/move/lock (7 Jan drag-drop).
 *  Replaces the fixture's assignments. Manual single-role stays free on every
 *  plan (Jul3/02 §5); a multi-role set needs officials.roles_multi. */
export async function patchFixtureOfficials(
  auth: AuthCtx,
  fixtureId: string,
  input: PatchFixtureOfficialsInput,
): Promise<{ officials: unknown }> {
  const roleCount = new Set(input.set.map((s) => s.role_key)).size;
  if (roleCount > 1) await requireFeature(auth.orgId, "officials.roles_multi");
  return withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<{ id: string }[]>`select id from fixtures where id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    await tx`delete from fixture_officials where fixture_id = ${fixtureId}`;
    for (const s of input.set) {
      await tx`
        insert into fixture_officials (fixture_id, official_id, role_key, source, locked)
        values (${fixtureId}, ${s.official_id}, ${s.role_key}, 'manual', ${s.locked})`;
    }
    const cache = await refreshOfficialsCache(tx, [fixtureId]);
    return { officials: cache.get(fixtureId) ?? [] };
  });
}

/** Rebuild fixtures.officials (the read cache) from fixture_officials. */
async function refreshOfficialsCache(
  tx: Tx,
  fixtureIds: string[],
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (fixtureIds.length === 0) return out;
  const rows = await tx<{ fixture_id: string; officials: unknown }[]>`
    select f.id as fixture_id,
           coalesce((select jsonb_agg(jsonb_build_object(
                       'official_id', fo.official_id,
                       'name', o.display_name,
                       'role', fo.role_key,
                       'locked', fo.locked)
                      order by fo.role_key, o.display_name)
                     from fixture_officials fo
                     join officials o on o.id = fo.official_id
                     where fo.fixture_id = f.id), '[]'::jsonb) as officials
    from fixtures f where f.id in ${tx(fixtureIds)}`;
  for (const r of rows) {
    await tx`update fixtures set officials = ${tx.json(r.officials as never)}
             where id = ${r.fixture_id}`;
    out.set(r.fixture_id, r.officials);
  }
  return out;
}

export const SourceOfficialsInput = z.object({
  sources: z.array(OfficialSourcing).min(1),
});
export type SourceOfficialsInput = z.infer<typeof SourceOfficialsInput>;

/** POST /stages/{id}/officials/source — resolve rank/result sourcing into
 *  entrant specs (pure resolver; propose-only, Jul3/02 §3). */
export async function sourceOfficials(
  auth: AuthCtx,
  stageId: string,
  input: SourceOfficialsInput,
): Promise<{
  resolved: { entrant_id: string; display_name: string; official_id: string | null }[];
  pending: { reason: string }[];
}> {
  await requireFeature(auth.orgId, "officials.auto");
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string }[]>`
      select division_id from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");

    // standings snapshots: decided = stage completed (rows frozen at complete)
    const standingsRows = await tx<{ stage_id: string; pool_id: string | null; rows: unknown; final: boolean }[]>`
      select ss.stage_id, ss.pool_id, ss.rows,
             (s.status = 'completed') as final
      from standings_snapshots ss join stages s on s.id = ss.stage_id
      where s.division_id = (select division_id from stages where id = ${stageId})`;
    const fixturesRows = await tx<{ id: string; status: string; outcome: { kind?: string; winner?: string; loser?: string } | null }[]>`
      select id, status, outcome from fixtures
      where division_id = ${stage.division_id}`;
    const withdrawn = await tx<{ id: string }[]>`
      select id from entrants
      where division_id = ${stage.division_id} and status in ('withdrawn','disqualified')`;

    const result = resolveOfficialSourcing(input.sources, {
      // snapshot rows are engine StandingsRow[] (camelCase, `rank` from the
      // ranking pass)
      standings: standingsRows.map((s) => ({
        stageId: s.stage_id,
        poolId: s.pool_id ?? undefined,
        decided: s.final,
        rows: ((s.rows as { entrantId: string; rank?: number }[]) ?? [])
          .filter((r) => r.rank !== undefined)
          .map((r) => ({ entrantId: r.entrantId, rank: r.rank! })),
      })),
      fixtures: fixturesRows.map((f) => ({
        id: f.id,
        decided: f.status === "decided",
        winnerId: f.outcome?.winner,
        loserId: f.outcome?.loser,
      })),
      withdrawnEntrantIds: withdrawn.map((w) => w.id),
    });

    const entrantIds = result.resolved.map((r) => r.entrantId);
    const names = entrantIds.length
      ? await tx<{ id: string; display_name: string }[]>`
          select id, display_name from entrants where id in ${tx(entrantIds)}`
      : [];
    const nameById = new Map(names.map((n) => [n.id, n.display_name]));
    const existing = entrantIds.length
      ? await tx<{ id: string; entrant_id: string }[]>`
          select id, entrant_id from officials where entrant_id in ${tx(entrantIds)}`
      : [];
    const officialByEntrant = new Map(existing.map((o) => [o.entrant_id, o.id]));

    return {
      resolved: result.resolved.map((r) => ({
        entrant_id: r.entrantId,
        display_name: nameById.get(r.entrantId) ?? r.entrantId,
        official_id: officialByEntrant.get(r.entrantId) ?? null,
      })),
      pending: result.pending.map((p) => ({ reason: p.reason })),
    };
  });
}
