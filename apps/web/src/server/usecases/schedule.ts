import "server-only";
// Scheduling console use-cases (doc 12, PROMPT-17): schedule-settings PUT,
// the pure auto pass (propose only), transactional apply, single-fixture move,
// full-board validation, publish, and the division start action. The engine
// stays pure — this module converts DB rows ↔ engine inputs (epoch ms) and
// owns every persist.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { cacheDelPattern } from "@/lib/cache";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { publishDivisionUpdate } from "@/lib/realtime";
import { REASON_CODE } from "@/lib/schedule-board";
import { resolveVenueTz } from "@/lib/tz";
import { EngineError } from "@seazn/engine/core";
import {
  conflictKey,
  dayKeyInTz,
  deltaConflicts,
  isBlockingConflict,
  slotFixtures,
  validateAssignments,
  validateInstructionRules,
  ymdAddDays,
  zonedTimeToUtc,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type RuleFixture,
  type SchedulableFixture,
  type SlotConfig,
  type VerifyConfig,
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
import { buildEngineConstraints } from "./engine-constraints";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";
import { generateStageFixtures } from "./stages";
import { schedulingAiModel, toRuleFixture } from "./schedule-ai";

type Tx = postgres.TransactionSql;

const MS_PER_MIN = 60_000;
const ms = (v: string | Date): number => new Date(v).getTime();
const iso = (t: number): string => new Date(t).toISOString();

// Every schedule write invalidates both public cache layers (the same pattern
// as scoring, doc 09 §3 / doc 12 §2) and refreshes any open boards.
// Exported for the #350 joint apply (competition-schedule-apply.ts), which fires
// it once per written division AFTER its single transaction commits — same
// placement as `applySchedule`, not a second copy of the invalidation list.
export function afterScheduleWrite(
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
// Exported so the #350 joint builder derives its "fixed occupancy" set as
// OCCUPYING minus MOVABLE_STATUS rather than copying the list — a copy would
// drift silently the day a status is added here.
export const OCCUPYING = ["scheduled", "in_play", "decided", "finalized", "forfeited"];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ScheduleSettingsOut {
  division_id: string;
  config: ScheduleConfig;
  /** RESOLVED venue zone (V305): stored division tz → org timezone → 'UTC'. */
  tz: string;
  /** The ORGANISATION zone, resolved independently of the division's own (#397).
   *  W2 makes this the one clock all temporal math runs in — day boundaries,
   *  weekday targets, session hours, output offsets — while `tz` above stays the
   *  display lane a division may override. */
  orgTz: string;
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
    // tz is tri-state (V305). An ABSENT key must not clobber the stored value:
    // the division settings form no longer offers a timezone at all, so every
    // console save omits it, and a save may never move a division's venue zone.
    const tzTouched = input.tz !== undefined;
    await tx`
      insert into schedule_settings (division_id, config, tz, updated_at)
      values (${divisionId}, ${tx.json(input.config as never)}, ${input.tz ?? null}, now())
      on conflict (division_id) do update
        set config = excluded.config,
            tz = case when ${tzTouched} then excluded.tz else schedule_settings.tz end,
            updated_at = now()`;
    return loadSettings(tx, divisionId);
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
  // Left-join from divisions so the org zone is available even when the
  // division has no settings row yet (quick-start, board before first PUT).
  const [row] = await tx<
    {
      config: unknown | null;
      tz: string | null;
      org_tz: string | null;
      updated_at: string | null;
    }[]
  >`
    select ss.config, ss.tz, o.timezone as org_tz, ss.updated_at
    from divisions d
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations o on o.id = d.org_id
    where d.id = ${divisionId}`;
  return {
    division_id: divisionId,
    config: ScheduleConfig.parse(row?.config ?? {}),
    // A division that already holds its own tz keeps winning, silently and
    // forever — the console can no longer set one, but it must never move.
    tz: resolveVenueTz(row?.tz, row?.org_tz),
    // Deliberately NOT resolveVenueTz(row?.tz, …): the division override must not
    // leak into the governing clock, or two divisions of one competition would
    // disagree about which calendar day a fixture is on (#397, design §2.1).
    orgTz: resolveVenueTz(null, row?.org_tz),
    updated_at: row?.updated_at ?? new Date(0).toISOString(),
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

// Exported for the #350 joint apply: a locked division must abort a joint write
// on exactly the terms it aborts a single-division one.
export async function divisionLockState(
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

/** A DB fixture row as the engine's `Assignment`.
 *
 *  `poolId`/`divisionId` are stamped (#446). They are not decoration: the
 *  verifier resolves a pool- or division-targeted `restByGroup` and
 *  `startWindows` entry off exactly these two fields
 *  (`effectiveRestMinutes`/`startWindowFor`), and the placer resolves the same
 *  rules off the twin fields on `SchedulableFixture` (built at :523 from the
 *  same row). Dropping them here is what made a pool rule bind for
 *  Auto-schedule and evaporate the moment an organiser dragged a card.
 *
 *  Optionality follows the `SchedulableFixture` builder exactly: `division_id`
 *  is NOT NULL so it is always stamped; `pool_id` is nullable and the key is
 *  omitted rather than set to `undefined`, because `Assignment.poolId` is an
 *  optional string and the verifier tests it with `!== undefined`. */
export function toAssignment(f: FixtureLite, matchMinutes: number, people: Map<string, string[]>): Assignment {
  const start = ms(f.scheduled_at as string | Date);
  return {
    fixtureId: f.id,
    court: f.court_label ?? "",
    startAt: start,
    endAt: start + matchMinutes * MS_PER_MIN,
    entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
    people: peopleOf(f, people),
    ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
    divisionId: f.division_id,
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
  /** Further divisions to leave out, on top of `divisionId` itself.
   *
   *  Added for the #350 joint pack: when several divisions of a competition are
   *  planned together the others are not "siblings" whose board is fixed — they
   *  are in the same run and their movable fixtures are being re-placed. Serving
   *  them here hands a division the rest of the run's own work as immovable
   *  obstacles, and since siblings carry NO division identity a caller cannot
   *  tell those entries from a genuinely-outside division's booking. Excluding
   *  them at the source is what makes "this obstacle is from outside the run" a
   *  fact instead of a slot-key guess. */
  excludeDivisionIds: readonly string[] = [],
): Promise<Assignment[]> {
  const excluded = [...new Set([divisionId, ...excludeDivisionIds])];
  const rows = await tx<FixtureLite[]>`
    select ${tx(FIXTURE_LITE_COLS)} from fixtures
    where division_id in (select id from divisions
                          where competition_id = ${competitionId} and id not in ${tx(excluded)})
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
  const window = applyWindow(settings);
  const startAtMs = c.startAt ? ms(c.startAt) : now;
  const horizonMinutes =
    window !== undefined && Number.isFinite(window.to)
      ? Math.floor((window.to - startAtMs) / MS_PER_MIN) - c.matchMinutes
      : 0;
  return {
    startAt: startAtMs,
    // #399: the days the competition actually runs, so a card dragged outside
    // them is refused instead of badged. Delta-gated at the write, so a board
    // already sitting outside its dates stays editable.
    ...(window !== undefined ? { window } : {}),
    // The SOLVER has to respect the same bound, or the auto pass proposes a
    // board the apply gate then refuses: `slotFixtures` searches to
    // `startAt + horizonMinutes` and cannot emit a `window` conflict of its own,
    // so an over-subscribed division would come back with cards past its end
    // date and 409 on apply. Bounded here it reports `no_slot` (CAP), which is
    // the truth.
    //
    // `horizonMinutes` bounds the match START, so the match LENGTH comes off it
    // — a match starting exactly at the window's end would finish outside it —
    // and it floors rather than ceils, because a rounded-up minute is a minute
    // outside the window. A non-positive result means the end date is not after
    // the start date: a config error, and clamping it to zero would answer every
    // fixture with CAP as if the day were merely full. Left unbounded there, so
    // the auto pass behaves exactly as it did and the apply gate is what speaks.
    ...(window !== undefined && Number.isFinite(window.to) && horizonMinutes > 0
      ? { horizonMinutes }
      : {}),
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
    // constraints v2 (Jul3/04 §3): ISO → epoch ms for the pure pass, through the
    // ONE builder (#458) the AI verify seams also go through, so this config and
    // the config a proposal is judged against cannot drift apart again.
    //
    // `hard: true` — the DURABLE typed rules (#398) ride `constraints.hard` on
    // this path, never the top-level `hard` field, because `effectiveHard`
    // MERGES the two and setting both would count every durable rule twice
    // (#447). The top-level field is where a run puts the stream it COMPILED
    // from an instruction, which is why the AI seams route them the other way.
    // Riding `toSlotConfig` rather than the wrapper below is deliberate too:
    // every existing caller gets them with no second place to remember.
    ...(c.constraints !== undefined
      ? {
          constraints: buildEngineConstraints(c.constraints, {
            fieldFairness: c.constraints.fieldFairness,
            parallelism: c.constraints.parallelism,
            crossPersonClash: c.constraints.crossPersonClash,
            hard: true,
          }),
        }
      : {}),
  };
}

/** A `fixtures` row as a `RuleFixture`, by renaming its columns onto the ONE
 *  builder (#447).
 *
 *  Deliberately not a second RuleFixture literal. `winnerTo` must carry
 *  `fixtures.winner_to_fixture` — a uuid FK to `fixtures.id` — and `extKey` must
 *  carry `fixtures.ext_key`, nullable text in a different namespace with no
 *  converter. `RuleFixture` types both `string | null`, so a producer that swaps
 *  them type-checks and then binds NOTHING, silently: that is #443, and #443 was
 *  invisible precisely because a second copy of the join existed. This function
 *  therefore does one thing — rename `pool_id`→`pool`, `winner_to_fixture`→
 *  `feeds.winner_to` — and hands the result to `toRuleFixture`, which stays the
 *  only assignment of `winnerTo` in the codebase. `schedule-ai-repair.test.ts`
 *  guards that count across all three modules. */
export function rowToRuleFixture(
  f: Pick<FixtureLite, "id" | "ext_key" | "pool_id" | "division_id" | "winner_to_fixture">,
): RuleFixture {
  return toRuleFixture(
    { id: f.id, ext_key: f.ext_key, pool: f.pool_id, feeds: { winner_to: f.winner_to_fixture } },
    f.division_id,
  );
}

/** Everything the VERIFIER reads, for the board paths (#447).
 *
 *  `toSlotConfig` answers the placer's question ("where may a card go?") and a
 *  `SlotConfig` is structurally assignable to a `VerifyConfig` with `tz`, `hard`,
 *  `ruleFixtures` and `restByDivision` all `undefined` — which is exactly why
 *  handing one straight to `validateAssignments` compiled clean for four call
 *  sites while dropping every typed rule on the floor.
 *
 *  Two of those fields are load-bearing here and both are traps:
 *
 *    tz            `validateInstructionRules` wraps its ENTIRE typed-rule block
 *                  in `if (tz !== undefined)`, on purpose: every rule in it
 *                  needs a day boundary or a wall-clock time, and bucketing one
 *                  in UTC would report a violation the organiser never expressed.
 *                  So carrying the rules WITHOUT the zone is a fix that binds
 *                  nothing. It is `orgTz`, never `tz` — the org zone governs
 *                  every temporal boundary (#397), and the division's display
 *                  override must not move a rule's calendar day.
 *    ruleFixtures  the feeder→dependent half of `min_rest_minutes` iterates it,
 *                  and every `terminal`/`ext_key` selector resolves through it.
 *                  Without it those rules compile, display as enforced, and bind
 *                  nothing — the same failure shape as #443.
 *
 *  No `restByDivision`: that is the JOINT verifier's field, for the one pass per
 *  division `verifyJoint` runs. These paths verify one division against a fixed
 *  sibling board, which is a different question.
 *
 *  Returns `SlotConfig & VerifyConfig` so the auto pass can hand ONE object to
 *  both the placer and the verifier. A second builder for the second consumer is
 *  how the placer and the verifier drift apart. */
export function toVerifyConfig(
  settings: ScheduleSettingsOut,
  /** The division's own fixture rows — `divisionFixtures`, not just the movable
   *  ones. A selector may name a fixture this run cannot move, and a day cap
   *  counts every fixture on the day. */
  fixtures: readonly FixtureLite[],
  now: number,
): SlotConfig & VerifyConfig {
  return {
    ...toSlotConfig(settings, now),
    tz: settings.orgTz,
    ruleFixtures: fixtures.map(rowToRuleFixture),
  };
}

// ---------------------------------------------------------------------------
// Conflict taxonomy (doc 12 §2) — engine reasons → API codes. REASON_CODE is
// the single shared table in lib/schedule-board (isomorphic), so the AI diff
// panel maps blocking-row reasons through the exact same map client-side.
// ---------------------------------------------------------------------------

/**
 * `blocking` means PHYSICALLY IMPOSSIBLE, on every path (#399) — a court booked
 * twice, a human on two courts at once, a slot outside the competition's days, a
 * fixture before its feeder is done resting. It is the engine's one answer
 * (`isBlockingConflict`), so the board's red badges and the AI pipeline's
 * verdicts cannot drift apart the way they had.
 *
 * It deliberately does NOT mean "this write was refused". That is the DELTA, and
 * it lives in `assertNoNewBlocking` below. Folding the two together made a
 * report of an impossible board come back entirely in amber, because nothing in
 * a read-only report is ever newly introduced.
 */
function mapConflicts(conflicts: readonly Conflict[]): ScheduleConflict[] {
  return conflicts.map((c) => ({
    fixture_id: c.fixtureId,
    code: REASON_CODE[c.reason],
    // The rule the prompt teaches, carried through so the organiser's 409 and a
    // repair round cite the same token (#399).
    ...(c.rule !== undefined ? { rule: c.rule } : {}),
    ...(c.shortfallMinutes !== undefined ? { shortfall_minutes: c.shortfallMinutes } : {}),
    blocking: isBlockingConflict(c),
    ...(c.detail !== undefined ? { detail: c.detail } : {}),
  }));
}

/**
 * The competition's own dates as an engine window (#399).
 *
 * Deliberately NOT the AI pack's resolved window: that one WIDENS onto whatever
 * is already scheduled and onto the compiled instruction, so nothing already on
 * the board could ever fall outside it — a window that can never be broken
 * enforces nothing. It also defaults to seven days when no end date is set, and
 * caging a board inside an invented week is not something an apply gate may do.
 *
 * Each bound is independently optional: an organiser who set only a start date
 * gets a floor and no ceiling.
 */
export function applyWindow(
  settings: ScheduleSettingsOut,
): { from: number; to: number } | undefined {
  const { startAt, endAt } = settings.config;
  if (!startAt && !endAt) return undefined;
  // The ORG zone governs every temporal boundary (#397): a day is a wall-clock
  // day where the organisation lives, and a DST day is 23 or 25 hours long, so
  // the bounds are converted rather than arithmetic on 86_400_000.
  const tz = settings.orgTz;
  return {
    from: startAt ? zonedTimeToUtc(dayKeyInTz(ms(startAt), tz), "00:00", tz) : -Infinity,
    // EXCLUSIVE end-of-last-day, matching `windowBounds` in the AI path: a match
    // ending at exactly midnight sits entirely on days inside the window.
    to: endAt ? zonedTimeToUtc(ymdAddDays(dayKeyInTz(ms(endAt), tz), 1), "00:00", tz) : Infinity,
  };
}

/**
 * The write gate (#399). Refuses only what THIS change introduced or worsened,
 * measured by running the identical verifier pass over the board as it stands
 * and taking the difference on conflict identity.
 *
 * Delta rather than absolute, because boards published before this wave may
 * legitimately carry person overlaps — they were warnings all along. Under an
 * absolute rule the organiser's next edit to such a board would 409 and they
 * would be stuck, unable to fix the very thing that is wrong.
 */
function assertNoNewBlocking(before: readonly Conflict[], after: readonly Conflict[]): void {
  const refused = deltaConflicts(before, after).filter(isBlockingConflict);
  if (refused.length > 0) {
    throw new EngineError("SCHEDULE_CONFLICT", "schedule change hits a blocking conflict", {
      conflicts: mapConflicts(refused),
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

    // ONE config for both halves of this pass (#447). The placer reads the
    // `SlotConfig` side, the typed-rule referee below reads the `VerifyConfig`
    // side, and neither can drift onto a different idea of the rules.
    const config = toVerifyConfig(settings, all, roundToMinute(Date.now()));
    const board = [...obstacles, ...siblings];
    const result = slotFixtures({ fixtures: schedulable, config, existing: board });
    return {
      assignments: result.assignments.map((a) => ({
        fixture_id: a.fixtureId,
        scheduled_at: iso(a.startAt),
        ends_at: iso(a.endAt),
        court_label: a.court,
      })),
      // No baseline: the auto pass PROPOSES a board rather than editing one, so
      // every conflict in it is this proposal's own doing (#399).
      //
      // `slotFixtures` PLACES; it does not referee typed rules — it reports only
      // what it could not fit (`no_slot`, `start_window`, a pinned collision).
      // So a durable rule the placer has no term for would come back clean from
      // the one surface an organiser uses to build a board. The AI path answers
      // this the same way: place, then run the referee over the proposal
      // (`verifyConfig`). Only `validateInstructionRules` is run here, not the
      // whole verifier, so this proposal reports exactly the typed rules it was
      // missing and does not start emitting rest/overlap rows the auto pass has
      // never emitted.
      conflicts: mapConflicts([
        ...result.conflicts,
        ...validateInstructionRules(result.assignments, config, board),
      ]),
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
        // #446: the proposed card's own group identity, so a pool- or
        // division-targeted rule is applied to the placement being judged and
        // not only to the board it lands on. Same shape as `toAssignment`.
        ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
        divisionId: f.division_id,
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

    // #447: the VERIFY config, so the durable typed rules an organiser stored
    // are the rules this gate judges by. Warn-only — see `assertNoNewBlocking`.
    const slotConfig = toVerifyConfig(settings, all, 0);
    const deps = feedDependencies(all);
    const board = [...untouched, ...siblings];
    // The SAME fixtures where they sit right now (#399). Anything the verifier
    // already says about this board is history, not this apply's doing — an
    // organiser whose board carries a pre-existing person overlap must still be
    // able to edit it, which is the only way they can ever fix it.
    // A fixture with no slot yet contributes nothing, so every conflict its
    // placement causes reads as introduced. Correct: it is.
    const currentSlots = input.assignments
      .map((a) => byId.get(a.fixture_id) as FixtureLite)
      .filter((f) => f.scheduled_at !== null && f.court_label !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people));
    const baseline = validateAssignments(currentSlots, slotConfig, board, deps);
    const found = validateAssignments(proposed, slotConfig, board, deps);
    assertNoNewBlocking(baseline, found);
    const conflicts = mapConflicts(found);

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
 *  `runs.used` counts the same 'schedule.ai_generated' rows the ai-plan
 *  orchestrator writes (failures never appear there); `runs.max` is always
 *  null now — v17 Phase 2 Task 5 (V322) retired the plan-graded per-division
 *  cap it used to resolve, replaced by the AI credit wallet, which meters
 *  spend rather than a per-division count (see `spendCredit` in
 *  schedule-ai.ts). Read-gated at route. */
export async function lastAiApply(
  auth: AuthCtx,
  divisionId: string,
): Promise<{
  last: { at: string; instruction: string; summary: string } | null;
  runs: { used: number; max: number | null };
}> {
  const { rows, used } = await withTenant(auth.orgId, async (tx) => {
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
    return { rows, used: count?.n ?? 0 };
  });
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
    runs: { used, max: null },
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
// Exported for the #350 joint apply, which asserts it once per division inside
// ONE transaction: a stale token on any division must abort every division's
// write, and that only holds if both sides raise the identical SEQ_CONFLICT.
export async function assertFreshSeq(
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
        // #446 — this is the drag/keyboard move the issue describes: without
        // these two the dragged card resolves its rest to `perEntrantMinRest`
        // and its start bound to (-inf, +inf), so a pool rule the auto pass
        // honoured is silently absent at exactly the moment a human overrides it.
        ...(fixture.pool_id !== null ? { poolId: fixture.pool_id } : {}),
        divisionId: fixture.division_id,
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
      // #447: the dragged card is judged against the durable typed rules too.
      const slotConfig = toVerifyConfig(settings, all, 0);
      const deps = feedDependencies(all);
      const board = [...others, ...siblings];
      // Where this card sits right now (#399). An unscheduled fixture has no
      // baseline, so every blocking conflict its first placement causes is
      // introduced — which is exactly what it is.
      const currentSlot =
        fixture.scheduled_at !== null && fixture.court_label !== null
          ? [toAssignment(fixture, settings.config.matchMinutes, people)]
          : [];
      const baseline = validateAssignments(currentSlot, slotConfig, board, deps);
      const found = validateAssignments([proposed], slotConfig, board, deps);
      assertNoNewBlocking(baseline, found);
      conflicts = mapConflicts(found);
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
               -- venue lane (V305): division override → org timezone → UTC
               coalesce(ss.tz, org.timezone, 'UTC') as venue_tz
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
      where f.division_id = ${divisionId}
        and fo.response in ('accepted','pending')
        and f.scheduled_at is not null
        -- venue lane (V305): settings already carries the RESOLVED zone
        -- (division override → org timezone → UTC), and this whole query is
        -- scoped to one division, so bind it rather than re-joining.
        and oa.date = (f.scheduled_at at time zone ${settings.tz})::date`;

    // A REPORT of the board as it stands. `blocking` here says "impossible", not
    // "refused" (#399) — the board paints those cards red, and it must keep
    // doing so for a court double-booking that is already on the timetable.
    // Nothing is written on this path, so no delta applies.
    return {
      conflicts: [
        ...mapConflicts(
          // #447: `toVerifyConfig`, so the board's own report shows the durable
          // typed rules the organiser stored — this is the surface the
          // constraints panel promises them on.
          validateAssignments(assignments, toVerifyConfig(settings, all, 0), siblings, feedDependencies(all)),
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
