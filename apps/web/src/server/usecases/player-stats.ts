import "server-only";
// Player statistics (Jul3/07 §2–§7): the derived fold over score_events —
// recompute-on-read into player_stat_snapshots (disposable cache), division-
// scoped leaderboards, per-person cards, consent-filtered public tables.
import type postgres from "postgres";
import { aggregatePlayerStats, sumPlayerStats, type PlayerStatRow } from "@seazn/engine/stats";
import type { EventEnvelope } from "@seazn/engine/core";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveModule } from "@/server/engine-db";

type Tx = postgres.TransactionSql;

interface EventRow {
  fixture_id: string;
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: Date;
  voids_event_id: string | null;
}

/** Refold every fixture's ledger into the division snapshot (Jul3/07 §2 —
 *  rebuildable at any time; the CI-style consistency check refolds and
 *  compares). Returns the fresh rows. */
export async function recomputePlayerStats(
  tx: Tx,
  divisionId: string,
): Promise<{ rows: PlayerStatRow[]; throughSeq: number; hasModel: boolean }> {
  const [division] = await tx<{ sport_key: string; module_version: string }[]>`
    select sport_key, module_version from divisions where id = ${divisionId}`;
  if (!division) throw new HttpError(404, "division not found");
  const sportModule = resolveModule(division.sport_key, division.module_version);
  const model = sportModule.playerStats;
  if (model === undefined) return { rows: [], throughSeq: 0, hasModel: false };

  const events = await tx<EventRow[]>`
    select se.fixture_id, se.id, se.seq, se.type, se.payload, se.recorded_at, se.voids_event_id
    from score_events se
    join fixtures f on f.id = se.fixture_id
    where f.division_id = ${divisionId}
    order by se.fixture_id, se.seq`;

  const byFixture = new Map<string, EventEnvelope[]>();
  let throughSeq = 0;
  for (const e of events) {
    throughSeq += 1;
    const envelope = {
      id: e.id,
      seq: e.seq,
      type: e.type,
      payload: e.payload,
      recordedAt: e.recorded_at.toISOString(),
      ...(e.voids_event_id !== null ? { voids: e.voids_event_id } : {}),
    } as EventEnvelope;
    (byFixture.get(e.fixture_id) ?? byFixture.set(e.fixture_id, []).get(e.fixture_id)!).push(envelope);
  }
  const perFixture = [...byFixture.values()].map((ledger) => aggregatePlayerStats(ledger, model));
  const rows = sumPlayerStats(perFixture, model);

  await tx`delete from player_stat_snapshots where division_id = ${divisionId}`;
  for (const row of rows) {
    await tx`
      insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
      values (${divisionId}, ${row.personId}, ${division.sport_key},
              ${tx.json(row.stats as never)}, ${throughSeq})
      on conflict (division_id, person_id) do update
        set stats = excluded.stats, computed_through_seq = excluded.computed_through_seq,
            updated_at = now()`;
  }
  return { rows, throughSeq, hasModel: true };
}

export interface LeaderboardRow {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  entrant: string | null;
  stats: Record<string, number>;
  /** PROMPT-65: the person has a public profile (public_name consent) — rows
   *  link there; non-consented rows stay plain text. */
  public_profile: boolean;
}

/** GET /divisions/{id}/stats/players?metric=&sort= (Jul3/07 §6). Pro
 *  `stats.player`. Sortable by any declared metric (27 Nov). */
export async function divisionPlayerStats(
  auth: AuthCtx,
  divisionId: string,
  query: { metric?: string; sort?: "asc" | "desc" },
): Promise<{
  metrics: { key: string; label: string }[];
  rows: LeaderboardRow[];
  requires_detailed_scoring: boolean;
}> {
  await requireFeature(auth.orgId, "stats.player");
  return withTenant(auth.orgId, async (tx) => {
    const { rows, hasModel } = await recomputePlayerStats(tx, divisionId);
    const [division] = await tx<{ sport_key: string; module_version: string }[]>`
      select sport_key, module_version from divisions where id = ${divisionId}`;
    const sportModule = resolveModule(division!.sport_key, division!.module_version);
    const model = sportModule.playerStats;
    const metrics = [
      ...(model?.metrics ?? []).map((m) => ({ key: m.key, label: m.label })),
      ...(model?.derived ?? []).map((d) => ({ key: d.key, label: d.label })),
      ...(model?.awards ?? []).map((a) => ({ key: `${a.key}_awards`, label: a.label })),
    ];

    const personIds = rows.map((r) => r.personId);
    const people = personIds.length
      ? await tx<
          { id: string; full_name: string; squad_number: number | null; entrant: string | null; public_name: boolean }[]
        >`
          select p.id, p.full_name, em.squad_number, e.display_name as entrant,
                 coalesce((p.consent->>'public_name')::boolean, false) as public_name
          from persons p
          left join entrant_members em on em.person_id = p.id
            and em.entrant_id in (select id from entrants where division_id = ${divisionId})
          left join entrants e on e.id = em.entrant_id
          where p.id in ${tx(personIds)}`
      : [];
    const infoById = new Map(people.map((p) => [p.id, p]));

    const metric = query.metric ?? metrics[0]?.key ?? "points";
    const dir = query.sort === "asc" ? 1 : -1;
    const out = rows
      .map((r) => ({
        person_id: r.personId,
        full_name: infoById.get(r.personId)?.full_name ?? r.personId,
        squad_number: infoById.get(r.personId)?.squad_number ?? null,
        entrant: infoById.get(r.personId)?.entrant ?? null,
        stats: r.stats,
        public_profile: infoById.get(r.personId)?.public_name ?? false,
      }))
      .sort((a, b) => dir * ((a.stats[metric] ?? 0) - (b.stats[metric] ?? 0)) || a.full_name.localeCompare(b.full_name));

    // Community with ball-by-ball off: coarse events yield no per-player rows —
    // say so instead of showing wrong zeros (Jul3/07 §8).
    const [{ decided }] = await tx<{ decided: number }[]>`
      select count(*) filter (where status = 'decided')::int as decided
      from fixtures where division_id = ${divisionId}`;
    return {
      metrics,
      rows: out,
      requires_detailed_scoring: hasModel && out.length === 0 && decided > 0,
    };
  });
}

/** GET /persons/{id}/stats?division_id= — a player's card, per division
 *  (tables never bleed across divisions, Jul3/07 §8). */
export async function personStats(
  auth: AuthCtx,
  personId: string,
  divisionId?: string,
): Promise<{ divisions: { division_id: string; division_name: string; stats: Record<string, number> }[] }> {
  await requireFeature(auth.orgId, "stats.player");
  return withTenant(auth.orgId, async (tx) => {
    const [person] = await tx`select 1 from persons where id = ${personId}`;
    if (!person) throw new HttpError(404, "person not found");
    // refresh the divisions this person appears in (or the requested one)
    const divisionIds = divisionId
      ? [divisionId]
      : (
          await tx<{ division_id: string }[]>`
            select distinct e.division_id
            from entrant_members em join entrants e on e.id = em.entrant_id
            where em.person_id = ${personId}`
        ).map((r) => r.division_id);
    for (const d of divisionIds) await recomputePlayerStats(tx, d);
    const rows = await tx<{ division_id: string; division_name: string; stats: Record<string, number> }[]>`
      select ps.division_id, d.name as division_name, ps.stats
      from player_stat_snapshots ps join divisions d on d.id = ps.division_id
      where ps.person_id = ${personId}
      ${divisionId ? tx`and ps.division_id = ${divisionId}` : tx``}
      order by d.name`;
    return { divisions: rows };
  });
}

/** Public consent-filtered leaderboard (Jul3/07 §6): names via
 *  public_person_name (minors gated, doc 06 §4.7). */
export async function publicDivisionStats(
  orgSlug: string,
  competitionSlug: string,
  divisionSlug: string,
): Promise<{ rows: { name: string; stats: Record<string, number> }[] }> {
  const { sql } = await import("@/lib/db");
  const [division] = await sql<{ id: string; org_id: string }[]>`
    select d.id, d.org_id
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${competitionSlug} and d.slug = ${divisionSlug}
      and c.visibility in ('public','unlisted')`;
  if (!division) throw new HttpError(404, "division not found");
  const refresh = await withTenant(division.org_id, async (tx) => recomputePlayerStats(tx, division.id));
  void refresh;
  const rows = await sql<{ name: string; stats: Record<string, number> }[]>`
    select public_person_name(p.full_name, p.consent) as name, ps.stats
    from player_stat_snapshots ps
    join persons p on p.id = ps.person_id
    where ps.division_id = ${division.id}
    order by (ps.stats->>'points')::numeric desc nulls last, name`;
  return { rows };
}
