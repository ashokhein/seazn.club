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
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { slotFixtures, type SchedulableFixture } from "@seazn/engine/scheduling";
import type { AuthCtx } from "@/server/api-v1/auth";
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
