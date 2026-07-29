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
// discriminator it uses the division NAME, never the per-seed division UUID.
//
// The two things a joint pack must get right that a per-division pack cannot:
//   * a selected division's own fixtures must never re-appear as obstacles —
//     buildSchedulePack serves every SIBLING division's placements as
//     "Other division" obstacles, including the siblings that are themselves in
//     this run;
//   * courts are matched across divisions by LABEL and nothing else, so the
//     pack names the labels that do not appear in every selected division
//     (`divergentCourts`) for the board to warn on.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
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

/** Total movable fixtures across the whole joint pack. Over this the run is
 *  refused before any credit is reserved — the per-division builder keeps its
 *  own 500 cap (schedule-ai.ts:293), this one is on the SUM. */
export const COMPETITION_MOVABLE_CAP = 500;

/** The label buildSchedulePack stamps on a sibling division's placements
 *  (schedule-ai.ts:450). Siblings arrive carrying no division metadata at all —
 *  siblingAssignments (schedule.ts:271) returns bare engine assignments — so
 *  this label is the only marker that separates "another division's board" from
 *  "this division's own fixed fixtures" in a per-division pack. */
const SIBLING_LABEL = "Other division";

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
  /** Sorted by name, then id. */
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
 * 409 AI_PLAN_TOO_LARGE when the summed movable count exceeds
 * {@link COMPETITION_MOVABLE_CAP}. The minimum-two-divisions rule is a caller
 * gate (it exists to stop discount arbitrage, not to protect the pack), so it
 * is enforced by aiPlanForCompetition, not here.
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

  const { competition, divisionRows } = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string; name: string }[]>`
      select id, name from competitions where id = ${competitionId}`;
    if (!row) throw new HttpError(404, "competition not found");
    const divisionRows = await tx<{ id: string; name: string }[]>`
      select id, name from divisions
      where competition_id = ${competitionId} and id in ${tx(requested)}`;
    return { competition: row, divisionRows };
  });

  const nameById = new Map(divisionRows.map((d) => [d.id, d.name]));
  for (const id of requested) {
    if (!nameById.has(id)) throw new HttpError(404, `division not in competition: ${id}`);
  }
  // Build (and therefore emit) in a stable DOMAIN order: name, then id as the
  // last-resort tie-break for two divisions sharing a name.
  const order = [...requested].sort(
    (a, b) => cmp(nameById.get(a)!, nameById.get(b)!) || cmp(a, b),
  );

  const built: { id: string; pack: SchedulePack; movableIds: Set<string> }[] = [];
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
    const one = await buildSchedulePack(auth, id, {
      mode: opts.mode,
      instruction: opts.instruction,
      ...(prior !== undefined ? { prior } : {}),
    });
    built.push({ id, pack: one.pack, movableIds: one.movableIds });
  }

  // The joint cap is on the SUM and is checked after the union — the caller
  // reserves credit only once this has passed.
  const movableIds = new Set(built.flatMap((b) => [...b.movableIds]));
  if (movableIds.size > COMPETITION_MOVABLE_CAP) {
    throw new HttpError(409, "too large — schedule per division", "AI_PLAN_TOO_LARGE");
  }

  const divisions: CompetitionPackDivision[] = built.map((b) => ({
    id: b.pack.division.id,
    name: b.pack.division.name,
    sport: b.pack.division.sport,
    tz: b.pack.division.tz,
    settings: b.pack.settings,
    movableIds: b.pack.fixtures.movable.map((f) => f.id),
  }));

  // Courts: a label is THE SAME COURT across divisions iff the string matches.
  const courtSets = built.map((b) => new Set(b.pack.settings.courts));
  const courts = [...new Set(built.flatMap((b) => b.pack.settings.courts))].sort(cmp);
  const divergentCourts = courts.filter((c) => !courtSets.every((s) => s.has(c)));

  const divisionName = (id: string): string => nameById.get(id) ?? "";

  const movable: CompetitionPackFixture[] = built
    .flatMap((b) => b.pack.fixtures.movable.map((f) => ({ ...f, division_id: b.id })))
    .sort(
      (a, b) =>
        cmp(divisionName(a.division_id), divisionName(b.division_id)) ||
        a.round - b.round ||
        a.seq - b.seq ||
        cmp(a.ext_key ?? "", b.ext_key ?? "") ||
        cmp(a.home ?? "", b.home ?? "") ||
        cmp(a.away ?? "", b.away ?? ""),
    );

  // -------------------------------------------------------------------------
  // Obstacles.
  //
  // A per-division pack's obstacle list is (its own fixed fixtures) + (EVERY
  // sibling division's placements, flattened to the SIBLING_LABEL). When two
  // siblings are both in this run each one's board arrives twice: once as its
  // own movable fixtures, once as the other's obstacles. Serving both would
  // hand the model a board where half its own work is already immovable.
  //
  // So: a sibling entry whose (court, start) is a slot a SELECTED division
  // already owns — as a movable fixture's current placement or as its own fixed
  // obstacle — is dropped. Court+start identifies a placement; end is left out
  // of the key because a sibling's duration is re-derived from that sibling's
  // settings and need not agree byte-for-byte with its own pack's.
  // -------------------------------------------------------------------------
  const ownedSlots = new Set<string>();
  for (const b of built) {
    for (const f of b.pack.fixtures.movable) {
      if (f.current.at !== null && f.current.court !== null) {
        ownedSlots.add(`${f.current.court}|${ms(f.current.at)}`);
      }
    }
    for (const o of b.pack.fixtures.obstacles) {
      if (o.label !== SIBLING_LABEL) ownedSlots.add(`${o.court}|${ms(o.from)}`);
    }
  }

  // Foreign obstacles arrive once per source pack, each rendered in THAT
  // division's timezone. Re-render them in one canonical zone (the first
  // division in the emitted order) so the same excluded placement is one entry
  // with one spelling however many selected divisions reported it.
  const canonicalTz = divisions[0]!.tz;
  const collected: CompetitionPackObstacle[] = [];
  for (const b of built) {
    for (const o of b.pack.fixtures.obstacles) {
      if (o.label !== SIBLING_LABEL) {
        collected.push({ ...o, division_id: b.id });
        continue;
      }
      if (ownedSlots.has(`${o.court}|${ms(o.from)}`)) continue;
      collected.push({
        court: o.court,
        from: zonedIso(ms(o.from), canonicalTz),
        to: zonedIso(ms(o.to), canonicalTz),
        label: o.label,
        division_id: null,
      });
    }
  }
  const seenObstacle = new Set<string>();
  const obstacles = collected
    .filter((o) => {
      const key = `${o.court}|${ms(o.from)}|${ms(o.to)}`;
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
    cmp(divisionName(a.division_id), divisionName(b.division_id)) ||
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
  // people in their per-division order) is the ordering key — person and entrant
  // ids are per-seed UUIDs and must never decide an order.
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
  const people: PackPerson[] = personOrder.map((person_id) => ({
    person_id,
    entrant_ids: entrantsByPerson.get(person_id)!,
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
