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
import { requireFeature } from "@/lib/entitlements";
import { balance, spendCredit, walletIdFor } from "@/lib/credits";
import { rateLimit } from "@/lib/rate-limit";
import { captureServer, isServerFeatureEnabled } from "@/lib/posthog-server";
import { aiRunCostUsd } from "@/lib/ai-pricing";
import {
  createTokenMeter,
  meterStamp,
  minimumCredits,
  quoteRun,
  schedulingRungWeights,
  unmeteredTokenMeter,
  type TokenMeter,
} from "@/lib/ai-rung";
import { deferred } from "@/lib/deferred";
import { maybeAlertExpensiveRun } from "@/server/usecases/ai-runs-admin";
import {
  computeParticipants,
  dayKeyInTz,
  isEpochSentinel,
  makeClock,
  slotFixtures,
  isBlockingConflict,
  stripByes,
  validateAssignments,
  ymdAddDays,
  zonedTimeToUtc,
  type Assignment,
  type Clock,
  type Conflict,
  type HardConstraint,
  type OrderDependency,
  type ParticipantFixture,
  type RuleCode,
  type RuleFixture,
  type SchedulableFixture,
  type SchedulingConstraints,
  type SlotConfig,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import {
  parseInstruction,
  resolveParsed,
  type RawParsed,
  type ResolvedParse,
} from "@/server/usecases/schedule-ai-parse";
import {
  applySolverMoves,
  solveBoard,
  solverBudgetMs,
  SOLVER_MIN_BUDGET_MS,
  type RepairEngine,
  type RepairReport,
  type SolverTelemetry,
} from "@/server/usecases/schedule-ai-solver";
import { consumePreview, PREVIEW_STALE, releasePreview } from "@/server/usecases/schedule-ai-preview";
import {
  assignOfficials,
  type AssignPolicy,
  type OfficialFixture,
  type OfficialSpec,
} from "@seazn/engine/officials";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AiPlanRequest, AiPlanResponse } from "@/server/api-v1/schemas";
import { AiSchedulePlan, SINGLE_SYSTEM_PROMPT } from "./schedule-ai-prompt";
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

const normName = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Scheduling-only identity guard (#396, design §4.2). Persons whose normalised
 * names match but whose ids differ collapse to ONE synthetic key so person
 * rules see one human. The key never leaves the pack (it lives in
 * `participants`, which `toModelPayload` strips), nothing writes it, and
 * nothing renders it as a merge.
 *
 * The asymmetry that justifies it holds for scheduling and NOT for records: a
 * false merge costs one unnecessary rest gap; a false split books one human on
 * two courts at the same time. It would be wrong in the database — merging two
 * real different people corrupts stats, discipline history, photo and consent.
 * Over-constrain the schedule, never the database.
 *
 * Blank names are skipped: "" and "   " normalise identically, so bucketing
 * them would fuse every unnamed person in the division into one player.
 *
 * Exported so the joint (#350) builder reuses this resolver verbatim rather
 * than growing a second, divergent notion of "same person".
 */
export function personKeyResolver(personNameById: ReadonlyMap<string, string>): {
  keyOf: (personId: string) => string;
  assumptions: string[];
} {
  const byName = new Map<string, string[]>();
  for (const [id, name] of personNameById) {
    const k = normName(name);
    if (k === "") continue;
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(id);
  }
  const synthetic = new Map<string, string>();
  const assumptions: string[] = [];
  // Buckets in normalised-name order; person ids are per-seed UUIDs and the
  // golden-pack test redacts UUIDs to FIRST-SEEN placeholders, so nothing here
  // may order on (or embed a fragment of) an id.
  for (const [norm, ids] of [...byName.entries()].sort(([a], [b]) => cmp(a, b))) {
    if (ids.length < 2) continue;
    for (const id of ids) synthetic.set(id, `name:${norm}`);
    // `personNameById` iterates in DB row order, so the bucket's id order is not
    // stable across reseeds. Display the lexicographically first RAW spelling —
    // a choice that depends only on the names, never on which row came back
    // first — so the assumption string is byte-identical on a reseed.
    const display = ids.map((id) => personNameById.get(id) ?? "").sort(cmp)[0]!;
    assumptions.push(
      `'${display}' matches ${ids.length} person records by name — ` +
        `treated as one player for scheduling only; no records were merged`,
    );
  }
  return { keyOf: (id) => synthetic.get(id) ?? id, assumptions };
}

/** Label stamped on a sibling division's placements. `siblingAssignments`
 *  (schedule.ts:271) returns bare engine assignments carrying no division
 *  metadata, so every other division in the competition flattens to this one
 *  string — deliberately, since a rival's roster must never leak into the pack.
 *
 *  Exported because that makes it the ONLY marker separating "another
 *  division's board" from "this division's own fixed fixtures" in
 *  `fixtures.obstacles`, and the #350 joint builder keys its sibling removal on
 *  it. A copied literal there would diverge silently. */
export const OTHER_DIVISION_LABEL = "Other division";

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
  /** Durable division rules (#398), in the same vocabulary a compiled
   *  instruction produces. Merged with `pack.parsed.hard` by `verifyConfig`, so
   *  hard rules have exactly one home. Optional for the same reason the engine's
   *  field is: this type is built as an object literal at many call sites. */
  hard?: HardConstraint[];
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

/** The draft's own row shape (#397). `scheduled_at` is nullable here and nowhere
 *  else: a fixture whose persisted time is an epoch sentinel reaches the model
 *  as UNPLACED rather than as 1970-01-01, which the model would anchor on.
 *  `prior` keeps `PackAssignment` — a prior proposal is by definition placed. */
export interface PackDraftAssignment {
  fixture_id: string;
  scheduled_at: string | null;
  court_label: string;
}

/** No configured `endAt`: the window runs a week from its start. Seven is the
 *  programme's unit — the design freezes a 7-day badminton golden schedule and
 *  the "read the end as the following week" assumption on top of it (#397). */
export const DEFAULT_WINDOW_DAYS = 7;

/** `ScheduleConfig` has no daily-hours field, so the pack advertises this as the
 *  fallback shape of a day for a division with no explicit `sessionWindows`.
 *  Advisory in W2 — it anchors the greedy draft and tells the model what a
 *  normal day looks like; the typed rules that enforce it land in W3/W4. */
export const DEFAULT_SESSION_HOURS = { start: "08:00", end: "22:00" } as const;

export interface SchedulePack {
  mode: "generate" | "refine" | "repair";
  division: { id: string; name: string; sport: string; tz: string };
  /** The ORGANISATION zone (#397, design §2.1). ONE zone governs every temporal
   *  decision in this pack — day boundaries, weekday targets, session hours and
   *  the offset every timestamp below is written in. `division.tz` above is
   *  display metadata and drives nothing. */
  tz: string;
  /** The calendar anchor, built from an instant the caller injected. Without it
   *  "from tomorrow till Friday" has two readings a week apart and nothing
   *  downstream can tell which one happened. */
  clock: Clock;
  /** The days this competition runs, resolved and never absent. `end` is
   *  inclusive — the last instant a fixture may still be occupying. */
  window: { start: string; end: string };
  /** The daily fallback for a division with no `sessionWindows`, as "HH:MM" in
   *  `tz`. */
  sessionHours: { start: string; end: string };
  settings: PackSettings;
  entrants: PackEntrant[];
  people: PackPerson[];
  /** Every person who COULD stand in each movable fixture, including the
   *  advancers behind a null slot (#396). Keyed for every movable fixture, in
   *  `fixtures.movable` order; the source of `Assignment.people` for both the
   *  greedy placer and the verifier, so a draft cannot be legal under a rule
   *  the referee applies differently. */
  participants: Record<string, string[]>;
  /** Deterministic preprocessing choices worth telling the organiser about:
   *  stripped bye feeders, same-name person grouping. Rendered at W5 (#400). */
  assumptions: string[];
  /** The organiser's instruction, compiled (#398).
   *
   *  PROMPT MATERIAL, unlike `participants` and `assumptions`: the model must
   *  satisfy the same rules it will be verified against, or a repair round can
   *  never converge on what was actually asked for.
   *
   *  The window a `window` instruction resolved to is deliberately NOT here — it
   *  is `pack.window` above, which the verifier already checks. That is what
   *  keeps every member of this union unit-free (minutes, counts, weekdays,
   *  YYYY-MM-DD, HH:mm) and lets the engine and the pack share one type. */
  parsed: {
    hard: HardConstraint[];
    soft: { note: string; weight: 1 | 2 | 3 }[];
    unparsed: string[];
  };
  fixtures: { movable: PackFixture[]; obstacles: PackObstacle[] };
  draft: PackDraftAssignment[];
  instruction: string;
  prior: { instruction: string; assignments: PackAssignment[] } | null;
  officials: PackOfficial[];
}

/**
 * What actually goes on the wire to the model: the pack MINUS `participants`
 * and `assumptions`.
 *
 * Both fields are server-side enforcement inputs, not prompt material. #396
 * gives the referee and the greedy placer the full advancer sets; it does not
 * change what the model is shown (design §3.1 — W2 is the only wave that moves
 * the prompt boundary, and W3 §7.3 teaches the advancer RULE in five sentences).
 *
 * The cost of getting this wrong is measured, not guessed. On a 500-fixture
 * elimination bracket (`schedule-ai-pack.test.ts`) the pack with `participants`
 * inlined is 100,252 proxy tokens against a 60,000 ceiling; the payload without
 * them is 51,341. (Even the flat 500-fixture league board saves 5,258: an empty
 * participant list per fixture is still 500 uuid keys.) Inlining the pack here
 * again re-breaks the budget on every bracket board, so send
 * `toModelPayload(pack)` — never `pack`.
 *
 * Written field-by-field rather than as a rest-spread on purpose: the return
 * type makes `tsc` fail here the moment `SchedulePack` gains a field, so what
 * reaches the model is always a decision somebody made, never a default.
 */
export function toModelPayload(pack: SchedulePack): Omit<SchedulePack, "participants" | "assumptions"> {
  return {
    mode: pack.mode,
    division: pack.division,
    // #397: the calendar anchor IS prompt material — W2 is the wave that moves
    // the prompt boundary. The enforcement inputs (participants, assumptions)
    // stay server-side.
    tz: pack.tz,
    clock: pack.clock,
    window: pack.window,
    sessionHours: pack.sessionHours,
    // #398: the compiled instruction IS prompt material — the model is verified
    // against exactly these rules, so withholding them would leave the repair
    // loop guessing at what it broke.
    parsed: pack.parsed,
    settings: pack.settings,
    entrants: pack.entrants,
    people: pack.people,
    fixtures: pack.fixtures,
    draft: pack.draft,
    instruction: pack.instruction,
    prior: pack.prior,
    officials: pack.officials,
  };
}

export interface BuildPackOptions {
  mode: "generate" | "refine" | "repair";
  instruction: string;
  /** The instant this run is happening, epoch ms. REQUIRED and always injected
   *  (#397): the pack builder reads no clock, so two builds at the same `now`
   *  are byte-identical and the golden pack tests stay reproducible. The only
   *  `Date.now()` on this path is at the runner entry. */
  now: number;
  /** Stage-1 output (#398), or null when there was no instruction, the compile
   *  failed, or the caller is a test or a replay. The BUILDER resolves it:
   *  symbolic dates need the clock and the feasibility bump needs the fixture
   *  count, and both live here rather than at the call site. */
  raw?: RawParsed | null;
  /** W5 (#400): a resolution the caller already has and the organiser has
   *  already SEEN — the stored `ai_parse_previews.resolved` of a confirmed
   *  preview. Wins over `raw` outright. `resolveParsed` reads the org clock, so
   *  re-deriving it here minutes after the preview can land a symbolic
   *  "tomorrow" on a different date and quietly run the architect under rules
   *  nobody approved. Absent on every other path, which resolves `raw` as
   *  before. */
  resolved?: ResolvedParse | null;
  scope?: { from?: string; courts?: string[]; pool_ids?: string[] };
  prior?: {
    instruction: string;
    assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
  };
  /** Extra court occupancy handed to the greedy draft solver, on top of this
   *  division's own fixed fixtures and its siblings' persisted board.
   *
   *  Added for the #350 joint pack (competition-schedule-ai.ts): several
   *  divisions of one competition are drafted in sequence, and each must see
   *  the slots the divisions before it have just taken. `siblingAssignments`
   *  only covers what is already PERSISTED, so without this the joint draft
   *  double-books every shared court label — anchoring the model on an illegal
   *  board and spending the run's FIXED token budget on repair rounds.
   *
   *  Optional and additive: it only widens `existing`, and `generate` is the
   *  only mode that solves a draft, so no current caller is affected. */
  extraExisting?: Assignment[];
  /** Divisions of the same competition to leave OUT of the sibling sweep, on
   *  top of this one — see `siblingAssignments` (schedule.ts:271). #350: the
   *  rest of a joint run is not fixed court occupancy, it is being re-planned in
   *  the same pass, and sibling obstacles carry no division identity, so
   *  anything surviving the sweep must be provably from outside the run.
   *  Defaults to none, so no current caller is affected. */
  excludeDivisionIds?: string[];
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

// Widened to the draft's row shape (#397): an unplaced draft row carries a null
// time. Null sorts as "" — ahead of every placed card, as one stable block —
// so the ordering stays total and the pack stays byte-reproducible.
function byAssignment(a: PackDraftAssignment, b: PackDraftAssignment): number {
  return (
    cmp(a.scheduled_at ?? "", b.scheduled_at ?? "") ||
    cmp(a.court_label, b.court_label) ||
    cmp(a.fixture_id, b.fixture_id)
  );
}

/** The fields the pack's ONE fixture order reads. `PackFixture` satisfies it;
 *  a `FixtureLite` gets there through {@link boardOrderOf}. */
interface BoardOrdered {
  round: number;
  seq: number;
  ext_key: string | null;
  id: string;
}

const boardOrderOf = (f: FixtureLite): BoardOrdered => ({
  round: f.round_no,
  seq: f.seq_in_round,
  ext_key: f.ext_key,
  id: f.id,
});

/**
 * THE fixture order for the whole pack — `participants` keys, `fixtures.movable`
 * and every `feeds.after` list alike.
 *
 * It must stay a SINGLE comparator. `participants` serialises before `fixtures`,
 * so its key order is what assigns every fixture-id placeholder in the golden
 * pack; two comparators that merely happen to agree on today's board (they
 * diverge as soon as `ext_key` order contradicts `id` order) would renumber the
 * snapshot the first time a board pulled them apart.
 */
function byBoardOrder(a: BoardOrdered, b: BoardOrdered): number {
  return (
    a.round - b.round ||
    a.seq - b.seq ||
    cmp(a.ext_key ?? "", b.ext_key ?? "") ||
    cmp(a.id, b.id)
  );
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
    // ONE clock (#397, design §2.1). `settings.tz` stays available as the
    // division's DISPLAY zone — it is what `pack.division.tz` carries — but
    // every instant below is rendered in, and every calendar question answered
    // in, the ORGANISATION zone.
    const tz = settings.tz;
    const orgTz = settings.orgTz;
    const clock = makeClock(opts.now, orgTz);
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

    // #396 identity inputs, resolved before anything reads a person id. Person
    // ids are per-seed UUIDs and the pack's determinism test maps UUIDs to
    // FIRST-SEEN placeholders, so a UUID-ordered array breaks it: order on the
    // person's name, with the id only as a last-resort tie-break.
    const personIdsInPlay = [...new Set([...people.values()].flat())];
    const personNameById = new Map<string, string>();
    if (personIdsInPlay.length > 0) {
      const nameRows = await tx<{ id: string; full_name: string }[]>`
        select id, full_name from persons where id in ${tx(personIdsInPlay)}`;
      for (const r of nameRows) personNameById.set(r.id, r.full_name);
    }
    // A synthetic `name:<normalised>` key has no row in `personNameById`, so it
    // would otherwise sort under the empty name and drift as soon as a real
    // person shares that bucket. Sort it on the normalised name it carries.
    //
    // ACCEPTED RESIDUAL: the `|${p}` tail is a raw person UUID, so a tie on
    // `full_name` falls through to a per-seed random value. The same-name guard
    // (`personKeyResolver`) already collapses same-named persons to ONE key
    // before this runs, so the only ties left are two persons whose names are
    // blank or whitespace — which the guard deliberately skips rather than fuse
    // every unnamed person in the org into one player. Two blank-named people
    // can therefore order differently across reseeds; that is a strictly better
    // trade than the alternative, and the redaction determinism test tolerates
    // it because such a board has no stable domain key to offer.
    const personSortKey = (p: string): string =>
      p.startsWith("name:") ? `${p.slice(5)}|${p}` : `${personNameById.get(p) ?? ""}|${p}`;

    const identity = personKeyResolver(personNameById);
    // Map every entrant's roster through the guard BEFORE the recursion, so a
    // collapsed pair is one key everywhere it appears — in the leaf sets, in the
    // advancer unions above them, in the placer and in the verifier alike. The
    // obstacle assignments below read it too: a collapsed person's already-fixed
    // court time must still clash with the movable fixture they could stand in,
    // which it would not if one side carried a raw id and the other the key.
    const guardedPeople = new Map<string, string[]>(
      [...people].map(([entrantId, ids]) => [entrantId, [...new Set(ids.map(identity.keyOf))]]),
    );

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
    const obstacleAssignments = obstacleFixtures.map((f) => toAssignment(f, matchMinutes, guardedPeople));
    const siblingsRaw = await siblingAssignments(
      tx,
      divisionId,
      division.competition_id,
      matchMinutes,
      opts.excludeDivisionIds ?? [],
    );
    // BOTH the raw person id and its guarded key, deliberately — the same shape
    // `buildCompetitionPack` uses for `fixedOccupancy`, and for the same reason.
    // `siblingAssignments` reads `peopleByEntrant` directly, so it emits raw
    // uuids, while the movable fixtures this list is compared against carry
    // guarded keys. The moment the same-name guard collapses a person, the raw
    // id on this side stops matching the key on that side and a constraint that
    // fired BEFORE #396 disappears. Emitting both can only ever add.
    //
    // WHAT THIS DOES NOT ACHIEVE, honestly: `identity.keyOf` is built from THIS
    // division's person map, so a person who exists only in a sibling division
    // is never in a collapse bucket here and keeps their raw id. A human
    // entered under two `persons` rows where one row appears solely in the
    // sibling division therefore still does not collapse — the joint pack
    // (`buildCompetitionPack`, which resolves identity over the whole run) is
    // the path that sees that case. This restores the pre-#396 raw↔raw parity
    // and nothing more; the wider case is a filed follow-up.
    const siblings: Assignment[] = siblingsRaw.map((a) => ({
      ...a,
      people: [...new Set(a.people.flatMap((p) => [p, identity.keyOf(p)]))],
    }));

    // feeds.after: the fixtures that must finish before each one starts. Built
    // HERE — above the draft — because the participant recursion below needs it
    // and the greedy placer needs the participants.
    const afterMap = new Map<string, string[]>();
    for (const d of feedDependencies(all)) {
      (afterMap.get(d.fixtureId) ?? afterMap.set(d.fixtureId, []).get(d.fixtureId)!).push(d.dependsOn);
    }

    // A feeder list ordered on the FEEDER's stable domain key. It used to sort
    // on the raw feeder UUID, which no test could catch (the double-seed board
    // is a round-robin, where every `after` is empty) — a bracket board would
    // have shipped a reseed-unstable array inside the golden pack.
    const liteById = new Map(all.map((f) => [f.id, f]));
    const byFixtureOrder = (x: string, y: string): number => {
      const a = liteById.get(x);
      const b = liteById.get(y);
      if (a === undefined || b === undefined) return cmp(x, y);
      return byBoardOrder(boardOrderOf(a), boardOrderOf(b));
    };

    // #396: who could stand in each fixture, advancers behind a null slot
    // included. Computed ONCE, above the draft, so the greedy placer, the pack
    // and the verifier all read the same map.
    //
    // The SAME comparator `packMovable` uses (`byBoardOrder`), so `participants`
    // key order is the pack's own fixture order and survives a reseed of the
    // same board.
    const participantView: ParticipantFixture[] = [...movable]
      .sort((a, b) => byBoardOrder(boardOrderOf(a), boardOrderOf(b)))
      .map((f) => ({
        id: f.id,
        ext_key: f.ext_key,
        home: f.home_entrant_id,
        away: f.away_entrant_id,
        feeds: { after: [...(afterMap.get(f.id) ?? [])].sort(byFixtureOrder) },
      }));
    const stripped = stripByes(participantView);
    // ONE source of truth for `feeds.after`: the pack must not name a feeder the
    // model cannot see, and the verifier must not be handed a dependency the
    // placer ignored.
    const afterByFixture = new Map(stripped.fixtures.map((f) => [f.id, [...f.feeds.after]]));
    const participants = computeParticipants(stripped.fixtures, guardedPeople, {
      sortKey: personSortKey,
    });
    // `stripByes` names a stripped feeder by its raw id (it holds no fixture
    // outside the view). Substitute each feeder's ext_key — the stable domain
    // key the plan asks these strings to carry. A feeder with no ext_key keeps
    // its FULL uuid (never a fragment: the determinism test's redaction only
    // matches whole uuids).
    const extKeyById = new Map(all.map((f) => [f.id, f.ext_key]));
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    // …and order the list on the BOARD, never on the rendered text.
    // `fixtures.ext_key` is nullable, so a dependent or feeder without one keeps
    // a raw UUID inside its message and a text sort would order two assumptions
    // on a per-seed random value — exactly what `redact()`'s first-seen
    // placeholders turn into a double-seed determinism failure. The sort key is
    // the dependent's (round_no, seq_in_round) then the feeder's, which is
    // stable across reseeds of the same logical board.
    //
    // KEYED ON THE (dependent, feeder) PAIR, never on the feeder alone. In
    // double elimination one match legitimately feeds BOTH the winners' and the
    // losers' bracket, so two dependents strip the SAME feeder; a feeder-keyed
    // entry is then overwritten by whichever dependent is written last and the
    // two assumptions come out with identical ranks. They fall through to
    // `cmp(text)` — and a dependent with a null `ext_key` still carries its raw
    // UUID in that text, so the order becomes per-seed and the double-seed
    // determinism test breaks.
    const OUT_OF_BOARD = Number.MAX_SAFE_INTEGER;
    type AssumptionRank = readonly [number, number, number, number];
    const OUT_OF_BOARD_RANK: AssumptionRank = [
      OUT_OF_BOARD,
      OUT_OF_BOARD,
      OUT_OF_BOARD,
      OUT_OF_BOARD,
    ];
    // `stripByes` renders the dependent by its stable label (`ext_key ?? id`)
    // and the feeder by its raw id, so those two tokens are what identifies a
    // message — the pair key is built from the same two.
    const labelOf = (id: string): string => extKeyById.get(id) ?? id;
    const assumptionRank: { label: string; feederId: string; rank: AssumptionRank }[] = [];
    for (const f of participantView) {
      const dep = liteById.get(f.id);
      for (const feederId of f.feeds.after) {
        if (movableSet.has(feederId)) continue; // kept, so it raises no assumption
        const feeder = liteById.get(feederId);
        assumptionRank.push({
          label: labelOf(f.id),
          feederId,
          rank: [
            dep?.round_no ?? OUT_OF_BOARD,
            dep?.seq_in_round ?? OUT_OF_BOARD,
            feeder?.round_no ?? OUT_OF_BOARD,
            feeder?.seq_in_round ?? OUT_OF_BOARD,
          ],
        });
      }
    }
    // Read off the RAW string, before the ext_key substitution rewrites it: the
    // stripped feeder appears there as its uuid. The LONGEST matching dependent
    // label wins, so an ext_key that happens to be a substring of another
    // ("final" inside "semi-final") cannot claim the wrong message.
    const rankOf = (raw: string): AssumptionRank => {
      let best: AssumptionRank | undefined;
      let bestLabel = -1;
      for (const e of assumptionRank) {
        if (e.label.length <= bestLabel) continue;
        if (!raw.includes(e.feederId) || !raw.includes(e.label)) continue;
        best = e.rank;
        bestLabel = e.label.length;
      }
      return best ?? OUT_OF_BOARD_RANK;
    };
    const assumptions = [
      ...stripped.assumptions
        .map((a) => ({ rank: rankOf(a), text: a.replace(UUID_RE, (u) => extKeyById.get(u) ?? u) }))
        .sort(
          (x, y) =>
            x.rank[0] - y.rank[0] ||
            x.rank[1] - y.rank[1] ||
            x.rank[2] - y.rank[2] ||
            x.rank[3] - y.rank[3] ||
            cmp(x.text, y.text),
        )
        .map((x) => x.text),
      // Already ordered by normalised name inside the resolver.
      ...identity.assumptions,
    ];

    // The window (#397), in the org zone. Every boundary is a wall-clock day
    // boundary converted with zonedTimeToUtc — NOT startMs + 86_400_000,
    // because a DST day is 23 or 25 hours long.
    const dayStart = (ymd: string): number => zonedTimeToUtc(ymd, "00:00", orgTz);
    const dayEnd = (ymd: string): number =>
      zonedTimeToUtc(ymdAddDays(ymd, 1), "00:00", orgTz) - 1000;

    const baseStartMs = config.startAt
      ? new Date(config.startAt).getTime()
      : dayStart(clock.today);
    const baseEndYmd = config.endAt
      ? dayKeyInTz(new Date(config.endAt).getTime(), orgTz)
      : ymdAddDays(dayKeyInTz(baseStartMs, orgTz), DEFAULT_WINDOW_DAYS - 1);

    // Widen — never narrow — to cover what the organiser has already stated
    // explicitly (sessionWindows are absolute instants they set by hand) or
    // already scheduled. A repair round that reported every card it was handed
    // would teach the organiser to ignore the reason. Epoch sentinels are
    // excluded, or the window swallows 1970 and the bug this wave exists to
    // kill becomes invisible again.
    const occupiedMs = movable
      .filter((f) => f.scheduled_at !== null)
      .map((f) => new Date(f.scheduled_at as string | Date).getTime())
      .filter((t) => !isEpochSentinel(t));
    // A sessionWindow anchored at the epoch is the same input by another door,
    // and widening onto it hides the defect just as thoroughly — a window that
    // opens in 1970 can never be broken. Filtered on the pair so a half-epoch
    // window cannot contribute one usable end and one sentinel.
    const sessionMs = config.sessionWindows
      .map((w) => ({ from: new Date(w.from).getTime(), to: new Date(w.to).getTime() }))
      .filter((w) => !isEpochSentinel(w.from) && !isEpochSentinel(w.to));
    const windowStartMs = Math.min(baseStartMs, ...sessionMs.map((w) => w.from), ...occupiedMs);
    const windowEndMs = Math.max(
      dayEnd(baseEndYmd),
      ...sessionMs.map((w) => w.to),
      ...occupiedMs.map((t) => t + matchMinutes * MS_PER_MIN),
    );
    // #398: the compiled instruction resolves LAST and wins outright. Widening
    // onto already-scheduled dates is right for an inferred window, but it would
    // silently defeat "run all the matches from tomorrow till Friday" — the one
    // window the organiser stated in words. Rendering stays here so there is a
    // single writer of the pack's window strings.
    const resolved =
      opts.resolved ?? resolveParsed(opts.raw ?? null, clock, orgTz, { fixtureCount: movable.length });
    const window =
      resolved.windowMs !== null
        ? {
            start: zonedIso(dayStart(dayKeyInTz(resolved.windowMs.from, orgTz)), orgTz),
            end: zonedIso(dayEnd(dayKeyInTz(resolved.windowMs.to, orgTz)), orgTz),
          }
        : {
            start: zonedIso(dayStart(dayKeyInTz(windowStartMs, orgTz)), orgTz),
            end: zonedIso(dayEnd(dayKeyInTz(windowEndMs, orgTz)), orgTz),
          };
    assumptions.push(...resolved.assumptions);
    // The greedy draft anchors on the window the pack actually ships. Anchored
    // on the inferred start instead, "from tomorrow till Friday" hands the model
    // a draft that sits OUTSIDE `pack.window` — every card arrives pre-flagged,
    // and the model is asked to repair a board we drew wrong.
    const draftAnchorMs = resolved.windowMs?.from ?? windowStartMs;

    // Draft: generate → greedy slotFixtures; refine → the prior proposal
    // verbatim; repair → the movable set's current persisted slots.
    let draft: PackDraftAssignment[];
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
        // #396: participants, not named entrants — a TBD slot carries whoever
        // can still advance into it, and the placer must respect that or it
        // hands the referee a board the referee will reject.
        people: participants[f.id] ?? [],
        // Pinned/scope-locked cards stay put — feed them to the solver as-is.
        ...(f.schedule_locked && f.scheduled_at !== null && f.court_label !== null
          ? { locked: { court: f.court_label, startAt: new Date(f.scheduled_at).getTime() } }
          : {}),
      }));
      const result = slotFixtures({
        fixtures: schedulable,
        // Was `0` — the epoch. `toSlotConfig` uses this only when the division
        // has no configured startAt, and with 0 the model was handed
        // 1970-01-01 as the draft time for every fixture (#397). The honest
        // fallback is the first session hour of the window's first day, in the
        // org zone.
        config: toSlotConfig(
          settings,
          zonedTimeToUtc(dayKeyInTz(draftAnchorMs, orgTz), DEFAULT_SESSION_HOURS.start, orgTz),
        ),
        // extraExisting is the #350 joint pack's already-drafted divisions;
        // empty for every single-division caller.
        existing: [...obstacleAssignments, ...siblings, ...(opts.extraExisting ?? [])],
      });
      draft = result.assignments.map((a) => ({
        fixture_id: realIdByRank.get(a.fixtureId) ?? a.fixtureId,
        scheduled_at: zonedIso(a.startAt, orgTz),
        court_label: a.court,
      }));
    } else if (opts.mode === "refine") {
      draft = (opts.prior?.assignments ?? [])
        .filter((a) => movableSet.has(a.fixture_id))
        .map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: zonedIso(a.scheduled_at, orgTz),
          court_label: a.court_label,
        }));
    } else {
      draft = movable
        .filter((f) => f.scheduled_at !== null && f.court_label !== null)
        .map((f) => ({
          fixture_id: f.id,
          scheduled_at: zonedIso(f.scheduled_at as string | Date, orgTz),
          court_label: f.court_label as string,
        }));
    }
    // Sentinel kill (#397). A time that predates 1971 is not a fixture time — it
    // is a division that was drafted at the epoch, or a row written before this
    // fix. Null is an honest "unplaced"; 1970-01-01 is a lie, and the model
    // anchors on it. Tested on the instant rather than the rendered string on
    // purpose: west of UTC the epoch renders as 1969-12-31.
    draft = draft.map((d) =>
      d.scheduled_at !== null && isEpochSentinel(new Date(d.scheduled_at).getTime())
        ? { ...d, scheduled_at: null }
        : d,
    );
    draft.sort(byAssignment);

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
          // Bye/finished feeders already stripped, ordered on the feeder's
          // domain key — see `afterByFixture` above.
          after: [...(afterByFixture.get(f.id) ?? [])],
        },
        current: {
          at:
            f.scheduled_at !== null &&
            !isEpochSentinel(new Date(f.scheduled_at as string | Date).getTime())
              ? zonedIso(f.scheduled_at, orgTz)
              : null,
          court: f.court_label,
        },
        pinned: f.schedule_locked,
      }))
      // Same comparator as `participantView` above — see `byBoardOrder`.
      .sort(byBoardOrder);

    const packObstacles: PackObstacle[] = [
      ...obstacleFixtures.map((f) => {
        const start = new Date(f.scheduled_at as string | Date).getTime();
        return {
          court: f.court_label as string,
          from: zonedIso(start, orgTz),
          to: zonedIso(start + matchMinutes * MS_PER_MIN, orgTz),
          label: `${division.name} · R${f.round_no}`,
        };
      }),
      // Siblings carry no display metadata through siblingAssignments — soft
      // context, so a generic label is enough (never leaks a rival's roster).
      ...siblings.map((a) => ({
        court: a.court,
        from: zonedIso(a.startAt, orgTz),
        to: zonedIso(a.endAt, orgTz),
        label: OTHER_DIVISION_LABEL,
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
        zonedIso(r.scheduled_at, orgTz),
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
        .map((w) => ({ from: zonedIso(w.from, orgTz), to: zonedIso(w.to, orgTz) }))
        .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)),
      blackouts: config.blackouts
        .map((b) => ({
          ...(b.court !== undefined ? { court: b.court } : {}),
          from: zonedIso(b.from, orgTz),
          to: zonedIso(b.to, orgTz),
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
              ...(w.notBefore !== undefined ? { notBefore: zonedIso(w.notBefore, orgTz) } : {}),
              ...(w.notAfter !== undefined ? { notAfter: zonedIso(w.notAfter, orgTz) } : {}),
            })),
            fieldFairness: config.constraints.fieldFairness,
            parallelism: config.constraints.parallelism,
            crossPersonClash: config.constraints.crossPersonClash,
            // OMITTED when empty, never `[]`. Absence already means "no durable
            // rules", and emitting an empty array on every pack would change the
            // shape of every instruction-free run for no information.
            ...(config.constraints.hard?.length ? { hard: config.constraints.hard } : {}),
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
      tz: orgTz,
      clock,
      window,
      sessionHours: { ...DEFAULT_SESSION_HOURS },
      parsed: { hard: resolved.hard, soft: resolved.soft, unparsed: resolved.unparsed },
      settings: settingsOut,
      entrants: packEntrants,
      people: packPeople,
      participants,
      assumptions,
      fixtures: { movable: packMovable, obstacles: packObstacles },
      draft,
      instruction: opts.instruction,
      prior: opts.prior
        ? {
            instruction: opts.prior.instruction,
            assignments: opts.prior.assignments
              .map((a) => ({
                fixture_id: a.fixture_id,
                scheduled_at: zonedIso(a.scheduled_at, orgTz),
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
// ROUND_TIMEOUT_MS / MAX_REPAIR_ROUNDS / MAX_TOKENS below are exported for the
// #350 joint runner (competition-schedule-ai.ts), which drives the same round
// loop over a multi-division pack and must not fork these numbers. Export only —
// no caller behaviour changes.
export const ROUND_TIMEOUT_MS = Number(process.env.SCHEDULING_AI_ROUND_TIMEOUT_MS) || 600_000;
export const MAX_REPAIR_ROUNDS = 2;

/** Output token ceiling per round. Configurable per environment (same
 *  philosophy as AI_PROVIDER) so a candidate that spends its whole budget on
 *  reasoning can be given more room without a code change. Default of
 *  32_000 is unchanged from the hardcoded value, so the shipped Anthropic
 *  path behaves identically unless this is explicitly overridden. */
export const MAX_TOKENS = Number(process.env.SCHEDULING_AI_MAX_TOKENS) || 32_000;

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
  unschedulable: { fixture_id: string; reason: string; rule: RuleCode }[];
  warnings: Conflict[]; // non-blocking verifier conflicts
  blocking: Conflict[]; // residual after ≤2 repairs
  diff: { moved: string[]; placed: string[]; unscheduled: string[]; unchanged: string[] };
  explanations: { fixture_id: string; note: string }[];
  constraint_suggestions?: Partial<SchedulingConstraints>;
  summary: string;
  /** W5 (#400): the ARCHITECT's own assumptions — what it assumed while placing.
   *  Produced on every run since v4 and dropped at the response build until now,
   *  so the organiser reviewed a proposal without seeing the reading it was
   *  built on. NOT the resolver's assumptions (stage 1, shown at the preview);
   *  the two arrays are never merged. Always an array, never undefined. */
  assumptions: string[];
  // cost_usd is the provider-reported cost when available, falling back to a
  // derived estimate per round; null only when neither is computable.
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number; cost_usd: number | null };
  /** W6 (#401): how this board reached its final state. `engine: "none"` means
   *  no repair changed it — it verified clean, or repair was attempted and
   *  nothing was adopted. Everything else the solver observed rides alongside,
   *  including the paths where it never ran, because #401 requires the LLM
   *  fallback to be TELEMETRY-VISIBLE rather than merely correct. */
  repair: RepairReport;
}

// A verifier conflict blocks when it makes the schedule physically impossible —
// a court double-booking, or a direct feed scheduled before its source ends.
// Same taxonomy as the drag-drop board (schedule.ts mapConflicts). Rest,
// blackout, session-window, person-overlap and indirect order land in warnings.
// Exported so the #350 joint runner classifies a joint conflict report with the
// SAME taxonomy — a cross-division court clash must block exactly as a
// within-division one does.
// #399 moved the answer itself into the engine, beside the reasons: the board's
// persistence gates need it too, and `schedule.ts` cannot import this module
// (the dependency runs the other way). Re-exported under the name every call
// site already uses.
export const isBlocking = isBlockingConflict;

/** Only the codes a `Conflict` can carry. The prompts also teach H1 and H7, and
 *  the joint J-series, but none of those map to a `ConflictReason` — passing one
 *  through would put a value nothing can render into the wire enum. */
const CITED_RULE = /\b(H[2-6]|H8)\b/;

/**
 * The rule an unschedulable row breaks (#399). The prompt asks the model to cite
 * the hard rule that stopped it, so when it did, that is the answer. When it did
 * not, the honest answer is `CAP`: demand exceeded capacity, no single rule was
 * violated, and the schedule simply cannot exist. A rule code invented for that
 * case would send the repair round after something that is not wrong.
 */
export function unschedulableRule(reason: string): RuleCode {
  return (CITED_RULE.exec(reason.toUpperCase())?.[0] as RuleCode | undefined) ?? "CAP";
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
 *  people come from the pack so the verifier can catch overlaps. */
function toEngineAssignments(plan: AiSchedulePlan, pack: SchedulePack): Assignment[] {
  const fixtureById = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
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
      // #396: participants, not the shared-player map — a TBD slot carries
      // whoever can still advance into it, which is what every person rule
      // needs and what `pack.people` (pairs sharing an entrant) never had.
      people: pack.participants[a.fixture_id] ?? [],
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

/**
 * THE one place a `RuleFixture` is built — for the single-division pack here and
 * for both joint producers in `competition-schedule-ai.ts` (#443).
 *
 * It is one function rather than three literals because of what #443 was: two
 * copies of a join drifted onto a shared wrong assumption, and the second copy
 * is exactly what made the first invisible. `winnerTo` and `id` must stay in ONE
 * namespace — `winnerTo` carries `fixtures.winner_to_fixture`, a uuid FK to
 * `fixtures.id`, and the engine now joins the feed edge on that id. `extKey`
 * carries `fixtures.ext_key`, nullable text, and is a different namespace with
 * no converter anywhere.
 *
 * A producer that put an ext key in `winnerTo` would type-check — `RuleFixture`
 * declares both `string | null` — and would fail SILENTLY, because a join that
 * resolves nothing reports nothing: `min_rest_minutes` would go on compiling and
 * displaying as enforced while binding nothing at all. One producer means one
 * thing to guard, and `schedule-ai-repair.test.ts` guards it.
 *
 * `divisionId` is a parameter because the two packs source it differently: the
 * single-division pack takes it from the division it is a pack OF, the joint
 * pack from each fixture's own `division_id`.
 */
export function toRuleFixture(f: PackFixture, divisionId: string): RuleFixture {
  return {
    id: f.id,
    extKey: f.ext_key,
    divisionId,
    ...(f.pool !== null ? { poolId: f.pool } : {}),
    winnerTo: f.feeds.winner_to,
  };
}

/** The fixture metadata typed rules need and `Assignment` does not carry (#398).
 *  `winnerTo` is the ONLY definition of terminal — never a round number, which
 *  is a display label an elimination bracket numbers sparsely. */
export function packRuleFixtures(pack: SchedulePack): RuleFixture[] {
  return pack.fixtures.movable.map((f) => toRuleFixture(f, pack.division.id));
}

/** Exported for the same reason the joint twin `verifyConfigFor` is: it is a
 *  pure derivation of the pack, and a test that asserts what the referee is
 *  handed must be able to build it the way the runner does. */
export function verifyConfig(pack: SchedulePack): VerifyConfig {
  return {
    // #398: the org zone plus ONE merged hard-rule stream. A rule compiled from
    // the instruction and a durable division rule are the same vocabulary and
    // the same enforcement, so the referee reads one list. No `restByDivision`
    // here — a single-division run has only one division's rest to be the
    // maximum of.
    tz: pack.tz,
    hard: [...pack.parsed.hard, ...(pack.settings.constraints?.hard ?? [])],
    ruleFixtures: packRuleFixtures(pack),
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
    // #397: the resolved window, in the engine's epoch-ms unit. Warn-only —
    // `isBlocking` still covers court and direct order alone, and W4 (#399) is
    // what turns this into a delta-based block.
    window: windowBounds(pack.window),
  };
}

/**
 * The pack renders the window's end as the last whole SECOND of the final day
 * (`…T23:59:59`) — the form a model reads correctly. The engine compares an
 * ms-resolution `endAt` against it, so the bound it needs is the EXCLUSIVE
 * instant after that second: a 22:30 match of 90 minutes ends at exactly
 * 00:00:00.000 and occupies only days inside the window, but `endAt > to`
 * against 23:59:59.000 reports it against the very day it legally sits on.
 * Shared with the joint verifier so the two cannot drift.
 */
export function windowBounds(window: { start: string; end: string }): { from: number; to: number } {
  return { from: toMs(window.start), to: toMs(window.end) + 1000 };
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
  maxTokens: number = MAX_TOKENS,
): Promise<AiChatResponse<AiSchedulePlan> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUND_TIMEOUT_MS);
  try {
    return await provider.chat({
      model,
      system: SINGLE_SYSTEM_PROMPT,
      messages,
      maxTokens,
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
 * @throws HttpError 503 (the resolved AI provider is not configured — no
 *   ANTHROPIC_API_KEY for an Anthropic rung, no OPENROUTER_API_KEY for an
 *   OpenRouter rung), 422 AI_PLAN_FAILED (model refusal, or an un-correctable
 *   structural violation), 422 AI_PLAN_TIMEOUT.
 */
export async function runAiPlan(
  pack: SchedulePack,
  movableIds: Set<string>,
  modelOverride?: string,
  providerName?: ProviderName,
  /** The run's cumulative token meter (lib/ai-rung.ts). ONE instance is shared
   *  by every ladder rung, so the hard budget spans the whole run instead of
   *  resetting per rung. Defaults to an unmetered one — behaviour is unchanged
   *  for callers that do not price a run. */
  meter: TokenMeter = unmeteredTokenMeter(),
): Promise<AiPlanResult> {
  // One provider per run: reasoning blocks are provider-specific and replayed
  // verbatim on repair, so a run that resolved a provider per round could send
  // one service's reasoning to another. 503 before any network if unconfigured.
  // A ladder rung pins its provider explicitly (never via AI_PROVIDER — that is
  // process-global and unsafe under concurrency); an unset name falls back to
  // the env-selected provider, exactly as before this parameter existed.
  const provider = providerName ? resolveProvider(providerName) : selectProvider();
  if (!provider.isConfigured()) {
    throw new HttpError(503, "AI scheduling is not configured on this server", "AI_PROVIDER_NOT_CONFIGURED");
  }
  const model = modelOverride ?? schedulingAiModel();

  const conversation: AiTurn[] = [{ role: "user", content: JSON.stringify(toModelPayload(pack)) }];
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
  // `engine` rides along per candidate rather than being tracked for the run:
  // the winning board can be an earlier round's, and "which engine repaired
  // this" is a fact about the board returned, not about the run.
  let best: { plan: AiSchedulePlan; blocking: Conflict[]; warnings: Conflict[]; engine: RepairEngine } | null = null;

  // #401 solver state. The budget is per RUN, not per round: the solver is
  // tried before every repair round, and a run that met its budget three times
  // over would add three times the latency it was sized for.
  const pinnedIds = new Set(pack.fixtures.movable.filter((f) => f.pinned).map((f) => f.id));
  let solverBudgetLeft = solverBudgetMs();
  let solverAttempts = 0;
  let repairTelemetry: SolverTelemetry = { solver_ran: false };

  // Accumulated usage rides along on a 422 too, so callers can meter a refused
  // or un-correctable run rather than losing the tokens already spent.
  const usageNow = () => ({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    repair_rounds: repairRounds,
    cost_usd: costUsd,
  });

  const finalizeFrom = (chosen: NonNullable<typeof best>): AiPlanResult => ({
    proposal: chosen.plan.assignments.map((a) => ({
      fixture_id: a.fixture_id,
      scheduled_at: a.scheduled_at,
      court_label: a.court_label,
      ...(a.schedule_locked !== undefined ? { schedule_locked: a.schedule_locked } : {}),
    })),
    // #399: every unplaced fixture carries a code — the rule the model cited,
    // or CAP when it named none (the capacity case).
    unschedulable: chosen.plan.unschedulable.map((u) => ({
      ...u,
      rule: unschedulableRule(u.reason),
    })),
    warnings: chosen.warnings,
    blocking: chosen.blocking,
    diff: computeDiff(chosen.plan, pack),
    explanations: chosen.plan.explanations,
    ...(chosen.plan.constraint_suggestions !== undefined
      ? { constraint_suggestions: chosen.plan.constraint_suggestions }
      : {}),
    summary: chosen.plan.summary,
    // `.max(10).optional()` on the prompt schema — the model omits it routinely,
    // and the review panel maps over the array.
    assumptions: chosen.plan.assumptions ?? [],
    usage: usageNow(),
    repair: { engine: chosen.engine, ...repairTelemetry },
  });

  for (;;) {
    // Hard token budget (design §5). The meter already holds every prior
    // round's AND every prior ladder rung's output tokens, so there is nothing
    // to add here. Below the reserve, stop asking for another round — ship the
    // best plan already produced, or (nothing produced yet) fail in a way
    // runLadder can recover from.
    if (!meter.canStartRound()) {
      if (best !== null) return finalizeFrom(best);
      throw new HttpError(
        422,
        "AI scheduling stopped: token budget exhausted before a usable plan was produced",
        "AI_PLAN_FAILED",
        { usage: usageNow() },
      );
    }
    const roundMaxTokens = meter.clampRound(MAX_TOKENS);

    let response: Awaited<ReturnType<typeof callModel>>;
    try {
      response = await callModel(provider, model, conversation, roundMaxTokens);
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
    // Charge the run's meter the moment usage is known — BEFORE any of the
    // throw paths below. A round that spent tokens and then refused/failed to
    // parse must still count against the budget, or a run could loop past its
    // cap on failures alone.
    meter.add(roundOutput);
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
    let chosen: AiSchedulePlan = plan!;
    let conflicts = validateAssignments(toEngineAssignments(chosen, pack), config, obstacles, dependencies);
    let blocking = conflicts.filter(isBlocking);
    // A board straight from the model carries no repair of ours; a board a
    // repair round produced carries the LLM's.
    let boardEngine: RepairEngine = repairRounds === 0 ? "none" : "llm";
    /** Fixtures the solver could not resolve — handed to the LLM round below so
     *  it is pointed at the residue rather than left to re-derive it. */
    let unresolved: readonly string[] = [];

    // ---- #401: solve before asking the model again -------------------------
    // The solver costs no tokens, no credits and no SDK call, so the only thing
    // a failed attempt spends is its own bounded wall clock. Every failure —
    // switched off, queued, out of budget, infeasible, thrown — falls through to
    // the LLM repair path exactly as this loop behaved before the wave, and says
    // so in `repair`.
    //
    // The MIN guard applies from the second attempt on: the first attempt runs
    // whatever budget it was given, so an operator who sets the budget very low
    // still gets the attempt (and the telemetry) they configured.
    if (blocking.length > 0 && (solverAttempts === 0 || solverBudgetLeft >= SOLVER_MIN_BUDGET_MS)) {
      solverAttempts++;
      const board = toEngineAssignments(chosen, pack);
      const attempt = await solveBoard({
        // A pinned fixture is not the solver's to move — `structuralCheck`
        // already refuses a model that moves one, and the solver must be held
        // to the same rule. It goes in as immovable occupancy instead, so it
        // still blocks the court and still owes its rest.
        proposal: board.filter((a) => !pinnedIds.has(a.fixtureId)),
        existing: [...obstacles, ...board.filter((a) => pinnedIds.has(a.fixtureId))],
        dependencies,
        config: { ...config, courts: pack.settings.courts },
        budgetMs: Math.max(solverBudgetLeft, 1),
      });
      solverBudgetLeft -= attempt.telemetry.ms ?? 0;
      // A later attempt that never reached the solver must not erase an earlier
      // one that did.
      if (attempt.telemetry.solver_ran || !repairTelemetry.solver_ran) {
        repairTelemetry = attempt.telemetry;
      }
      unresolved = attempt.unresolvedFixtureIds;

      if (attempt.assignments !== null && attempt.movedFixtureIds.length > 0) {
        const patched = applySolverMoves(
          chosen,
          attempt.assignments,
          attempt.movedFixtureIds,
          (instantMs) => zonedIso(instantMs, pack.tz),
        );
        const after = validateAssignments(toEngineAssignments(patched, pack), config, obstacles, dependencies);
        const afterBlocking = after.filter(isBlocking);
        // ADOPTION GATE: strictly fewer BLOCKING conflicts, judged by this
        // runner's own verifier rather than by the solver's internal one. A
        // solver answer that trades a blocking conflict for warnings is still a
        // good trade — a warning is a quality note, a blocking conflict is an
        // impossible board — so warnings are recorded, never a veto.
        if (afterBlocking.length < blocking.length) {
          chosen = patched;
          conflicts = after;
          blocking = afterBlocking;
          boardEngine = "z3";
        } else {
          repairTelemetry = { ...repairTelemetry, fallback: "not_adopted" };
        }
      }
    }

    const warnings = conflicts.filter((c) => !isBlocking(c));

    // Keep the fewest-blocking plan; `<=` lets a later round win an exact tie.
    if (best === null || blocking.length <= best.blocking.length) {
      best = { plan: chosen, blocking, warnings, engine: boardEngine };
    }

    if (blocking.length === 0 || repairRounds >= MAX_REPAIR_ROUNDS) {
      return finalizeFrom(best!);
    }

    // Blocking conflicts remain and rounds are left — send the report back and
    // ask for minimal fixes (01 §5).
    //
    // HAND-OFF POLICY (#401), stated once because it is a choice and not a
    // consequence: BLOCKING residue is mandatory work and always triggers this
    // round. Non-blocking residue left behind by a solver that RELAXED a family
    // does not trigger a round of its own — the board is legal, and spending a
    // paid round on a quality note the organiser can see would be the wrong
    // trade. It stays visible in two places: `warnings` (which the review panel
    // renders and `planIsAcceptable` already counts toward ladder escalation)
    // and `repair.relaxed` / `repair.residual`.
    repairRounds++;
    conversation.push(response?.assistantTurn ?? { role: "assistant", content: [] });
    conversation.push({
      role: "user",
      content: JSON.stringify({
        verifier_conflicts: conflicts,
        // When the solver moved fixtures, the model's own last turn is no longer
        // the board these conflicts were measured on. Send the board, or it
        // repairs a plan nobody holds and silently discards the solver's work.
        ...(boardEngine === "z3" ? { repaired_assignments: chosen.assignments } : {}),
        ...(unresolved.length > 0 ? { focus_fixture_ids: [...unresolved] } : {}),
        note:
          boardEngine === "z3"
            ? "An automatic solver has already moved some fixtures to clear other conflicts. `repaired_assignments` is the board these conflicts were measured on and it REPLACES your previous output — start from it. Fix only these conflicts, concentrating on focus_fixture_ids. Move as few fixtures as possible. Do not reintroduce earlier conflicts."
            : "Fix only these conflicts. Move as few fixtures as possible. Do not reintroduce earlier conflicts.",
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
 *  cross-person), so they are judged against pack size rather than absolutely.
 *
 *  Exported for the #350 joint ladder, and its parameter widened from
 *  AiPlanResult to the two fields it actually reads so a joint result (which
 *  carries division-tagged proposals) satisfies it without a cast. No caller
 *  behaviour changes — every existing AiPlanResult still matches. */
export function planIsAcceptable(
  result: Pick<AiPlanResult, "blocking" | "warnings">,
  movableCount: number,
): boolean {
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

/** The shipped default fallback ladder: cheap/fast primary → proven backstop →
 *  last-ditch. Rungs whose provider has no API key are SKIPPED at run time (see
 *  isConfigured / isRecoverable), so a deployment with only ANTHROPIC_API_KEY
 *  transparently resolves to sonnet-direct; the gemini/grok rungs activate only
 *  once OPENROUTER_API_KEY is present. That key is the deliberate production
 *  flip — no separate SCHEDULING_AI_LADDER needed. */
export const DEFAULT_LADDER: readonly LadderRung[] = [
  { provider: "openrouter", model: "google/gemini-3.6-flash" },
  { provider: "anthropic", model: "claude-sonnet-5" },
  { provider: "openrouter", model: "x-ai/grok-4.5" },
];

/** The ordered candidate list for one architect run. Precedence:
 *    1. SCHEDULING_AI_LADDER       — explicit ladder, used verbatim.
 *    2. SCHEDULING_AI_MODEL         — explicit single-model pin (no fallback),
 *       on the AI_PROVIDER transport; the "force exactly this model" escape
 *       hatch (also what the bench pins, though the bench calls runAiPlan
 *       directly and never reaches here).
 *    3. SCHEDULING_AI_CHEAP_MODEL   — legacy cheap→primary escalation.
 *    4. DEFAULT_LADDER              — the shipped default (gemini→sonnet→grok).
 *  Because unconfigured rungs are skipped, (4) resolves to sonnet-direct until
 *  OPENROUTER_API_KEY is set, so nothing about a no-OpenRouter deployment
 *  changes. */
export function planRungs(): LadderRung[] {
  const ladder = schedulingAiLadder();
  if (ladder) return ladder;
  const provider: ProviderName = process.env.AI_PROVIDER === "openrouter" ? "openrouter" : "anthropic";
  if (process.env.SCHEDULING_AI_MODEL) return [{ provider, model: process.env.SCHEDULING_AI_MODEL }];
  const cheap = schedulingAiCheapModel();
  if (cheap && cheap !== schedulingAiModel()) {
    return [{ provider, model: cheap }, { provider, model: schedulingAiModel() }];
  }
  return [...DEFAULT_LADDER];
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
 *  produce (AI_PLAN_FAILED / AI_PLAN_TIMEOUT), a transport/API failure
 *  (AiProviderError — unparsable body, 5xx, refusal), or a rung whose provider
 *  simply has no API key here (AI_PROVIDER_NOT_CONFIGURED — skip it) is
 *  recoverable by a different model/provider. A deterministic user error (empty
 *  scope, too large, 400/404) is NOT — it would fail identically on every rung.
 *
 *  Skipping unconfigured rungs is what lets DEFAULT_LADDER ship safely: a
 *  deployment with only ANTHROPIC_API_KEY skips the gemini/grok rungs and lands
 *  on sonnet-direct; if EVERY rung is unconfigured, the last one's 503
 *  propagates unchanged. */
function isRecoverable(err: unknown): boolean {
  if (err instanceof AiProviderError) return true;
  return (
    err instanceof HttpError &&
    (err.code === "AI_PLAN_FAILED" ||
      err.code === "AI_PLAN_TIMEOUT" ||
      err.code === "AI_PROVIDER_NOT_CONFIGURED")
  );
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
 *
 * The hard token budget (lib/ai-rung.ts) needs NOTHING from this function: the
 * caller closes over one `TokenMeter` and hands the same instance to every
 * rung's runner, which charges it per round. Cross-rung accounting therefore
 * cannot drift from the ladder's own `acc`, and a rung that throws without
 * riding its usage on the error still has its tokens counted.
 */
export async function runLadder<T extends { usage: Usage }>(
  rungs: LadderRung[],
  attempt: (rung: LadderRung) => Promise<T>,
  acceptable: (result: T) => boolean,
  /** Asked BEFORE each rung after the first. Returning false stops escalation
   *  without recording the rung — a budget-exhausted run must not list models
   *  it never actually asked in `rungs_tried`. */
  canEscalate?: () => boolean,
): Promise<T & { served_model: string; escalated_from?: string; rungs_tried: string[] }> {
  let acc: Usage = { input_tokens: 0, output_tokens: 0, repair_rounds: 0, cost_usd: 0 };
  const tried: string[] = [];
  // Best-so-far USABLE plan (a rung returned it, but it failed `acceptable`).
  // A degraded-but-real plan beats any failure, so if every later rung throws or
  // is skipped (unconfigured), this is returned rather than surfacing an error —
  // exactly what the old single-rung path did when sonnet was the terminal rung.
  let bestEffort: { result: T; model: string } | null = null;
  // Most recent MEANINGFUL failure (anything but a skipped-because-unconfigured
  // rung) + the model that raised it. Thrown on exhaustion ONLY when no usable
  // plan exists, in preference to a trailing "not configured" skip — so a real
  // outage / AI_PLAN_FAILED on a configured rung surfaces with its true code, not
  // a spurious 503-not-configured.
  let meaningful: { err: unknown; model: string } | null = null;
  const finalize = (result: T, model: string) => ({
    ...result,
    usage: acc,
    served_model: model,
    rungs_tried: tried,
    ...(tried.length > 1 ? { escalated_from: tried[0] } : {}),
  });
  // Exhausted (the ladder ran out of rungs, or escalation was stopped early).
  // A usable (if degraded) plan beats any failure — ship it. Otherwise throw the
  // last MEANINGFUL failure over a trailing unconfigured skip, carrying the
  // accumulated spend + the model that raised it. HttpError.extra is read-only
  // → rebuild it; provider errors take loose fields.
  const exhaust = (err: unknown, model: string): never => {
    const chosen = meaningful ?? { err, model };
    if (chosen.err instanceof HttpError) {
      throw new HttpError(chosen.err.status, chosen.err.message, chosen.err.code, {
        ...(chosen.err.extra ?? {}),
        usage: acc,
        model: chosen.model,
      });
    }
    (chosen.err as { usage?: Usage; model?: string }).usage = acc;
    (chosen.err as { model?: string }).model = chosen.model;
    throw chosen.err;
  };
  for (let i = 0; i < rungs.length; i++) {
    const rung = rungs[i]!;
    const last = i === rungs.length - 1;
    if (i > 0 && canEscalate && !canEscalate()) {
      if (bestEffort) return finalize(bestEffort.result, bestEffort.model);
      exhaust(
        meaningful?.err ?? new HttpError(422, "AI planning stopped before a usable plan", "AI_PLAN_FAILED"),
        tried[tried.length - 1] ?? rung.model,
      );
    }
    tried.push(rung.model);
    try {
      const result = await attempt(rung);
      acc = addUsage(acc, result.usage);
      if (acceptable(result)) return finalize(result, rung.model); // clean win — stop
      bestEffort = { result, model: rung.model }; // usable but degraded — remember
      if (last) return finalize(result, rung.model); // nothing better left to try
    } catch (err) {
      if (!isRecoverable(err)) throw err;
      acc = addUsage(acc, (err as { extra?: { usage?: Partial<Usage> } }).extra?.usage ?? {});
      const unconfigured = err instanceof HttpError && err.code === "AI_PROVIDER_NOT_CONFIGURED";
      if (!unconfigured) meaningful = { err, model: rung.model };
      if (last) {
        if (bestEffort) return finalize(bestEffort.result, bestEffort.model);
        exhaust(err, rung.model);
      }
    }
  }
  // Unreachable: a non-empty ladder's final rung always returns or throws.
  throw new HttpError(500, "model ladder exhausted without a result", "AI_PLAN_FAILED");
}

/** Wire the ladder to the real architect: each rung runs on its own provider,
 *  and a degraded plan escalates via the existing quality gate. The `meter`
 *  (lib/ai-rung.ts) is the SAME instance for every rung, so the run's hard
 *  token budget spans the whole ladder rather than resetting per rung.
 *
 *  Escalation stops the moment the meter refuses a round: continuing would
 *  enter each remaining rung only to have it throw before any network call,
 *  which spends nothing but writes models into `rungs_tried` that were never
 *  actually asked. */
async function runAiPlanLadder(
  pack: SchedulePack,
  movableIds: Set<string>,
  meter: TokenMeter,
): Promise<AiPlanResult & { served_model: string; escalated_from?: string; rungs_tried: string[] }> {
  return runLadder(
    planRungs(),
    (rung) => runAiPlan(pack, movableIds, rung.model, rung.provider, meter),
    (result) => planIsAcceptable(result, movableIds.size),
    () => !meter.stoppedOnBudget,
  );
}

/**
 * POST /divisions/{id}/schedule/ai-plan orchestrator. Gate order is deliberate
 * (design/v4/00 §5, wallet per SPEC-2 §5.2): the staged-rollout kill switch
 * (fail-open) → the paid gate (`scheduling.ai`, 402) → the frozen-division
 * check → the spend limiter (5/division/hour, 429) → build the deterministic
 * pack → reserve 1 AI credit, run the architect, settle/release (402 on an
 * empty wallet, right before the LLM call) → append the schedule.ai_generated
 * audit event → optional dry officials coverage. Telemetry fires on success AND
 * on a 422 AI_PLAN_FAILED (usage rides on the error's extra) so refused spend is
 * still metered.
 *
 * @throws HttpError 403 FEATURE_DISABLED (kill switch), 402 (paid gate or an
 *   empty AI credit wallet), 409 SCHEDULE_LOCKED (frozen division — refused
 *   before the spend gates), 429 (rate limit), plus everything
 *   buildSchedulePack/runAiPlan raise (409/422/400/503).
 */
export async function aiPlanForDivision(
  auth: AuthCtx,
  divisionId: string,
  input: AiPlanRequest,
): Promise<AiPlanResponse> {
  // W5 (#400) Task 2b/H3. The confirmation is claimed early — before the pack,
  // the quote and the reserve — because an atomic single-use claim is the only
  // thing that makes a double-submitted confirm buy ONE run under READ
  // COMMITTED. The claim therefore has to be given back when the run never got
  // as far as reserving a credit, or an empty wallet or an unplannable division
  // would silently cost the organiser their confirmation and a second compile.
  //
  // The test is "was anything BOUGHT", not "did the reserve succeed" — the two
  // differ on every failure of the architect itself, which `spendCredit`
  // refunds. `creditConsumed` is therefore set inside the callback and unset
  // again by `onHoldReleased`; a settle failure leaves it set, because there the
  // run happened and the credit really is gone.
  const claim: PreviewClaim = { previewId: null, creditConsumed: false };
  try {
    return await planForDivision(auth, divisionId, input, claim);
  } catch (err) {
    if (claim.previewId !== null && !claim.creditConsumed) {
      await releasePreviewQuietly(claim.previewId, auth.orgId);
    }
    throw err;
  }
}

/** Mutable out-parameter for the release above: what this run claimed, and
 *  whether the organiser ended up paying for it. */
export interface PreviewClaim {
  previewId: string | null;
  creditConsumed: boolean;
}

/**
 * Hand a confirmation back without ever displacing the error that caused it.
 *
 * Both wrappers call this from a `catch`, so an unhandled throw here would
 * replace the 402/422 the caller has to see with a database error about a
 * bookkeeping detail. The worst case of swallowing it is the state we already
 * had before this fix — a preview that stays claimed — which is strictly better
 * than losing the real refusal.
 */
export async function releasePreviewQuietly(previewId: string, orgId: string): Promise<void> {
  try {
    await releasePreview(previewId, orgId);
  } catch (err) {
    console.error(`[schedule-ai] could not release preview ${previewId} after a failed run`, err);
  }
}

async function planForDivision(
  auth: AuthCtx,
  divisionId: string,
  input: AiPlanRequest,
  claim: PreviewClaim,
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

  // The per-division run cap this used to also gate on is retired (v17 Phase
  // 2 Task 5, V322) — runs are metered by the credit wallet on every tier
  // now (SPEC-2 §5.2/Task 4). This lookup only resolves the division's
  // competition + frozen state for the checks below.
  const gate = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string; name: string; schedule_locked: boolean }[]>`
      select competition_id, name, schedule_locked from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return {
      competitionId: division.competition_id,
      // #398: the stage-1 compile is shown division names so a scoped
      // instruction ("finals in the Open on Friday") can resolve to an id.
      divisionName: division.name,
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
  // AI runs are metered by the credit wallet on EVERY tier (SPEC-2 §5.2), not
  // by plan — resolve the wallet up front; the actual reserve/402 happens right
  // before the LLM call below, so a frozen-division or rate-limited request
  // never touches the wallet at all.
  const walletId = await walletIdFor(auth.orgId);

  // W5 (#400). A confirmed compile is the one that executes. The organiser was
  // shown what their sentence compiled into and pressed "run with these rules";
  // compiling again here would hand the architect a SECOND, independently
  // non-deterministic answer and run it under a confirmation given for the
  // first — the exact failure this wave exists to close. So a mismatch refuses
  // instead of guessing, and the claim is atomic and single-use (see
  // `consumePreview` for why each of its six refusals is the same 409).
  //
  // Claimed BEFORE the rate limit, so an unusable preview_id costs the organiser
  // neither a slot nor a token; and a valid one skips the limiter entirely,
  // because the preview already spent that slot on the LLM round the limit
  // exists to bound. Charging twice would make looking before you leap cost a
  // run.
  const confirmed =
    input.preview_id !== undefined
      ? await consumePreview(input.preview_id, {
          orgId: auth.orgId,
          scope: "division",
          scopeId: divisionId,
          // Redundant here — a division preview's scope_id IS this id — and
          // written anyway, so the predicate is one unconditional array
          // equality on both paths rather than a shape the joint path alone
          // has to remember (V346).
          divisionIds: [divisionId],
          instruction: input.instruction,
        })
      : null;
  if (input.preview_id !== undefined && confirmed === null) {
    throw new HttpError(
      409,
      "that preview no longer matches this request — check the instruction again",
      PREVIEW_STALE,
    );
  }
  // Held from here on: everything below may throw, and until a credit is
  // actually reserved this confirmation is owed back to the organiser.
  if (confirmed !== null) claim.previewId = input.preview_id!;

  if (confirmed === null) await rateLimit(`ai-plan:${divisionId}`, { max: 5, windowSeconds: 3600 });

  // The one wall-clock read on this path (#397). Everything downstream — the
  // pack builder, the clock, the window — takes the instant as a parameter, so
  // a run is reproducible from its inputs alone.
  // Stage-1 compile (#398), OUTSIDE `spendCredit` and ahead of the quote. A
  // credit buys a token BUDGET, not a number of rounds, so an extra LLM round
  // must never mint one — and the confirm step W5 (#400) adds is only genuinely
  // free to walk away from if this round is unpriced. Own meter, own ~1K
  // ceiling; the abuse bound is the rate limit above, five runs an hour.
  //
  // A failure here is NOT fatal. The run continues with no compiled rules rather
  // than presenting a rule as enforced while nothing enforces it.
  //
  // Skipped when the wallet cannot cover even the CHEAPEST this request could
  // be. "402 before any model call" is a standing invariant of this path
  // (schedule-ai-route.test.ts), and unpriced is not the same as free: an org
  // that cannot pay for the run must not spend our tokens compiling for it.
  // A lower bound, never an estimate — it can only decline to skip, never skip a
  // run that would have gone through. The 402 itself still comes from
  // `spendCredit` below, unchanged.
  //
  // The COMPILE is skipped on a confirmed preview — that round already happened
  // and was already metered on its own ledger row — but the affordability bound
  // is NOT (Task 2b/H3). The preview checked it minutes ago; a wallet emptied by
  // another run in between makes this run a 402, and finding that out at the
  // reserve costs the confirmation as well as the run. Checking it here refuses
  // before the pack is built, and the release above hands the confirmation back
  // so the retry is free.
  const canPay = (await balance(walletId)) >= minimumCredits([input.rung]);
  if (confirmed !== null && !canPay) throw new PaymentRequiredError("ai.credits");
  const parse =
    confirmed !== null
      ? { raw: confirmed.raw, failed: false, tokens: 0, servedModel: null }
      : input.instruction.trim().length > 0 && canPay
        ? await parseInstruction(input.instruction, {
            divisions: [{ id: divisionId, name: gate.divisionName }],
          })
        : { raw: null, failed: false, tokens: 0, servedModel: null };

  // OMITTED when no compile ran on THIS request — an empty instruction, a wallet
  // that could not pay for one, or a reused preview whose tokens are already
  // stamped on its own `schedule.ai_previewed` row. Without this,
  // `parse_failed: false` on the ledger doubles as "never attempted" (or, worse,
  // bills the same compile twice) and reconciliation cannot tell them apart.
  const parseStamp =
    parse.servedModel !== null || parse.failed
      ? { tokens: parse.tokens, failed: parse.failed }
      : undefined;

  const { pack, movableIds } = await buildSchedulePack(auth, divisionId, {
    ...input,
    now: Date.now(),
    raw: parse.raw,
    // The RESOLVED parse as the organiser saw it, not a re-resolution of `raw`.
    // `resolveParsed` reads the org clock, so re-running it minutes later can
    // move a symbolic "tomorrow" onto a different date — a run under rules
    // nobody approved, arrived at without a single extra model call.
    ...(confirmed !== null ? { resolved: confirmed.resolved } : {}),
  });

  // Token-weighted credit pricing (lib/ai-rung.ts). One line — a division is
  // one unit of work — so `credits` is just its rung; #350's joint solve passes
  // one line per division to the SAME function and gets the batch discount.
  // The server always recomputes this: a client's displayed prediction, and its
  // `rung` override, are advisory. A pick below the prediction is honoured and
  // stamps `underfunded`.
  const quote = quoteRun(
    [
      {
        key: divisionId,
        input: {
          movableFixtures: movableIds.size,
          entrants: pack.entrants.length,
          courts: pack.settings.courts.length,
        },
        ...(input.rung !== undefined ? { chosen: input.rung } : {}),
      },
    ],
    schedulingRungWeights(),
  );
  // One meter for the whole run — every ladder rung and repair round charges it.
  // Sized by the movable fixtures so the per-round reserve is large enough to
  // actually emit this pack's assignment list.
  const meter = createTokenMeter(quote.budget, { units: movableIds.size });

  let result: AiPlanResult & { served_model: string; escalated_from?: string; rungs_tried: string[] };
  try {
    // Reserve `quote.credits` → run the architect → settle on success / release
    // on failure (SPEC-2 §5.2). PaymentRequiredError("ai.credits") from an empty
    // wallet falls through the catch below untouched (it matches neither
    // planErr nor providerErr) and rethrows as the 402.
    result = await spendCredit(
      walletId,
      auth.orgId,
      quote.credits,
      async () => {
        // The hold exists by the time this runs. Provisionally consumed…
        claim.creditConsumed = true;
        return {
          aiRunId: crypto.randomUUID(),
          result: await runAiPlanLadder(pack, movableIds, meter),
        };
      },
      // …and un-consumed again if the ladder throws, because `spendCredit`
      // refunds the hold in that case: a timed-out or refused run costs the
      // organiser nothing, so it must not cost them their confirmation either.
      { onHoldReleased: () => (claim.creditConsumed = false) },
    );
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
                    // Size measure alongside cost (v17 gap #295 — instrument
                    // now, weight later): the fixture count the pack builder
                    // already computed, the same number already reported to
                    // PostHog as `fixtures`.
                    pack_units: movableIds.size,
                    // Token-weighted credit pricing (lib/ai-rung.ts): what was
                    // charged, what it bought, what the predictor said, how much
                    // the run actually spent and whether the BUDGET cut it off
                    // — even on a failed run the credits were reserved, so the
                    // ledger stamps it here too. One helper builds this fragment
                    // for every surface so they cannot drift.
                    ...meterStamp(quote, meter, parseStamp),
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
                // Size measure alongside cost (v17 gap #295): the fixture
                // count the pack builder already computed — the smallest
                // correct instrumentation ahead of any size-weighted pricing
                // decision (deferred, SPEC-2 §5.1).
                pack_units: movableIds.size,
                // Token-weighted credit pricing (lib/ai-rung.ts): what was
                // charged, what token budget it bought, what the predictor
                // said, how much of the budget this run actually spent, whether
                // the org picked below the prediction, and whether the budget
                // cut the run short — the last is what makes a mispriced rung
                // visible instead of looking like a merely degraded plan.
                ...meterStamp(quote, meter, parseStamp),
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

  // Expensive-run watch (v17 gap #295): best-effort, never throws, silent
  // without a baseline or STAFF_ALERT_EMAIL — see maybeAlertExpensiveRun.
  // Deliberately AFTER the schedule.ai_generated insert above: the baseline
  // median is read from that same table, so this run counts in its own window
  // (moot at AI_RUN_MEDIAN_MIN_SAMPLE=20, but the order is pinned by test).
  // Registered as tail work: the check is a table scan plus an email send, and
  // the tenant's paid response must not wait on staff telemetry.
  // Also deliberately success-only — an expensive FAILURE (schedule.ai_failed
  // carries a real cost_usd) does not alert here; aborted/retried runs are a
  // different cost story and a different alert class, out of #295's scope.
  // mode + pack_units travel with the cost so the staff email is triageable on
  // its own — a regenerate over 400 movable fixtures at $0.90 is a different
  // story from a nudge over 6 at the same price. pack_units is the SAME number
  // stamped on the schedule.ai_generated row above (movableIds.size), so the
  // alert and the audit trail can never disagree about the run's size.
  deferred(() =>
    maybeAlertExpensiveRun({
      orgId: auth.orgId,
      competitionId: gate.competitionId,
      phase: "schedule",
      model,
      costUsd: cost_usd,
      mode: input.mode,
      packUnits: movableIds.size,
    }),
  );

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
    // The ARCHITECT's assumptions (stage 2). The resolver's are a different
    // array on a different response — see AiPlanResponse.assumptions.
    assumptions: result.assumptions,
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
    // W6 (#401): which engine repaired the board, and what the automatic one
    // did or gave up on. Carried whole — the fields are already the public
    // shape, and a run that fell back must be able to say so to the organiser.
    repair: result.repair,
    officials_coverage,
    // Token-weighted credit pricing (lib/ai-rung.ts) — what was charged, what
    // the predictor said, whether the confirm card's warning applies, and
    // whether the budget cut the run short, so the client can reconcile against
    // its own (advisory) prediction.
    ...meterStamp(quote, meter, parseStamp),
  };
}
