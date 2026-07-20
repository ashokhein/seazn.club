import "server-only";
// Scheduling console use-cases (doc 12, PROMPT-17): schedule-settings PUT,
// the pure auto pass (propose only), transactional apply, single-fixture move,
// full-board validation, publish, and the division start action. The engine
// stays pure — this module converts DB rows ↔ engine inputs (epoch ms) and
// owns every persist.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature, getLimit } from "@/lib/entitlements";
import { cacheDelPattern } from "@/lib/cache";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { publishDivisionUpdate } from "@/lib/realtime";
import { REASON_CODE } from "@/lib/schedule-board";
import { EngineError } from "@seazn/engine/core";
import {
  slotFixtures,
  validateAssignments,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SchedulableFixture,
  type SlotConfig,
} from "@seazn/engine/scheduling";
import { appendDivisionEvent } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  ScheduleConfig,
  type ApplyScheduleRequest,
  type PutScheduleSettings,
  type ScheduleConflict,
} from "@/server/api-v1/schemas";
import { sendOfficialAssignmentChangedEmail } from "@/lib/email";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";
import { generateStageFixtures } from "./stages";
import { schedulingAiModel } from "./schedule-ai";

type Tx = postgres.TransactionSql;

const MS_PER_MIN = 60_000;
const ms = (v: string | Date): number => new Date(v).getTime();
const iso = (t: number): string => new Date(t).toISOString();

// Every schedule write invalidates both public cache layers (the same pattern
// as scoring, doc 09 §3 / doc 12 §2) and refreshes any open boards.
function afterScheduleWrite(
  divisionId: string,
  competitionId: string,
  reason: "schedule" | "publish" | "start",
): void {
  fireDivisionRevalidate(divisionId, competitionId);
  void cacheDelPattern(`pub:v1:div:${divisionId}:*`);
  void publishDivisionUpdate(divisionId, reason);
}

// A fixture the auto pass / board may still move; everything else on the
// timetable is a fixed obstacle (doc 12 §6: decided fixtures are immutable —
// rain-rescheduling touches remaining fixtures only).
export const MOVABLE_STATUS = "scheduled";
// Statuses that still occupy a court (cancelled/abandoned ones do not).
const OCCUPYING = ["scheduled", "in_play", "decided", "finalized", "forfeited"];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ScheduleSettingsOut {
  division_id: string;
  config: ScheduleConfig;
  tz: string;
  updated_at: string;
}

/** Does a config use the Pro constraint solver (doc 12 §5)? Community keeps
 *  quick-start + basic auto: one court, no rest/blackout/session constraints. */
function usesConstraints(config: ScheduleConfig): boolean {
  return (
    config.perEntrantMinRest > 0 ||
    config.blackouts.length > 0 ||
    config.sessionWindows.length > 0 ||
    config.courts.length > 1 ||
    // constraints v2 (Jul3/04 §6): the whole family rides the same Pro key
    config.constraints !== undefined
  );
}

export async function putScheduleSettings(
  auth: AuthCtx,
  divisionId: string,
  input: PutScheduleSettings,
): Promise<ScheduleSettingsOut> {
  if (usesConstraints(input.config)) {
    await requireFeature(auth.orgId, "scheduling.constraints");
  }
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    await assertCompetitionNotFrozen(auth.orgId, division.competition_id, tx);
    const [row] = await tx<{ division_id: string; config: unknown; tz: string; updated_at: string }[]>`
      insert into schedule_settings (division_id, config, tz, updated_at)
      values (${divisionId}, ${tx.json(input.config as never)}, ${input.tz}, now())
      on conflict (division_id) do update
        set config = excluded.config, tz = excluded.tz, updated_at = now()
      returning division_id, config, tz, updated_at`;
    return { ...row, config: ScheduleConfig.parse(row.config) };
  });
}

export async function getScheduleSettings(
  auth: AuthCtx,
  divisionId: string,
): Promise<ScheduleSettingsOut> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return loadSettings(tx, divisionId);
  });
}

// Settings row or the parsed defaults — the board and quick-start work
// without an explicit PUT (single court, no constraints).
export async function loadSettings(tx: Tx, divisionId: string): Promise<ScheduleSettingsOut> {
  const [row] = await tx<{ division_id: string; config: unknown; tz: string; updated_at: string }[]>`
    select division_id, config, tz, updated_at from schedule_settings
    where division_id = ${divisionId}`;
  if (row) return { ...row, config: ScheduleConfig.parse(row.config) };
  return {
    division_id: divisionId,
    config: ScheduleConfig.parse({}),
    tz: "UTC",
    updated_at: new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Engine input assembly
// ---------------------------------------------------------------------------

export interface FixtureLite {
  id: string;
  stage_id: string;
  division_id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  ext_key: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: string | Date | null;
  court_label: string | null;
  venue: string | null;
  status: string;
  schedule_locked: boolean;
  winner_to_fixture: string | null;
  loser_to_fixture: string | null;
}

// Scope locks (Jul3/03 §4, 22 Jun two-site safety): fixtures matching a
// division's locked_scopes entry are treated exactly like pinned fixtures.
export interface LockedScope {
  courts?: string[];
  venues?: string[];
  pool_ids?: string[];
}

export function scopeLocked(
  f: Pick<FixtureLite, "court_label" | "venue" | "pool_id">,
  scopes: readonly LockedScope[],
): boolean {
  return scopes.some(
    (s) =>
      (s.courts !== undefined && f.court_label !== null && s.courts.includes(f.court_label)) ||
      (s.venues !== undefined && f.venue !== null && s.venues.includes(f.venue)) ||
      (s.pool_ids !== undefined && f.pool_id !== null && s.pool_ids.includes(f.pool_id)),
  );
}

async function divisionLockState(
  tx: Tx,
  divisionId: string,
): Promise<{ frozen: boolean; scopes: LockedScope[] }> {
  const [row] = await tx<{ schedule_locked: boolean; locked_scopes: LockedScope[] }[]>`
    select schedule_locked, locked_scopes from divisions where id = ${divisionId}`;
  return { frozen: row?.schedule_locked ?? false, scopes: row?.locked_scopes ?? [] };
}

const FIXTURE_LITE_COLS = [
  "id", "stage_id", "division_id", "pool_id", "round_no", "seq_in_round", "ext_key",
  "home_entrant_id", "away_entrant_id",
  "scheduled_at", "court_label", "venue", "status", "schedule_locked",
  "winner_to_fixture", "loser_to_fixture",
] as const;

export async function divisionFixtures(tx: Tx, divisionId: string): Promise<FixtureLite[]> {
  return tx<FixtureLite[]>`
    select ${tx(FIXTURE_LITE_COLS)} from fixtures
    where division_id = ${divisionId} and status in ${tx(OCCUPYING)}
    order by round_no, seq_in_round, id`;
}

// person ids per entrant, for cross-division overlap warnings (doc 06 §4.3).
export async function peopleByEntrant(tx: Tx, entrantIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (entrantIds.length === 0) return map;
  const rows = await tx<{ entrant_id: string; person_id: string }[]>`
    select entrant_id, person_id from entrant_members where entrant_id in ${tx(entrantIds)}`;
  for (const r of rows) {
    (map.get(r.entrant_id) ?? map.set(r.entrant_id, []).get(r.entrant_id)!).push(r.person_id);
  }
  return map;
}

function peopleOf(f: FixtureLite, people: Map<string, string[]>): string[] {
  return [
    ...(f.home_entrant_id ? (people.get(f.home_entrant_id) ?? []) : []),
    ...(f.away_entrant_id ? (people.get(f.away_entrant_id) ?? []) : []),
  ];
}

export function toAssignment(f: FixtureLite, matchMinutes: number, people: Map<string, string[]>): Assignment {
  const start = ms(f.scheduled_at as string | Date);
  return {
    fixtureId: f.id,
    court: f.court_label ?? "",
    startAt: start,
    endAt: start + matchMinutes * MS_PER_MIN,
    entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
    people: peopleOf(f, people),
  };
}

// Direct-feed dependencies (doc 12 §2 warn.order): the source fixture's
// winner/loser feeds the target, so the target must not start earlier.
export function feedDependencies(fixtures: readonly FixtureLite[]): OrderDependency[] {
  const ids = new Set(fixtures.map((f) => f.id));
  const deps: OrderDependency[] = [];
  for (const f of fixtures) {
    for (const target of [f.winner_to_fixture, f.loser_to_fixture]) {
      if (target !== null && ids.has(target)) {
        deps.push({ fixtureId: target, dependsOn: f.id, direct: true });
      }
    }
  }
  return deps;
}

// Sibling divisions' timetables (doc 06 §4.3): fixed court occupancy for the
// pass, and the source of cross-division person-overlap warnings. Durations
// use each sibling's own matchMinutes when it has settings.
export async function siblingAssignments(
  tx: Tx,
  divisionId: string,
  competitionId: string,
  fallbackMatchMinutes: number,
): Promise<Assignment[]> {
  const rows = await tx<FixtureLite[]>`
    select ${tx(FIXTURE_LITE_COLS)} from fixtures
    where division_id in (select id from divisions
                          where competition_id = ${competitionId} and id <> ${divisionId})
      and scheduled_at is not null and court_label is not null
      and status in ${tx(OCCUPYING)}`;
  if (rows.length === 0) return [];
  const settings = await tx<{ division_id: string; config: unknown }[]>`
    select division_id, config from schedule_settings
    where division_id in ${tx([...new Set(rows.map((r) => r.division_id))])}`;
  const minutes = new Map(
    settings.map((s) => [s.division_id, ScheduleConfig.parse(s.config).matchMinutes]),
  );
  const entrantIds = [
    ...new Set(rows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id])),
  ].filter((e): e is string => e !== null);
  const people = await peopleByEntrant(tx, entrantIds);
  return rows.map((r) =>
    toAssignment(r, minutes.get(r.division_id) ?? fallbackMatchMinutes, people),
  );
}

export function toSlotConfig(settings: ScheduleSettingsOut, now: number): SlotConfig {
  const c = settings.config;
  return {
    startAt: c.startAt ? ms(c.startAt) : now,
    matchMinutes: c.matchMinutes,
    gapMinutes: c.gapMinutes,
    courts: [...c.courts],
    perEntrantMinRest: c.perEntrantMinRest,
    blackouts: c.blackouts.map((b) => ({
      ...(b.court !== undefined ? { court: b.court } : {}),
      from: ms(b.from),
      to: ms(b.to),
    })),
    sessionWindows: c.sessionWindows.map((w) => ({ from: ms(w.from), to: ms(w.to) })),
    // constraints v2 (Jul3/04 §3): ISO → epoch ms for the pure pass
    ...(c.constraints !== undefined
      ? {
          constraints: {
            ...(c.constraints.restMin !== undefined ? { restMin: c.constraints.restMin } : {}),
            ...(c.constraints.restByGroup !== undefined
              ? { restByGroup: c.constraints.restByGroup }
              : {}),
            noBackToBack: c.constraints.noBackToBack,
            startWindows: c.constraints.startWindows.map((w) => ({
              target: w.target,
              ...(w.notBefore !== undefined ? { notBefore: ms(w.notBefore) } : {}),
              ...(w.notAfter !== undefined ? { notAfter: ms(w.notAfter) } : {}),
            })),
            fieldFairness: c.constraints.fieldFairness,
            parallelism: c.constraints.parallelism,
            crossPersonClash: c.constraints.crossPersonClash,
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Conflict taxonomy (doc 12 §2) — engine reasons → API codes. REASON_CODE is
// the single shared table in lib/schedule-board (isomorphic), so the AI diff
// panel maps blocking-row reasons through the exact same map client-side.
// ---------------------------------------------------------------------------

function mapConflicts(
  conflicts: readonly Conflict[],
  crossPersonClash?: "warn" | "hard",
): ScheduleConflict[] {
  // crossPersonClash="hard" (Jul3/04 §2) means the organiser asked for a person
  // double-booking to be refused, not badged. The solver already refuses to
  // place one — but the board accepted a hand-placed clash, because blocking
  // was decided here without ever consulting the setting. Default stays "warn",
  // so only organisations that opted in see the change.
  const personBlocks = crossPersonClash === "hard";
  return conflicts.map((c) => ({
    fixture_id: c.fixtureId,
    code: REASON_CODE[c.reason],
    // conflict.court blocks (physically impossible); warn.order blocks for
    // direct feeds; everything else is a badge (doc 12 §2).
    blocking:
      c.reason === "court" ||
      (c.reason === "order" && c.direct === true) ||
      (c.reason === "person_overlap" && personBlocks),
    ...(c.detail !== undefined ? { detail: c.detail } : {}),
  }));
}

function assertNoBlocking(conflicts: ScheduleConflict[]): void {
  const blocking = conflicts.filter((c) => c.blocking);
  if (blocking.length > 0) {
    throw new EngineError("SCHEDULE_CONFLICT", "schedule change hits a blocking conflict", {
      conflicts: blocking,
    });
  }
}

// ---------------------------------------------------------------------------
// Auto pass (propose only — doc 12 §4: nothing persisted)
// ---------------------------------------------------------------------------

export interface AutoScheduleOut {
  assignments: { fixture_id: string; scheduled_at: string; ends_at: string; court_label: string }[];
  conflicts: ScheduleConflict[];
}

export async function autoSchedule(
  auth: AuthCtx,
  stageId: string,
  onlyUnlocked: boolean,
): Promise<AutoScheduleOut> {
  return withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; competition_id: string }[]>`
      select s.division_id, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    const settings = await loadSettings(tx, stage.division_id);
    const all = await divisionFixtures(tx, stage.division_id);
    const { scopes } = await divisionLockState(tx, stage.division_id);
    const entrantIds = [
      ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
    ].filter((e): e is string => e !== null);
    const people = await peopleByEntrant(tx, entrantIds);

    // Movable: this stage's undecided fixtures. Fixed obstacles: everything
    // already on the timetable elsewhere in the division (other stages,
    // decided fixtures) plus sibling divisions.
    const movable = all.filter((f) => f.stage_id === stageId && f.status === MOVABLE_STATUS);
    const obstacles = all
      .filter((f) => !movable.includes(f))
      .filter((f) => f.scheduled_at !== null && f.court_label !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people));
    const siblings = await siblingAssignments(
      tx,
      stage.division_id,
      stage.competition_id,
      settings.config.matchMinutes,
    );

    const schedulable: SchedulableFixture[] = movable.map((f) => ({
      id: f.id,
      roundNo: f.round_no,
      ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
      divisionId: f.division_id,
      ...(f.home_entrant_id !== null ? { home: f.home_entrant_id } : {}),
      ...(f.away_entrant_id !== null ? { away: f.away_entrant_id } : {}),
      people: peopleOf(f, people),
      // Re-flow remaining (doc 12 §2): pinned cards are fixed obstacles;
      // scope-locked fixtures (Jul3/03 §4 two-site safety) pin the same way.
      ...(onlyUnlocked &&
      (f.schedule_locked || scopeLocked(f, scopes)) &&
      f.scheduled_at !== null &&
      f.court_label !== null
        ? { locked: { court: f.court_label, startAt: ms(f.scheduled_at) } }
        : {}),
    }));

    const result = slotFixtures({
      fixtures: schedulable,
      config: toSlotConfig(settings, roundToMinute(Date.now())),
      existing: [...obstacles, ...siblings],
    });
    return {
      assignments: result.assignments.map((a) => ({
        fixture_id: a.fixtureId,
        scheduled_at: iso(a.startAt),
        ends_at: iso(a.endAt),
        court_label: a.court,
      })),
      conflicts: mapConflicts(result.conflicts),
    };
  });
}

const roundToMinute = (t: number): number => Math.ceil(t / MS_PER_MIN) * MS_PER_MIN;

// ---------------------------------------------------------------------------
// Apply (transactional persist — doc 12 §4)
// ---------------------------------------------------------------------------

export interface ApplyScheduleOut {
  applied: number;
  conflicts: ScheduleConflict[];
}

export async function applySchedule(
  auth: AuthCtx,
  stageId: string,
  input: ApplyScheduleRequest,
): Promise<ApplyScheduleOut> {
  // Manual assignment sets and pin changes are board editing — Pro (doc 12 §5;
  // Community keeps the basic auto flow).
  if (input.source === "manual" || input.assignments.some((a) => a.schedule_locked !== undefined)) {
    await requireFeature(auth.orgId, "scheduling.board");
  }
  const out = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; competition_id: string }[]>`
      select s.division_id, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    await assertFreshSeq(tx, stage.division_id, input.expected_seq);
    await assertCompetitionNotFrozen(auth.orgId, stage.competition_id, tx);

    const settings = await loadSettings(tx, stage.division_id);
    const all = await divisionFixtures(tx, stage.division_id);
    const lockState = await divisionLockState(tx, stage.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, "the division schedule is locked — unlock it to edit");
    }
    const byId = new Map(all.map((f) => [f.id, f]));
    for (const a of input.assignments) {
      const f = byId.get(a.fixture_id);
      if (!f || f.stage_id !== stageId) {
        throw new HttpError(422, `fixture ${a.fixture_id} is not part of this stage`);
      }
      if (f.status !== MOVABLE_STATUS) {
        throw new HttpError(422, `fixture ${a.fixture_id} is ${f.status} — decided fixtures are immutable`);
      }
      if (scopeLocked(f, lockState.scopes)) {
        throw new HttpError(422, `fixture ${a.fixture_id} is inside a locked scope`);
      }
    }

    const entrantIds = [
      ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
    ].filter((e): e is string => e !== null);
    const people = await peopleByEntrant(tx, entrantIds);

    const proposed: Assignment[] = input.assignments.map((a) => {
      const f = byId.get(a.fixture_id) as FixtureLite;
      const start = ms(a.scheduled_at);
      return {
        fixtureId: a.fixture_id,
        court: a.court_label,
        startAt: start,
        endAt: start + settings.config.matchMinutes * MS_PER_MIN,
        entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
        people: peopleOf(f, people),
      };
    });
    const listed = new Set(input.assignments.map((a) => a.fixture_id));
    const untouched = all
      .filter((f) => !listed.has(f.id) && f.scheduled_at !== null && f.court_label !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people));
    const siblings = await siblingAssignments(
      tx,
      stage.division_id,
      stage.competition_id,
      settings.config.matchMinutes,
    );

    const conflicts = mapConflicts(
      validateAssignments(
        proposed,
        toSlotConfig(settings, 0),
        [...untouched, ...siblings],
        feedDependencies(all),
      ),
      settings.config.constraints?.crossPersonClash,
    );
    assertNoBlocking(conflicts);

    const moves: { fixture: string; from: unknown; to: unknown }[] = [];
    for (const a of input.assignments) {
      const f = byId.get(a.fixture_id) as FixtureLite;
      await tx`
        update fixtures set
          scheduled_at = ${a.scheduled_at},
          court_label = ${a.court_label},
          venue = coalesce(${a.venue ?? null}, venue),
          schedule_source = ${input.source},
          schedule_locked = ${a.schedule_locked ?? f.schedule_locked}
        where id = ${a.fixture_id}`;
      moves.push({
        fixture: a.fixture_id,
        from: {
          at: f.scheduled_at !== null ? iso(ms(f.scheduled_at)) : null,
          court: f.court_label,
        },
        to: { at: a.scheduled_at, court: a.court_label },
      });
    }
    // One auditable ledger entry per apply (doc 12 §2 family: schedule_edited/…).
    const seq = await appendDivisionEvent(tx, stage.division_id, "schedule_applied", {
      stageId,
      source: input.source,
      moves,
      // Stamp the runtime model, not the client's constant: SCHEDULING_AI_MODEL
      // can override the model that actually ran, and the run ledger records the
      // truth — so trusting the client's `model` here would misrecord the audit.
      // The client field is still accepted (schema unchanged); it's just ignored.
      ...(input.ai
        ? { ai: { ...input.ai, instruction: input.ai.instruction.trim(), model: schedulingAiModel() } }
        : {}),
    });
    await tx`update divisions set seq = ${seq} where id = ${stage.division_id}`;
    return { divisionId: stage.division_id, competitionId: stage.competition_id, applied: input.assignments.length, conflicts };
  });
  afterScheduleWrite(out.divisionId, out.competitionId, "schedule");
  return { applied: out.applied, conflicts: out.conflicts };
}

/** GET /divisions/{id}/schedule/ai-last — recall the most recent AI-sourced
 *  schedule apply from the division ledger (v4/03 §10) plus the division's
 *  generation budget. `last` is the trimmed instruction + human summary +
 *  apply timestamp, or null when the division has never been AI-scheduled.
 *  `runs.used` counts the same 'schedule.ai_generated' rows the ai-plan quota
 *  gate counts (failures never appear there); `runs.max` is the plan's
 *  per-division cap resolved with the same overlay chain as the gate
 *  (event-pass lift, admin override), null = unlimited. Read-gated at route. */
export async function lastAiApply(
  auth: AuthCtx,
  divisionId: string,
): Promise<{
  last: { at: string; instruction: string; summary: string } | null;
  runs: { used: number; max: number | null };
}> {
  const { rows, competitionId, used } = await withTenant(auth.orgId, async (tx) => {
    const rows = await tx<
      { created_at: Date; payload: { ai?: { instruction?: string; summary?: string } } }[]
    >`
      select created_at, payload from division_events
      where division_id = ${divisionId}
        and type = 'schedule_applied'
        and payload->>'source' = 'ai'
      order by seq desc limit 1`;
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [count] = await tx<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where competition_id = ${division.competition_id}
        and type = 'schedule.ai_generated'
        and payload->>'division_id' = ${divisionId}`;
    return { rows, competitionId: division.competition_id, used: count?.n ?? 0 };
  });
  const max = await getLimit(auth.orgId, "scheduling.ai.runs_per_division.max", competitionId);
  const ai = rows[0]?.payload.ai ?? {};
  return {
    last:
      rows.length === 0
        ? null
        : {
            at: iso(ms(rows[0]!.created_at)),
            instruction: ai.instruction ?? "",
            summary: ai.summary ?? "",
          },
    runs: { used, max },
  };
}

// ---------------------------------------------------------------------------
// Single move (fixture PATCH, doc 12 §4) — used by the drag-and-drop board
// ---------------------------------------------------------------------------

export interface MoveInput {
  scheduled_at?: string | null;
  court_label?: string | null;
  venue?: string | null;
  schedule_locked?: boolean;
  expected_seq?: number;
}

/** Optimistic-concurrency guard (v3/11 gap 10): schedule writes may carry the
 *  division seq the client rendered from; a stale token means another admin
 *  edited the board since — 409 with the current seq so the client resyncs. */
async function assertFreshSeq(
  tx: Tx,
  divisionId: string,
  expectedSeq: number | undefined,
): Promise<void> {
  if (expectedSeq === undefined) return;
  const [row] = await tx<{ seq: string | number }[]>`
    select seq from divisions where id = ${divisionId}`;
  const actual = Number(row?.seq ?? 0);
  if (expectedSeq !== actual) {
    throw new EngineError("SEQ_CONFLICT", "schedule changed since you loaded it", {
      actualSeq: actual,
    });
  }
}

/**
 * Schedule-aware single-fixture move: blocks on conflict.court / direct
 * warn.order (409 with the conflicts), otherwise persists and appends
 * `schedule_edited {fixture, from, to}` (doc 12 §2).
 */
export async function moveFixture(
  auth: AuthCtx,
  fixtureId: string,
  patch: MoveInput,
): Promise<void> {
  if (patch.schedule_locked !== undefined) {
    await requireFeature(auth.orgId, "scheduling.board");
  }
  const out = await withTenant(auth.orgId, async (tx) => {
    const [fixture] = await tx<
      (FixtureLite & { competition_id: string })[]
    >`
      select f.id, f.stage_id, f.division_id, f.round_no, f.home_entrant_id,
             f.away_entrant_id, f.scheduled_at, f.court_label, f.venue, f.pool_id,
             f.status, f.schedule_locked, f.winner_to_fixture, f.loser_to_fixture,
             d.competition_id
      from fixtures f join divisions d on d.id = f.division_id
      where f.id = ${fixtureId}`;
    if (!fixture) throw new HttpError(404, "fixture not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + fixture.division_id}))`;
    await assertFreshSeq(tx, fixture.division_id, patch.expected_seq);
    await assertCompetitionNotFrozen(auth.orgId, fixture.competition_id, tx);

    // Single-fixture moves are board edits too — the whole-division freeze
    // must hold here exactly as it does for applySchedule (this is the route
    // the board's drag/keyboard move actually uses). Scope locks deliberately
    // do NOT bite on single moves (see history.test.ts — the board apply path
    // enforces them; a targeted move is the escape hatch).
    const lockState = await divisionLockState(tx, fixture.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, "the division schedule is locked — unlock it to edit");
    }

    const movesTimetable = patch.scheduled_at !== undefined || patch.court_label !== undefined;
    if (movesTimetable && fixture.status !== MOVABLE_STATUS) {
      throw new HttpError(422, `fixture is ${fixture.status} — decided fixtures are immutable`);
    }

    const settings = await loadSettings(tx, fixture.division_id);
    const nextAt = patch.scheduled_at !== undefined ? patch.scheduled_at : (fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null);
    const nextCourt = patch.court_label !== undefined ? patch.court_label : fixture.court_label;

    let conflicts: ScheduleConflict[] = [];
    if (movesTimetable && nextAt !== null && nextCourt !== null) {
      const all = await divisionFixtures(tx, fixture.division_id);
      const entrantIds = [
        ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
      ].filter((e): e is string => e !== null);
      const people = await peopleByEntrant(tx, entrantIds);
      const start = ms(nextAt);
      const proposed: Assignment = {
        fixtureId: fixture.id,
        court: nextCourt,
        startAt: start,
        endAt: start + settings.config.matchMinutes * MS_PER_MIN,
        entrants: [fixture.home_entrant_id, fixture.away_entrant_id].filter(
          (e): e is string => e !== null,
        ),
        people: peopleOf(fixture, people),
      };
      const others = all
        .filter((f) => f.id !== fixture.id && f.scheduled_at !== null && f.court_label !== null)
        .map((f) => toAssignment(f, settings.config.matchMinutes, people));
      const siblings = await siblingAssignments(
        tx,
        fixture.division_id,
        fixture.competition_id,
        settings.config.matchMinutes,
      );
      conflicts = mapConflicts(
        validateAssignments(
          [proposed],
          toSlotConfig(settings, 0),
          [...others, ...siblings],
          feedDependencies(all),
        ),
        settings.config.constraints?.crossPersonClash,
      );
      assertNoBlocking(conflicts);
    }

    const values: Record<string, unknown> = {};
    if (patch.scheduled_at !== undefined) values.scheduled_at = patch.scheduled_at;
    if (patch.court_label !== undefined) values.court_label = patch.court_label;
    if (patch.venue !== undefined) values.venue = patch.venue;
    if (patch.schedule_locked !== undefined) values.schedule_locked = patch.schedule_locked;
    if (movesTimetable) values.schedule_source = "manual";
    if (Object.keys(values).length > 0) {
      await tx`
        update fixtures set ${tx(values as never, ...(Object.keys(values) as never[]))}
        where id = ${fixture.id}`;
    }

    if (movesTimetable || patch.schedule_locked !== undefined) {
      const seq = await appendDivisionEvent(tx, fixture.division_id, "schedule_edited", {
        fixture: fixture.id,
        from: {
          at: fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null,
          court: fixture.court_label,
          locked: fixture.schedule_locked,
        },
        to: {
          at: nextAt,
          court: nextCourt,
          locked: patch.schedule_locked ?? fixture.schedule_locked,
        },
      });
      await tx`update divisions set seq = ${seq} where id = ${fixture.division_id}`;
    }

    // v11: officials who agreed to a slot must hear when it moves. Only real
    // timetable/venue changes notify, only non-declined assignments, only
    // officials with an email — assembled in-tx, sent after commit.
    const timetableChanged =
      (movesTimetable &&
        ((fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null) !== nextAt ||
          fixture.court_label !== nextCourt)) ||
      (patch.venue !== undefined && patch.venue !== fixture.venue);
    let changeNotices: {
      email: string; display_name: string; role_key: string; org_name: string;
      home_name: string | null; away_name: string | null; venue_tz: string | null;
    }[] = [];
    if (timetableChanged) {
      changeNotices = await tx`
        select o.email, o.display_name, fo.role_key, org.name as org_name,
               h.display_name as home_name, a.display_name as away_name,
               ss.tz as venue_tz
        from fixture_officials fo
        join officials o on o.id = fo.official_id
        join organizations org on org.id = o.org_id
        left join entrants h on h.id = ${fixture.home_entrant_id}
        left join entrants a on a.id = ${fixture.away_entrant_id}
        left join schedule_settings ss on ss.division_id = ${fixture.division_id}
        where fo.fixture_id = ${fixture.id}
          and fo.response <> 'declined' and o.email is not null`;
    }
    return {
      divisionId: fixture.division_id,
      competitionId: fixture.competition_id,
      changeNotices,
      change: {
        prevAt: fixture.scheduled_at !== null ? iso(ms(fixture.scheduled_at)) : null,
        nextAt,
        court: nextCourt,
        venue: patch.venue !== undefined ? patch.venue : fixture.venue,
      },
    };
  });
  for (const n of out.changeNotices) {
    void sendOfficialAssignmentChangedEmail(n.email, {
      orgName: n.org_name,
      officialName: n.display_name,
      roleKey: n.role_key,
      label: `${n.home_name ?? "TBD"} vs ${n.away_name ?? "TBD"}`,
      prevAt: out.change.prevAt,
      nextAt: out.change.nextAt,
      venueTz: n.venue_tz,
      court: out.change.court,
      venue: out.change.venue,
    }).catch(() => {});
  }
  afterScheduleWrite(out.divisionId, out.competitionId, "schedule");
}

// ---------------------------------------------------------------------------
// Validate (full board report — doc 12 §4)
// ---------------------------------------------------------------------------

export async function validateSchedule(
  auth: AuthCtx,
  divisionId: string,
): Promise<{ conflicts: ScheduleConflict[] }> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const settings = await loadSettings(tx, divisionId);
    const all = await divisionFixtures(tx, divisionId);
    const entrantIds = [
      ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
    ].filter((e): e is string => e !== null);
    const people = await peopleByEntrant(tx, entrantIds);
    const assignments = all
      .filter((f) => f.scheduled_at !== null && f.court_label !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people));
    const siblings = await siblingAssignments(
      tx,
      divisionId,
      division.competition_id,
      settings.config.matchMinutes,
    );
    const officialConflicts = await tx<{ fixture_id: string; code: string }[]>`
      -- declined: any assigned official said no
      select fo.fixture_id, 'warn.official_declined' as code
      from fixture_officials fo
      join fixtures f on f.id = fo.fixture_id
      where f.division_id = ${divisionId} and fo.response = 'declined'
      union
      -- unavailable: an accepted/pending official is blacked out on the
      -- fixture's date (venue zone), i.e. a schedule clash
      select fo.fixture_id, 'warn.official_unavailable' as code
      from fixture_officials fo
      join fixtures f on f.id = fo.fixture_id
      join officials o on o.id = fo.official_id
      join official_availability oa on oa.official_id = o.id
      left join schedule_settings ss on ss.division_id = f.division_id
      where f.division_id = ${divisionId}
        and fo.response in ('accepted','pending')
        and f.scheduled_at is not null
        and oa.date = (f.scheduled_at at time zone coalesce(ss.tz, 'UTC'))::date`;

    return {
      conflicts: [
        ...mapConflicts(
          validateAssignments(assignments, toSlotConfig(settings, 0), siblings, feedDependencies(all)),
        ),
        ...officialConflicts.map((c) => ({ fixture_id: c.fixture_id, code: c.code as ScheduleConflict["code"], blocking: false })),
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Publish & start (doc 12 §1 state machine)
// ---------------------------------------------------------------------------

export interface PublishScheduleOut {
  division_id: string;
  status: string;
  published: boolean;
}

export async function publishSchedule(auth: AuthCtx, divisionId: string): Promise<PublishScheduleOut> {
  const out = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ status: string; competition_id: string }[]>`
      select status, competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    await assertCompetitionNotFrozen(auth.orgId, division.competition_id, tx);
    if (division.status === "completed") {
      throw new HttpError(422, "a completed division cannot publish a schedule");
    }
    const status = division.status === "setup" ? "scheduled" : division.status;
    if (status !== division.status) {
      await tx`update divisions set status = ${status} where id = ${divisionId}`;
    }
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from fixtures
      where division_id = ${divisionId} and scheduled_at is not null`;
    const seq = await appendDivisionEvent(tx, divisionId, "schedule_published", {
      fixturesScheduled: n,
    });
    await tx`update divisions set seq = ${seq} where id = ${divisionId}`;
    return { competitionId: division.competition_id, status };
  });
  afterScheduleWrite(divisionId, out.competitionId, "publish");
  return { division_id: divisionId, status: out.status, published: true };
}

export interface StartDivisionOut {
  division_id: string;
  status: string;
  started: boolean;
  generated: number;
}

/**
 * The "start tournament" action (doc 12 §1 — both modes end here). Quick-start
 * from setup generates the first stage's fixtures when none exist and, when
 * `roundMinutes` is configured, slots rolling times (round r at startAt +
 * (r−1)·roundMinutes). Scoring opens only after this (division_started).
 */
export async function startDivision(auth: AuthCtx, divisionId: string): Promise<StartDivisionOut> {
  const pre = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ status: string; competition_id: string }[]>`
      select status, competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    await assertCompetitionNotFrozen(auth.orgId, division.competition_id, tx);
    if (division.status === "completed") throw new HttpError(422, "division is completed");
    const [firstStage] = await tx<{ id: string; n: number }[]>`
      select s.id, (select count(*)::int from fixtures f where f.stage_id = s.id) as n
      from stages s where s.division_id = ${divisionId}
      order by s.seq limit 1`;
    if (!firstStage) throw new HttpError(422, "division has no stages to start");
    return { ...division, firstStage };
  });
  if (pre.status === "active") {
    return { division_id: divisionId, status: "active", started: false, generated: 0 };
  }

  // Quick-start: generate outside the status transaction (the generator takes
  // its own division lock).
  let generated = 0;
  if (pre.firstStage.n === 0) {
    const outcome = await generateStageFixtures(auth, pre.firstStage.id);
    generated = outcome.created;
  }

  const out = await withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [division] = await tx<{ status: string }[]>`
      select status from divisions where id = ${divisionId}`;
    if (!division || division.status === "active") return { started: false };

    // Rolling quick-start times (doc 12 §1.A) — only for a straight
    // setup→active start; a published timetable is left untouched.
    const settings = await loadSettings(tx, divisionId);
    if (division.status === "setup" && settings.config.roundMinutes) {
      const startAt = settings.config.startAt
        ? ms(settings.config.startAt)
        : roundToMinute(Date.now());
      const step = settings.config.roundMinutes * MS_PER_MIN;
      const rounds = await tx<{ round_no: number }[]>`
        select distinct round_no from fixtures
        where stage_id = ${pre.firstStage.id} and scheduled_at is null
        order by round_no`;
      for (const [i, r] of rounds.entries()) {
        await tx`
          update fixtures set scheduled_at = ${iso(startAt + i * step)}, schedule_source = 'auto'
          where stage_id = ${pre.firstStage.id} and round_no = ${r.round_no}
            and scheduled_at is null`;
      }
    }

    await tx`update divisions set status = 'active' where id = ${divisionId}`;
    const seq = await appendDivisionEvent(tx, divisionId, "division_started", {
      from: division.status,
    });
    await tx`update divisions set seq = ${seq} where id = ${divisionId}`;
    return { started: true };
  });
  afterScheduleWrite(divisionId, pre.competition_id, "start");
  return { division_id: divisionId, status: "active", started: out.started, generated };
}
