// Staff-only queries behind /admin/ai-runs — cross-org on the superuser
// connection (same convention as the other /admin usecases; callers must have
// passed requireStaff). One row per architect run from the competition audit
// ledger; the payload columns arrived with the cost work, so pre-existing rows
// surface as nulls rather than being filtered out.
import { sql } from "@/lib/db";
import { sendAiRunCostAlertEmail } from "@/lib/email";

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

/** SPEC-2 §5.1's own named trigger for revisiting flat 1-credit-per-run
 *  pricing (v17 gap #295): "a run class > ~2x median COGS". */
export const AI_RUN_COST_ALERT_MULTIPLE = 2;

/** Pure decision: should a run at `costUsd` trip the expensive-run alert
 *  against a `medianUsd` baseline? Split out from the DB/email wiring below
 *  so every branch (no cost, no baseline yet, below/at/above the multiple)
 *  is unit-testable without a database. */
export function shouldAlertOnRunCost(
  costUsd: number | null,
  medianUsd: number | null,
  multiple: number = AI_RUN_COST_ALERT_MULTIPLE,
): boolean {
  if (costUsd == null) return false;
  if (medianUsd == null || medianUsd <= 0) return false;
  return costUsd >= medianUsd * multiple;
}

/** Trailing-window median `cost_usd` for one phase's SUCCESSFUL runs (v17 gap
 *  #295) — the baseline `maybeAlertExpensiveRun` compares a fresh run
 *  against. Scoped to the phase's own SUCCESS event type
 *  (schedule.ai_generated / schedule.ai_officials_generated), never
 *  schedule.ai_failed, whose cost distribution is a different thing (aborted
 *  / retried runs). `null` when the window has no qualifying row yet — there
 *  is no baseline to compare against. Global across orgs/divisions by
 *  design: SPEC-2 §5.1 frames the trigger as a platform-wide pricing
 *  question, not a per-org one. */
export async function medianRunCostUsd(
  eventType: "schedule.ai_generated" | "schedule.ai_officials_generated",
  days: number,
): Promise<number | null> {
  const [row] = await sql<{ median: number | null }[]>`
    select percentile_cont(0.5) within group (order by (payload->>'cost_usd')::numeric) as median
      from competition_events
     where type = ${eventType}
       and payload->>'cost_usd' is not null
       and created_at >= now() - make_interval(days => ${days})`;
  return row?.median != null ? Number(row.median) : null;
}

const MEDIAN_WINDOW_DAYS = 30;

/** Best-effort staff alert (v17 gap #295): fires when a just-completed run's
 *  cost trips `shouldAlertOnRunCost` against the trailing 30-day median for
 *  its phase. Never throws — a check failure must not fail an AI run that
 *  already succeeded (same discipline as every other post-commit alert in
 *  this codebase, e.g. `sendCreditPackGrantFailedAlertEmail`'s call site).
 *  Silent (no email attempted) when `STAFF_ALERT_EMAIL` is unset, matching
 *  every other alert in `billing-events.ts`/`pass-credit.ts`. */
export async function maybeAlertExpensiveRun(opts: {
  orgId: string;
  competitionId?: string;
  phase: "schedule" | "officials";
  model: string;
  costUsd: number | null;
}): Promise<void> {
  try {
    const eventType =
      opts.phase === "schedule" ? "schedule.ai_generated" : "schedule.ai_officials_generated";
    const median = await medianRunCostUsd(eventType, MEDIAN_WINDOW_DAYS);
    if (!shouldAlertOnRunCost(opts.costUsd, median)) return;
    const alertTo = process.env.STAFF_ALERT_EMAIL;
    if (!alertTo) return;
    await sendAiRunCostAlertEmail({
      to: alertTo,
      orgId: opts.orgId,
      ...(opts.competitionId ? { competitionId: opts.competitionId } : {}),
      phase: opts.phase,
      model: opts.model,
      costUsd: opts.costUsd as number,
      medianUsd: median as number,
    });
  } catch (err) {
    console.error(`[ai-runs] expensive-run alert check failed (org ${opts.orgId})`, err);
  }
}
