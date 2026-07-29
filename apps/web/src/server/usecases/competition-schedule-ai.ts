import "server-only";
// #350 Multi-division joint AI scheduling — Phase A joint context pack.
//
// buildCompetitionPack unions several divisions of ONE competition into a
// single deterministic pack. It owns no SQL of its own beyond the competition
// lookup: every division's board is assembled by the existing
// buildSchedulePack in schedule-ai.ts, then merged here. That keeps one
// loader, one draft solver and one set of ordering invariants.
//
// Determinism is contractual (see schedule-ai.ts:1-12 — a golden snapshot binds
// two builds of an identically-seeded board to be byte-identical). Every array
// here sorts on stable DOMAIN keys; where a joint sort needs a division
// discriminator it uses the division's NAME and SLUG, never the per-seed UUID.
// Slug matters as more than a tie-break: division order decides the sequential
// draft below, so it decides pack CONTENT, and `createDivision` enforces a
// unique slug but not a unique name.
//
// The three things a joint pack must get right that a per-division pack cannot:
//   * the run's own divisions must not be served to each other as immovable
//     obstacles. buildSchedulePack flattens every sibling division to the
//     anonymous OTHER_DIVISION_LABEL, so they are excluded at the source
//     (`excludeDivisionIds`) rather than filtered out afterwards — a slot-key
//     filter cannot tell "division B's fixture re-served to me" from "excluded
//     division C happens to sit on the same court at the same instant", and
//     deleting the second is deleting a hard constraint with no trace.
//   * courts are matched across divisions by LABEL and nothing else, so the
//     pack names the labels that do not appear in every selected division
//     (`divergentCourts`) for the board to warn on.
//   * the shared-player map is rebuilt over the whole run. A per-division map
//     keeps only persons in >= 2 of ITS OWN entrants, so someone in one entrant
//     of A and one of B is in neither — invisible to a union of the two. H4
//     points the model at that map, so leaving the gap would ask it to avoid a
//     clash it was never shown.
//
// THE DRAFT IS A LEGALITY HINT, NOT A BALANCE HINT. Divisions are drafted in
// sequence, each seeing what the ones before it took, which makes the joint
// draft free of cross-division court clashes but maximally UNBALANCED by
// construction: the first division gets every prime slot and the last gets
// whatever is left (and on a board that does not fit, nothing at all — hence
// `draftPlaced`). That trade is deliberate. Legal-but-unbalanced beats
// balanced-but-clashing for something that is only a starting point, and
// chunked interleaving would put the determinism contract at risk for a hint.
// Fair prime-slot distribution across divisions (the plan's rule J4) is the
// MODEL's job, and JOINT_RULES tells it to rebalance rather than anchor on what
// it was handed.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { MOVABLE_STATUS, OCCUPYING, peopleByEntrant } from "./schedule";
import { ScheduleConfig } from "@/server/api-v1/schemas";
import {
  MAX_REPAIR_ROUNDS,
  MAX_TOKENS,
  OTHER_DIVISION_LABEL,
  ROUND_TIMEOUT_MS,
  aiReasoning,
  buildSchedulePack,
  isBlocking,
  planIsAcceptable,
  planRungs,
  runLadder,
  schedulingAiModel,
  zonedIso,
  type PackAssignment,
  type PackEntrant,
  type PackFixture,
  type PackObstacle,
  type PackPerson,
  type PackSettings,
  type SchedulePack,
} from "./schedule-ai";
import { AiSchedulePlan, JOINT_RULES, SYSTEM_PROMPT } from "./schedule-ai-prompt";
import { resolveProvider, selectProvider, type ProviderName } from "@/server/ai/select-provider";
import {
  AiProviderError,
  type AiChatResponse,
  type AiProvider,
  type AiTurn,
} from "@/server/ai/provider";
import { aiRunCostUsd } from "@/lib/ai-pricing";
import {
  createTokenMeter,
  meterStamp,
  quoteRun,
  schedulingRungWeights,
  unmeteredTokenMeter,
  type RunMeterStamp,
  type Rung,
  type TokenMeter,
} from "@/lib/ai-rung";
import { spendCredit, walletIdFor } from "@/lib/credits";
import { deferred } from "@/lib/deferred";
import { requireFeature } from "@/lib/entitlements";
import { captureServer, isServerFeatureEnabled } from "@/lib/posthog-server";
import { rateLimit } from "@/lib/rate-limit";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";
import { maybeAlertExpensiveRun } from "./ai-runs-admin";
import {
  validateAssignments,
  type Assignment,
  type Conflict,
  type OrderDependency,
} from "@seazn/engine/scheduling";

const MS_PER_MIN = 60_000;

/** Total movable fixtures across the whole joint pack. Over this the run is
 *  refused before any credit is reserved — the per-division builder keeps its
 *  own 500 cap in schedule-ai.ts, this one is on the SUM. */
export const COMPETITION_MOVABLE_CAP = 500;

const TOO_LARGE = "AI_PLAN_TOO_LARGE";
/** The per-division builder's "nothing in scope" refusal. Never surfaced to a
 *  joint caller — see the build loop's catch. */
const EMPTY_SCOPE = "AI_PLAN_EMPTY_SCOPE";
/** What it becomes instead: a retryable 409, because the only way to reach it
 *  from a joint call is a concurrent change between the gate and the build. */
const SCOPE_CHANGED = "AI_PLAN_SCOPE_CHANGED";

/** One too-large contract for the whole joint call. The per-division builder
 *  refuses >500 with a 422 carrying this same code string, and a joint caller
 *  must never have to tell the two apart. In practice the pre-check subsumes
 *  the per-division case entirely — see the catch in the build loop, which is
 *  a backstop, not live logic. The per-division 422 is left alone for the
 *  per-division callers. */
const tooLarge = (): HttpError =>
  new HttpError(409, "too large — schedule per division", TOO_LARGE);

/** Court-holding statuses that are NOT being re-placed by this run: the fixed
 *  board of a part-played competition (a rain-delay repair over a morning that
 *  is already `decided` is the canonical case). Derived, never copied. */
const FIXED_OCCUPYING = OCCUPYING.filter((s) => s !== MOVABLE_STATUS);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ms = (iso: string): number => Date.parse(iso);

// ---------------------------------------------------------------------------
// Pack shape. Every per-division `Pack*` type is reused verbatim and widened
// with the division it belongs to; later tasks depend on these exact names.
// ---------------------------------------------------------------------------

export interface CompetitionPackDivision {
  id: string;
  name: string;
  sport: string;
  tz: string;
  /** That division's own settings, verbatim — never merged with a sibling's.
   *  matchMinutes/gapMinutes/sessionWindows/blackouts legitimately differ. */
  settings: PackSettings;
  /** This division's movable fixture ids, in the pack's movable order. */
  movableIds: string[];
  /** How many of `movableIds` this division contributed to `draft`. Less than
   *  `movableIds.length` means the draft is PARTIAL — without this count a
   *  truncated draft is indistinguishable from a complete one.
   *
   *  WHY it is short depends on the mode, so do not render one explanation:
   *    generate — the board did not fit. The greedy pass returns the overflow
   *               as `no_slot` conflicts, which the per-division builder
   *               discards. Divisions are drafted in order, so the later ones
   *               starve first. This is the only mode where "did not fit" is
   *               the right reading.
   *    repair   — `draft` is the movable set filtered to fixtures that already
   *               have a slot, so a short count just means some are unplaced.
   *    refine   — `draft` is the prior proposal intersected with the movable
   *               set, so a short count means the prior did not cover them. */
  draftPlaced: number;
}

export interface CompetitionPackFixture extends PackFixture {
  division_id: string;
}

export interface CompetitionPackObstacle extends PackObstacle {
  /** null when the obstacle comes from a division NOT in this run. */
  division_id: string | null;
}

export interface CompetitionPackAssignment extends PackAssignment {
  division_id: string;
}

export interface CompetitionPack {
  mode: "generate" | "refine" | "repair";
  competition: { id: string; name: string };
  /** Sorted by name, then slug. */
  divisions: CompetitionPackDivision[];
  /** Union of every selected division's court labels, sorted. */
  courts: string[];
  /** Court labels that do NOT appear in every selected division — the board
   *  warns on these, because cross-division court identity is a string match
   *  and nothing else. */
  divergentCourts: string[];
  entrants: (PackEntrant & { division_id: string })[];
  people: PackPerson[];
  fixtures: { movable: CompetitionPackFixture[]; obstacles: CompetitionPackObstacle[] };
  draft: CompetitionPackAssignment[];
  instruction: string;
  prior: { instruction: string; assignments: CompetitionPackAssignment[] } | null;
}

export interface BuildCompetitionPackOptions {
  mode: "generate" | "refine" | "repair";
  instruction: string;
  prior?: { instruction: string; assignments: CompetitionPackAssignment[] };
}

/**
 * Build the joint Phase A context pack for several divisions of one competition.
 *
 * @returns the pack plus the union of every division's movable fixture ids —
 *   the set the joint verifier rejects out-of-set assignments against.
 *
 * Throws 404 (unknown competition, or a division that is not in it) and
 * 409 AI_PLAN_TOO_LARGE when the run is too big — the summed movable count
 * exceeding {@link COMPETITION_MOVABLE_CAP}, which subsumes a single division
 * being over the per-division cap, so a joint call has exactly one too-large
 * contract and one status. The minimum-two-divisions rule is a caller gate (it
 * exists to stop discount arbitrage, not to protect the pack), so it is
 * enforced by aiPlanForCompetition, not here.
 */
export async function buildCompetitionPack(
  auth: AuthCtx,
  competitionId: string,
  divisionIds: string[],
  opts: BuildCompetitionPackOptions,
): Promise<{ pack: CompetitionPack; movableIds: Set<string> }> {
  const requested = [...new Set(divisionIds)];
  if (requested.length === 0) {
    throw new HttpError(400, "no divisions selected", "AI_PLAN_NO_DIVISIONS");
  }

  const { competition, divisionRows, movableCount, fixedRows, fixedPeople } = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string; name: string }[]>`
      select id, name from competitions where id = ${competitionId}`;
    if (!row) throw new HttpError(404, "competition not found");
    const divisionRows = await tx<{ id: string; name: string; slug: string }[]>`
      select id, name, slug from divisions
      where competition_id = ${competitionId} and id in ${tx(requested)}`;
    // Cheap cap pre-check: without it 20 divisions × 500 fixtures are greedily
    // solved before the refusal. This counts UN-SCOPED movable fixtures, which
    // is exact for every mode this builder uses (it never passes a repair
    // `scope`); the post-union check below stays the authoritative one.
    const [count] = await tx<{ n: number }[]>`
      select count(*)::int as n from fixtures
      where division_id in ${tx(requested)} and status = ${MOVABLE_STATUS}`;
    // The run's own FIXED board — court-holding fixtures that this run is not
    // re-placing. Excluding the run from the sibling sweep (so obstacle
    // attribution is sound) also took these out of every division's greedy
    // view, and feeding each built division's obstacles forward only closes the
    // gap one way: the division built FIRST would still never see a later one's
    // immovable fixtures and could draft on top of them.
    //
    // Loaded ONCE here, in the pre-pass that already runs, and handed to every
    // division — so the compensation is symmetric. Movable fixtures are
    // deliberately excluded: their current placements are exactly what is being
    // re-planned, and constraining against them would pin the schedule to where
    // it already is.
    const fixedRows = await tx<
      {
        id: string;
        division_id: string;
        scheduled_at: string | Date;
        court_label: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        round_no: number;
        seq_in_round: number;
        ext_key: string | null;
        config: unknown;
      }[]
    >`
      select f.id, f.division_id, f.scheduled_at, f.court_label,
             f.home_entrant_id, f.away_entrant_id, f.round_no, f.seq_in_round, f.ext_key,
             s.config
      from fixtures f
      left join schedule_settings s on s.division_id = f.division_id
      where f.division_id in ${tx(requested)}
        and f.status in ${tx(FIXED_OCCUPYING)}
        and f.scheduled_at is not null
        and f.court_label is not null`;
    // …with their PEOPLE. Under `crossPersonClash: "hard"` slotFixtures rejects
    // any placement overlapping someone already committed in `existing`
    // (calendar.ts:275-283), so an empty people list silently disables that
    // block and lets a draft double-book a person against a fixture nobody can
    // move. This is the same call `siblingAssignments` makes for exactly this
    // field, over the same kind of rows.
    const fixedPeople = await peopleByEntrant(
      tx,
      [...new Set(fixedRows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]))].filter(
        (e): e is string => e !== null,
      ),
    );
    return { competition: row, divisionRows, movableCount: count?.n ?? 0, fixedRows, fixedPeople };
  });

  const nameById = new Map(divisionRows.map((d) => [d.id, d.name]));
  const slugById = new Map(divisionRows.map((d) => [d.id, d.slug]));
  for (const id of requested) {
    if (!nameById.has(id)) throw new HttpError(404, `division not in competition: ${id}`);
  }
  if (movableCount > COMPETITION_MOVABLE_CAP) throw tooLarge();

  // Build (and therefore emit) in a stable DOMAIN order: name, then SLUG. Slug
  // is not a cosmetic tie-break — the sequential draft below means this order
  // decides every later division's greedy result, so a UUID tie-break would
  // make two identically-seeded boards with same-named divisions produce
  // different packs. `createDivision` enforces a unique slug, not a unique name.
  const order = [...requested].sort(
    (a, b) => cmp(nameById.get(a)!, nameById.get(b)!) || cmp(slugById.get(a)!, slugById.get(b)!),
  );

  // Division discriminator for every joint sort: name (human-meaningful
  // grouping) then slug (unique and stable). Never the UUID.
  const byDivision = (a: string, b: string): number =>
    cmp(nameById.get(a) ?? "", nameById.get(b) ?? "") ||
    cmp(slugById.get(a) ?? "", slugById.get(b) ?? "");

  // The run's fixed board as engine assignments — every division gets all of it
  // (minus its own, which buildSchedulePack already supplies internally), so the
  // compensation is symmetric rather than one-directional. Sorted on stable
  // domain keys like everything else here; the byte-identical test is the guard.
  const fixedMinutes = new Map<string, number>();
  for (const r of fixedRows) {
    if (!fixedMinutes.has(r.division_id)) {
      fixedMinutes.set(r.division_id, ScheduleConfig.parse(r.config ?? {}).matchMinutes);
    }
  }
  const fixedOccupancy: Assignment[] = [...fixedRows]
    .sort(
      (a, b) =>
        byDivision(a.division_id, b.division_id) ||
        a.round_no - b.round_no ||
        a.seq_in_round - b.seq_in_round ||
        cmp(a.ext_key ?? "", b.ext_key ?? ""),
    )
    .map((r) => {
      const startAt = new Date(r.scheduled_at).getTime();
      return {
        fixtureId: r.id,
        court: r.court_label,
        startAt,
        endAt: startAt + (fixedMinutes.get(r.division_id) ?? 0) * MS_PER_MIN,
        entrants: [r.home_entrant_id, r.away_entrant_id].filter((e): e is string => e !== null),
        // Unlike the drafts below, these rows come from this module's own SQL,
        // so the person data IS available — and it is load-bearing: it is what
        // makes `crossPersonClash: "hard"` reject a draft that would commit
        // someone already playing in another division's fixed fixture.
        people: [
          ...(r.home_entrant_id !== null ? fixedPeople.get(r.home_entrant_id) ?? [] : []),
          ...(r.away_entrant_id !== null ? fixedPeople.get(r.away_entrant_id) ?? [] : []),
        ],
        divisionId: r.division_id,
      };
    });

  // Sequential accumulation. Each division's greedy draft sees the run's whole
  // fixed board plus the slots the divisions BEFORE it drafted, so the joint
  // draft is free of cross-division court clashes rather than N
  // independently-legal boards stacked on top of each other. See the module
  // header on why this is a legality hint only.
  const built: { id: string; pack: SchedulePack; movableIds: Set<string> }[] = [];
  const drafted: Assignment[] = [];
  for (const id of order) {
    const prior = opts.prior
      ? {
          instruction: opts.prior.instruction,
          assignments: opts.prior.assignments
            .filter((a) => a.division_id === id)
            .map((a) => ({
              fixture_id: a.fixture_id,
              scheduled_at: a.scheduled_at,
              court_label: a.court_label,
            })),
        }
      : undefined;
    let one: { pack: SchedulePack; movableIds: Set<string> };
    try {
      one = await buildSchedulePack(auth, id, {
        mode: opts.mode,
        instruction: opts.instruction,
        ...(prior !== undefined ? { prior } : {}),
        // This division's own fixed fixtures arrive internally as
        // obstacleAssignments, so only the rest of the run's are added here.
        extraExisting: [...fixedOccupancy.filter((a) => a.divisionId !== id), ...drafted],
        // The rest of the run is not fixed court occupancy — it is being
        // re-planned in this same pass. Excluding it here is what makes every
        // surviving OTHER_DIVISION_LABEL obstacle provably from outside the run.
        excludeDivisionIds: order,
      });
    } catch (err) {
      // UNREACHABLE BY CONSTRUCTION — kept as a backstop, not live logic.
      //
      // The per-division builder refuses >500 movable with a 422 carrying this
      // same code, and inside a joint call that must read as the joint 409. But
      // the pre-check above always fires first: it counts `status =
      // MOVABLE_STATUS` over exactly these divisions, and a division's own
      // `movable` is a strict subset of that count (same predicate, same
      // divisions, and this builder never passes a repair `scope`). So
      // `movable.length > 500` implies `movableCount > 500`, and the pre-check
      // has already thrown. Delete the pre-check and this becomes live again —
      // which is what makes it worth keeping. It is also only unreachable
      // WITHIN ONE SNAPSHOT: the pre-check and buildSchedulePack read in
      // different transactions, so fixtures inserted between them can push a
      // division over 500 after the pre-check has passed — a second reason to
      // keep the backstop, not a reason to trust the pre-check less.
      if (err instanceof HttpError && (err.code === TOO_LARGE || err.message === TOO_LARGE)) {
        throw tooLarge();
      }
      // The OTHER per-division refusal that must never reach a joint caller
      // (ruling R6): in `repair` mode buildSchedulePack 422s AI_PLAN_EMPTY_SCOPE
      // when a division has nothing movable. The orchestrator drops such
      // divisions before ever getting here — but its gate query and this build
      // run in different transactions, so a concurrent unschedule/finalize can
      // empty a division in between. That is a transient race, not a request
      // defect: re-running picks up the new state and drops the division. So it
      // becomes a retryable 409 rather than a per-division 422 the joint caller
      // has no way to act on. Before any credit is reserved either way.
      if (err instanceof HttpError && (err.code === EMPTY_SCOPE || err.message === EMPTY_SCOPE)) {
        throw new HttpError(
          409,
          "a division's schedule changed while planning — please retry",
          SCOPE_CHANGED,
        );
      }
      throw err;
    }
    built.push({ id, pack: one.pack, movableIds: one.movableIds });

    // Feed the slots this division just drafted forward to the next ones. Its
    // fixed fixtures are already in `fixedOccupancy`, which every division sees.
    //
    // entrants ride along because they are free (they are on the fixture),
    // though they can never clash across divisions — an entrant belongs to
    // exactly one division. `people` is empty because there is nothing to put
    // in it HERE: a person rostered into one entrant of A and one of B is in
    // NEITHER source pack's people map, so this feed-forward cannot supply
    // cross-division person data even in principle.
    //
    // The joint pack's own `people` (built below over the run's whole entrant
    // set) does cover it, so the MODEL can avoid these. The greedy DRAFT still
    // cannot — each division's pass sees only its own people — so a draft may
    // hand over a cross-division person overlap, and the joint verifier remains
    // the backstop for it (Task 3).
    const minutes = one.pack.settings.matchMinutes;
    const fixtureById = new Map(one.pack.fixtures.movable.map((f) => [f.id, f]));
    for (const a of one.pack.draft) {
      const startAt = ms(a.scheduled_at);
      const f = fixtureById.get(a.fixture_id);
      drafted.push({
        fixtureId: a.fixture_id,
        court: a.court_label,
        startAt,
        endAt: startAt + minutes * MS_PER_MIN,
        entrants: [f?.home ?? null, f?.away ?? null].filter((e): e is string => e !== null),
        people: [],
      });
    }
  }

  // The joint cap is on the SUM and is checked after the union — the caller
  // reserves credit only once this has passed.
  const movableIds = new Set(built.flatMap((b) => [...b.movableIds]));
  if (movableIds.size > COMPETITION_MOVABLE_CAP) throw tooLarge();

  const divisions: CompetitionPackDivision[] = built.map((b) => ({
    id: b.pack.division.id,
    name: b.pack.division.name,
    sport: b.pack.division.sport,
    tz: b.pack.division.tz,
    settings: b.pack.settings,
    movableIds: b.pack.fixtures.movable.map((f) => f.id),
    draftPlaced: b.pack.draft.length,
  }));

  // Courts: a label is THE SAME COURT across divisions iff the string matches.
  const courtSets = built.map((b) => new Set(b.pack.settings.courts));
  const courts = [...new Set(built.flatMap((b) => b.pack.settings.courts))].sort(cmp);
  const divergentCourts = courts.filter((c) => !courtSets.every((s) => s.has(c)));

  const movable: CompetitionPackFixture[] = built
    .flatMap((b) => b.pack.fixtures.movable.map((f) => ({ ...f, division_id: b.id })))
    .sort(
      (a, b) =>
        byDivision(a.division_id, b.division_id) ||
        a.round - b.round ||
        a.seq - b.seq ||
        cmp(a.ext_key ?? "", b.ext_key ?? "") ||
        cmp(a.home ?? "", b.home ?? "") ||
        cmp(a.away ?? "", b.away ?? ""),
    );

  // -------------------------------------------------------------------------
  // Obstacles.
  //
  // Each source pack's obstacle list is now (its own fixed fixtures, labelled
  // with the division) + (only the divisions OUTSIDE this run, flattened to the
  // anonymous OTHER_DIVISION_LABEL) — the run itself was excluded at the source
  // via `excludeDivisionIds`. So the label is a sound classifier: an
  // OTHER_DIVISION_LABEL entry is provably from outside the run and
  // `division_id: null` is a fact, not an inference.
  //
  // That is why there is no slot-key filter here any more. One could not tell
  // "division B's fixture re-served to me" from "excluded division C sits on the
  // same court at the same instant", and dropping the second silently deletes a
  // hard constraint — obstacles are what the joint verifier reads, so nothing
  // downstream could recover it.
  //
  // Foreign obstacles still arrive once per source pack, each rendered in THAT
  // division's timezone; re-render them in one canonical zone (the first
  // division in the emitted order) so the same excluded placement is one entry
  // with one spelling however many selected divisions reported it.
  // -------------------------------------------------------------------------
  const canonicalTz = divisions[0]!.tz;
  const collected: CompetitionPackObstacle[] = [];
  for (const b of built) {
    for (const o of b.pack.fixtures.obstacles) {
      if (o.label !== OTHER_DIVISION_LABEL) {
        collected.push({ ...o, division_id: b.id });
        continue;
      }
      collected.push({
        court: o.court,
        from: zonedIso(ms(o.from), canonicalTz),
        to: zonedIso(ms(o.to), canonicalTz),
        label: o.label,
        division_id: null,
      });
    }
  }
  // Dedupe carries the division identity: without it, two selected divisions'
  // own immovable fixtures sharing a court and span collapse into one entry
  // tagged with whichever built first, hiding a real fixture from both the model
  // and the verifier. Foreign entries all key on the same null, so the
  // duplicate-report collapse they need still happens.
  const seenObstacle = new Set<string>();
  const obstacles = collected
    .filter((o) => {
      const key = `${o.division_id ?? ""}|${o.court}|${ms(o.from)}|${ms(o.to)}`;
      if (seenObstacle.has(key)) return false;
      seenObstacle.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        cmp(a.court, b.court) ||
        ms(a.from) - ms(b.from) ||
        ms(a.to) - ms(b.to) ||
        cmp(a.label, b.label),
    );

  // Instants, not strings: divisions may sit in different zones, so a
  // lexicographic compare over mixed-offset ISO is not chronological.
  const byJointAssignment = (a: CompetitionPackAssignment, b: CompetitionPackAssignment): number =>
    ms(a.scheduled_at) - ms(b.scheduled_at) ||
    cmp(a.court_label, b.court_label) ||
    byDivision(a.division_id, b.division_id) ||
    cmp(a.fixture_id, b.fixture_id);

  const draft: CompetitionPackAssignment[] = built
    .flatMap((b) => b.pack.draft.map((a) => ({ ...a, division_id: b.id })))
    .sort(byJointAssignment);

  const entrants = built.flatMap((b) =>
    b.pack.entrants.map((e) => ({ ...e, division_id: b.id })),
  );

  // Shared players, derived from the RUN's whole entrant set — deliberately NOT
  // a union of the per-division maps.
  //
  // Each source pack keeps only persons rostered into >= 2 of its OWN entrants
  // (schedule-ai.ts:540-543), because within one division those are the only ones
  // that can create a cross-entrant clash. Across a joint run that bar is wrong:
  // a person in ONE entrant of A and ONE of B clears it in neither division and
  // is therefore in no source map, while H4 sends the model to this very map to
  // avoid entrant overlaps. The model would then be asked to avoid a clash the
  // pack never showed it.
  //
  // Applying the same >= 2 rule to the joint entrant set fixes that at the
  // source. It is a strict superset of the union: every within-division sharer
  // still qualifies, and the cross-division ones now do too. Nothing downstream
  // changes semantics — person_overlap stays the warn it is single-division
  // (calendar.ts:102) — the model simply gets the data it needs to comply.
  const entrantNameById = new Map(entrants.map((e) => [e.id, e.name]));
  const byEntrantName = (a: string, b: string): number =>
    cmp(entrantNameById.get(a) ?? "", entrantNameById.get(b) ?? "") || cmp(a, b);
  const entrantNameKey = (ids: readonly string[]): string =>
    ids.map((e) => entrantNameById.get(e) ?? e).join("|");
  const membersByEntrant = await withTenant(auth.orgId, (tx) =>
    peopleByEntrant(
      tx,
      entrants.map((e) => e.id),
    ),
  );
  const entrantsByPerson = new Map<string, Set<string>>();
  for (const [entrantId, personIds] of membersByEntrant) {
    for (const p of personIds) {
      (entrantsByPerson.get(p) ?? entrantsByPerson.set(p, new Set()).get(p)!).add(entrantId);
    }
  }
  // peopleByEntrant's rows carry no ORDER BY, so nothing here may lean on
  // insertion order the way the old first-seen merge did. Both the entrant_ids
  // array and the people array sort on the entrant NAME — the invariant at
  // schedule-ai.ts:517-523, mirroring its own people sort at :544-548.
  const people: PackPerson[] = [...entrantsByPerson.entries()]
    .filter(([, ents]) => ents.size >= 2)
    .map(([person_id, ents]) => ({ person_id, entrant_ids: [...ents].sort(byEntrantName) }))
    .sort(
      (a, b) =>
        cmp(entrantNameKey(a.entrant_ids), entrantNameKey(b.entrant_ids)) ||
        cmp(a.person_id, b.person_id),
    );

  // Each source pack already normalised its slice of the prior proposal into
  // its own timezone; re-tag and re-sort rather than re-deriving.
  const prior = opts.prior
    ? {
        instruction: opts.prior.instruction,
        assignments: built
          .flatMap((b) => (b.pack.prior?.assignments ?? []).map((a) => ({ ...a, division_id: b.id })))
          .sort(byJointAssignment),
      }
    : null;

  const pack: CompetitionPack = {
    mode: opts.mode,
    competition: { id: competition.id, name: competition.name },
    divisions,
    courts,
    divergentCourts,
    entrants,
    people,
    fixtures: { movable, obstacles },
    draft,
    instruction: opts.instruction,
    prior,
  };

  return { pack, movableIds };
}

// ===========================================================================
// #350 Phase B — the JOINT VERIFIER and the JOINT RUNNER.
//
// THE CENTRAL DESIGN DECISION, stated once here because everything below
// follows from it:
//
//   `validateAssignments` takes ONE scalar config — one matchMinutes, one
//   gapMinutes, one blackouts[], one sessionWindows[], one constraints. A joint
//   run's divisions legitimately differ on every one of them.
//
// The tempting move is to merge them into a "strictest" config and make one
// call. That is wrong in both directions and silently: a merged session window
// applies division A's 09:00-12:00 to division B's fixtures (rejecting a legal
// afternoon board), and a merged blackout blacks out a division that never had
// one. There is no merge that is sound, because the fields are not properties of
// the BOARD — they are properties of a division's fixtures.
//
// So `verifyJoint` runs one pass PER DIVISION, with that division's own config,
// over that division's own fixtures, handing every OTHER division's proposed
// slots plus every obstacle in as `existing`. `validateAssignments` reports
// conflicts only for the assignments it is given, never for `existing`, so each
// pass judges exactly one division's fixtures by exactly one division's rules —
// while the checks that read the whole board (court occupancy, person overlap,
// feed order) still see every division's fixtures. That is precisely what
// JOINT_RULES' preamble promises the model, and the model is graded on it.
//
// Two consequences worth naming, both covered by tests:
//   * a cross-division court clash is reported TWICE, once per side, from the
//     two divisions' own passes. That is the desired report — either fixture
//     can be the one that moves — but it is also why some conflicts genuinely
//     arrive twice and are deduped below.
//   * cross-division court gap is charged at each division's OWN gapMinutes, so
//     verifyJoint can legitimately reject the greedy draft it was handed (the
//     drafting division applied its own, smaller, gap). Expected, not a bug.
// ===========================================================================

/** The joint system prompt. SYSTEM_PROMPT is golden-snapshotted and must never
 *  be edited; JOINT_RULES is a separate constant appended to it here — this is
 *  its ONLY consumer, so this concatenation is what puts Task 2's rules on the
 *  wire. */
export const JOINT_SYSTEM_PROMPT = `${SYSTEM_PROMPT}\n\n${JOINT_RULES}`;

export interface CompetitionPlanResult {
  /** Each entry carries the division the server resolved it to — the model is
   *  told NOT to emit a division field (JOINT_RULES OUTPUT), so this is derived
   *  from the pack, never echoed. */
  proposal: {
    fixture_id: string;
    scheduled_at: string;
    court_label: string;
    division_id: string;
    schedule_locked?: boolean;
  }[];
  unschedulable: { fixture_id: string; reason: string }[];
  warnings: Conflict[];
  blocking: Conflict[];
  diff: { moved: string[]; placed: string[]; unscheduled: string[]; unchanged: string[] };
  explanations: { fixture_id: string; note: string }[];
  constraint_suggestions?: AiSchedulePlan["constraint_suggestions"];
  summary: string;
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number; cost_usd: number | null };
}

/** Raised when a plan/proposal names a fixture this pack does not contain, or a
 *  fixture whose division is not in the run. That is a CALLER bug, never
 *  something a model can cause on the runner path (`jointStructuralCheck` gates
 *  it first), so it fails loudly instead of being defaulted away — see
 *  {@link toJointEngineAssignments}. A caller working from client-supplied
 *  assignments (the Task 6 apply path) must validate ids against the pack before
 *  reaching here, and translate this into its own 4xx. */
export const JOINT_ASSIGNMENT_UNKNOWN = "AI_PLAN_INVALID_ASSIGNMENT";

/** Map the LLM proposal onto engine assignments. Three things differ from the
 *  single-division `toEngineAssignments` (schedule-ai.ts:878):
 *
 *  * `endAt` uses EACH fixture's own division's matchMinutes. A shared duration
 *    is the single easiest way to make this whole module wrong — a 30-minute
 *    reading of a 90-minute division's fixtures reports a clean board.
 *  * `divisionId` is stamped, because it is what `verifyJoint` partitions on.
 *    It has one further effect, deliberate: `effectiveRestMinutes` consults
 *    `constraints.restByGroup[divisionId]`, which the single-division path
 *    never reaches (it leaves divisionId unset). Since each division's pass runs
 *    with that division's own constraints, a restByGroup entry keyed by a
 *    division now governs that division's own fixtures — which is what the field
 *    means. `poolId` is deliberately still NOT stamped, matching the
 *    single-division path exactly.
 *  * An unresolvable assignment THROWS rather than defaulting.
 *
 *  That last one is the important one, and it is why there is no `?? 0` here.
 *  An assignment whose fixture is unknown, or whose division is not in the run,
 *  has no duration and no division. Defaulting it produces something far worse
 *  than an error: a zero-length assignment carrying no `divisionId` matches NO
 *  division's `mine` filter in `verifyJoint`, so it is verified by nobody while
 *  still being injected into every other pass's `existing` as a phantom
 *  zero-duration court booking. A wrong answer that looks like a right one.
 *
 *  The runner cannot reach this — `jointStructuralCheck` rejects foreign ids
 *  before verification — but `verifyJoint` is a pure exported function and the
 *  apply path is expected to reuse this shape over client-supplied assignments,
 *  where no such gate exists. */
export function toJointEngineAssignments(plan: AiSchedulePlan, pack: CompetitionPack): Assignment[] {
  const fixtureById = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
  const minutesByDivision = new Map(pack.divisions.map((d) => [d.id, d.settings.matchMinutes]));
  const personsByEntrant = new Map<string, string[]>();
  for (const p of pack.people) {
    for (const e of p.entrant_ids) {
      (personsByEntrant.get(e) ?? personsByEntrant.set(e, []).get(e)!).push(p.person_id);
    }
  }
  return plan.assignments.map((a) => {
    const f = fixtureById.get(a.fixture_id);
    if (f === undefined) {
      throw new HttpError(
        500,
        `assignment names a fixture outside the pack: ${a.fixture_id}`,
        JOINT_ASSIGNMENT_UNKNOWN,
      );
    }
    const minutes = minutesByDivision.get(f.division_id);
    if (minutes === undefined) {
      throw new HttpError(
        500,
        `fixture ${a.fixture_id} belongs to a division that is not in this run: ${f.division_id}`,
        JOINT_ASSIGNMENT_UNKNOWN,
      );
    }
    const entrants = [f.home, f.away].filter((e): e is string => e !== null);
    const startAt = ms(a.scheduled_at);
    return {
      fixtureId: a.fixture_id,
      court: a.court_label,
      startAt,
      endAt: startAt + minutes * MS_PER_MIN,
      entrants,
      people: entrants.flatMap((e) => personsByEntrant.get(e) ?? []),
      divisionId: f.division_id,
    };
  });
}

/** Fixed court occupancy the proposal must dodge, as engine assignments.
 *
 *  The synthetic ids are division-scoped (`obstacle:${divisionIndex}:${i}`,
 *  with `x` standing for an obstacle from outside the run) rather than the
 *  per-division `obstacle:${i}` of schedule-ai.ts:904. That id is only unique
 *  within ONE division's list, and a duplicate id on the joint board is not
 *  inert: `validateAssignments` builds a `byId` map over `existing` +
 *  `assignments` for feed-order resolution, where a collision silently drops an
 *  entry. */
export function toJointObstacleAssignments(pack: CompetitionPack): Assignment[] {
  const indexByDivision = new Map(pack.divisions.map((d, i) => [d.id, String(i)]));
  const counters = new Map<string, number>();
  return pack.fixtures.obstacles.map((o) => {
    const key = o.division_id === null ? "x" : indexByDivision.get(o.division_id) ?? o.division_id;
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    return {
      fixtureId: `obstacle:${key}:${n}`,
      court: o.court,
      startAt: ms(o.from),
      endAt: ms(o.to),
      entrants: [],
      people: [],
    };
  });
}

/** Direct winner/loser feeds across the whole union — the joint mirror of
 *  `packFeedDependencies` (schedule-ai.ts:957). Feeds are within-division in
 *  practice, but the dependency list is resolved against the whole board by the
 *  engine, so it is built over the whole board here too. */
export function jointFeedDependencies(pack: CompetitionPack): OrderDependency[] {
  const deps: OrderDependency[] = [];
  for (const f of pack.fixtures.movable) {
    for (const dependsOn of f.feeds.after) {
      deps.push({ fixtureId: f.id, dependsOn, direct: true });
    }
  }
  return deps;
}

/** One division's verifier config — the per-division mirror of `verifyConfig`
 *  (schedule-ai.ts:914), reading `division.settings` instead of `pack.settings`.
 *
 *    startWindows       CONVERTED, not dropped. The single-division mirror
 *                        drops these on the grounds that the pack carries ISO
 *                        strings and the engine wants epoch ms — but that is a
 *                        conversion excuse: the `blackouts` and `sessionWindows`
 *                        lines below do exactly that conversion, with `ms()`.
 *                        The drop made `start_window` a conflict class the whole
 *                        joint product was blind to, at plan time AND apply
 *                        time, while the per-stage apply reports it through
 *                        `toSlotConfig` (schedule.ts:337-341).
 *                        The engine matches a `kind: "division"` window on the
 *                        assignment's `divisionId`, which the joint path is the
 *                        only one that stamps — so these govern per division
 *                        exactly as `restByGroup` does.
 *                        WARNINGS ONLY: `isBlocking` does not cover
 *                        `start_window`, and must not be taught to.
 *    fieldFairness: off
 *    parallelism: mixed  a PLACER preference, not a legality rule. Load-bearing
 *                        here in a way it is not single-division: the joint draft
 *                        feeds block-mode exclusivity asymmetrically (a division
 *                        avoids the divisions drafted BEFORE it and never those
 *                        after), so honouring it in the verifier would turn a
 *                        build-order artefact into a verdict.
 *    crossPersonClash: warn   matches the single-division AI PLAN path
 *                        (`verifyConfig`, schedule-ai.ts:914) — this function's
 *                        actual twin. It does NOT match the single-division
 *                        APPLY path, and that asymmetry is deliberate on both
 *                        sides: `applySchedule` hands the division's real
 *                        setting to `mapConflicts` (schedule.ts:553) and refuses
 *                        a hand-placed person double-booking, while the plan
 *                        path warns and never asks the model to repair it.
 *                        An earlier version of this comment claimed the two
 *                        matched "exactly". They never did. The joint APPLY
 *                        re-applies the setting itself rather than changing this
 *                        line — see `applyCompetitionSchedule`. */
export function verifyConfigFor(
  division: CompetitionPackDivision,
): Parameters<typeof validateAssignments>[1] {
  const s = division.settings;
  return {
    perEntrantMinRest: s.perEntrantMinRest,
    matchMinutes: s.matchMinutes,
    ...(s.constraints !== null
      ? {
          constraints: {
            ...(s.constraints.restMin !== undefined ? { restMin: s.constraints.restMin } : {}),
            ...(s.constraints.restByGroup !== undefined
              ? { restByGroup: s.constraints.restByGroup }
              : {}),
            noBackToBack: s.constraints.noBackToBack,
            // `PackStartWindow.target.kind` is a bare `string` (the pack is a
            // wire shape), so an unrecognised kind is DROPPED rather than cast
            // through: the engine would silently never match it, and a cast
            // would hide that a settings row has drifted from the enum.
            startWindows: s.constraints.startWindows.flatMap((w) =>
              w.target.kind === "entrant" || w.target.kind === "pool" || w.target.kind === "division"
                ? [
                    {
                      target: { kind: w.target.kind, id: w.target.id },
                      ...(w.notBefore !== undefined ? { notBefore: ms(w.notBefore) } : {}),
                      ...(w.notAfter !== undefined ? { notAfter: ms(w.notAfter) } : {}),
                    },
                  ]
                : [],
            ),
            fieldFairness: "off" as const,
            parallelism: "mixed" as const,
            crossPersonClash: "warn" as const,
          },
        }
      : {}),
    gapMinutes: s.gapMinutes,
    blackouts: s.blackouts.map((b) => ({
      ...(b.court !== undefined ? { court: b.court } : {}),
      from: ms(b.from),
      to: ms(b.to),
    })),
    sessionWindows: s.sessionWindows.map((w) => ({ from: ms(w.from), to: ms(w.to) })),
  };
}

/**
 * Verify a joint proposal: one `validateAssignments` pass per division, each
 * with that division's own config, each over the whole board.
 *
 * See the section header for why this is not one merged call. The `existing`
 * handed to a division's pass is every OTHER division's proposed slots plus
 * every obstacle — that is what makes a cross-division court clash visible: the
 * other division's fixture is on the board, so this division's fixture collides
 * with it and is reported. The other side of the same clash is reported by that
 * division's own pass.
 *
 * `existing` also carries every OBSTACLE — the selected divisions' own immovable
 * fixtures plus every out-of-run division's placements. Dropping them does not
 * fail loudly: it makes the verifier call a board clean while the model has
 * double-booked a court against a real, already-scheduled fixture nobody can
 * move.
 *
 * Deduplication is not cosmetic. `validateAssignments` resolves feed
 * dependencies against the whole board rather than the pass's own assignments,
 * so a within-division order violation is re-reported verbatim by every other
 * division's pass. Keyed on (fixtureId, reason, detail): the two SIDES of a
 * court clash differ on fixtureId and both survive, which is the intent — either
 * one can be the fixture that moves.
 *
 * @throws HttpError 500 AI_PLAN_INVALID_ASSIGNMENT (inherited from
 *   {@link toJointEngineAssignments}) when the plan names a fixture outside the
 *   pack — the invariant every entry has a resolvable `divisionId`, without
 *   which an assignment would be verified by no pass at all.
 */
export function verifyJoint(plan: AiSchedulePlan, pack: CompetitionPack): Conflict[] {
  const all = toJointEngineAssignments(plan, pack);
  const obstacles = toJointObstacleAssignments(pack);
  const deps = jointFeedDependencies(pack);
  const seen = new Set<string>();
  const out: Conflict[] = [];
  for (const division of pack.divisions) {
    const mine = all.filter((a) => a.divisionId === division.id);
    if (mine.length === 0) continue;
    const others = all.filter((a) => a.divisionId !== division.id);
    for (const c of validateAssignments(
      mine,
      verifyConfigFor(division),
      [...others, ...obstacles],
      deps,
    )) {
      const key = `${c.fixtureId}|${c.reason}|${c.detail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  // Sort on DOMAIN keys, never on the fixture UUID (the determinism contract at
  // schedule-ai.ts:1-12). Division order is the pack's own (name, slug) order, so
  // the report also arrives grouped by division and then in playing order, which
  // is how the model reads it back on a repair round.
  const rank = new Map<string, [number, number, number, string]>();
  const divisionIndex = new Map(pack.divisions.map((d, i) => [d.id, i]));
  for (const f of pack.fixtures.movable) {
    rank.set(f.id, [divisionIndex.get(f.division_id) ?? pack.divisions.length, f.round, f.seq, f.ext_key ?? ""]);
  }
  const UNRANKED: [number, number, number, string] = [Number.MAX_SAFE_INTEGER, 0, 0, ""];
  return out.sort((a, b) => {
    const ra = rank.get(a.fixtureId) ?? UNRANKED;
    const rb = rank.get(b.fixtureId) ?? UNRANKED;
    return (
      ra[0] - rb[0] ||
      ra[1] - rb[1] ||
      ra[2] - rb[2] ||
      cmp(ra[3], rb[3]) ||
      cmp(a.reason, b.reason) ||
      cmp(a.detail ?? "", b.detail ?? "") ||
      // Last-resort only: two conflicts identical on every domain key. Reaching
      // this means the seed has duplicate (round, seq, ext_key) within one
      // division, which the fixture generator does not produce.
      cmp(a.fixtureId, b.fixtureId)
    );
  });
}

/** Structural gate run before the engine verifier — the joint mirror of
 *  `structuralCheck` (schedule-ai.ts:841). One rule changes: a fixture's
 *  `court_label` must appear in ITS OWN division's `settings.courts`, not merely
 *  in `pack.courts`. The union is a rendering convenience for the board; using
 *  it as the gate would let the model place an Alpha fixture on a court only
 *  Beta has, which is unschedulable in the real world and which the engine
 *  cannot detect (it has no notion of which courts a division owns). */
export function jointStructuralCheck(
  plan: AiSchedulePlan,
  movableIds: Set<string>,
  pack: CompetitionPack,
): string | null {
  const fixtureById = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
  const divisionById = new Map(pack.divisions.map((d) => [d.id, d]));
  const pinned = new Map(pack.fixtures.movable.filter((f) => f.pinned).map((f) => [f.id, f]));
  const seen = new Set<string>();
  const placed = new Set<string>();
  for (const a of plan.assignments) {
    if (!movableIds.has(a.fixture_id)) return `assignment references non-movable fixture ${a.fixture_id}`;
    if (seen.has(a.fixture_id)) return `fixture ${a.fixture_id} appears more than once`;
    seen.add(a.fixture_id);
    placed.add(a.fixture_id);
    const division = divisionById.get(fixtureById.get(a.fixture_id)?.division_id ?? "");
    if (division === undefined) return `assignment references a fixture with no division: ${a.fixture_id}`;
    if (!division.settings.courts.includes(a.court_label)) {
      return `fixture ${a.fixture_id} uses a court its own division (${division.name}) does not have: ${a.court_label}`;
    }
    const pin = pinned.get(a.fixture_id);
    if (
      pin &&
      (pin.current.at === null ||
        ms(pin.current.at) !== ms(a.scheduled_at) ||
        pin.current.court !== a.court_label)
    ) {
      return `pinned fixture ${a.fixture_id} must not move`;
    }
  }
  for (const u of plan.unschedulable) {
    if (!movableIds.has(u.fixture_id)) return `unschedulable references non-movable fixture ${u.fixture_id}`;
    if (seen.has(u.fixture_id)) return `fixture ${u.fixture_id} appears more than once`;
    seen.add(u.fixture_id);
    if (pinned.has(u.fixture_id)) return `pinned fixture ${u.fixture_id} cannot be marked unschedulable`;
  }
  // R7: `movableIds` iteration order is NOT stable — only `.size` and
  // membership are. This loop reads membership and produces at most one id in an
  // error string, so it is safe; nothing here may serialise the whole set.
  for (const id of movableIds) {
    if (!seen.has(id)) return `movable fixture ${id} is missing from the plan`;
  }
  // UNREACHABLE BY CONSTRUCTION, kept because schedule-ai.ts:870 keeps it and
  // the two must not drift. Every pinned movable id has already been accounted
  // for above: absent from both lists → "is missing from the plan"; in
  // `unschedulable` → "cannot be marked unschedulable"; in `assignments` →
  // `placed`. It only becomes live if one of those three guards is removed.
  for (const [id] of pinned) {
    if (movableIds.has(id) && !placed.has(id)) return `pinned fixture ${id} must stay at its current slot`;
  }
  return null;
}

/** proposal vs each movable fixture's current slot, over the union — the joint
 *  mirror of `computeDiff` (schedule-ai.ts:968). */
function computeJointDiff(plan: AiSchedulePlan, pack: CompetitionPack): CompetitionPlanResult["diff"] {
  const proposalById = new Map(plan.assignments.map((a) => [a.fixture_id, a]));
  const unsched = new Set(plan.unschedulable.map((u) => u.fixture_id));
  const diff: CompetitionPlanResult["diff"] = { moved: [], placed: [], unscheduled: [], unchanged: [] };
  for (const f of pack.fixtures.movable) {
    const a = proposalById.get(f.id);
    if (a) {
      const hadSlot = f.current.at !== null && f.current.court !== null;
      if (!hadSlot) diff.placed.push(f.id);
      else if (ms(f.current.at!) === ms(a.scheduled_at) && f.current.court === a.court_label) {
        diff.unchanged.push(f.id);
      } else diff.moved.push(f.id);
    } else if (unsched.has(f.id)) {
      diff.unscheduled.push(f.id);
    }
  }
  return diff;
}

/** One round, joint system prompt. A near-copy of `callModel`
 *  (schedule-ai.ts:990) rather than a parameterisation of it: that function's
 *  `system: SYSTEM_PROMPT` is asserted by the single-division tests, and adding
 *  a prompt parameter to the shipped per-division path to serve a new one is a
 *  behaviour change on a live endpoint for no gain. Everything else — the
 *  AbortController deadline, the explicit SDK timeout, the null-on-unparseable
 *  contract — is identical and must stay so. */
async function callJointModel(
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
      system: JOINT_SYSTEM_PROMPT,
      messages,
      maxTokens,
      reasoning: aiReasoning(model),
      schema: { name: "schedule_plan", zod: AiSchedulePlan },
      signal: controller.signal,
      timeoutMs: 600_000,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HttpError(422, "AI scheduling timed out; please retry", "AI_PLAN_TIMEOUT");
    }
    if (err instanceof HttpError || err instanceof AiProviderError) throw err;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the schedule architect over a pre-built JOINT pack. Mirrors `runAiPlan`
 * (schedule-ai.ts:1042) round for round — same meter placement (the round's
 * output is charged the moment usage is known, BEFORE the refusal and
 * parse-failure throws), same single corrective retry for a malformed plan, same
 * MAX_REPAIR_ROUNDS, same fewest-blocking best-so-far selection, same
 * usage-rides-on-the-422 contract. Takes the pack as data; never touches the DB.
 *
 * PREFER {@link runCompetitionAiPlanLadder}. This function runs ONE model with
 * no fallback; the ladder is what production wants and what the orchestrator
 * must call. It is exported only because the ladder needs an attempt function
 * and because the bench pins a single model. (The single-division twin avoids
 * this ambiguity by keeping `runAiPlanLadder` module-private — it cannot here,
 * since the orchestrator lives in a different module.)
 *
 * What differs: the system prompt is SYSTEM_PROMPT + JOINT_RULES, and the two
 * checks are the joint ones.
 *
 * @throws HttpError 503 AI_PROVIDER_NOT_CONFIGURED, 422 AI_PLAN_FAILED (refusal,
 *   un-correctable structural violation, or budget exhausted before a usable
 *   plan), 422 AI_PLAN_TIMEOUT.
 */
export async function runCompetitionAiPlan(
  pack: CompetitionPack,
  movableIds: Set<string>,
  modelOverride?: string,
  providerName?: ProviderName,
  meter: TokenMeter = unmeteredTokenMeter(),
): Promise<CompetitionPlanResult> {
  const provider = providerName ? resolveProvider(providerName) : selectProvider();
  if (!provider.isConfigured()) {
    throw new HttpError(503, "AI scheduling is not configured on this server", "AI_PROVIDER_NOT_CONFIGURED");
  }
  const model = modelOverride ?? schedulingAiModel();

  const conversation: AiTurn[] = [{ role: "user", content: JSON.stringify(pack) }];
  const divisionByFixture = new Map(pack.fixtures.movable.map((f) => [f.id, f.division_id]));
  /** Same invariant as toJointEngineAssignments, and for the same reason: a
   *  proposal entry with an empty division_id is a valid-looking lie that the
   *  route would serialise straight to the client. `jointStructuralCheck` has
   *  already rejected foreign ids by the time this runs. */
  const divisionOf = (fixtureId: string): string => {
    const d = divisionByFixture.get(fixtureId);
    if (d === undefined) {
      throw new HttpError(
        500,
        `assignment names a fixture outside the pack: ${fixtureId}`,
        JOINT_ASSIGNMENT_UNKNOWN,
      );
    }
    return d;
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = 0;
  let repairRounds = 0;
  let correctiveUsed = false;

  let best: { plan: AiSchedulePlan; blocking: Conflict[]; warnings: Conflict[] } | null = null;

  const usageNow = () => ({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    repair_rounds: repairRounds,
    cost_usd: costUsd,
  });

  const finalizeFrom = (chosen: NonNullable<typeof best>): CompetitionPlanResult => ({
    proposal: chosen.plan.assignments.map((a) => ({
      fixture_id: a.fixture_id,
      scheduled_at: a.scheduled_at,
      court_label: a.court_label,
      // Resolved server-side from the pack. JOINT_RULES tells the model NOT to
      // emit a division field, so this is never an echo of model output.
      division_id: divisionOf(a.fixture_id),
      ...(a.schedule_locked !== undefined ? { schedule_locked: a.schedule_locked } : {}),
    })),
    unschedulable: chosen.plan.unschedulable,
    warnings: chosen.warnings,
    blocking: chosen.blocking,
    diff: computeJointDiff(chosen.plan, pack),
    explanations: chosen.plan.explanations,
    ...(chosen.plan.constraint_suggestions !== undefined
      ? { constraint_suggestions: chosen.plan.constraint_suggestions }
      : {}),
    summary: chosen.plan.summary,
    usage: usageNow(),
  });

  for (;;) {
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

    let response: Awaited<ReturnType<typeof callJointModel>>;
    try {
      response = await callJointModel(provider, model, conversation, roundMaxTokens);
    } catch (err) {
      if (err instanceof HttpError && err.code === "AI_PLAN_TIMEOUT") {
        throw new HttpError(422, err.message, "AI_PLAN_TIMEOUT", { usage: usageNow() });
      }
      throw err;
    }
    const roundInput = response?.usage?.inputTokens ?? 0;
    const roundOutput = response?.usage?.outputTokens ?? 0;
    inputTokens += roundInput;
    outputTokens += roundOutput;
    meter.add(roundOutput);
    const roundCost =
      response?.usage?.costUsd ??
      (response ? aiRunCostUsd(response.servedModel, roundInput, roundOutput) : 0);
    costUsd = costUsd === null || roundCost === null ? null : costUsd + roundCost;

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
      plan === null ? "the model returned no parseable plan" : jointStructuralCheck(plan, movableIds, pack);
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
          note: "Your previous output was rejected before verification. Resend the full plan: every movable fixture of every division exactly once (in assignments or unschedulable), only movable ids, court_label drawn from that fixture's OWN division's settings.courts, and never move a pinned fixture.",
        }),
      });
      continue;
    }

    const conflicts = verifyJoint(plan!, pack);
    const blocking = conflicts.filter(isBlocking);
    const warnings = conflicts.filter((c) => !isBlocking(c));

    if (best === null || blocking.length <= best.blocking.length) {
      best = { plan: plan!, blocking, warnings };
    }

    if (blocking.length === 0 || repairRounds >= MAX_REPAIR_ROUNDS) {
      return finalizeFrom(best!);
    }

    repairRounds++;
    conversation.push(response?.assistantTurn ?? { role: "assistant", content: [] });
    conversation.push({
      role: "user",
      content: JSON.stringify({
        verifier_conflicts: conflicts,
        note: "Fix only these conflicts. Move as few fixtures as possible. Do not reintroduce earlier conflicts. A court conflict between two divisions may be reported on both fixtures; where it is, moving either one resolves it.",
      }),
    });
  }
}

/** Wire the joint runner to the shared model ladder — the joint mirror of
 *  `runAiPlanLadder` (schedule-ai.ts:1541). The SAME meter instance is handed to
 *  every rung, so the run's hard token budget spans the whole ladder rather than
 *  resetting per rung, and escalation stops the moment the meter refuses a round
 *  (entering a further rung would spend nothing but would write a model into
 *  `rungs_tried` that was never actually asked). */
export async function runCompetitionAiPlanLadder(
  pack: CompetitionPack,
  movableIds: Set<string>,
  meter: TokenMeter,
): Promise<CompetitionPlanResult & { served_model: string; escalated_from?: string; rungs_tried: string[] }> {
  return runLadder(
    planRungs(),
    (rung) => runCompetitionAiPlan(pack, movableIds, rung.model, rung.provider, meter),
    (result) => planIsAcceptable(result, movableIds.size),
    () => !meter.stoppedOnBudget,
  );
}

// ===========================================================================
// #350 Phase C — the ORCHESTRATOR. Gates, pricing, the credit spend, the two
// competition-level ledger events. This is the money path: everything that can
// refuse must refuse BEFORE `spendCredit`, and the gate ORDER below is the
// acceptance criterion, not an implementation detail.
// ===========================================================================

const SINGLE_DIVISION = "AI_PLAN_SINGLE_DIVISION";

/** Fewer than two divisions to solve. This is not merely a UX nicety: pricing
 *  gives a joint run `max(1, Σ rungs − 1)`, so a lone rung-2 division routed
 *  through this endpoint would cost 1 credit instead of the 2 the division
 *  endpoint charges. The rule closes that arbitrage, which is why it also fires
 *  when the zero-movable drop below leaves only one division standing. */
const singleDivision = (): HttpError =>
  new HttpError(400, "use the division schedule page to plan a single division", SINGLE_DIVISION);

/** A division whose own data cannot be planned (spec §11). Refused before any
 *  credit is reserved and NAMES the division — "something is wrong somewhere in
 *  your competition" is not an actionable error for a 12-division board. */
const UNPLANNABLE = "AI_PLAN_DIVISION_UNPLANNABLE";

export interface AiCompetitionPlanRequest {
  /** At least two, de-duplicated by the orchestrator. */
  division_ids: string[];
  instruction: string;
  mode: "generate" | "refine" | "repair";
  /** Per-division rung override keyed by division id (the confirm card's
   *  segmented control). Advisory: the server always recomputes the quote, and
   *  a value that is not 1|2|3 — or names a division not in the run — is
   *  ignored by `quoteRun` rather than being an error. */
  rung_overrides?: Record<string, number>;
  prior?: { instruction: string; assignments: CompetitionPackAssignment[] };
}

/**
 * `constraint_suggestions` is deliberately NOT part of the joint response.
 *
 * The model emits them in the ENGINE shape — `startWindows[].notBefore/notAfter`
 * are epoch ms — and the single-division endpoint renders them to
 * ISO-with-offset in that division's timezone before answering
 * (`isoConstraintSuggestions`, schedule-ai.ts:1275). A joint run has no single
 * timezone to render in (ruling R8), and a suggestion is a durable rule for ONE
 * division's settings. So there is no correct joint answer here — only a choice
 * between shipping raw epoch numbers into a field clients parse as ISO, and
 * silently attributing one division's zone to another division's rule. Dropping
 * the field is the honest third option; a per-division suggestion channel is its
 * own design, not a side effect of this endpoint.
 */
export interface AiCompetitionPlanResponse
  extends Omit<CompetitionPlanResult, "usage" | "constraint_suggestions">,
    Omit<RunMeterStamp, "divisions"> {
  /** Court labels not shared by every solved division — same-named courts are
   *  the SAME court and differently-named ones are not, so the board warns. */
  divergent_courts: string[];
  /**
   * One row per SOLVED division, in pack order: what it is AND what it cost.
   *
   * Deliberately ONE array. `RunMeterStamp.divisions` (lib/ai-rung.ts, mirrored
   * by `AiRunPriceFields` in api-v1/schemas.ts) already keys a per-division
   * price breakdown by division id, and the board needs the division's name and
   * movable count against the same ids — two sibling arrays over one key is a
   * join the client would have to do on every render, and the plan's own
   * response sketch collided on this exact name. So the price fields are merged
   * in here, and the LEDGER event keeps meterStamp's narrow shape verbatim.
   */
  divisions: {
    id: string;
    name: string;
    movable: number;
    rung: Rung;
    predicted_rung: Rung;
    underfunded: boolean;
  }[];
  /** Requested divisions dropped from the run before quoting (ruling R6), so
   *  the organiser is told why a division they selected is missing from the
   *  proposal rather than silently getting a smaller board back. */
  skipped_divisions: { id: string; name: string; reason: "no_movable_fixtures" }[];
  /** Public shape only — `cost_usd` stays on the ledger event. */
  usage: { input_tokens: number; output_tokens: number; repair_rounds: number };
}

/** The competition-level ledger event a successful joint RUN writes. Named once
 *  so the writer below and {@link lastCompetitionAiApply}'s counter cannot
 *  drift — the whole `_multi` suffix exists to keep joint runs apart from
 *  single-division ones, and a literal in two places is how they get mixed up. */
const JOINT_RUN_EVENT = "schedule.ai_generated_multi";

/**
 * The competition-level event a joint APPLY writes — **owned by Task 6**
 * (`applyCompetitionSchedule`), which does not exist yet. Exported so that
 * writer imports this constant instead of retyping the string; the reader below
 * and the two payload keys it needs are the contract:
 *
 *   type    `schedule.applied_multi`
 *   payload `{ source: "ai" | "manual", ai?: { instruction, summary } }`
 *
 * Mirrors the division twin's `schedule_applied` + `payload->>'source' = 'ai'`
 * exactly (schedule.ts:618-622), for the same reason: the same event records a
 * manual multi-division apply, and only an AI-sourced one is a recall.
 */
export const JOINT_APPLY_EVENT = "schedule.applied_multi";

/**
 * GET /competitions/{id}/schedule/ai-last — the joint twin of `lastAiApply`
 * (schedule.ts:607), field for field.
 *
 * IT RECALLS THE LAST APPLY, NOT THE LAST PROPOSAL, and that is not a shortfall
 * of the joint flow — the single-division board has never persisted a proposal
 * either. An AI plan is propose-only: nothing about it is written down unless
 * the organiser applies it, at which point the apply event carries the
 * instruction that produced it and the model's own summary of what it did.
 * Recalling that is what "what did the AI last do to my schedule?" means here.
 *
 * `last` is therefore legitimately null until Task 6 lands
 * {@link JOINT_APPLY_EVENT} — no joint apply can have happened, so there is
 * nothing to recall, and a plan run alone must not fill this in.
 *
 * `runs.used` counts joint runs on this competition. Note it is NOT the same
 * counter as the division twin's: `lastAiApply` counts `schedule.ai_generated`
 * rows carrying a matching `division_id`, which a joint run never writes, so a
 * joint run does not and should not move a division's count. One counter per
 * endpoint, each counting the runs its own endpoint bills for. `max` is null —
 * joint runs are metered by the credit wallet, not by a run quota.
 *
 * Read scope: the recall exposes provenance that is already in the ledger.
 */
export async function lastCompetitionAiApply(
  auth: AuthCtx,
  competitionId: string,
): Promise<{
  last: { at: string; instruction: string; summary: string } | null;
  runs: { used: number; max: number | null };
}> {
  const { rows, used } = await withTenant(auth.orgId, async (tx) => {
    const rows = await tx<
      { created_at: Date; payload: { ai?: { instruction?: string; summary?: string } } }[]
    >`
      select created_at, payload from competition_events
       where competition_id = ${competitionId}
         and type = ${JOINT_APPLY_EVENT}
         and payload->>'source' = 'ai'
       -- competition_events has no seq column (division_events does), so the
       -- tie-break is the id. Two applies inside ONE transaction would share a
       -- created_at; nothing writes two.
       order by created_at desc, id desc
       limit 1`;
    const [count] = await tx<{ n: number }[]>`
      select count(*)::int as n from competition_events
       where competition_id = ${competitionId} and type = ${JOINT_RUN_EVENT}`;
    return { rows, used: count?.n ?? 0 };
  });
  const ai = rows[0]?.payload.ai ?? {};
  return {
    last:
      rows.length === 0
        ? null
        : {
            at: new Date(rows[0]!.created_at).toISOString(),
            instruction: ai.instruction ?? "",
            summary: ai.summary ?? "",
          },
    runs: { used, max: null },
  };
}

/**
 * POST /competitions/{id}/schedule/ai-plan orchestrator — the joint twin of
 * `aiPlanForDivision` (schedule-ai.ts:1585).
 *
 * GATE ORDER, and why each step sits where it does:
 *
 *   1. kill switch `ai-scheduling` (fail-open) — a rollout switch, never a
 *      billing gate, so an unreachable PostHog must not block a paying org.
 *   2. `scheduling.ai` (402).
 *   3. `scheduling.multi_division` (402). This is the FIRST server-side
 *      enforcement of that key anywhere: until now it only hid a page
 *      (`c/[compSlug]/schedule/page.tsx:36`), so an API caller could reach
 *      multi-division behaviour without the plan.
 *   4. `>= 2` divisions (400) — the discount-arbitrage rule above.
 *   5. competition + divisions in ONE query: unknown competition 404, a
 *      requested id not in this competition 404 naming it, a frozen division
 *      409 naming it.
 *   6. a division that cannot be planned at all (no courts / unparseable
 *      settings) 422 naming it.
 *   6b. divisions with nothing movable are DROPPED (ruling R6), not refused —
 *      a joint action over five divisions must not fail because one of them is
 *      already fully scheduled, and must never charge for a division it did not
 *      solve. Fewer than two left falls back to step 4's 400.
 *   7. wallet resolve, 8. rate limit (its OWN key namespace — a joint run must
 *      not consume the per-division 5/hr buckets), 9. pack build (the summed
 *      500 cap fires here), 10. quote, 11. `spendCredit`.
 *
 * Everything through step 10 happens before a single credit is reserved.
 *
 * @throws HttpError 403 FEATURE_DISABLED, 402 (either paid gate, or an empty
 *   credit wallet), 400 AI_PLAN_SINGLE_DIVISION, 404, 409 SCHEDULE_LOCKED,
 *   409 AI_PLAN_TOO_LARGE, 422 AI_PLAN_DIVISION_UNPLANNABLE, 429, plus
 *   everything the runner raises (422 AI_PLAN_FAILED/AI_PLAN_TIMEOUT, 503).
 */
export async function aiPlanForCompetition(
  auth: AuthCtx,
  competitionId: string,
  input: AiCompetitionPlanRequest,
): Promise<AiCompetitionPlanResponse> {
  // Stable analytics id: the user, or an org: synthetic when an API key drives
  // the call (auth.userId is null for key auth).
  const distinctId = auth.userId ?? `org:${auth.orgId}`;
  if (
    !(await isServerFeatureEnabled("ai-scheduling", distinctId, { orgId: auth.orgId, fallback: true }))
  ) {
    throw new HttpError(403, "AI scheduling is currently turned off", "FEATURE_DISABLED");
  }
  await requireFeature(auth.orgId, "scheduling.ai");
  await requireFeature(auth.orgId, "scheduling.multi_division");

  const requested = [...new Set(input.division_ids)];
  if (requested.length < 2) throw singleDivision();

  const rows = await withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx<{ id: string }[]>`
      select id from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    // A competition frozen by competitions.max_active (a downgrade left more
    // active competitions than the plan allows) is read-only: applySchedule
    // refuses with a 402 (schedule.ts:496). Exactly the argument the
    // schedule_locked 409 below makes — planning one spends credits and tokens
    // on a proposal the organiser is then blocked from applying — except a
    // joint run's charge is N times larger, so it is checked here rather than
    // inherited from the single-division path, which does not check it.
    await assertCompetitionNotFrozen(auth.orgId, competitionId, tx);
    // One query for every per-division gate below — locked state, slot config
    // and the movable count that decides the R6 drop. The count is un-scoped
    // `status = MOVABLE_STATUS`, which is exactly what the joint builder plans
    // (it never passes a repair `scope`), so it cannot disagree with the pack.
    return tx<
      {
        id: string;
        name: string;
        slug: string;
        schedule_locked: boolean | null;
        config: unknown | null;
        movable: number;
      }[]
    >`
      select d.id, d.name, d.slug, d.schedule_locked, ss.config,
             (select count(*)::int from fixtures f
               where f.division_id = d.id and f.status = ${MOVABLE_STATUS}) as movable
        from divisions d
        left join schedule_settings ss on ss.division_id = d.id
       where d.competition_id = ${competitionId} and d.id in ${tx(requested)}`;
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  // Checks run in REQUEST order so the error a caller gets back is a function
  // of the request alone, never of row order out of Postgres.
  for (const id of requested) {
    if (!byId.has(id)) throw new HttpError(404, `division not in competition: ${id}`);
  }
  for (const id of requested) {
    const row = byId.get(id)!;
    // A frozen division rejects every applied plan, so planning one spends
    // credits and tokens on a proposal the organiser is then blocked from
    // using — the failure would surface minutes later at Apply. Refuse here.
    if (row.schedule_locked === true) {
      throw new HttpError(
        409,
        `the schedule for division "${row.name}" is frozen — unfreeze it to plan with AI`,
        "SCHEDULE_LOCKED",
      );
    }
  }
  for (const id of requested) {
    const row = byId.get(id)!;
    // `courts` is min(1) in ScheduleConfig, so an empty list can only reach the
    // row from outside the API — and it would otherwise surface as a 500 from
    // the parse inside buildSchedulePack. Both branches are live: the first is
    // the specific, actionable message, the second catches every other way a
    // hand-edited config fails to parse.
    const raw = (row.config ?? {}) as { courts?: unknown };
    if (Array.isArray(raw.courts) && raw.courts.length === 0) {
      throw new HttpError(
        422,
        `division "${row.name}" has no courts configured — set them on its schedule settings`,
        UNPLANNABLE,
      );
    }
    if (!ScheduleConfig.safeParse(row.config ?? {}).success) {
      throw new HttpError(
        422,
        `division "${row.name}" has invalid schedule settings and cannot be planned`,
        UNPLANNABLE,
      );
    }
  }

  // Ruling R6. Dropped BEFORE the quote, so a division with nothing to solve is
  // never a priced line — and, in `repair` mode, so the per-division builder's
  // 422 AI_PLAN_EMPTY_SCOPE can never escape from a joint call.
  const kept = requested.filter((id) => byId.get(id)!.movable > 0);
  const skipped_divisions = requested
    .filter((id) => byId.get(id)!.movable === 0)
    .map((id) => ({
      id,
      name: byId.get(id)!.name,
      reason: "no_movable_fixtures" as const,
    }))
    // Same (name, slug) domain order the pack sorts divisions by — never the id.
    .sort(
      (a, b) =>
        cmp(a.name, b.name) || cmp(byId.get(a.id)!.slug, byId.get(b.id)!.slug),
    );
  if (kept.length < 2) throw singleDivision();

  // AI runs are wallet-metered on every tier (v17 SPEC-2 §5.2). Resolved here;
  // the reserve itself happens below, right around the model call, so a
  // rate-limited or too-large request never touches the wallet.
  const walletId = await walletIdFor(auth.orgId);
  // Its OWN key namespace. Sharing `ai-plan:{divisionId}` would let one joint
  // run burn a slot in every selected division's per-division bucket.
  await rateLimit(`ai-plan-competition:${competitionId}`, { max: 3, windowSeconds: 3600 });

  // The summed 500-fixture cap lives in here — still before any reserve.
  const { pack, movableIds } = await buildCompetitionPack(auth, competitionId, kept, {
    mode: input.mode,
    instruction: input.instruction,
    ...(input.prior !== undefined ? { prior: input.prior } : {}),
  });

  // Token-weighted pricing (lib/ai-rung.ts): one line per SOLVED division, so
  // `credits` is max(1, Σ rungs − 1) and `budget` is sized from the
  // UNDISCOUNTED Σ — the batch discount is a margin gift, not a capability cut.
  const quote = quoteRun(
    pack.divisions.map((d) => ({
      key: d.id,
      input: {
        movableFixtures: d.movableIds.length,
        entrants: pack.entrants.filter((e) => e.division_id === d.id).length,
        courts: d.settings.courts.length,
      },
      ...(input.rung_overrides?.[d.id] !== undefined
        ? { chosen: input.rung_overrides[d.id]! }
        : {}),
    })),
    schedulingRungWeights(),
  );
  // One meter for the whole run — every ladder rung and repair round charges it.
  const meter = createTokenMeter(quote.budget, { units: movableIds.size });
  const pricedByDivision = new Map(quote.lines.map((l) => [l.key, l]));

  // R7: only `.size` and membership of `movableIds` are stable, so nothing here
  // serialises the set. Division ids are a sorted array off the pack instead.
  const division_ids = pack.divisions.map((d) => d.id).sort(cmp);
  const skipped_division_ids = skipped_divisions.map((s) => s.id).sort(cmp);

  let result: CompetitionPlanResult & {
    served_model: string;
    escalated_from?: string;
    rungs_tried: string[];
  };
  try {
    // Reserve → run → settle on success, release on throw. A
    // PaymentRequiredError("ai.credits") from an empty wallet is raised by the
    // reserve itself, before the model is ever called, and falls through the
    // catch below untouched.
    result = await spendCredit(walletId, auth.orgId, quote.credits, async () => ({
      aiRunId: crypto.randomUUID(),
      // The LADDER, not the single-model runner: production wants the fallback
      // chain, and the two names differ by one word.
      result: await runCompetitionAiPlanLadder(pack, movableIds, meter),
    }));
  } catch (err) {
    // Spec §11: a run that produced nothing usable is not charged (spendCredit
    // released the hold on the throw) but IS recorded — an un-metered failure
    // is invisible in both analytics and the run ledger, and a failed joint run
    // is the most expensive failure this product has.
    const providerErr = err instanceof AiProviderError ? err : null;
    const providerCause = providerErr?.cause as { status?: number; name?: string } | undefined;
    const planErr =
      err instanceof HttpError && (err.code === "AI_PLAN_FAILED" || err.code === "AI_PLAN_TIMEOUT")
        ? err
        : null;
    if (planErr || providerErr) {
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
      const outcome = providerErr
        ? "provider_error"
        : planErr!.code === "AI_PLAN_TIMEOUT"
          ? "timeout"
          : "failed";
      const cost_usd =
        usage.cost_usd ?? aiRunCostUsd(model, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
      await withTenant(auth.orgId, async (tx) => {
        await tx`
          insert into competition_events (competition_id, org_id, type, payload, actor_id)
          values (${competitionId}, ${auth.orgId}, 'schedule.ai_failed_multi',
                  ${tx.json({
                    division_ids,
                    skipped_division_ids,
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
                    pack_units: movableIds.size,
                    // What was reserved, what it bought, and the per-division
                    // breakdown behind the discount — stamped on the failure row
                    // too, so a run that cost real tokens for nothing is priced
                    // in the ledger exactly like one that worked.
                    ...meterStamp(quote, meter),
                    ...(providerErr
                      ? {
                          provider_status: providerCause?.status ?? null,
                          provider_type: providerCause?.name ?? providerErr.name,
                        }
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
          divisions: pack.divisions.length,
          credits: quote.credits,
          ...(providerErr ? { provider_status: providerCause?.status ?? null } : {}),
        },
      });
    }
    if (providerErr) {
      // The provider's message can carry OUR billing state — never let it reach
      // a tenant.
      throw new HttpError(
        503,
        "AI scheduling is temporarily unavailable; please retry",
        "AI_PROVIDER_UNAVAILABLE",
      );
    }
    throw err;
  }

  const model = result.served_model;
  const cost_usd =
    result.usage.cost_usd ??
    aiRunCostUsd(model, result.usage.input_tokens, result.usage.output_tokens);
  await withTenant(auth.orgId, async (tx) => {
    await tx`
      insert into competition_events (competition_id, org_id, type, payload, actor_id)
      values (${competitionId}, ${auth.orgId}, ${JOINT_RUN_EVENT},
              ${tx.json({
                division_ids,
                // R6: what the organiser asked for but the run did not solve —
                // without it the ledger cannot explain why a 5-division request
                // was priced as 4.
                skipped_division_ids,
                // LOAD-BEARING, not decoration. Both /admin readers classify a
                // run by `type` first and fall back to `payload->>'phase'`,
                // whose default arm is 'officials' (ai-runs-admin.ts:115,472) —
                // so an unstamped joint run is filed under the wrong phase and
                // skews both phases' $/unit. The failure row below stamps it
                // too; the two must not drift.
                phase: "schedule",
                mode: input.mode,
                model,
                usage: result.usage,
                cost_usd,
                pack_units: movableIds.size,
                // credits, discount, budget, spent_tokens, stopped_on_budget,
                // underfunded and the per-division breakdown — one builder, so
                // the event and the API response cannot drift.
                ...meterStamp(quote, meter),
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

  // Expensive-run watch (v17 gap #295) — deliberately AFTER the insert above,
  // whose table is the baseline's own source, and deferred so the tenant's paid
  // response does not wait on a table scan plus an email send. A joint run is
  // the class this alert exists for: it is compared against the SINGLE-division
  // 30-day median (medianRunCostUsd is scoped to schedule.ai_generated), so an
  // N-division run that costs several times one division's run will trip it —
  // which is the intended signal while joint pricing is uncalibrated, not noise.
  deferred(() =>
    maybeAlertExpensiveRun({
      orgId: auth.orgId,
      competitionId,
      phase: "schedule",
      model,
      costUsd: cost_usd,
      mode: input.mode,
      packUnits: movableIds.size,
    }),
  );

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
      // The one property the single-division event cannot carry: what makes
      // this run a joint one, and what it was priced on.
      divisions: pack.divisions.length,
      credits: quote.credits,
    },
  });

  return {
    proposal: result.proposal,
    unschedulable: result.unschedulable,
    // R13: warnings are carried IN FULL. `isBlocking` covers only `court` and
    // direct `order`, so blackout, session-window, rest and person-overlap
    // violations neither block nor trigger a repair round — the organiser
    // reviewing this response is the last automated-gate-free line of defence,
    // and the board cannot render what is not returned here.
    warnings: result.warnings,
    blocking: result.blocking,
    diff: result.diff,
    explanations: result.explanations,
    // constraint_suggestions is dropped on purpose — see the response type.
    summary: result.summary,
    divergent_courts: pack.divergentCourts,
    skipped_divisions,
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      repair_rounds: result.usage.repair_rounds,
    },
    ...meterStamp(quote, meter),
    // AFTER the stamp, deliberately: the stamp carries its own narrow
    // `divisions` breakdown and this merged one replaces it (see the field's
    // doc comment). Every solved division has a quote line — they are built
    // from the same `pack.divisions` — so the lookup cannot miss.
    divisions: pack.divisions.map((d) => {
      const line = pricedByDivision.get(d.id)!;
      return {
        id: d.id,
        name: d.name,
        movable: d.movableIds.length,
        rung: line.rung,
        predicted_rung: line.predictedRung,
        underfunded: line.underfunded,
      };
    }),
  };
}
