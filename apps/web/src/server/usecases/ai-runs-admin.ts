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

/** Minimum qualifying rows in the window before a median counts as a baseline
 *  (v17 gap #295, controller ruling). With one or two runs recorded, "2x the
 *  median" is noise, not a signal — every slightly-above-average run would
 *  email staff. Below this floor there is NO baseline, so no alert fires. */
export const AI_RUN_MEDIAN_MIN_SAMPLE = 20;

/** Trailing-window median `cost_usd` for one phase's SUCCESSFUL runs (v17 gap
 *  #295) — the baseline `maybeAlertExpensiveRun` compares a fresh run
 *  against. Scoped to the phase's own SUCCESS event type
 *  (schedule.ai_generated / schedule.ai_officials_generated), never
 *  schedule.ai_failed, whose cost distribution is a different thing (aborted
 *  / retried runs). `null` when the window holds fewer than
 *  `AI_RUN_MEDIAN_MIN_SAMPLE` qualifying rows — there is no trustworthy
 *  baseline to compare against. Global across orgs/divisions by design:
 *  SPEC-2 §5.1 frames the trigger as a platform-wide pricing question, not a
 *  per-org one. */
export async function medianRunCostUsd(
  eventType: "schedule.ai_generated" | "schedule.ai_officials_generated",
  days: number,
): Promise<number | null> {
  const [row] = await sql<{ median: number | null; n: number }[]>`
    select percentile_cont(0.5) within group (order by (payload->>'cost_usd')::numeric) as median,
           count(*)::int as n
      from competition_events
     where type = ${eventType}
       and payload->>'cost_usd' is not null
       and created_at >= now() - make_interval(days => ${days})`;
  if (!row || row.n < AI_RUN_MEDIAN_MIN_SAMPLE) return null;
  return row.median != null ? Number(row.median) : null;
}

/** Trailing window the baseline is computed over — the single source for both
 *  the query and the alert copy (which interpolates it rather than hardcoding
 *  "30-day"). */
export const MEDIAN_WINDOW_DAYS = 30;

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
  /** Requested run mode — `schedule` only (the officials path has none).
   *  Pass-through to the alert copy so an expensive run can be triaged without
   *  opening /admin/ai-runs; deliberately does NOT narrow the median, which
   *  stays pooled per phase until there is enough data to calibrate a
   *  mode-scoped baseline (v17 gap #295). */
  mode?: string | null;
  /** The run's `pack_units` — the same number stamped on its ledger row, so
   *  the alert and the audit trail cannot disagree about the run's size.
   *  Nullable by contract (see `AiRunCostAlertEmail.packUnits`). */
  packUnits?: number | null;
}): Promise<void> {
  try {
    // Cheap guards FIRST. `competition_events` is the audit ledger and carries
    // no index on (type, created_at), so the median query is a scan — running
    // it before these checks would make every production AI run pay for a
    // baseline that can never be used (STAFF_ALERT_EMAIL is unset in the
    // normal case, and a costless run has nothing to compare).
    const alertTo = process.env.STAFF_ALERT_EMAIL;
    const costUsd = opts.costUsd;
    if (!alertTo || costUsd == null) return;
    const eventType =
      opts.phase === "schedule" ? "schedule.ai_generated" : "schedule.ai_officials_generated";
    const median = await medianRunCostUsd(eventType, MEDIAN_WINDOW_DAYS);
    if (median == null || !shouldAlertOnRunCost(costUsd, median)) return;
    await sendAiRunCostAlertEmail({
      to: alertTo,
      orgId: opts.orgId,
      ...(opts.competitionId ? { competitionId: opts.competitionId } : {}),
      phase: opts.phase,
      model: opts.model,
      costUsd,
      medianUsd: median,
      windowDays: MEDIAN_WINDOW_DAYS,
      // Forwarded only when the caller actually has them — an omitted mode or
      // size must reach the copy as absent, never as "" or 0 (0 units is a
      // real, empty pack and would be rendered as one).
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.packUnits != null ? { packUnits: opts.packUnits } : {}),
    });
  } catch (err) {
    console.error(`[ai-runs] expensive-run alert check failed (org ${opts.orgId})`, err);
  }
}
