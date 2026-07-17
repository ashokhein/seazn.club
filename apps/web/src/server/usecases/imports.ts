import "server-only";
// Bulk participant import (Jul3/01 §3, §6): dry-run plan → preview → commit.
// The pure diff lives in @seazn/engine/import; this module is the I/O half —
// parse the upload, fetch the snapshot, persist the plan, and (on commit)
// execute the ops in ref-dependency order inside one withTenant transaction.
import type postgres from "postgres";
import {
  ImportConfig,
  ImportRow,
  planImport,
  type ImportOp,
  type ImportPlan,
  type ImportSnapshot,
  type ImportTarget,
} from "@seazn/engine/import";
import { withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { requireFeature, withinLimit } from "@/lib/entitlements";
import { cacheGet, cacheSet } from "@/lib/cache";
import type { AuthCtx } from "@/server/api-v1/auth";
import { parseUpload, toImportRows, type ImportField } from "./import-parse";

type Tx = postgres.TransactionSql;

export interface ImportPreview {
  importId: string;
  filename: string;
  status: "planned" | "committed";
  rowCount: number;
  mapping?: Record<string, ImportField>;
  plan: ImportPlan;
}

export interface ImportCommitResult {
  importId: string;
  stats: ImportPlan["stats"];
  divisionIds: string[];
}

// A pinned import (doc 08 §3 alias) only ever sees its own division —
// applied on every plan/re-plan so commit can't drift to a same-slug
// division in another competition.
function pinSnapshot(snapshot: ImportSnapshot, pinDivisionId: string | null): ImportSnapshot {
  if (!pinDivisionId) return snapshot;
  return { ...snapshot, divisions: snapshot.divisions.filter((d) => d.id === pinDivisionId) };
}

// Read-only org state the planner matches against (Jul3/01 §3). Fetched in
// the same transaction that executes the plan so commit never runs on a stale
// diff.
async function fetchSnapshot(tx: Tx): Promise<ImportSnapshot> {
  const clubs = await tx<{ id: string; name: string; short_name: string | null; external_ref: string | null }[]>`
    select id, name, short_name, external_ref from clubs order by id`;
  const teams = await tx<{ id: string; name: string; club_id: string | null }[]>`
    select id, name, club_id from teams order by id`;
  const persons = await tx<{ id: string; full_name: string; dob: string | null; external_ref: string | null }[]>`
    select id, full_name, dob::text as dob, external_ref from persons order by id`;
  // positionKeys: the sport's position_catalog group keys (doc 02 §3).
  const divisions = await tx<{ id: string; name: string; slug: string; sport_key: string; position_keys: string[] }[]>`
    select d.id, d.name, d.slug, d.sport_key,
           coalesce((select array_agg(g->>'key')
                     from jsonb_array_elements(s.position_catalog->'groups') g), '{}') as position_keys
    from divisions d join sports s on s.key = d.sport_key
    order by d.id`;
  const entrants = await tx<{ id: string; division_id: string; team_id: string | null; member_ids: string[] }[]>`
    select e.id, e.division_id, e.team_id,
           coalesce((select array_agg(em.person_id) from entrant_members em
                     where em.entrant_id = e.id), '{}') as member_ids
    from entrants e order by e.id`;
  return {
    clubs: clubs.map((c) => ({
      id: c.id, name: c.name, shortName: c.short_name, externalRef: c.external_ref,
    })),
    teams: teams.map((t) => ({ id: t.id, name: t.name, clubId: t.club_id })),
    persons: persons.map((p) => ({
      id: p.id, fullName: p.full_name, dob: p.dob, externalRef: p.external_ref,
    })),
    divisions: divisions.map((d) => ({
      id: d.id, name: d.name, slug: d.slug, sportKey: d.sport_key, positionKeys: d.position_keys,
    })),
    entrants: entrants.map((e) => ({
      id: e.id, divisionId: e.division_id, teamId: e.team_id, memberPersonIds: e.member_ids,
    })),
  };
}

/** POST /api/v1/imports — parse + plan; dry-run, writes only the stored
 *  parse/plan for re-preview (Jul3/01 §6). */
export async function createImport(
  auth: AuthCtx,
  input: {
    filename: string;
    contentType: string | null;
    buffer: Buffer;
    mapping?: Record<string, ImportField>;
    config?: unknown;
    /** Division-pinned alias (doc 08 §3 entrants CSV hook): every row is
     *  placed into this division regardless of a divisionSlug column. Pinned
     *  by id — slugs are only unique per competition. */
    pinDivision?: { id: string; slug: string };
  },
): Promise<ImportPreview> {
  const table = await parseUpload(input.filename, input.contentType, input.buffer);
  const { rows: parsed, mapping } = toImportRows(table, input.mapping);
  const rows = input.pinDivision
    ? parsed.map((r) => ({ ...r, divisionSlug: input.pinDivision!.slug }))
    : parsed;
  // Jul3/01 §7: Community capped at 20 rows/file (int limit on import.bulk).
  const quota = await withinLimit(auth.orgId, "import.bulk", rows.length);
  if (!quota.ok) throw new PaymentRequiredError("import.bulk");
  const config = ImportConfig.parse(input.config ?? {});

  return withTenant(auth.orgId, async (tx) => {
    const snapshot = pinSnapshot(await fetchSnapshot(tx), input.pinDivision?.id ?? null);
    const plan = planImport(rows, snapshot, config);
    const [row] = await tx<{ id: string }[]>`
      insert into imports (org_id, filename, config, rows, plan, pin_division_id, created_by)
      values (${auth.orgId}, ${input.filename}, ${tx.json(config as never)},
              ${tx.json(rows as never)}, ${tx.json(plan as never)},
              ${input.pinDivision?.id ?? null}, ${auth.userId})
      returning id`;
    return {
      importId: row!.id,
      filename: input.filename,
      status: "planned" as const,
      rowCount: rows.length,
      mapping,
      plan,
    };
  });
}

/** GET /api/v1/imports/{id} — re-preview against CURRENT state (the plan is
 *  recomputed, not replayed: previewing after someone edited entrants shows
 *  the true diff). */
export async function getImport(auth: AuthCtx, id: string): Promise<ImportPreview> {
  return withTenant(auth.orgId, async (tx) => {
    const [imp] = await tx<{ id: string; filename: string; status: "planned" | "committed"; rows: unknown; config: unknown; pin_division_id: string | null }[]>`
      select id, filename, status, rows, config, pin_division_id from imports where id = ${id}`;
    if (!imp) throw new HttpError(404, "import not found");
    const rows = ImportRow.array().parse(imp.rows);
    const config = ImportConfig.parse(imp.config);
    const snapshot = pinSnapshot(await fetchSnapshot(tx), imp.pin_division_id);
    const plan = planImport(rows, snapshot, config);
    if (imp.status === "planned") {
      await tx`update imports set plan = ${tx.json(plan as never)} where id = ${id}`;
    }
    return { importId: imp.id, filename: imp.filename, status: imp.status, rowCount: rows.length, plan };
  });
}

const IDEM_TTL_SECONDS = 24 * 60 * 60; // doc 08 §4

/** POST /api/v1/imports/{id}/commit — execute the plan transactionally.
 *  Re-planned against fresh state inside the tx; any op failure rolls the
 *  whole commit back (Jul3/01 §9 partial failure). */
export async function commitImport(
  auth: AuthCtx,
  id: string,
  idempotencyKey: string | null,
): Promise<ImportCommitResult> {
  const idemKey = idempotencyKey
    ? `idem:v1:import-commit:${auth.orgId}:${idempotencyKey}`
    : null;
  if (idemKey) {
    const cached = await cacheGet<ImportCommitResult>(idemKey);
    if (cached) return cached;
  }

  const result = await withTenant(auth.orgId, async (tx) => {
    // One import commit at a time per org — serialises the club/team upsert
    // keys without relying on constraint races.
    await tx`select pg_advisory_xact_lock(hashtext(${"import-commit:" + auth.orgId}))`;
    const [imp] = await tx<{ id: string; status: string; rows: unknown; config: unknown; plan: unknown; pin_division_id: string | null }[]>`
      select id, status, rows, config, plan, pin_division_id from imports where id = ${id}`;
    if (!imp) throw new HttpError(404, "import not found");
    if (imp.status === "committed") {
      // Idempotent re-commit: nothing to do, report the recorded outcome.
      const plan = imp.plan as ImportPlan;
      const touched = await tx<{ division_id: string }[]>`
        select division_id from division_events
        where type = 'participants_imported' and payload->>'import_id' = ${id}`;
      return { importId: id, stats: plan.stats, divisionIds: touched.map((r) => r.division_id) };
    }
    const rows = ImportRow.array().parse(imp.rows);
    const config = ImportConfig.parse(imp.config);
    const snapshot = pinSnapshot(await fetchSnapshot(tx), imp.pin_division_id);
    const plan = planImport(rows, snapshot, config);

    const blocking = plan.issues.filter((i) => i.severity === "error");
    if (blocking.length > 0) {
      throw new HttpError(
        422,
        `import has ${blocking.length} blocking issue(s): ` +
          blocking.slice(0, 5).map((i) => `row ${i.rowNo} ${i.code}`).join(", "),
      );
    }
    // Jul3/01 §7: the Club hierarchy itself is Pro.
    if (plan.ops.some((op) => op.kind.startsWith("club."))) {
      await requireFeature(auth.orgId, "clubs.hierarchy");
    }

    const divisionIds = await executePlan(tx, auth, plan.ops);

    // Ledger + audit (Jul3/01 §6): one division_events row per touched
    // division (hash-chained by trigger), one competition_events row per
    // touched competition. Structural, same family as fixtures_generated.
    for (const divisionId of divisionIds) {
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
      const [{ seq }] = await tx<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int as seq from division_events
        where division_id = ${divisionId}`;
      await tx`
        insert into division_events (division_id, seq, type, payload, actor_id)
        values (${divisionId}, ${seq + 1}, 'participants_imported',
                ${tx.json({ import_id: id, stats: plan.stats } as never)}, ${auth.userId})`;
    }
    if (divisionIds.length > 0) {
      const comps = await tx<{ competition_id: string }[]>`
        select distinct competition_id from divisions where id in ${tx(divisionIds)}`;
      for (const c of comps) {
        await tx`
          insert into competition_events (competition_id, org_id, type, payload, actor_id)
          values (${c.competition_id}, ${auth.orgId}, 'participants_imported',
                  ${tx.json({ import_id: id, stats: plan.stats } as never)}, ${auth.userId})`;
      }
    }

    await tx`
      update imports set status = 'committed', committed_at = now(),
                         plan = ${tx.json(plan as never)}
      where id = ${id}`;
    return { importId: id, stats: plan.stats, divisionIds };
  });

  if (idemKey) await cacheSet(idemKey, result, IDEM_TTL_SECONDS);
  return result;
}

// Execute ops in bucket order (clubs → teams → persons → entrants → rosters,
// Jul3/01 §9), resolving each op's synthetic ref to the uuid it minted.
async function executePlan(tx: Tx, auth: AuthCtx, ops: ImportOp[]): Promise<string[]> {
  const ids = new Map<string, string>();
  const resolve = (t: ImportTarget): string => {
    if ("id" in t) return t.id;
    const hit = ids.get(t.ref);
    if (!hit) throw new HttpError(500, `unresolved import ref '${t.ref}'`);
    return hit;
  };
  const divisionIds = new Set<string>();
  const rosterEntrantIds = new Set<string>();

  for (const op of ops) {
    switch (op.kind) {
      case "club.create": {
        const [row] = await tx<{ id: string }[]>`
          insert into clubs (org_id, name, short_name, external_ref)
          values (${auth.orgId}, ${op.after.name}, ${op.after.shortName ?? null},
                  ${op.after.externalRef ?? null})
          returning id`;
        ids.set(op.ref, row!.id);
        break;
      }
      case "club.update":
        await tx`update clubs set short_name = ${op.after.shortName} where id = ${op.clubId}`;
        break;
      case "team.create": {
        const [row] = await tx<{ id: string }[]>`
          insert into teams (org_id, name, short_name, club_id)
          values (${auth.orgId}, ${op.after.name}, ${op.after.shortName ?? null},
                  ${op.after.club ? resolve(op.after.club) : null})
          returning id`;
        ids.set(op.ref, row!.id);
        break;
      }
      case "team.link":
        await tx`update teams set club_id = ${resolve(op.club)} where id = ${op.teamId}`;
        break;
      case "person.create": {
        const [row] = await tx<{ id: string }[]>`
          insert into persons (org_id, full_name, dob, gender, consent)
          values (${auth.orgId}, ${op.after.fullName}, ${op.after.dob ?? null},
                  ${op.after.gender ?? null}, ${tx.json(op.after.consent as never)})
          returning id`;
        ids.set(op.ref, row!.id);
        break;
      }
      case "entrant.create": {
        const [row] = await tx<{ id: string }[]>`
          insert into entrants (division_id, kind, team_id, display_name)
          values (${op.divisionId}, 'team', ${resolve(op.after.team)}, ${op.after.displayName})
          returning id`;
        ids.set(op.ref, row!.id);
        divisionIds.add(op.divisionId);
        break;
      }
      case "roster.add": {
        const entrantId = resolve(op.entrant);
        await tx`
          insert into entrant_members (entrant_id, person_id, squad_number,
                                       default_position_key, is_captain)
          values (${entrantId}, ${resolve(op.person)}, ${op.after.squadNumber ?? null},
                  ${op.after.positionKey ?? null}, ${op.after.isCaptain})
          on conflict (entrant_id, person_id) do nothing`;
        rosterEntrantIds.add(entrantId);
        break;
      }
    }
  }
  // rosters added onto pre-existing entrants also touch their division
  const existingEntrantIds = [...rosterEntrantIds].filter(
    (eid) => ![...ids.values()].includes(eid),
  );
  if (existingEntrantIds.length > 0) {
    const rows = await tx<{ division_id: string }[]>`
      select distinct division_id from entrants where id in ${tx(existingEntrantIds)}`;
    for (const r of rows) divisionIds.add(r.division_id);
  }
  return [...divisionIds];
}
