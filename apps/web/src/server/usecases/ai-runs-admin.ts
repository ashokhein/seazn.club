// Staff-only queries behind /admin/ai-runs — cross-org on the superuser
// connection (same convention as the other /admin usecases; callers must have
// passed requireStaff). One row per architect run from the competition audit
// ledger; the payload columns arrived with the cost work, so pre-existing rows
// surface as nulls rather than being filtered out.
import { sql } from "@/lib/db";
import { aiRunUnitNoun } from "@/lib/ai-pricing";
// lib/credits is a leaf w.r.t. server/usecases (it imports only other lib
// modules), so reading it here closes no import cycle.
import { EARN_GRANT_DAILY_ALERT_THRESHOLD, earnGrantVolumeToday } from "@/lib/credits";
import { sendAiRunCostAlertEmail } from "@/lib/email";

export const AI_RUN_EVENT_TYPES = [
  "schedule.ai_generated",
  "schedule.ai_officials_generated",
  "schedule.ai_failed",
] as const;

// ---------------------------------------------------------------------------
// JSONB read guards (v17 gap #295)
//
// Everything this file reads out of `competition_events.payload` is free-form
// JSONB, not a typed column: nothing in the database stops a future writer, a
// replayed payload, or a hand-patched row putting a string where a number
// belongs. A bare `::numeric` / `::int` / `::uuid` cast does not skip such a
// row — it ABORTS THE WHOLE QUERY. That is not a cosmetic nit here:
//
//   * `medianRunCostUsd` throwing is swallowed by `maybeAlertExpensiveRun`'s
//     own try/catch, so ONE bad row silences the expensive-run alert this
//     wave ships — permanently, with nothing surfacing it.
//   * `listAiRuns` / `aiRunTotals` are rendered server-side by
//     /admin/ai-runs, and `aiMarginReport` by /admin/revenue, so the same row
//     500s two staff pages until someone finds and deletes it.
//
// Policy, uniform across every reader below: an unreadable value is treated as
// ABSENT, never as zero. The run still counts as a run; only the unreadable
// number drops out. Regexes are bound as parameters so there is exactly one
// copy of each and they cannot drift between call sites.
//
// Written with `[.]` rather than `\.` deliberately — a backslash escape inside
// a JS template literal is not preserved, and the resulting bare `.` would
// match any character and quietly defeat the guard.

/** Accepts what `JSON.stringify` can emit for a number, INCLUDING exponent
 *  form: it switches to exponential below 1e-6, so a genuinely tiny per-run
 *  cost arrives as "1e-7". Rejecting those would silently understate cost —
 *  a worse failure than the crash this replaces, because nothing surfaces it. */
const NUMERIC_RE = "^-?[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$";
/** Token/round counters are whole numbers; JSON never emits an integer in
 *  exponent form below 1e21. */
const INT_RE = "^-?[0-9]+$";
const UUID_RE = "^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$";

/** "This run recorded a readable cost." `coalesce(..., false)` because a NULL
 *  key makes the regex NULL, not false. */
const COSTED = sql`coalesce(payload->>'cost_usd' ~ ${NUMERIC_RE}, false)`;
/** Same predicate against the `e.` alias `listAiRuns` joins under. */
const COSTED_E = sql`coalesce(e.payload->>'cost_usd' ~ ${NUMERIC_RE}, false)`;

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
           case when e.payload->'usage'->>'input_tokens' ~ ${INT_RE}
                then (e.payload->'usage'->>'input_tokens')::int end  as input_tokens,
           case when e.payload->'usage'->>'output_tokens' ~ ${INT_RE}
                then (e.payload->'usage'->>'output_tokens')::int end as output_tokens,
           case when e.payload->'usage'->>'repair_rounds' ~ ${INT_RE}
                then (e.payload->'usage'->>'repair_rounds')::int end as repair_rounds,
           case when ${COSTED_E}
                then (e.payload->>'cost_usd')::numeric::float8 end   as cost_usd,
           case
             when e.type = 'schedule.ai_failed' then coalesce(e.payload->>'outcome', 'failed')
             else 'ok'
           end as outcome
    from competition_events e
    join organizations o on o.id = e.org_id
    -- Guarded too: this cast sits in a JOIN condition, so one malformed
    -- division_id takes the whole listing down rather than one row's label.
    left join divisions d on d.id = case when e.payload->>'division_id' ~ ${UUID_RE}
                                         then (e.payload->>'division_id')::uuid end
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
    -- runs counts every row; only unreadable NUMBERS drop out of the sums,
    -- so a corrupt payload understates spend rather than hiding the run or
    -- taking /admin/ai-runs down. No new field is surfaced for that gap here
    -- (the margin panel already carries runs_missing_cost).
    select count(*)::int as runs,
           coalesce(sum((payload->'usage'->>'input_tokens')::int)
                    filter (where payload->'usage'->>'input_tokens' ~ ${INT_RE}), 0)::int  as input_tokens,
           coalesce(sum((payload->'usage'->>'output_tokens')::int)
                    filter (where payload->'usage'->>'output_tokens' ~ ${INT_RE}), 0)::int as output_tokens,
           sum((payload->>'cost_usd')::numeric) filter (where ${COSTED})::float8 as cost_usd
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
       -- Subsumes the old is-not-null check AND drops unreadable values.
       -- Deliberately in the WHERE, not a FILTER on the percentile: a row
       -- carrying no usable cost carries no signal either, so it must not help
       -- a thin window reach AI_RUN_MEDIAN_MIN_SAMPLE. Otherwise 19 real runs
       -- plus one corrupt row would start alerting off a baseline of 19.
       and ${COSTED}
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

// ---------------------------------------------------------------------------
// Credits sold vs COGS — the margin monitor behind /admin/revenue
// (v17 gap #295; SPEC-2 §5.3 "live margin monitor", SPEC-3 §6).
// ---------------------------------------------------------------------------

/** SPEC-2 §6 base list price — the revenue-equivalent this report prices
 *  net credit spend at. Tunable dial (README §7 style); not read from
 *  stripe-plans.json because the packs price in bonus-scaled tiers, and
 *  this report is about the FLOOR price every credit is worth, not what any
 *  one purchase actually paid. */
export const CREDIT_LIST_PRICE_USD = 0.25;

export interface AiMarginRow {
  org_id: string | null;
  org_name: string;
  /** Net credits consumed (run_spend, netted against their own refunds) in
   *  the window — the same derive `spentThisPeriodByOrg` uses, generalized
   *  across every org instead of one. */
  credits_spent: number;
  /** credits_spent priced at CREDIT_LIST_PRICE_USD — the "credits sold" side
   *  of the margin monitor (SPEC-2 §5.3 / SPEC-3 §6). */
  revenue_usd: number;
  /** Real $ COGS from the AI run audit trail in the same window — see the
   *  plan's Migration note for why this is an independent aggregate, not a
   *  per-run join against credits_spent. */
  cogs_usd: number;
  /** null when revenue_usd is 0 (nothing sold/spent yet) rather than a
   *  divide-by-zero or a misleading 0%/100%. */
  margin_pct: number | null;
}

/** Per-phase COGS and size, the only level at which a $/unit figure is
 *  meaningful (v17 gap #295). Carries NO revenue or margin: the credit ledger
 *  records which ORG burned a credit, never which PHASE, so splitting revenue
 *  by phase would be an invention. */
export interface AiPhaseUnitRow {
  phase: AiRunPhase;
  /** Plural noun for one unit on THIS phase — schedule counts the movable
   *  subset it was asked to place, officials counts every fixture in the pack.
   *  The label travels with the number so nobody compares the two. */
  unit_noun: string;
  runs: number;
  /** Runs in the window whose event carries no `pack_units`. The key only
   *  started being stamped in this wave, so every older run lands here. Their
   *  COGS stays in `cogs_usd` — dropping it would understate the platform's
   *  real spend — but it is excluded from the $/unit ratio, which is why
   *  `sized_cogs_usd` exists as a separate numerator. */
  runs_missing_units: number;
  /** Runs whose `cost_usd` is missing or unreadable. Their spend was real but
   *  is not recorded, so `cogs_usd` (and the margin above it) is a FLOOR
   *  whenever this is non-zero. Surfaced rather than swallowed, exactly like
   *  `runs_missing_units`. */
  runs_missing_cost: number;
  /** Sum of `pack_units` across the runs counted in `sized_cogs_usd` — a
   *  MATCHED pair with it, so the ratio can never divide one set of runs'
   *  cost by another set's units. */
  units: number;
  /** COGS across every run of this phase whose cost is readable, sized or not.
   *  The phase rows partition the report's total COGS. */
  cogs_usd: number;
  /** COGS of the runs that carry BOTH a usable size and a readable cost — the
   *  numerator of `cost_per_unit_usd`. */
  sized_cogs_usd: number;
  /** `sized_cogs_usd / units`, or null when the phase recorded no units at
   *  all. NEVER blended across phases. */
  cost_per_unit_usd: number | null;
}

export interface AiMarginReport {
  days: number;
  aggregate: AiMarginRow;
  byOrg: AiMarginRow[];
  /** Always both phases, in a fixed order, even when one has no runs — a
   *  stable table shape, and "officials: no runs yet" is itself information. */
  byPhase: AiPhaseUnitRow[];
  /** Earn grants issued TODAY (v17 gap #296) — deliberately a different
   *  window from `days` above: it is the same UTC-day count the daily cron
   *  alert checks, read through the same `earnGrantVolumeToday` so the panel
   *  and the alert email can never disagree. Surfaced here so staff can watch
   *  it approach the threshold instead of only learning once the email fires. */
  earn_grants_today: number;
  /** The count at which the daily alert fires — shown next to the count so
   *  the number above means something without opening the code. */
  earn_grant_alert_threshold: number;
}

export type AiRunPhase = "schedule" | "officials";

const PHASES: readonly AiRunPhase[] = ["schedule", "officials"];

/** "This run recorded a usable size." Same guard policy as `COSTED` at the top
 *  of this file — an unreadable `pack_units` is treated exactly like a missing
 *  one: counted in `runs` and `cogs_usd`, excluded from `units` and the ratio.
 *  A plain non-negative integer is the only shape either writer produces
 *  (`movableIds.size` / `pack.fixtures.length`), so `INT_RE`'s leading `-?`
 *  would be too generous here and this uses its own stricter pattern. */
const SIZED = sql`coalesce(payload->>'pack_units' ~ '^[0-9]+$', false)`;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Pure: $ per unit for one phase, or null when the phase recorded no units.
 *  Split out of the rollup so the divide-by-zero branch — which a production
 *  window really can hit, since every pre-wave run event carries no
 *  `pack_units` — is testable without a database. Zero sized COGS over real
 *  units is a genuine $0.00/unit (officials records solver-draft runs at
 *  cost 0) and stays 0, not null. Six decimals: a per-fixture cost lives
 *  around $0.0004 and rounding to cents would erase it. */
export function costPerUnitUsd(sizedCogsUsd: number, units: number): number | null {
  if (!units || units <= 0) return null;
  return Math.round((sizedCogsUsd / units) * 1_000_000) / 1_000_000;
}

function marginRow(
  orgId: string | null,
  orgName: string,
  creditsSpent: number,
  cogsUsdRaw: number,
): AiMarginRow {
  const revenueUsd = round2(creditsSpent * CREDIT_LIST_PRICE_USD);
  const cogsUsd = round2(cogsUsdRaw);
  const marginPct =
    revenueUsd > 0 ? Math.round(((revenueUsd - cogsUsd) / revenueUsd) * 1000) / 10 : null;
  return {
    org_id: orgId,
    org_name: orgName,
    credits_spent: creditsSpent,
    revenue_usd: revenueUsd,
    cogs_usd: cogsUsd,
    margin_pct: marginPct,
  };
}

/**
 * Credits sold vs COGS consumed, per org and aggregate, plus per-phase unit
 * economics (v17 gap #295, SPEC-2 §5.3's "live margin monitor", SPEC-3 §6's
 * "/admin/revenue — add credits sold vs COGS"). `credits_spent` nets refunds
 * the same way `spentThisPeriodByOrg` (`lib/credits.ts`) does for one org,
 * generalized to a GROUP BY across every org that spent in the window.
 * `cogs_usd` sums `cost_usd` off every AI run event (success AND failure — a
 * failed run still burns real tokens) in the same window.
 *
 * The credit side and the COGS side are INDEPENDENT aggregates joined by org
 * id in JS, not a SQL join: `ai_credit_ledger` and `competition_events` share
 * no run id to join on (see the wave plan's Migration note), so nothing here
 * is a reconciled per-run figure and the panel's own copy says so.
 */
export async function aiMarginReport(days: number): Promise<AiMarginReport> {
  // Net spend per org: holds minus their own refunds, the same derive
  // `spentThisPeriodByOrg` (lib/credits.ts) does for a single wallet+org.
  //
  // That function expresses the refund leg as a CORRELATED SUBQUERY, which is
  // fine there — it is scoped to one wallet and one org, so it runs a handful
  // of times. Copying the shape into this platform-wide rollup is not: with no
  // index on (source, ref) the planner re-scans the WHOLE ledger once per hold
  // row. Measured on a 725-hold / 16,840-row test schema: 722 loops, 285,190
  // buffer hits, 922ms — and it grows as holds x ledger, so a production
  // ledger would simply never render this page.
  //
  // Pre-aggregating the refunds once and hash-joining is the same arithmetic
  // in two scans. `ref` is the hold's id as text (holds carry no `ref` of
  // their own until settle), and the `source = 'refund'` filter is unchanged,
  // so the join key cannot collide with a pack_purchase's payment-intent ref.
  const creditRows = await sql<{ org_id: string | null; credits_spent: string }[]>`
    with refunds as (
      select ref, sum(delta) as refunded
        from ai_credit_ledger
       where source = 'refund' and ref is not null
       group by ref
    )
    select h.spent_by_org_id as org_id,
           coalesce(sum(-h.delta - coalesce(r.refunded, 0)), 0)::text as credits_spent
      from ai_credit_ledger h
      left join refunds r on r.ref = h.id::text
     where h.source = 'run_spend'
       and h.created_at >= now() - make_interval(days => ${days})
     group by h.spent_by_org_id`;

  const cogsRows = await sql<{ org_id: string | null; cogs_usd: string | null }[]>`
    select org_id,
           coalesce(sum((payload->>'cost_usd')::numeric)
                    filter (where ${COSTED}), 0)::text as cogs_usd
      from competition_events
     where type = any(${AI_RUN_EVENT_TYPES as unknown as string[]})
       and created_at >= now() - make_interval(days => ${days})
     group by org_id`;

  // Phase attribution. Both phases record FAILURES under the same event type
  // (schedule.ai_failed) and stamp `phase` in the payload, so the type alone
  // cannot tell them apart — keying off it would file every officials failure
  // under schedule and skew both $/unit figures. Total by construction: a
  // legacy failure with no stamped phase falls to 'officials', matching
  // `listAiRuns` above so the two /admin surfaces cannot disagree.
  const phaseRows = await sql<
    {
      phase: string;
      runs: number;
      runs_missing_units: number;
      runs_missing_cost: number;
      units: string;
      cogs_usd: string;
      sized_cogs_usd: string;
    }[]
  >`
    select case
             when type = 'schedule.ai_generated' then 'schedule'
             when type = 'schedule.ai_officials_generated' then 'officials'
             when payload->>'phase' = 'schedule' then 'schedule'
             else 'officials'
           end as phase,
           count(*)::int as runs,
           count(*) filter (where not ${SIZED}) ::int as runs_missing_units,
           count(*) filter (where not ${COSTED}) ::int as runs_missing_cost,
           -- units and sized_cogs_usd share ONE filter so they stay a matched
           -- pair: a run missing either half is out of both, and the ratio
           -- below can never divide one set's cost by another set's units.
           coalesce(sum((payload->>'pack_units')::numeric)
                    filter (where ${SIZED} and ${COSTED}), 0)::text as units,
           coalesce(sum((payload->>'cost_usd')::numeric)
                    filter (where ${COSTED}), 0)::text as cogs_usd,
           coalesce(sum((payload->>'cost_usd')::numeric)
                    filter (where ${SIZED} and ${COSTED}), 0)::text as sized_cogs_usd
      from competition_events
     where type = any(${AI_RUN_EVENT_TYPES as unknown as string[]})
       and created_at >= now() - make_interval(days => ${days})
     group by 1`;

  const orgIds = new Set<string>();
  for (const r of creditRows) if (r.org_id) orgIds.add(r.org_id);
  for (const r of cogsRows) if (r.org_id) orgIds.add(r.org_id);

  const names = orgIds.size
    ? await sql<{ id: string; name: string }[]>`
        select id, name from organizations where id in ${sql([...orgIds])}`
    : [];
  const nameById = new Map(names.map((n) => [n.id, n.name]));
  // Clamp at 0 exactly as `spentThisPeriodByOrg` does: a refund can only ever
  // net a hold back to zero, so a negative here would be corrupt data, and
  // negative "credits sold" would poison the margin.
  const creditsByOrg = new Map(
    creditRows.map((r) => [r.org_id, Math.max(0, Number(r.credits_spent))]),
  );
  const cogsByOrg = new Map(cogsRows.map((r) => [r.org_id, Number(r.cogs_usd ?? 0)]));

  const byOrg = [...orgIds]
    .map((orgId) =>
      marginRow(
        orgId,
        nameById.get(orgId) ?? "Unknown org",
        creditsByOrg.get(orgId) ?? 0,
        cogsByOrg.get(orgId) ?? 0,
      ),
    )
    // COGS alone is not a total order: $0.00 is the common case, and ties would
    // otherwise resolve by Set-insertion order inherited from two GROUP BY
    // queries that carry no ORDER BY. Postgres may return those rows in a
    // different order on any run, so an org could appear and disappear from the
    // view's 25-row cap with no underlying change. Revenue breaks most ties;
    // org id is the tiebreak of last resort and guarantees ONE answer.
    .sort(
      (a, b) =>
        b.cogs_usd - a.cogs_usd ||
        b.revenue_usd - a.revenue_usd ||
        (a.org_id ?? "").localeCompare(b.org_id ?? ""),
    );

  const phaseByKey = new Map(phaseRows.map((r) => [r.phase, r]));
  const byPhase = PHASES.map((phase) => {
    const r = phaseByKey.get(phase);
    const units = Number(r?.units ?? 0);
    const sizedCogs = round2(Number(r?.sized_cogs_usd ?? 0));
    return {
      phase,
      unit_noun: aiRunUnitNoun(phase),
      runs: r?.runs ?? 0,
      runs_missing_units: r?.runs_missing_units ?? 0,
      runs_missing_cost: r?.runs_missing_cost ?? 0,
      units,
      cogs_usd: round2(Number(r?.cogs_usd ?? 0)),
      sized_cogs_usd: sizedCogs,
      cost_per_unit_usd: costPerUnitUsd(sizedCogs, units),
    } satisfies AiPhaseUnitRow;
  });

  let totalCredits = 0;
  for (const orgId of orgIds) totalCredits += creditsByOrg.get(orgId) ?? 0;

  // Headline COGS is the sum of the ROUNDED phase rows, not an independently
  // rounded grand total. Same event set either way, but rounding twice lets
  // the two disagree by a cent, and the phase table is the one partition the
  // panel shows in full — a staff member who adds those two rows must land on
  // the headline. (The per-org table is capped in the view and offers no
  // total, so it is not a partition anyone is invited to sum.)
  const totalCogs = byPhase.reduce((s, r) => s + r.cogs_usd, 0);

  return {
    days,
    aggregate: marginRow(null, "All orgs", totalCredits, totalCogs),
    byOrg,
    byPhase,
    earn_grants_today: await earnGrantVolumeToday(),
    earn_grant_alert_threshold: EARN_GRANT_DAILY_ALERT_THRESHOLD,
  };
}
