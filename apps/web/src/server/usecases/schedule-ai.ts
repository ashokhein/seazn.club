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
import { resolveProvider, selectProvider, type ProviderName } from "@/server/ai/select-provider";
import {
  AiProviderError,
  type AiChatResponse,
  type AiProvider,
  type AiReasoning,
  type AiTurn,
} from "@/server/ai/provider";
import { withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { requireFeature, withinLimit } from "@/lib/entitlements";
import { rateLimit } from "@/lib/rate-limit";
import { captureServer, isServerFeatureEnabled } from "@/lib/posthog-server";
import { aiRunCostUsd } from "@/lib/ai-pricing";
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
import {
  assignOfficials,
  type AssignPolicy,
  type OfficialFixture,
  type OfficialSpec,
} from "@seazn/engine/officials";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AiPlanRequest, AiPlanResponse } from "@/server/api-v1/schemas";
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

/** An instant formatted `YYYY-MM-DDTHH:mm:ss±HH:mm` in the division timezone.
 *  Exported so the Phase B officials pack (officials-ai.ts) formats times the
 *  same way — one zoned-ISO helper, not two. */
export function zonedIso(value: string | number | Date, tz: string): string {
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
  /** The Settings-tab rest. Absent from the pack until now, which is how the
   *  referee came to enforce only `constraints.restMin` — a division whose rest
   *  was set in Settings had it silently ignored by AI Schedule while
   *  Auto-schedule honoured it. Both the model and the referee need it. */
  perEntrantMinRest: number;
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
  division: { id: string; name: string; sport: string; tz: string };
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
      { id: string; name: string; sport_key: string; competition_id: string }[]
    >`
      select id, name, sport_key, competition_id
      from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
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
      // Determinism (defect fix): the greedy solver breaks intra-round ties on
      // SchedulableFixture.id — which is a per-seed random fixture UUID — so an
      // identical logical board produced a different draft (and golden pack) on
      // every reseed. Order the movable set on STABLE domain keys (round_no,
      // seq_in_round, ext_key, then entrant NAMES — never the UUID) and hand the
      // solver a domain-ranked id in place of the UUID, mapping its result back
      // to real fixture ids afterwards. The engine stays untouched.
      const movableEntrantIds = [
        ...new Set(movable.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
      ].filter((e): e is string => e !== null);
      const nameByEntrant = new Map<string, string>();
      if (movableEntrantIds.length > 0) {
        const nameRows = await tx<{ id: string; display_name: string }[]>`
          select id, display_name from entrants where id in ${tx(movableEntrantIds)}`;
        for (const r of nameRows) nameByEntrant.set(r.id, r.display_name);
      }
      const nameOf = (e: string | null): string => (e !== null ? nameByEntrant.get(e) ?? "" : "");
      // INVARIANT: this comparator must remain a total order on
      // (round_no, seq_in_round, ext_key, home name, away name) with NO UUID
      // fallback — reintroducing id-based tie-breaks re-breaks cross-reseed
      // determinism (see the double-seed test).
      const orderedMovable = [...movable].sort(
        (a, b) =>
          a.round_no - b.round_no ||
          a.seq_in_round - b.seq_in_round ||
          cmp(a.ext_key ?? "", b.ext_key ?? "") ||
          cmp(nameOf(a.home_entrant_id), nameOf(b.home_entrant_id)) ||
          cmp(nameOf(a.away_entrant_id), nameOf(b.away_entrant_id)),
      );
      const rankById = new Map(orderedMovable.map((f, i) => [f.id, String(i).padStart(6, "0")]));
      const realIdByRank = new Map(orderedMovable.map((f, i) => [String(i).padStart(6, "0"), f.id]));

      const schedulable: SchedulableFixture[] = movable.map((f) => ({
        // Domain-ranked stand-in for the UUID so the solver's tie-break is stable.
        id: rankById.get(f.id)!,
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
        fixture_id: realIdByRank.get(a.fixtureId) ?? a.fixtureId,
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

    // Entrant-id arrays nested inside people/officials must order on a STABLE
    // domain key — the entrant NAME, never the per-seed UUID — so the pack is
    // byte-identical across reseeds of the same logical board. (Officials may
    // link entrants outside this division; those names are backfilled below.)
    const entrantNameById = new Map(entrantRows.map((e) => [e.id, e.display_name]));
    const byEntrantName = (a: string, b: string): number =>
      cmp(entrantNameById.get(a) ?? "", entrantNameById.get(b) ?? "") || cmp(a, b);
    const entrantNameKey = (ids: readonly string[]): string =>
      ids.map((e) => entrantNameById.get(e) ?? e).join("|");

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
      .map(([person_id, ents]) => ({ person_id, entrant_ids: [...ents].sort(byEntrantName) }))
      // Order people by their (name-sorted) entrant set, not the random
      // person UUID; person_id is only a last-resort tie-break.
      .sort(
        (a, b) => cmp(entrantNameKey(a.entrant_ids), entrantNameKey(b.entrant_ids)) || cmp(a.person_id, b.person_id),
      );

    // Officials availability (soft context): roster + role_keys + max_per_day
    // + blackout dates + cross-org busy windows + linked entrant ids.
    const officialRows = await loadOfficialsWithEntrants(tx);
    // Backfill names for any official-linked entrants outside this division so
    // their entrant_ids still order by name rather than UUID.
    const unknownEntrantIds = [...new Set(officialRows.flatMap((o) => o.entrant_ids))].filter(
      (e) => !entrantNameById.has(e),
    );
    if (unknownEntrantIds.length > 0) {
      const extraNames = await tx<{ id: string; display_name: string }[]>`
        select id, display_name from entrants where id in ${tx(unknownEntrantIds)}`;
      for (const r of extraNames) entrantNameById.set(r.id, r.display_name);
    }
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
        entrant_ids: [...new Set(o.entrant_ids)].sort(byEntrantName),
      }))
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));

    const settingsOut: PackSettings = {
      matchMinutes,
      gapMinutes: config.gapMinutes,
      perEntrantMinRest: config.perEntrantMinRest,
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

// 300s: live runs with adaptive thinking + effort:high regularly exceed 120s
// per round even at ~17 movable fixtures (measured 2026-07-19: opus round 1
// >120s, sonnet ~4 rounds ≈ 480s). The abort must outlast a real round or
// every sizable live run dies as AI_PLAN_TIMEOUT.
// 600s. Measured 2026-07-20 on a 30-fixture pack with dense constraints
// (round-robin + 60m rest + no-back-to-back + a court blackout): effort:high
// needed 1095s and never returned inside the old 300s, so the run 422'd having
// spent a full generation it could neither bill nor show; effort:medium took
// 213s and 194s across two runs — under 300s, but with <30% headroom against
// observed ~2x run-to-run variance in adaptive thinking, so a slow sample of a
// passing config would still 422.
//
// Raising this does NOT make the model generate more: the abort is client-side
// and only decides whether we receive the round. It does make repair rounds 2-3
// reachable, and each round re-sends the prior round's output as input — so the
// worst case gets more expensive even though the per-round cost is unchanged.
const ROUND_TIMEOUT_MS = Number(process.env.SCHEDULING_AI_ROUND_TIMEOUT_MS) || 600_000;
const MAX_REPAIR_ROUNDS = 2;

/** Output token ceiling per round. Configurable per environment (same
 *  philosophy as AI_PROVIDER) so a candidate that spends its whole budget on
 *  reasoning can be given more room without a code change. Default of
 *  32_000 is unchanged from the hardcoded value, so the shipped Anthropic
 *  path behaves identically unless this is explicitly overridden. */
const MAX_TOKENS = Number(process.env.SCHEDULING_AI_MAX_TOKENS) || 32_000;

/** The model every architect run uses (both phases import this — single
 *  source). Default measured live 2026-07-19 (17-fixture pack, adaptive
 *  thinking, effort:high): opus-4-8 could not finish round 1 inside 300s;
 *  sonnet-5 returned an engine-verified CLEAN plan in one 249s round at
 *  $0.42. The deterministic referee checks every proposal regardless of
 *  model, so the faster model is the safe default; SCHEDULING_AI_MODEL
 *  still overrides. */
export function schedulingAiModel(): string {
  return process.env.SCHEDULING_AI_MODEL ?? "claude-sonnet-5";
}

/** Effort hint for the architect call.
 *
 *  Stays "high". A live A/B (2026-07-20, sonnet-5, two packs, n=3 per cell)
 *  was run specifically to justify lowering it, and concluded against:
 *
 *    pack             effort   secs mean            out mean   warnings
 *    teams-15 (30)    high     276.8 [268.5-282.9]   29,858       0
 *    teams-15 (30)    medium   616.1 [291.4-808.3]   20,411       0
 *    individuals-50   high      97.6 [ 73.4-142.7]   11,510       0
 *    individuals-50   medium    80.0 [ 55.8- 98.0]    9,460       0
 *
 *  Quality is identical — all 12 runs returned an engine-verified plan with
 *  zero blocking, zero warnings, zero repair rounds. So the only live axes are
 *  latency and money, and on the dense pack medium is 2.2x SLOWER to save
 *  $0.135. Against a lifetime quota of 20-50 runs per division that is a few
 *  dollars, traded for ~5.6 extra minutes of an organiser watching a spinner.
 *
 *  An n=1 pass had briefly suggested the opposite (medium "5.1x faster") — that
 *  was a 1095s outlier on the high side; with n=3 high never exceeded 283s on
 *  that pack. Recorded here because the wrong conclusion shipped for a day.
 *
 *  Effort escalation is NOT viable for the same reason: medium never produced a
 *  degraded plan, so the referee has nothing to escalate on. Cheap-MODEL
 *  escalation is a different matter — see runLadder / runAiPlanLadder.
 *
 *  Phase B (officials-ai.ts) is deliberately still "high": it was not measured.
 *  Full write-up: design/v4/04-architect-benchmarks.md. */
export function schedulingAiEffort(): AiEffort {
  return parseAiEffort(process.env.SCHEDULING_AI_EFFORT, "high");
}

export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max";

const AI_EFFORTS: readonly AiEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Shared by both architect phases, which carry DIFFERENT defaults on purpose:
 *  Phase A is benched, Phase B is not. An unset or unrecognised value falls back
 *  rather than throwing — a typo'd env var must not take AI scheduling down. */
export function parseAiEffort(raw: string | undefined, fallback: AiEffort): AiEffort {
  return (AI_EFFORTS as readonly string[]).includes(raw ?? "") ? (raw as AiEffort) : fallback;
}

/** Thinking mode for the architect call.
 *
 *  Measured 2026-07-20: the structured plan is only ~2,588 tokens of a 27,349
 *  token response — 90.5% of what a run costs is thinking, not output. So this
 *  is the largest single cost lever available, an order of magnitude bigger
 *  than any schema change (short ids save 2.1%, diff-from-draft 7.5%).
 *
 *  Default stays "adaptive". Turning it off is only defensible because the
 *  deterministic referee verifies every proposal and the repair loop re-prompts
 *  on blocking conflicts — a thin plan gets caught, never shipped. Whether that
 *  actually wins is an open question: fewer thinking tokens per round, but
 *  possibly more rounds, and each round re-sends the prior output as input.
 *  SCHEDULING_AI_THINKING=disabled exists so the bench can settle it. */
export type AiThinking = "adaptive" | "disabled";

export function schedulingAiThinking(): AiThinking {
  return process.env.SCHEDULING_AI_THINKING === "disabled" ? "disabled" : "adaptive";
}

/** Models that predate adaptive thinking and the effort parameter. Verified
 *  live against the API on 2026-07-20 — claude-haiku-4-5 rejects BOTH:
 *    thinking:{type:"adaptive"}  → 400 "adaptive thinking is not supported on this model"
 *    output_config.effort        → 400 "This model does not support the effort parameter."
 *  It does accept legacy `thinking:{type:"enabled",budget_tokens}` and returns
 *  structured output through zodOutputFormat exactly like the newer models, so
 *  it is usable here — just not with the request shape the newer models want. */
const LEGACY_REASONING_MODELS = new Set(["claude-haiku-4-5", "claude-sonnet-4-5"]);

/** Thinking budget for legacy-reasoning models. Must stay below max_tokens.
 *  Unlike effort's five positions this is a token-precise ceiling, which is the
 *  shape this workload wants: the 2026-07-20 repeats showed effort:medium's
 *  problem was spread (1.63x), not its average. */
export function schedulingAiThinkingBudget(): number {
  const n = Number(process.env.SCHEDULING_AI_THINKING_BUDGET);
  return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : 0;
}

/** The reasoning half of the request, shaped for what `model` actually accepts.
 *  Anthropic-shaped: schedule-ai-run.test.ts asserts these fields directly.
 *
 *  Derived from `aiReasoning` below (the provider-neutral function `callModel`
 *  actually uses) rather than duplicating the per-model branching, so there is
 *  one source of truth for reasoning policy — a bug in `aiReasoning` fails
 *  this function's tests too instead of shipping silently. */
export function aiReasoningParams(model: string): {
  thinking?: { type: "adaptive" } | { type: "disabled" } | { type: "enabled"; budget_tokens: number };
  effort?: AiEffort;
} {
  const r = aiReasoning(model);
  if (r.kind === "none") return {};
  if (r.kind === "budget") return { thinking: { type: "enabled", budget_tokens: r.tokens } };
  return { thinking: { type: r.thinking }, effort: r.effort };
}

/** Provider-neutral reasoning request, shaped for what `model` actually
 *  accepts. Same legacy-model list and budget as `aiReasoningParams` — this is
 *  what `callModel` sends through the provider seam.
 *
 *  `effort` rides along even when thinking is disabled — the code this
 *  replaces (the old inline callModel) sent it unconditionally. Mapping
 *  "disabled" thinking to `kind: "none"` would silently drop
 *  SCHEDULING_AI_EFFORT on that path. */
export function aiReasoning(model: string): AiReasoning {
  if (LEGACY_REASONING_MODELS.has(model)) {
    const budget = schedulingAiThinkingBudget();
    return budget > 0 ? { kind: "budget", tokens: budget } : { kind: "none" };
  }
  return {
    kind: "effort",
    effort: schedulingAiEffort(),
    thinking: schedulingAiThinking() === "disabled" ? "disabled" : "adaptive",
  };
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
  // cost_usd is the provider-reported cost when available, falling back to a
  // derived estimate per round; null only when neither is computable.
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number; cost_usd: number | null };
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
  const placed = new Set<string>();
  for (const a of plan.assignments) {
    if (!movableIds.has(a.fixture_id)) return `assignment references non-movable fixture ${a.fixture_id}`;
    if (seen.has(a.fixture_id)) return `fixture ${a.fixture_id} appears more than once`;
    seen.add(a.fixture_id);
    placed.add(a.fixture_id);
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
    // A pinned (schedule-locked) fixture may never be dropped: marking it
    // unschedulable silently loses a locked slot, so reject before verification.
    if (pinned.has(u.fixture_id)) return `pinned fixture ${u.fixture_id} cannot be marked unschedulable`;
  }
  for (const id of movableIds) {
    if (!seen.has(id)) return `movable fixture ${id} is missing from the plan`;
  }
  // Every pinned movable fixture must land in assignments (at its exact current
  // slot, enforced in the assignments loop) — never absent, never diverted.
  for (const [id] of pinned) {
    if (movableIds.has(id) && !placed.has(id)) return `pinned fixture ${id} must stay at its current slot`;
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

function verifyConfig(
  pack: SchedulePack,
): Pick<SlotConfig, "perEntrantMinRest" | "gapMinutes" | "blackouts" | "sessionWindows"> &
  Partial<Pick<SlotConfig, "matchMinutes" | "constraints">> {
  return {
    // Both rest sources, plus the match length noBackToBack needs: the engine's
    // effectiveRestMinutes takes the strictest, exactly as the solver does.
    perEntrantMinRest: pack.settings.perEntrantMinRest,
    matchMinutes: pack.settings.matchMinutes,
    // Only the rest-bearing fields: the pack's startWindows carry ISO strings
    // (the model reads them), while the engine wants epoch ms. Window
    // validation is a separate piece of work — carrying them across here would
    // silently compare the wrong units.
    ...(pack.settings.constraints !== null
      ? {
          constraints: {
            ...(pack.settings.constraints.restMin !== undefined
              ? { restMin: pack.settings.constraints.restMin }
              : {}),
            ...(pack.settings.constraints.restByGroup !== undefined
              ? { restByGroup: pack.settings.constraints.restByGroup }
              : {}),
            noBackToBack: pack.settings.constraints.noBackToBack,
            startWindows: [],
            fieldFairness: "off" as const,
            parallelism: "mixed" as const,
            crossPersonClash: "warn" as const,
          },
        }
      : {}),
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

/** Ask `provider` for one round. Thin wrapper: the provider seam owns the
 *  wire format, the reasoning shape, structured-output parsing, and echoing
 *  the assistant turn back unchanged on repair (01 §5) — callers just replay
 *  `response.assistantTurn`. */
async function callModel(
  provider: AiProvider,
  model: string,
  messages: AiTurn[],
): Promise<AiChatResponse<AiSchedulePlan> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUND_TIMEOUT_MS);
  try {
    return await provider.chat({
      model,
      system: SYSTEM_PROMPT,
      messages,
      maxTokens: MAX_TOKENS,
      reasoning: aiReasoning(model),
      schema: { name: "schedule_plan", zod: AiSchedulePlan },
      signal: controller.signal,
      // The explicit timeout is load-bearing: without it the Anthropic SDK
      // refuses non-streaming requests whose max_tokens implies >10 min and
      // throws synchronously ("Streaming is required…"), which the
      // corrective path would mask as AI_PLAN_FAILED. The AbortController
      // above remains the real per-round deadline.
      timeoutMs: 600_000,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HttpError(422, "AI scheduling timed out; please retry", "AI_PLAN_TIMEOUT");
    }
    // Genuine transport/API failures propagate (→ 5xx). The adapter, however,
    // returns null on schema-invalid structured output instead of throwing —
    // fold that into the null-parsed path so the corrective retry (01 §1)
    // runs rather than surfacing a raw 500.
    if (err instanceof HttpError || err instanceof AiProviderError) {
      throw err;
    }
    return null;
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
export async function runAiPlan(
  pack: SchedulePack,
  movableIds: Set<string>,
  modelOverride?: string,
  providerName?: ProviderName,
): Promise<AiPlanResult> {
  // One provider per run: reasoning blocks are provider-specific and replayed
  // verbatim on repair, so a run that resolved a provider per round could send
  // one service's reasoning to another. 503 before any network if unconfigured.
  // A ladder rung pins its provider explicitly (never via AI_PROVIDER — that is
  // process-global and unsafe under concurrency); an unset name falls back to
  // the env-selected provider, exactly as before this parameter existed.
  const provider = providerName ? resolveProvider(providerName) : selectProvider();
  if (!provider.isConfigured()) {
    throw new HttpError(503, "AI scheduling is not configured on this server");
  }
  const model = modelOverride ?? schedulingAiModel();

  const conversation: AiTurn[] = [{ role: "user", content: JSON.stringify(pack) }];
  const config = verifyConfig(pack);
  const obstacles = toObstacleAssignments(pack);
  const dependencies = packFeedDependencies(pack);

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = 0;
  let repairRounds = 0;
  let correctiveUsed = false; // one non-repair retry for a malformed plan (01 §1)

  // Best-so-far across repair rounds: repair round 2 can leave MORE blocking
  // conflicts than round 1, so we keep the plan with the fewest blocking (ties
  // resolve to the later round) and return that — never blindly the last round.
  let best: { plan: AiSchedulePlan; blocking: Conflict[]; warnings: Conflict[] } | null = null;

  // Accumulated usage rides along on a 422 too, so callers can meter a refused
  // or un-correctable run rather than losing the tokens already spent.
  const usageNow = () => ({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    repair_rounds: repairRounds,
    cost_usd: costUsd,
  });

  for (;;) {
    let response: Awaited<ReturnType<typeof callModel>>;
    try {
      response = await callModel(provider, model, conversation);
    } catch (err) {
      // A timed-out round still spent the earlier rounds' tokens — ride the
      // accumulated usage on the 422 so callers can meter it (same contract
      // as AI_PLAN_FAILED).
      if (err instanceof HttpError && err.code === "AI_PLAN_TIMEOUT") {
        throw new HttpError(422, err.message, "AI_PLAN_TIMEOUT", { usage: usageNow() });
      }
      throw err;
    }
    const roundInput = response?.usage?.inputTokens ?? 0;
    const roundOutput = response?.usage?.outputTokens ?? 0;
    inputTokens += roundInput;
    outputTokens += roundOutput;
    // Prefer the cost the provider reports; fall back to a derived estimate
    // only when the round produced no reported cost. Never a guess.
    const roundCost =
      response?.usage?.costUsd ??
      (response ? aiRunCostUsd(response.servedModel, roundInput, roundOutput) : 0);
    costUsd = costUsd === null || roundCost === null ? null : costUsd + roundCost;

    // Refusal: bail before reading content (01 §1). `stop_reason` is not part
    // of the provider-neutral response — `refused` is the seam's equivalent,
    // and MUST stay distinct from a null parse: a refusal spends no
    // corrective retry.
    if (response?.refused) {
      throw new HttpError(
        422,
        "AI scheduling could not produce a usable plan; please retry",
        "AI_PLAN_FAILED",
        { usage: usageNow() },
      );
    }

    const plan = response?.parsed ?? null;
    const structuralError =
      plan === null ? "the model returned no parseable plan" : structuralCheck(plan, movableIds, pack);
    if (structuralError !== null) {
      if (correctiveUsed) {
        throw new HttpError(
          422,
          "AI scheduling could not produce a usable plan; please retry",
          "AI_PLAN_FAILED",
          { usage: usageNow() },
        );
      }
      correctiveUsed = true;
      conversation.push(response?.assistantTurn ?? { role: "assistant", content: [] });
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

    // Keep the fewest-blocking plan; `<=` lets a later round win an exact tie.
    if (best === null || blocking.length <= best.blocking.length) {
      best = { plan: plan!, blocking, warnings };
    }

    if (blocking.length === 0 || repairRounds >= MAX_REPAIR_ROUNDS) {
      const chosen = best;
      return {
        proposal: chosen.plan.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_label: a.court_label,
          ...(a.schedule_locked !== undefined ? { schedule_locked: a.schedule_locked } : {}),
        })),
        unschedulable: chosen.plan.unschedulable,
        warnings: chosen.warnings,
        blocking: chosen.blocking,
        diff: computeDiff(chosen.plan, pack),
        explanations: chosen.plan.explanations,
        ...(chosen.plan.constraint_suggestions !== undefined
          ? { constraint_suggestions: chosen.plan.constraint_suggestions }
          : {}),
        summary: chosen.plan.summary,
        usage: usageNow(),
      };
    }

    // Blocking conflicts remain and rounds are left — send the report back and
    // ask for minimal fixes (01 §5).
    repairRounds++;
    conversation.push(response?.assistantTurn ?? { role: "assistant", content: [] });
    conversation.push({
      role: "user",
      content: JSON.stringify({
        verifier_conflicts: conflicts,
        note: "Fix only these conflicts. Move as few fixtures as possible. Do not reintroduce earlier conflicts.",
      }),
    });
  }
}

// ===========================================================================
// Phase A endpoint orchestrator (design/v4/00 §5, 03 §2). Gates → pack → run →
// dry officials coverage → telemetry. This is the single place the schedule
// architect meets the DB, the entitlement matrix, and the kill switch.
// ===========================================================================

type OfficialsCoverage = NonNullable<AiPlanResponse["officials_coverage"]>;

/** Dry officials coverage over the proposal — the same pure engine pass the
 *  officials-auto endpoint uses, run here with `locked: []` and no LLM. Maps the
 *  proposal to engine fixtures (epoch ms via matchMinutes) and the pack's
 *  officials to specs; `role_unfilled` conflicts are the coverage gaps. */
function coveragePreview(
  pack: SchedulePack,
  proposal: AiPlanResult["proposal"],
  policy: AssignPolicy,
): OfficialsCoverage {
  const fixtureById = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
  const durMs = pack.settings.matchMinutes * MS_PER_MIN;
  const fixtures: OfficialFixture[] = proposal.map((a) => {
    const f = fixtureById.get(a.fixture_id);
    const startAt = toMs(a.scheduled_at);
    return {
      id: a.fixture_id,
      startAt,
      endAt: startAt + durMs,
      court: a.court_label,
      divisionId: pack.division.id,
      entrants: f ? [f.home, f.away].filter((e): e is string => e !== null) : [],
    };
  });
  const officials: OfficialSpec[] = pack.officials.map((o) => ({
    id: o.id,
    roleKeys: o.role_keys,
    ...(o.max_per_day !== null ? { maxPerDay: o.max_per_day } : {}),
    ...(o.entrant_ids.length > 0 ? { entrantIds: o.entrant_ids } : {}),
    homeDivisionId: pack.division.id,
  }));
  const { conflicts } = assignOfficials({ fixtures, officials, locked: [], policy, rngSeed: "coverage" });
  const unfilled = conflicts
    .filter((c) => c.kind === "role_unfilled")
    .map((c) => ({ fixture_id: c.fixtureId ?? "", role_key: c.roleKey ?? "" }));
  const total = proposal.length * policy.roles.length;
  return { total, unfilled, fillable: total - unfilled.length };
}

/** Convert the engine constraint delta (epoch-ms startWindows) into the API
 *  shape (ISO-with-offset in the division tz) that clients + the
 *  schedule-settings PUT speak. Non-startWindow fields pass through. */
function isoConstraintSuggestions(
  s: Partial<SchedulingConstraints>,
  tz: string,
): AiPlanResponse["constraint_suggestions"] {
  return {
    ...(s.restMin !== undefined ? { restMin: s.restMin } : {}),
    ...(s.restByGroup !== undefined ? { restByGroup: s.restByGroup } : {}),
    ...(s.noBackToBack !== undefined ? { noBackToBack: s.noBackToBack } : {}),
    ...(s.startWindows !== undefined
      ? {
          startWindows: s.startWindows.map((w) => ({
            target: w.target,
            ...(w.notBefore !== undefined ? { notBefore: zonedIso(w.notBefore, tz) } : {}),
            ...(w.notAfter !== undefined ? { notAfter: zonedIso(w.notAfter, tz) } : {}),
          })),
        }
      : {}),
    ...(s.fieldFairness !== undefined ? { fieldFairness: s.fieldFairness } : {}),
    ...(s.parallelism !== undefined ? { parallelism: s.parallelism } : {}),
    ...(s.crossPersonClash !== undefined ? { crossPersonClash: s.crossPersonClash } : {}),
  };
}

/** Opt-in cheaper first-attempt model. Unset (the default) means no escalation
 *  and behaviour is exactly as before. */
export function schedulingAiCheapModel(): string | null {
  return process.env.SCHEDULING_AI_CHEAP_MODEL || null;
}

/** Warnings-per-movable-fixture above which a cheap plan is rejected and the
 *  primary model re-runs.
 *
 *  UNCALIBRATED. Measured 2026-07-20 (n=3 per cell): sonnet-5 scored 0 warnings
 *  on both benched packs; haiku-4-5 scored 0 on the sparse pack and 20/43/100
 *  on the dense one — 0.67, 1.43 and 3.33 per fixture. The default of 1.0 sits
 *  inside that observed range rather than at a boundary derived from real
 *  divisions, so it will need tuning against production data before this is
 *  trusted. That is exactly why escalation is opt-in. */
function escalationWarningRatio(): number {
  const n = Number(process.env.SCHEDULING_AI_ESCALATE_WARN_RATIO);
  return Number.isFinite(n) && n >= 0 ? n : 1.0;
}

/** Is a plan good enough to ship without re-running on the primary model?
 *  Blocking conflicts are never acceptable — the engine says the schedule is
 *  physically impossible. Warnings are soft (rest, blackout, session window,
 *  cross-person), so they are judged against pack size rather than absolutely. */
function planIsAcceptable(result: AiPlanResult, movableCount: number): boolean {
  if (result.blocking.length > 0) return false;
  if (movableCount === 0) return true;
  return result.warnings.length / movableCount <= escalationWarningRatio();
}

/** One candidate in the fallback ladder: a model and the provider that serves
 *  it. Provider is pinned per rung so a cross-provider ladder (OpenRouter
 *  gemini → Anthropic sonnet → OpenRouter grok) never mutates AI_PROVIDER. */
export type LadderRung = { provider: ProviderName; model: string };

/** Parse SCHEDULING_AI_LADDER into ordered rungs, or null when unset/empty (the
 *  caller then uses the legacy cheap→primary path). Comma-separated model ids;
 *  the provider is inferred from the id — an OpenRouter id carries a vendor
 *  prefix ("google/…", "x-ai/…"), an Anthropic id does not ("claude-sonnet-5").
 *  Example (the recommended production ladder):
 *    SCHEDULING_AI_LADDER="google/gemini-3.6-flash,claude-sonnet-5,x-ai/grok-4.5"
 */
/** Parse a comma-separated ladder spec into rungs, or null when empty/unset.
 *  Shared by the schedule and officials ladders (each reads its own env var).
 *  Provider is inferred from the id — a "/" means an OpenRouter vendor prefix,
 *  else Anthropic direct. */
export function parseLadderSpec(raw: string | null | undefined): LadderRung[] | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const rungs = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((model): LadderRung => ({ provider: model.includes("/") ? "openrouter" : "anthropic", model }));
  return rungs.length > 0 ? rungs : null;
}

export function schedulingAiLadder(): LadderRung[] | null {
  return parseLadderSpec(process.env.SCHEDULING_AI_LADDER);
}

/** The ordered candidate list for one architect run. An explicit
 *  SCHEDULING_AI_LADDER wins; otherwise the legacy behaviour is reproduced
 *  exactly — cheap→primary escalation (both on the env-selected provider) when
 *  a cheap model is set, else a single primary rung. So with neither env var
 *  set, this is the shipped Anthropic/sonnet single-model path, unchanged. */
export function planRungs(): LadderRung[] {
  const ladder = schedulingAiLadder();
  if (ladder) return ladder;
  const provider: ProviderName = process.env.AI_PROVIDER === "openrouter" ? "openrouter" : "anthropic";
  const primary = schedulingAiModel();
  const cheap = schedulingAiCheapModel();
  return cheap && cheap !== primary
    ? [{ provider, model: cheap }, { provider, model: primary }]
    : [{ provider, model: primary }];
}

type Usage = AiPlanResult["usage"];

/** Sum a run's usage into the accumulator. `cost_usd` is null-preserving: a real
 *  `null` (cost unknown — the model has no PRICING entry) must NOT collapse to 0
 *  (which asserts "free" and undercounts the total); only a genuinely-absent
 *  `undefined` defaults to 0. */
function addUsage(acc: Usage, next: Partial<Usage>): Usage {
  const nextCost = next.cost_usd === undefined ? 0 : next.cost_usd;
  return {
    input_tokens: acc.input_tokens + (next.input_tokens ?? 0),
    output_tokens: acc.output_tokens + (next.output_tokens ?? 0),
    repair_rounds: acc.repair_rounds + (next.repair_rounds ?? 0),
    cost_usd: acc.cost_usd === null || nextCost === null ? null : acc.cost_usd + nextCost,
  };
}

/** Does this error justify trying the next rung? A plan the model could not
 *  produce (AI_PLAN_FAILED / AI_PLAN_TIMEOUT) or a transport/API failure
 *  (AiProviderError — unparsable body, 5xx, refusal) is recoverable by a
 *  different model/provider. A deterministic user error (empty scope, too
 *  large, 400/404) is NOT — it would fail identically on every rung. */
function isRecoverable(err: unknown): boolean {
  if (err instanceof AiProviderError) return true;
  return err instanceof HttpError && (err.code === "AI_PLAN_FAILED" || err.code === "AI_PLAN_TIMEOUT");
}

/**
 * Run an ordered ladder of model candidates, returning the first acceptable
 * plan and falling back on evidence (a thrown recoverable failure, or a
 * usable-but-degraded plan that fails `acceptable`). Deterministic user errors
 * stop the ladder immediately — retrying them only burns money.
 *
 * ESCALATE on evidence, don't PREDICT from the pack: choosing a model up front
 * needs a "density" metric the bench could not supply, and the referee already
 * measures the thing that matters — plan quality — so let it decide. Failure
 * mode is bounded: a wasted earlier rung is at most the cost of that rung, and
 * the ladder can never ship a worse plan than a later rung would have.
 *
 * COST TRUTH (aligns spend with what actually ran): usage from EVERY attempted
 * rung is summed (null-preserving), and the winning rung's model is returned as
 * `served_model` so the ledger/analytics record the model that produced the
 * plan — not a static default. When all rungs fail, the thrown error carries the
 * accumulated usage and the last rung's model so a failed run is still metered
 * against the truth.
 *
 * Pure over `attempt`/`acceptable` so it is unit-tested without a network.
 * Generic over the result so both phases reuse it — schedule (AiPlanResult) and
 * officials (OfficialsPlanResult) both carry a `usage` with the same shape.
 */
export async function runLadder<T extends { usage: Usage }>(
  rungs: LadderRung[],
  attempt: (rung: LadderRung) => Promise<T>,
  acceptable: (result: T) => boolean,
): Promise<T & { served_model: string; escalated_from?: string; rungs_tried: string[] }> {
  let acc: Usage = { input_tokens: 0, output_tokens: 0, repair_rounds: 0, cost_usd: 0 };
  const tried: string[] = [];
  for (let i = 0; i < rungs.length; i++) {
    const rung = rungs[i]!;
    const last = i === rungs.length - 1;
    tried.push(rung.model);
    try {
      const result = await attempt(rung);
      // The last rung ships its plan even if degraded — a best-effort schedule
      // beats a hard failure, and the referee's blocking/warnings ride along.
      if (acceptable(result) || last) {
        return {
          ...result,
          usage: addUsage(acc, result.usage),
          served_model: rung.model,
          rungs_tried: tried,
          ...(tried.length > 1 ? { escalated_from: tried[0] } : {}),
        };
      }
      acc = addUsage(acc, result.usage); // usable but not good enough — pay it, advance
    } catch (err) {
      if (!isRecoverable(err)) throw err;
      const u = (err as { extra?: { usage?: Partial<Usage> } }).extra?.usage ?? {};
      acc = addUsage(acc, u);
      if (last) {
        // All rungs exhausted: surface the full accumulated spend and the model
        // that failed, so the caller's failure metering records the true total
        // and the true (last) model. HttpError.extra is read-only, so rebuild
        // it (preserving status/code/message); provider errors take loose fields.
        if (err instanceof HttpError) {
          throw new HttpError(err.status, err.message, err.code, {
            ...(err.extra ?? {}),
            usage: acc,
            model: rung.model,
          });
        }
        (err as { usage?: Usage; model?: string }).usage = acc;
        (err as { model?: string }).model = rung.model;
        throw err;
      }
    }
  }
  // Unreachable: a non-empty ladder's final rung always returns or throws.
  throw new HttpError(500, "model ladder exhausted without a result", "AI_PLAN_FAILED");
}

/** Wire the ladder to the real architect: each rung runs on its own provider,
 *  and a degraded plan escalates via the existing quality gate. */
async function runAiPlanLadder(
  pack: SchedulePack,
  movableIds: Set<string>,
): Promise<AiPlanResult & { served_model: string; escalated_from?: string; rungs_tried: string[] }> {
  return runLadder(
    planRungs(),
    (rung) => runAiPlan(pack, movableIds, rung.model, rung.provider),
    (result) => planIsAcceptable(result, movableIds.size),
  );
}

/**
 * POST /divisions/{id}/schedule/ai-plan orchestrator. Gate order is deliberate
 * (design/v4/00 §5): the staged-rollout kill switch (fail-open) → the paid gate
 * (`scheduling.ai`, 402) → the per-division run cap (upstream V291, 402 before
 * any LLM spend) → the spend limiter (5/division/hour, 429) → build the
 * deterministic pack → run the architect → append the schedule.ai_generated
 * audit event → optional dry officials coverage. Telemetry fires on success AND
 * on a 422 AI_PLAN_FAILED (usage rides on the error's extra) so refused spend is
 * still metered.
 *
 * @throws HttpError 403 FEATURE_DISABLED (kill switch), 402 (paid gate or
 *   over-quota run cap), 409 SCHEDULE_LOCKED (frozen division — refused before
 *   the quota and spend gates), 429 (rate limit), plus everything
 *   buildSchedulePack/runAiPlan raise (409/422/400/503).
 */
export async function aiPlanForDivision(
  auth: AuthCtx,
  divisionId: string,
  input: AiPlanRequest,
): Promise<AiPlanResponse> {
  // Stable analytics id: the user, or an org: synthetic when a key drives the
  // call (auth.userId is null for API-key auth — CaptureArgs convention).
  const distinctId = auth.userId ?? `org:${auth.orgId}`;
  // Kill switch (feature-flag rollout, not billing): fail-open so an unconfigured
  // or unreachable PostHog never blocks a paying customer.
  if (
    !(await isServerFeatureEnabled("ai-scheduling", distinctId, { orgId: auth.orgId, fallback: true }))
  ) {
    throw new HttpError(403, "AI scheduling is currently turned off", "FEATURE_DISABLED");
  }
  await requireFeature(auth.orgId, "scheduling.ai");

  // Pro AI cap (owner 2026-07-18, amends pro-plus D4): Pro keeps AI scheduling
  // but is limited to N generations per division; Pro Plus is unlimited (null
  // int_value → withinLimit returns ok). Count prior runs from the audit ledger
  // and refuse the (cap+1)th here, before the LLM call, so an over-quota org
  // never burns a request.
  const gate = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string; schedule_locked: boolean }[]>`
      select competition_id, schedule_locked from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [row] = await tx<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where competition_id = ${division.competition_id}
        and type = 'schedule.ai_generated'
        and payload->>'division_id' = ${divisionId}`;
    return {
      competitionId: division.competition_id,
      priorRuns: row?.n ?? 0,
      frozen: division.schedule_locked ?? false,
    };
  });

  // A frozen division rejects every applied plan (schedule.ts applySchedule,
  // 422 "the division schedule is locked"). Running the architect anyway spends
  // a generation, a rate-limit slot and real tokens to produce a proposal the
  // organiser is then blocked from using — the failure only surfaced at Apply,
  // several minutes and one paid run later. Refuse here, ahead of the quota and
  // spend gates, so a frozen board costs nothing.
  if (gate.frozen) {
    throw new HttpError(
      409,
      "the division schedule is frozen — unfreeze it to plan with AI",
      "SCHEDULE_LOCKED",
    );
  }
  const cap = await withinLimit(
    auth.orgId,
    "scheduling.ai.runs_per_division.max",
    gate.priorRuns + 1,
    gate.competitionId,
  );
  if (!cap.ok) throw new PaymentRequiredError("scheduling.ai.runs_per_division.max");

  await rateLimit(`ai-plan:${divisionId}`, { max: 5, windowSeconds: 3600 });

  const { pack, movableIds } = await buildSchedulePack(auth, divisionId, input);

  let result: AiPlanResult & { served_model: string; escalated_from?: string; rungs_tried: string[] };
  try {
    result = await runAiPlanLadder(pack, movableIds);
  } catch (err) {
    // Meter a refused / un-correctable / timed-out run's token spend too —
    // usage rides on the 422 extra so a failed architect call is not invisible
    // in analytics or the run ledger. The failure row uses its own event type
    // ('schedule.ai_failed'): the quota above counts 'schedule.ai_generated'
    // only, so failures never consume a generation.
    // A provider-level failure (billing 400, auth 401, rate-limit 429,
    // overloaded 529, upstream 5xx — wrapped as AiProviderError by the
    // adapter) is NOT a planning failure — the provider is unusable right
    // now. Before 2026-07-20 it matched neither branch below: it was
    // rethrown raw from callModel, surfaced to the tenant as a 500, and left no
    // ledger row. Observed live during the effort bench, where an exhausted
    // credit balance took AI scheduling down with no diagnostic. Meter it under
    // its own outcome and translate it to a 503 — the provider's message can
    // carry our billing state and must never reach a tenant.
    const providerErr = err instanceof AiProviderError ? err : null;
    // The adapter's cause is the raw SDK error (Anthropic.APIError has
    // `status` + `name`) — read defensively since other providers' causes may
    // not carry the same shape.
    const providerCause = providerErr?.cause as { status?: number; name?: string } | undefined;
    const planErr =
      err instanceof HttpError && (err.code === "AI_PLAN_FAILED" || err.code === "AI_PLAN_TIMEOUT") ? err : null;

    if (planErr || providerErr) {
      // The ladder annotates the thrown error with the accumulated usage across
      // every rung it tried and the last rung's model, so a failed run is
      // metered against the true total spend and the true (last) model — not a
      // static default. Provider errors carry the annotation as loose fields.
      const usage = (planErr?.extra?.usage ??
        (err as { usage?: Record<string, unknown> }).usage ??
        {}) as {
        input_tokens?: number;
        output_tokens?: number;
        repair_rounds?: number;
        cost_usd?: number | null;
      };
      const model =
        (planErr?.extra?.model as string | undefined) ??
        (err as { model?: string }).model ??
        schedulingAiModel();
      const outcome = providerErr ? "provider_error" : planErr!.code === "AI_PLAN_TIMEOUT" ? "timeout" : "failed";
      const cost_usd = usage.cost_usd ?? aiRunCostUsd(model, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
      await withTenant(auth.orgId, async (tx) => {
        await tx`
          insert into competition_events (competition_id, org_id, type, payload, actor_id)
          values (${gate.competitionId}, ${auth.orgId}, 'schedule.ai_failed',
                  ${tx.json({
                    division_id: divisionId,
                    phase: "schedule",
                    mode: input.mode,
                    outcome,
                    model,
                    usage: {
                      input_tokens: usage.input_tokens ?? 0,
                      output_tokens: usage.output_tokens ?? 0,
                      repair_rounds: usage.repair_rounds ?? 0,
                    },
                    cost_usd,
                    // Provider diagnostics stay server-side (ops needs the real
                    // status; the tenant gets a bare 503).
                    ...(providerErr
                      ? { provider_status: providerCause?.status ?? null, provider_type: providerCause?.name ?? providerErr.name }
                      : {}),
                  } as never)}, ${auth.userId})`;
      });
      await captureServer({
        event: "ai_plan_run",
        distinctId,
        orgId: auth.orgId,
        properties: {
          phase: "schedule",
          mode: input.mode,
          model,
          fixtures: movableIds.size,
          repair_rounds: usage.repair_rounds ?? 0,
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cost_usd,
          blocking: 0,
          outcome,
          ...(providerErr ? { provider_status: providerCause?.status ?? null } : {}),
        },
      });
    }
    if (providerErr) {
      throw new HttpError(503, "AI scheduling is temporarily unavailable; please retry", "AI_PROVIDER_UNAVAILABLE");
    }
    throw err;
  }

  // Record this generation against the per-division cap counted above (owner
  // 2026-07-18). Append-only audit; org_id is set explicitly by the insert below.
  // Stamp the model the ladder ACTUALLY served (winning rung), not a static
  // default — so the audit and cost (result.usage sums every rung tried) reflect
  // what really ran and what it really cost.
  const model = result.served_model;
  const cost_usd = result.usage.cost_usd ?? aiRunCostUsd(model, result.usage.input_tokens, result.usage.output_tokens);
  await withTenant(auth.orgId, async (tx) => {
    await tx`
      insert into competition_events (competition_id, org_id, type, payload, actor_id)
      values (${gate.competitionId}, ${auth.orgId}, 'schedule.ai_generated',
              ${tx.json({
                division_id: divisionId,
                mode: input.mode,
                model,
                usage: result.usage,
                cost_usd,
                // Ladder telemetry: which model was tried first and rejected,
                // the full ordered chain of rungs attempted (so a 3-rung fall
                // gemini→sonnet→grok is auditable — `model` above is only the
                // winner), and the warning ratio that rejected it. The threshold
                // is uncalibrated (see escalationWarningRatio), so the ledger has
                // to carry what it would take to tune it.
                ...(result.escalated_from
                  ? {
                      escalated_from: result.escalated_from,
                      rungs_tried: result.rungs_tried,
                      warnings: result.warnings.length,
                      movable: movableIds.size,
                    }
                  : {}),
              } as never)}, ${auth.userId})`;
  });

  const officials_coverage = input.officials_policy
    ? coveragePreview(pack, result.proposal, input.officials_policy)
    : null;

  await captureServer({
    event: "ai_plan_run",
    distinctId,
    orgId: auth.orgId,
    properties: {
      phase: "schedule",
      mode: input.mode,
      model,
      fixtures: movableIds.size,
      repair_rounds: result.usage.repair_rounds,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cost_usd,
      blocking: result.blocking.length,
      outcome: "ok",
    },
  });

  return {
    proposal: result.proposal,
    unschedulable: result.unschedulable,
    warnings: result.warnings,
    blocking: result.blocking,
    diff: result.diff,
    explanations: result.explanations,
    ...(result.constraint_suggestions !== undefined
      ? { constraint_suggestions: isoConstraintSuggestions(result.constraint_suggestions, pack.division.tz) }
      : {}),
    summary: result.summary,
    // Public shape is pinned to AiPlanResponse.usage in api-v1/schemas.ts —
    // exactly these three fields. cost_usd lives on AiPlanResult["usage"] for
    // the ledger (competition_events insert above) but must not leak into the
    // API response, so it is built explicitly here rather than by spreading
    // result.usage.
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      repair_rounds: result.usage.repair_rounds,
    },
    officials_coverage,
  };
}
