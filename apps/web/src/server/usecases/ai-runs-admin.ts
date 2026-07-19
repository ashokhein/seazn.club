// Staff-only queries behind /admin/ai-runs — cross-org on the superuser
// connection (same convention as the other /admin usecases; callers must have
// passed requireStaff). One row per architect run from the competition audit
// ledger; the payload columns arrived with the cost work, so pre-existing rows
// surface as nulls rather than being filtered out.
import { sql } from "@/lib/db";

export const AI_RUN_EVENT_TYPES = [
  "schedule.ai_generated",
  "schedule.ai_officials_generated",
  "schedule.ai_failed",
] as const;

export interface AiRunRow {
  id: string;
  created_at: string;
  org_name: string | null;
  division_name: string | null;
  phase: "schedule" | "officials";
  mode: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  repair_rounds: number | null;
  cost_usd: number | null;
  outcome: "ok" | "failed" | "timeout";
}

export async function listAiRuns(limit: number): Promise<AiRunRow[]> {
  return sql<AiRunRow[]>`
    select e.id,
           e.created_at,
           o.name as org_name,
           d.name as division_name,
           case
             when e.type = 'schedule.ai_generated' then 'schedule'
             else coalesce(e.payload->>'phase', 'officials')
           end as phase,
           e.payload->>'mode'  as mode,
           e.payload->>'model' as model,
           (e.payload->'usage'->>'input_tokens')::int  as input_tokens,
           (e.payload->'usage'->>'output_tokens')::int as output_tokens,
           (e.payload->'usage'->>'repair_rounds')::int as repair_rounds,
           (e.payload->>'cost_usd')::numeric::float8   as cost_usd,
           case
             when e.type = 'schedule.ai_failed' then coalesce(e.payload->>'outcome', 'failed')
             else 'ok'
           end as outcome
    from competition_events e
    join organizations o on o.id = e.org_id
    left join divisions d on d.id = (e.payload->>'division_id')::uuid
    where e.type = any(${AI_RUN_EVENT_TYPES as unknown as string[]})
    order by e.created_at desc
    limit ${limit}`;
}

export interface AiRunTotals {
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}

export async function aiRunTotals(days: number): Promise<AiRunTotals> {
  const [row] = await sql<AiRunTotals[]>`
    select count(*)::int as runs,
           coalesce(sum((payload->'usage'->>'input_tokens')::int), 0)::int  as input_tokens,
           coalesce(sum((payload->'usage'->>'output_tokens')::int), 0)::int as output_tokens,
           sum((payload->>'cost_usd')::numeric)::float8 as cost_usd
    from competition_events
    where type = any(${AI_RUN_EVENT_TYPES as unknown as string[]})
      and created_at >= now() - make_interval(days => ${days})`;
  return row ?? { runs: 0, input_tokens: 0, output_tokens: 0, cost_usd: null };
}
