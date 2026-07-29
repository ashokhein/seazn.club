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
import { unmeteredTokenMeter, type TokenMeter } from "@/lib/ai-rung";
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

/** Map the LLM proposal onto engine assignments. Two things differ from the
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
 *    single-division path exactly. */
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
    const entrants = f ? [f.home, f.away].filter((e): e is string => e !== null) : [];
    const startAt = ms(a.scheduled_at);
    const minutes = f !== undefined ? minutesByDivision.get(f.division_id) ?? 0 : 0;
    return {
      fixtureId: a.fixture_id,
      court: a.court_label,
      startAt,
      endAt: startAt + minutes * MS_PER_MIN,
      entrants,
      people: entrants.flatMap((e) => personsByEntrant.get(e) ?? []),
      ...(f !== undefined ? { divisionId: f.division_id } : {}),
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
 *  (schedule-ai.ts:914), reading `division.settings` instead of `pack.settings`
 *  and keeping every one of its deliberate drops:
 *
 *    startWindows: []   the pack carries ISO strings, the engine wants epoch ms
 *    fieldFairness: off
 *    parallelism: mixed  a PLACER preference, not a legality rule. Load-bearing
 *                        here in a way it is not single-division: the joint draft
 *                        feeds block-mode exclusivity asymmetrically (a division
 *                        avoids the divisions drafted BEFORE it and never those
 *                        after), so honouring it in the verifier would turn a
 *                        build-order artefact into a verdict.
 *    crossPersonClash: warn   matches single-division semantics exactly — a
 *                        person clash is reported, never blocking. */
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
            startWindows: [],
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
 * Deduplication is not cosmetic. `validateAssignments` resolves feed
 * dependencies against the whole board rather than the pass's own assignments,
 * so a within-division order violation is re-reported verbatim by every other
 * division's pass. Keyed on (fixtureId, reason, detail): the two SIDES of a
 * court clash differ on fixtureId and both survive, which is the intent — either
 * one can be the fixture that moves.
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
  return out.sort((a, b) => cmp(a.fixtureId, b.fixtureId) || cmp(a.reason, b.reason));
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
      division_id: divisionByFixture.get(a.fixture_id) ?? "",
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
        note: "Fix only these conflicts. Move as few fixtures as possible. Do not reintroduce earlier conflicts. A court conflict between two divisions is reported on both fixtures — move either one.",
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
