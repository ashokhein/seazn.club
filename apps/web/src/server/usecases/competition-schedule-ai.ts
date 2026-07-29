import "server-only";
// #350 Multi-division joint AI scheduling — Phase A joint context pack.
//
// buildCompetitionPack unions several divisions of ONE competition into a
// single deterministic pack. It owns no SQL of its own beyond the competition
// lookup: every division's board is assembled by the existing
// buildSchedulePack (schedule-ai.ts:256), then merged here. That keeps one
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
// The two things a joint pack must get right that a per-division pack cannot:
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
  OTHER_DIVISION_LABEL,
  buildSchedulePack,
  zonedIso,
  type PackAssignment,
  type PackEntrant,
  type PackFixture,
  type PackObstacle,
  type PackPerson,
  type PackSettings,
  type SchedulePack,
} from "./schedule-ai";
import type { Assignment } from "@seazn/engine/scheduling";

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
    // exactly one division. `people` is deliberately empty: a person rostered
    // into one entrant of A and one of B is in NEITHER division's pack people
    // map, so a per-division pack cannot supply cross-division person data.
    // Cross-division person overlap is the joint VERIFIER's job (Task 3).
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

  // Shared players. A person rostered into two entrants of division A and two of
  // division B appears in both source packs; union the entrant sets rather than
  // emitting the person twice. First-seen order (divisions in emitted order,
  // people in their per-division order) is the ordering key for the PEOPLE array
  // — person ids are per-seed UUIDs and must never decide an order.
  const personOrder: string[] = [];
  const entrantsByPerson = new Map<string, string[]>();
  for (const b of built) {
    for (const p of b.pack.people) {
      let ents = entrantsByPerson.get(p.person_id);
      if (ents === undefined) {
        ents = [];
        entrantsByPerson.set(p.person_id, ents);
        personOrder.push(p.person_id);
      }
      for (const e of p.entrant_ids) if (!ents.includes(e)) ents.push(e);
    }
  }
  // The merged entrant_ids must be re-sorted GLOBALLY by entrant name — the
  // invariant at schedule-ai.ts:517-523, applied at :542. Concatenating A's name-sorted ids with
  // B's leaves the array sorted only within each division.
  const entrantNameById = new Map(entrants.map((e) => [e.id, e.name]));
  const byEntrantName = (a: string, b: string): number =>
    cmp(entrantNameById.get(a) ?? "", entrantNameById.get(b) ?? "") || cmp(a, b);
  const people: PackPerson[] = personOrder.map((person_id) => ({
    person_id,
    entrant_ids: entrantsByPerson.get(person_id)!.sort(byEntrantName),
  }));

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
