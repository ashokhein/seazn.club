import "server-only";
// v4 AI Schedule Architect — Phase A context pack (design/v4/01-llm-contract.md §2,
// design/v4/03 §2). buildSchedulePack assembles ONE deterministic, JSON-serialisable
// pack — settings, entrants, shared-person map, movable fixtures, obstacles, a greedy
// solver draft, and officials availability — that later tasks hand to the LLM. This
// module never calls the model; it only builds the pack and the draft.
//
// Determinism is binding (a golden snapshot asserts two builds are byte-identical):
// every array is sorted, fixtures order by (round_no, seq_in_round, ext_key), officials
// by (display_name, id), and every timestamp is an ISO-8601 string carrying the division
// timezone offset. DB reads reuse the schedule.ts / officials.ts loaders — no SQL is
// re-derived here.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  slotFixtures,
  validateAssignments,
  type Assignment,
  type Conflict,
  type OrderDependency,
  type SchedulableFixture,
  type SchedulingConstraints,
  type SlotConfig,
} from "@seazn/engine/scheduling";
import type { AuthCtx } from "@/server/api-v1/auth";
import { AiSchedulePlan, SYSTEM_PROMPT } from "./schedule-ai-prompt";
import {
  MOVABLE_STATUS,
  divisionFixtures,
  feedDependencies,
  loadSettings,
  peopleByEntrant,
  siblingAssignments,
  toAssignment,
  toSlotConfig,
  type FixtureLite,
} from "./schedule";
import {
  loadOfficialBlackouts,
  loadOfficialsWithEntrants,
  listOfficialBusyElsewhere,
} from "./officials";

const MS_PER_MIN = 60_000;

// ---------------------------------------------------------------------------
// Timezone-aware ISO (design/v4/01 §2: "ISO-8601 with a UTC offset, in the
// division timezone"). Same offset-probing trick as device-links.ts.
// ---------------------------------------------------------------------------

/** Offset (minutes east of UTC) of `tz` at `instant`. */
function tzOffsetMinutes(instant: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour) % 24, Number(p.minute), Number(p.second),
    );
    return Math.round((asUtc - instant.getTime()) / MS_PER_MIN);
  } catch {
    return 0;
  }
}

/** An instant formatted `YYYY-MM-DDTHH:mm:ss±HH:mm` in the division timezone. */
function zonedIso(value: string | number | Date, tz: string): string {
  const d = value instanceof Date ? value : new Date(value);
  const off = tzOffsetMinutes(d, tz);
  const local = new Date(d.getTime() + off * MS_PER_MIN);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Pack shape (design/v4/01 §2 + officials per design/v4/03 §2). JSON-serialisable.
// ---------------------------------------------------------------------------

export interface PackStartWindow {
  target: { kind: string; id: string };
  notBefore?: string;
  notAfter?: string;
}

export interface PackConstraints {
  restMin?: number;
  restByGroup?: Record<string, number>;
  noBackToBack: boolean;
  startWindows: PackStartWindow[];
  fieldFairness: string;
  parallelism: string;
  crossPersonClash: string;
}

export interface PackSettings {
  matchMinutes: number;
  gapMinutes: number;
  courts: string[];
  sessionWindows: { from: string; to: string }[];
  blackouts: { court?: string; from: string; to: string }[];
  constraints: PackConstraints | null;
}

export interface PackFixture {
  id: string;
  ext_key: string | null;
  round: number;
  seq: number;
  pool: string | null;
  home: string | null;
  away: string | null;
  feeds: { winner_to: string | null; after: string[] };
  current: { at: string | null; court: string | null };
  pinned: boolean;
}

export interface PackObstacle {
  court: string;
  from: string;
  to: string;
  label: string;
}

export interface PackEntrant {
  id: string;
  name: string;
  pool: string | null;
  seed: number | null;
}

export interface PackPerson {
  person_id: string;
  entrant_ids: string[];
}

export interface PackOfficial {
  id: string;
  name: string;
  role_keys: string[];
  max_per_day: number | null;
  blackout_dates: string[];
  busy_elsewhere: string[];
  entrant_ids: string[];
}

export interface PackAssignment {
  fixture_id: string;
  scheduled_at: string;
  court_label: string;
}

export interface SchedulePack {
  mode: "generate" | "refine" | "repair";
  division: { id: string; name: string; sport: string; tz: string; scheduling_mode: string };
  settings: PackSettings;
  entrants: PackEntrant[];
  people: PackPerson[];
  fixtures: { movable: PackFixture[]; obstacles: PackObstacle[] };
  draft: PackAssignment[];
  instruction: string;
  prior: { instruction: string; assignments: PackAssignment[] } | null;
  officials: PackOfficial[];
}

export interface BuildPackOptions {
  mode: "generate" | "refine" | "repair";
  instruction: string;
  scope?: { from?: string; courts?: string[]; pool_ids?: string[] };
  prior?: {
    instruction: string;
    assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
  };
}

/** Movable fixtures respect a repair `scope`: a fixture stays movable if it is
 *  unscheduled (needs a home) or matches every provided predicate. Anything
 *  out of scope keeps its court and becomes an obstacle. */
function inScope(f: FixtureLite, scope: BuildPackOptions["scope"]): boolean {
  if (!scope) return true;
  if (scope.courts && !(f.court_label === null || scope.courts.includes(f.court_label))) {
    return false;
  }
  if (scope.pool_ids && !(f.pool_id !== null && scope.pool_ids.includes(f.pool_id))) {
    return false;
  }
  if (scope.from) {
    const from = new Date(scope.from).getTime();
    if (!(f.scheduled_at === null || new Date(f.scheduled_at).getTime() >= from)) return false;
  }
  return true;
}

function byAssignment(a: PackAssignment, b: PackAssignment): number {
  return cmp(a.scheduled_at, b.scheduled_at) || cmp(a.court_label, b.court_label) || cmp(a.fixture_id, b.fixture_id);
}

/**
 * Build the deterministic Phase A context pack for a division.
 *
 * @returns the pack plus the set of fixture ids the LLM may place — later tasks
 *   reject any assignment id outside `movableIds`.
 * @throws HttpError 409 AI_PLAN_UNSUPPORTED (flexible division — no timetable),
 *   422 AI_PLAN_TOO_LARGE (>500 movable), 422 AI_PLAN_EMPTY_SCOPE (repair scope
 *   matched nothing), 400 (scope names a court that is not in settings.courts).
 */
export async function buildSchedulePack(
  auth: AuthCtx,
  divisionId: string,
  opts: BuildPackOptions,
): Promise<{ pack: SchedulePack; movableIds: Set<string> }> {
  // Cross-org "booked elsewhere" straddles tenants by design — it runs on the
  // superuser connection, so it is gathered outside the tenant transaction.
  const busyElsewhere = await listOfficialBusyElsewhere(auth);

  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<
      { id: string; name: string; sport_key: string; scheduling_mode: string; competition_id: string }[]
    >`
      select id, name, sport_key, scheduling_mode, competition_id
      from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    // Flexible divisions are ordered, never clock-slotted (Jul3/04 §4) — there
    // is no timetable for the architect to solve.
    if (division.scheduling_mode === "flexible") {
      throw new HttpError(409, "AI_PLAN_UNSUPPORTED", "AI_PLAN_UNSUPPORTED");
    }

    const settings = await loadSettings(tx, divisionId);
    const config = settings.config;
    const tz = settings.tz;
    const courts = [...config.courts];
    const matchMinutes = config.matchMinutes;

    // A scope may only reference courts the division actually has.
    if (opts.scope?.courts) {
      for (const c of opts.scope.courts) {
        if (!courts.includes(c)) throw new HttpError(400, `unknown scope court "${c}"`);
      }
    }

    const all = await divisionFixtures(tx, divisionId);
    const candidates = all.filter((f) => f.status === MOVABLE_STATUS);
    // Scope only narrows a repair round; generate/refine re-plan the whole set.
    const movable = opts.mode === "repair" ? candidates.filter((f) => inScope(f, opts.scope)) : candidates;

    if (opts.mode === "repair" && movable.length === 0) {
      throw new HttpError(422, "AI_PLAN_EMPTY_SCOPE", "AI_PLAN_EMPTY_SCOPE");
    }
    if (movable.length > 500) {
      throw new HttpError(422, "AI_PLAN_TOO_LARGE", "AI_PLAN_TOO_LARGE");
    }
    const movableSet = new Set(movable.map((f) => f.id));

    // People map (entrant → person ids) for the engine draft and the pack's
    // shared-player list.
    const fixtureEntrantIds = [...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]))]
      .filter((e): e is string => e !== null);
    const people = await peopleByEntrant(tx, fixtureEntrantIds);

    // Pool id → key ('A', 'B', …) across this division's stages.
    const poolRows = await tx<{ id: string; key: string }[]>`
      select p.id, p.key from pools p
      join stages s on s.id = p.stage_id
      where s.division_id = ${divisionId}`;
    const poolKey = new Map(poolRows.map((p) => [p.id, p.key]));

    // Obstacles: this division's fixed court time (decided fixtures + anything
    // scoped out of a repair) plus sibling divisions' timetables.
    const obstacleFixtures = all.filter(
      (f) => !movableSet.has(f.id) && f.scheduled_at !== null && f.court_label !== null,
    );
    const obstacleAssignments = obstacleFixtures.map((f) => toAssignment(f, matchMinutes, people));
    const siblings = await siblingAssignments(tx, divisionId, division.competition_id, matchMinutes);

    // Draft: generate → greedy slotFixtures; refine → the prior proposal
    // verbatim; repair → the movable set's current persisted slots.
    let draft: PackAssignment[];
    if (opts.mode === "generate") {
      const schedulable: SchedulableFixture[] = movable.map((f) => ({
        id: f.id,
        roundNo: f.round_no,
        ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
        divisionId: f.division_id,
        ...(f.home_entrant_id !== null ? { home: f.home_entrant_id } : {}),
        ...(f.away_entrant_id !== null ? { away: f.away_entrant_id } : {}),
        people: [
          ...(f.home_entrant_id ? people.get(f.home_entrant_id) ?? [] : []),
          ...(f.away_entrant_id ? people.get(f.away_entrant_id) ?? [] : []),
        ],
        // Pinned/scope-locked cards stay put — feed them to the solver as-is.
        ...(f.schedule_locked && f.scheduled_at !== null && f.court_label !== null
          ? { locked: { court: f.court_label, startAt: new Date(f.scheduled_at).getTime() } }
          : {}),
      }));
      const result = slotFixtures({
        fixtures: schedulable,
        config: toSlotConfig(settings, 0),
        existing: [...obstacleAssignments, ...siblings],
      });
      draft = result.assignments.map((a) => ({
        fixture_id: a.fixtureId,
        scheduled_at: zonedIso(a.startAt, tz),
        court_label: a.court,
      }));
    } else if (opts.mode === "refine") {
      draft = (opts.prior?.assignments ?? [])
        .filter((a) => movableSet.has(a.fixture_id))
        .map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: zonedIso(a.scheduled_at, tz),
          court_label: a.court_label,
        }));
    } else {
      draft = movable
        .filter((f) => f.scheduled_at !== null && f.court_label !== null)
        .map((f) => ({
          fixture_id: f.id,
          scheduled_at: zonedIso(f.scheduled_at as string | Date, tz),
          court_label: f.court_label as string,
        }));
    }
    draft.sort(byAssignment);

    // feeds.after: the fixtures that must finish before each one starts.
    const afterMap = new Map<string, string[]>();
    for (const d of feedDependencies(all)) {
      (afterMap.get(d.fixtureId) ?? afterMap.set(d.fixtureId, []).get(d.fixtureId)!).push(d.dependsOn);
    }

    const packMovable: PackFixture[] = movable
      .map((f) => ({
        id: f.id,
        ext_key: f.ext_key,
        round: f.round_no,
        seq: f.seq_in_round,
        pool: f.pool_id !== null ? poolKey.get(f.pool_id) ?? null : null,
        home: f.home_entrant_id,
        away: f.away_entrant_id,
        feeds: {
          winner_to: f.winner_to_fixture,
          after: [...(afterMap.get(f.id) ?? [])].sort(cmp),
        },
        current: {
          at: f.scheduled_at !== null ? zonedIso(f.scheduled_at, tz) : null,
          court: f.court_label,
        },
        pinned: f.schedule_locked,
      }))
      .sort(
        (a, b) =>
          a.round - b.round ||
          a.seq - b.seq ||
          cmp(a.ext_key ?? "", b.ext_key ?? "") ||
          cmp(a.id, b.id),
      );

    const packObstacles: PackObstacle[] = [
      ...obstacleFixtures.map((f) => {
        const start = new Date(f.scheduled_at as string | Date).getTime();
        return {
          court: f.court_label as string,
          from: zonedIso(start, tz),
          to: zonedIso(start + matchMinutes * MS_PER_MIN, tz),
          label: `${division.name} · R${f.round_no}`,
        };
      }),
      // Siblings carry no display metadata through siblingAssignments — soft
      // context, so a generic label is enough (never leaks a rival's roster).
      ...siblings.map((a) => ({
        court: a.court,
        from: zonedIso(a.startAt, tz),
        to: zonedIso(a.endAt, tz),
        label: "Other division",
      })),
    ].sort(
      (a, b) => cmp(a.court, b.court) || cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.label, b.label),
    );

    // Entrants + each one's pool, derived from the division's fixtures.
    const entrantPool = new Map<string, string>();
    for (const f of all) {
      if (f.pool_id === null) continue;
      const key = poolKey.get(f.pool_id);
      if (key === undefined) continue;
      for (const e of [f.home_entrant_id, f.away_entrant_id]) {
        if (e !== null && !entrantPool.has(e)) entrantPool.set(e, key);
      }
    }
    const entrantRows = await tx<{ id: string; display_name: string; seed: number | null }[]>`
      select id, display_name, seed from entrants
      where division_id = ${divisionId} and status not in ('withdrawn', 'disqualified')`;
    const packEntrants: PackEntrant[] = entrantRows
      .map((e) => ({ id: e.id, name: e.display_name, pool: entrantPool.get(e.id) ?? null, seed: e.seed }))
      .sort(
        (a, b) =>
          (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER) ||
          cmp(a.name, b.name) ||
          cmp(a.id, b.id),
      );

    // Shared-player map: persons rostered into two or more of this division's
    // entrants — the only ones that create a cross-entrant clash.
    const divEntrantIds = entrantRows.map((e) => e.id);
    const personEntrants = new Map<string, Set<string>>();
    if (divEntrantIds.length > 0) {
      const memberRows = await tx<{ person_id: string; entrant_id: string }[]>`
        select person_id, entrant_id from entrant_members where entrant_id in ${tx(divEntrantIds)}`;
      for (const r of memberRows) {
        (personEntrants.get(r.person_id) ?? personEntrants.set(r.person_id, new Set()).get(r.person_id)!).add(
          r.entrant_id,
        );
      }
    }
    const packPeople: PackPerson[] = [...personEntrants.entries()]
      .filter(([, ents]) => ents.size >= 2)
      .map(([person_id, ents]) => ({ person_id, entrant_ids: [...ents].sort(cmp) }))
      .sort((a, b) => cmp(a.person_id, b.person_id));

    // Officials availability (soft context): roster + role_keys + max_per_day
    // + blackout dates + cross-org busy windows + linked entrant ids.
    const officialRows = await loadOfficialsWithEntrants(tx);
    const blackoutByOfficial = new Map<string, string[]>();
    for (const r of await loadOfficialBlackouts(tx)) {
      (blackoutByOfficial.get(r.official_id) ?? blackoutByOfficial.set(r.official_id, []).get(r.official_id)!).push(
        r.date,
      );
    }
    const busyByOfficial = new Map<string, string[]>();
    for (const r of busyElsewhere) {
      (busyByOfficial.get(r.official_id) ?? busyByOfficial.set(r.official_id, []).get(r.official_id)!).push(
        zonedIso(r.scheduled_at, tz),
      );
    }
    const packOfficials: PackOfficial[] = officialRows
      .map((o) => ({
        id: o.id,
        name: o.display_name,
        role_keys: [...o.role_keys],
        max_per_day: o.max_per_day,
        blackout_dates: [...(blackoutByOfficial.get(o.id) ?? [])].sort(cmp),
        busy_elsewhere: [...(busyByOfficial.get(o.id) ?? [])].sort(cmp),
        entrant_ids: [...new Set(o.entrant_ids)].sort(cmp),
      }))
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));

    const settingsOut: PackSettings = {
      matchMinutes,
      gapMinutes: config.gapMinutes,
      // v15 venues: when venue_courts lands, this builder is the single
      // place court_label strings become venue-scoped (design/v15-venue).
      courts,
      sessionWindows: config.sessionWindows
        .map((w) => ({ from: zonedIso(w.from, tz), to: zonedIso(w.to, tz) }))
        .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)),
      blackouts: config.blackouts
        .map((b) => ({
          ...(b.court !== undefined ? { court: b.court } : {}),
          from: zonedIso(b.from, tz),
          to: zonedIso(b.to, tz),
        }))
        .sort((a, b) => cmp(a.court ?? "", b.court ?? "") || cmp(a.from, b.from) || cmp(a.to, b.to)),
      constraints: config.constraints
        ? {
            ...(config.constraints.restMin !== undefined ? { restMin: config.constraints.restMin } : {}),
            ...(config.constraints.restByGroup !== undefined
              ? { restByGroup: config.constraints.restByGroup }
              : {}),
            noBackToBack: config.constraints.noBackToBack,
            startWindows: config.constraints.startWindows.map((w) => ({
              target: w.target,
              ...(w.notBefore !== undefined ? { notBefore: zonedIso(w.notBefore, tz) } : {}),
              ...(w.notAfter !== undefined ? { notAfter: zonedIso(w.notAfter, tz) } : {}),
            })),
            fieldFairness: config.constraints.fieldFairness,
            parallelism: config.constraints.parallelism,
            crossPersonClash: config.constraints.crossPersonClash,
          }
        : null,
    };

    const pack: SchedulePack = {
      mode: opts.mode,
      division: {
        id: division.id,
        name: division.name,
        sport: division.sport_key,
        tz,
        scheduling_mode: division.scheduling_mode,
      },
      settings: settingsOut,
      entrants: packEntrants,
      people: packPeople,
      fixtures: { movable: packMovable, obstacles: packObstacles },
      draft,
      instruction: opts.instruction,
      prior: opts.prior
        ? {
            instruction: opts.prior.instruction,
            assignments: opts.prior.assignments
              .map((a) => ({
                fixture_id: a.fixture_id,
                scheduled_at: zonedIso(a.scheduled_at, tz),
                court_label: a.court_label,
              }))
              .sort(byAssignment),
          }
        : null,
      officials: packOfficials,
    };

    return { pack, movableIds: movableSet };
  });
}

// ===========================================================================
// Phase A runner — the Anthropic structured-output call + engine verify/repair
// loop (design/v4/00 §3-4, 01 §1,§5). Pure over the pack: no DB, no wall clock.
// ===========================================================================

const ROUND_TIMEOUT_MS = 120_000;
const MAX_REPAIR_ROUNDS = 2;

/**
 * Single Anthropic client factory. Rejects early when the server is not
 * configured (503) and honours the SCHEDULING_AI_BASE_URL escape hatch (Task
 * 17's e2e fixture server points at it). Other AI tasks (officials) reuse this.
 */
export function anthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new HttpError(503, "AI scheduling is not configured on this server");
  }
  const baseURL = process.env.SCHEDULING_AI_BASE_URL;
  return new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

export interface AiPlanResult {
  proposal: { fixture_id: string; scheduled_at: string; court_label: string; schedule_locked?: boolean }[];
  unschedulable: { fixture_id: string; reason: string }[];
  warnings: Conflict[]; // non-blocking verifier conflicts
  blocking: Conflict[]; // residual after ≤2 repairs
  diff: { moved: string[]; placed: string[]; unscheduled: string[]; unchanged: string[] };
  explanations: { fixture_id: string; note: string }[];
  constraint_suggestions?: Partial<SchedulingConstraints>;
  summary: string;
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number };
}

// A verifier conflict blocks when it makes the schedule physically impossible —
// a court double-booking, or a direct feed scheduled before its source ends.
// Same taxonomy as the drag-drop board (schedule.ts mapConflicts). Rest,
// blackout, session-window, person-overlap and indirect order land in warnings.
function isBlocking(c: Conflict): boolean {
  return c.reason === "court" || (c.reason === "order" && c.direct === true);
}

const toMs = (iso: string): number => new Date(iso).getTime();

/** Structural gate run before the engine verifier (01 §1 hard rule 1/7): every
 *  movable id appears exactly once, no foreign ids, no unknown courts, no pinned
 *  fixture nudged off its current slot. Returns a human note on the first
 *  violation, or null when the plan is well-formed. */
function structuralCheck(plan: AiSchedulePlan, movableIds: Set<string>, pack: SchedulePack): string | null {
  const courts = new Set(pack.settings.courts);
  const pinned = new Map(pack.fixtures.movable.filter((f) => f.pinned).map((f) => [f.id, f]));
  const seen = new Set<string>();
  for (const a of plan.assignments) {
    if (!movableIds.has(a.fixture_id)) return `assignment references non-movable fixture ${a.fixture_id}`;
    if (seen.has(a.fixture_id)) return `fixture ${a.fixture_id} appears more than once`;
    seen.add(a.fixture_id);
    if (!courts.has(a.court_label)) return `assignment uses a court not in settings.courts: ${a.court_label}`;
    const pin = pinned.get(a.fixture_id);
    if (pin && (pin.current.at === null || toMs(pin.current.at) !== toMs(a.scheduled_at) || pin.current.court !== a.court_label)) {
      return `pinned fixture ${a.fixture_id} must not move`;
    }
  }
  for (const u of plan.unschedulable) {
    if (!movableIds.has(u.fixture_id)) return `unschedulable references non-movable fixture ${u.fixture_id}`;
    if (seen.has(u.fixture_id)) return `fixture ${u.fixture_id} appears more than once`;
    seen.add(u.fixture_id);
  }
  for (const id of movableIds) {
    if (!seen.has(id)) return `movable fixture ${id} is missing from the plan`;
  }
  return null;
}

/** Map the LLM proposal onto engine assignments (ISO → epoch ms). Entrants and
 *  shared people come from the pack so the verifier can catch overlaps. */
function toEngineAssignments(plan: AiSchedulePlan, pack: SchedulePack): Assignment[] {
  const fixtureById = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
  const personsByEntrant = new Map<string, string[]>();
  for (const p of pack.people) {
    for (const e of p.entrant_ids) {
      (personsByEntrant.get(e) ?? personsByEntrant.set(e, []).get(e)!).push(p.person_id);
    }
  }
  const durMs = pack.settings.matchMinutes * MS_PER_MIN;
  return plan.assignments.map((a) => {
    const f = fixtureById.get(a.fixture_id);
    const entrants = f ? [f.home, f.away].filter((e): e is string => e !== null) : [];
    const startAt = toMs(a.scheduled_at);
    return {
      fixtureId: a.fixture_id,
      court: a.court_label,
      startAt,
      endAt: startAt + durMs,
      entrants,
      people: entrants.flatMap((e) => personsByEntrant.get(e) ?? []),
    };
  });
}

/** Fixed court occupancy the proposal must dodge (other stages + siblings). */
function toObstacleAssignments(pack: SchedulePack): Assignment[] {
  return pack.fixtures.obstacles.map((o, i) => ({
    fixtureId: `obstacle:${i}`,
    court: o.court,
    startAt: toMs(o.from),
    endAt: toMs(o.to),
    entrants: [],
    people: [],
  }));
}

function verifyConfig(pack: SchedulePack): Pick<SlotConfig, "perEntrantMinRest" | "gapMinutes" | "blackouts" | "sessionWindows"> {
  return {
    perEntrantMinRest: pack.settings.constraints?.restMin ?? 0,
    gapMinutes: pack.settings.gapMinutes,
    blackouts: pack.settings.blackouts.map((b) => ({
      ...(b.court !== undefined ? { court: b.court } : {}),
      from: toMs(b.from),
      to: toMs(b.to),
    })),
    sessionWindows: pack.settings.sessionWindows.map((w) => ({ from: toMs(w.from), to: toMs(w.to) })),
  };
}

/** feeds.after are direct winner/loser feeds (schedule.ts feedDependencies);
 *  an order violation on one blocks. Deps whose source isn't placed are ignored
 *  by validateAssignments. */
function packFeedDependencies(pack: SchedulePack): OrderDependency[] {
  const deps: OrderDependency[] = [];
  for (const f of pack.fixtures.movable) {
    for (const dependsOn of f.feeds.after) {
      deps.push({ fixtureId: f.id, dependsOn, direct: true });
    }
  }
  return deps;
}

/** proposal vs each movable fixture's current slot (design §3 diff groups). */
function computeDiff(plan: AiSchedulePlan, pack: SchedulePack): AiPlanResult["diff"] {
  const proposalById = new Map(plan.assignments.map((a) => [a.fixture_id, a]));
  const unsched = new Set(plan.unschedulable.map((u) => u.fixture_id));
  const diff: AiPlanResult["diff"] = { moved: [], placed: [], unscheduled: [], unchanged: [] };
  for (const f of pack.fixtures.movable) {
    const a = proposalById.get(f.id);
    if (a) {
      const hadSlot = f.current.at !== null && f.current.court !== null;
      if (!hadSlot) diff.placed.push(f.id);
      else if (toMs(f.current.at!) === toMs(a.scheduled_at) && f.current.court === a.court_label) diff.unchanged.push(f.id);
      else diff.moved.push(f.id);
    } else if (unsched.has(f.id)) {
      diff.unscheduled.push(f.id);
    }
  }
  return diff;
}

/** Echo an assistant turn back into the conversation unchanged (01 §5 — thinking
 *  blocks included). Response ContentBlocks are valid input blocks at runtime. */
function assistantTurn(response: { content?: unknown } | null | undefined): Anthropic.MessageParam {
  return { role: "assistant", content: (response?.content ?? []) as Anthropic.ContentBlockParam[] };
}

async function callModel(
  client: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[],
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUND_TIMEOUT_MS);
  try {
    return await client.messages.parse(
      {
        model,
        max_tokens: 32_000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high", format: zodOutputFormat(AiSchedulePlan) },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [...messages],
      },
      { signal: controller.signal },
    );
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HttpError(422, "AI scheduling timed out; please retry", "AI_PLAN_TIMEOUT");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the schedule architect over a pre-built pack: call the model, verify the
 * proposal with the engine, and repair blocking conflicts up to twice before
 * returning best-so-far. Takes the pack + movable id set as data — never touches
 * the DB.
 *
 * @throws HttpError 503 (no ANTHROPIC_API_KEY), 422 AI_PLAN_FAILED (model
 *   refusal, or an un-correctable structural violation), 422 AI_PLAN_TIMEOUT.
 */
export async function runAiPlan(pack: SchedulePack, movableIds: Set<string>): Promise<AiPlanResult> {
  const client = anthropicClient(); // 503 before any network if unconfigured
  const model = process.env.SCHEDULING_AI_MODEL ?? "claude-opus-4-8";

  const conversation: Anthropic.MessageParam[] = [{ role: "user", content: JSON.stringify(pack) }];
  const config = verifyConfig(pack);
  const obstacles = toObstacleAssignments(pack);
  const dependencies = packFeedDependencies(pack);

  let inputTokens = 0;
  let outputTokens = 0;
  let repairRounds = 0;
  let correctiveUsed = false; // one non-repair retry for a malformed plan (01 §1)

  for (;;) {
    const response = await callModel(client, model, conversation);
    inputTokens += response?.usage?.input_tokens ?? 0;
    outputTokens += response?.usage?.output_tokens ?? 0;

    // Refusal: bail before reading content (01 §1).
    if (response?.stop_reason === "refusal") {
      throw new HttpError(422, "AI_PLAN_FAILED", "AI_PLAN_FAILED");
    }

    const plan = response?.parsed_output ?? null;
    const structuralError =
      plan === null ? "the model returned no parseable plan" : structuralCheck(plan, movableIds, pack);
    if (structuralError !== null) {
      if (correctiveUsed) throw new HttpError(422, "AI_PLAN_FAILED", "AI_PLAN_FAILED");
      correctiveUsed = true;
      conversation.push(assistantTurn(response));
      conversation.push({
        role: "user",
        content: JSON.stringify({
          structural_error: structuralError,
          note: "Your previous output was rejected before verification. Resend the full plan: every movable fixture exactly once (in assignments or unschedulable), only movable ids, court_label drawn from settings.courts, and never move a pinned fixture.",
        }),
      });
      continue;
    }

    // Verify against the engine (obstacles are fixed occupancy).
    const conflicts = validateAssignments(toEngineAssignments(plan!, pack), config, obstacles, dependencies);
    const blocking = conflicts.filter(isBlocking);
    const warnings = conflicts.filter((c) => !isBlocking(c));

    if (blocking.length === 0 || repairRounds >= MAX_REPAIR_ROUNDS) {
      return {
        proposal: plan!.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_label: a.court_label,
          ...(a.schedule_locked !== undefined ? { schedule_locked: a.schedule_locked } : {}),
        })),
        unschedulable: plan!.unschedulable,
        warnings,
        blocking,
        diff: computeDiff(plan!, pack),
        explanations: plan!.explanations,
        ...(plan!.constraint_suggestions !== undefined ? { constraint_suggestions: plan!.constraint_suggestions } : {}),
        summary: plan!.summary,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens, repair_rounds: repairRounds },
      };
    }

    // Blocking conflicts remain and rounds are left — send the report back and
    // ask for minimal fixes (01 §5).
    repairRounds++;
    conversation.push(assistantTurn(response));
    conversation.push({
      role: "user",
      content: JSON.stringify({
        verifier_conflicts: conflicts,
        note: "Fix only these conflicts. Move as few fixtures as possible. Do not reintroduce earlier conflicts.",
      }),
    });
  }
}
