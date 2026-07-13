import "server-only";
// Card-grid aggregates (v3/03 §1–2): the EntityCard's meta / "Next:" /
// progress lines in one query per list — no N+1 across a 3-column grid.
// Read-only; RLS scopes everything through withTenant.
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";

export interface NextFixture {
  home: string | null;
  away: string | null;
  court_label: string | null;
  scheduled_at: string | null;
  in_play: boolean;
}

export interface CompetitionCardStats {
  competition_id: string;
  divisions: number;
  entrants: number;
  played: number;
  total: number;
  /** Most common division sport — drives the card banner tint (v8). */
  top_sport: string | null;
  next: NextFixture | null;
}

export interface DivisionCardStats {
  division_id: string;
  entrants: number;
  capacity: number | null;
  stage_kinds: string[];
  registration_open: boolean;
  played: number;
  total: number;
  next: NextFixture | null;
}

// "Played" = a result exists (decided/finalized); denominator excludes
// cancelled fixtures. Matches how organisers count a matchday.
const PLAYED = ["decided", "finalized"] as const;

export async function listCompetitionCardStats(
  auth: AuthCtx,
): Promise<Map<string, CompetitionCardStats>> {
  const rows = await withTenant(auth.orgId, (tx) =>
    tx<(CompetitionCardStats & { next: NextFixture | null })[]>`
      select c.id as competition_id,
        (select count(*)::int from divisions d
          where d.competition_id = c.id and d.archived_at is null) as divisions,
        (select count(*)::int from entrants e
          join divisions d on d.id = e.division_id
          where d.competition_id = c.id and d.archived_at is null
            and e.status in ('registered','confirmed')) as entrants,
        (select count(*)::int from fixtures f
          join divisions d on d.id = f.division_id
          where d.competition_id = c.id and d.archived_at is null
            and f.status in ${tx([...PLAYED])}) as played,
        (select count(*)::int from fixtures f
          join divisions d on d.id = f.division_id
          where d.competition_id = c.id and d.archived_at is null
            and f.status <> 'cancelled') as total,
        (select d.sport_key from divisions d
          where d.competition_id = c.id and d.archived_at is null
          group by d.sport_key order by count(*) desc, d.sport_key limit 1) as top_sport,
        nf.next
      from competitions c
      left join lateral (
        select jsonb_build_object(
            'home', he.display_name, 'away', ae.display_name,
            'court_label', f.court_label, 'scheduled_at', f.scheduled_at,
            'in_play', f.status = 'in_play') as next
        from fixtures f
        join divisions d on d.id = f.division_id
        left join entrants he on he.id = f.home_entrant_id
        left join entrants ae on ae.id = f.away_entrant_id
        where d.competition_id = c.id and d.archived_at is null
          and f.status in ('scheduled','in_play')
        order by (f.status = 'in_play') desc,
                 f.scheduled_at asc nulls last, f.round_no, f.seq_in_round
        limit 1
      ) nf on true`,
  );
  return new Map(rows.map((r) => [r.competition_id, r]));
}

export async function listDivisionCardStats(
  auth: AuthCtx,
  competitionId: string,
): Promise<Map<string, DivisionCardStats>> {
  const rows = await withTenant(auth.orgId, (tx) =>
    tx<DivisionCardStats[]>`
      select d.id as division_id,
        (select count(*)::int from entrants e
          where e.division_id = d.id
            and e.status in ('registered','confirmed')) as entrants,
        rs.capacity,
        coalesce(rs.enabled, false)
          and (rs.opens_at is null or rs.opens_at <= now())
          and (rs.closes_at is null or rs.closes_at > now()) as registration_open,
        coalesce((select array_agg(distinct s.kind order by s.kind)
          from stages s where s.division_id = d.id), '{}') as stage_kinds,
        (select count(*)::int from fixtures f
          where f.division_id = d.id and f.status in ${tx([...PLAYED])}) as played,
        (select count(*)::int from fixtures f
          where f.division_id = d.id and f.status <> 'cancelled') as total,
        nf.next
      from divisions d
      left join registration_settings rs on rs.division_id = d.id
      left join lateral (
        select jsonb_build_object(
            'home', he.display_name, 'away', ae.display_name,
            'court_label', f.court_label, 'scheduled_at', f.scheduled_at,
            'in_play', f.status = 'in_play') as next
        from fixtures f
        left join entrants he on he.id = f.home_entrant_id
        left join entrants ae on ae.id = f.away_entrant_id
        where f.division_id = d.id and f.status in ('scheduled','in_play')
        order by (f.status = 'in_play') desc,
                 f.scheduled_at asc nulls last, f.round_no, f.seq_in_round
        limit 1
      ) nf on true
      where d.competition_id = ${competitionId} and d.archived_at is null`,
  );
  return new Map(rows.map((r) => [r.division_id, r]));
}

/** "Arun vs Dev · Court 2 · 14:30" — the card's one-line answer to "what's
 *  next?". Null-safe on every field (TBD entrants, unscheduled fixtures). */
export function nextLine(next: NextFixture | null): string | null {
  if (!next) return null;
  const pair = `${next.home ?? "TBD"} vs ${next.away ?? "TBD"}`;
  const parts = [pair];
  if (next.court_label) parts.push(next.court_label);
  if (next.scheduled_at) {
    const at = new Date(next.scheduled_at);
    const sameDay = at.toDateString() === new Date().toDateString();
    parts.push(
      at.toLocaleString("en-GB", {
        ...(sameDay ? {} : { weekday: "short", day: "numeric", month: "short" }),
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }
  return (next.in_play ? "Now: " : "") + parts.join(" · ");
}

/** "Knockout", "Group + Knockout", "League" — format from real structure. */
export function formatLabel(kinds: string[]): string | null {
  if (kinds.length === 0) return null;
  const label: Record<string, string> = {
    league: "League",
    group: "Groups",
    knockout: "Knockout",
    swiss: "Swiss",
    ladder: "Ladder",
    americano: "Americano",
  };
  return kinds.map((k) => label[k] ?? k).join(" + ");
}
