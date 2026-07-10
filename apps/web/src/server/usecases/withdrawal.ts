import "server-only";
// Mid-tournament withdrawal (spec 05 §5, wired per organiser ask 2026-07-10).
// The pure policies live in @seazn/engine/competition/stage:
//   - table stages (league/group/swiss): played < 50% of their fixtures →
//     EXPUNGE (every game they touched voids; standings read as if they never
//     entered); otherwise their remaining games walk over to the opponents.
//   - brackets (knockout/double_elim/stepladder): opponents advance by
//     walkover.
//   - open formats (ladder/americano): remaining games void; the standings
//     they earned stand.
// The surgery itself rides the scoring ledger — core.forfeit for walkovers,
// core.void + core.abandon for expunges — so standings recompute, undo works
// and the public cache invalidates exactly like any other scoring write.
// Finalized fixtures are locked (spec 03) and are reported, not touched.
import {
  withdrawBracketEntrant,
  withdrawTableEntrant,
  type BracketFixture,
  type FixtureUpdate,
  type TableFixture,
} from "@seazn/engine/competition";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getEntrant, patchEntrant } from "./entrants";
import { getDivision } from "./divisions";
import { listStages } from "./stages";
import { listDivisionFixtures, listEvents, getFixtureState } from "./fixtures";
import { scoreEvent } from "./scoring";

const TABLE_KINDS = new Set(["league", "group", "swiss"]);
const BRACKET_KINDS = new Set(["knockout", "double_elim", "stepladder"]);
const SETTLED = new Set(["decided", "finalized", "forfeited"]);
const PENDING = new Set(["scheduled", "in_play"]);
const REASON = "entrant withdrew";

export interface WithdrawCascadeOut {
  entrant_id: string;
  status: "withdrawn";
  /** Which policy the engine picked per spec 05 §5. */
  policy: "none" | "walkover" | "expunge";
  walkovers: number;
  voided: number;
  /** Finalized fixtures are immutable — listed so the organiser knows. */
  skipped_finalized: number;
}

interface FixtureRowLite {
  id: string;
  stage_id: string;
  pool_id?: string | null;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
}

/** Void every effective (not-yet-voided) state-bearing event, newest first,
 *  then abandon — the expunge path for a fixture that already has a result. */
async function voidAndAbandon(auth: AuthCtx, fixtureId: string): Promise<void> {
  const events = await listEvents(auth, fixtureId, 0);
  const voidedIds = new Set(
    events.filter((e) => e.voids_event_id !== null).map((e) => e.voids_event_id as string),
  );
  const targets = events
    .filter(
      (e) =>
        !["core.start", "core.void", "core.note", "core.award"].includes(e.type) &&
        !voidedIds.has(e.id),
    )
    .sort((a, b) => b.seq - a.seq);
  for (const target of targets) {
    const state = await getFixtureState(auth, fixtureId);
    await scoreEvent(auth, fixtureId, {
      expected_seq: state.last_seq,
      type: "core.void",
      payload: { event_id: target.id },
    });
  }
  const state = await getFixtureState(auth, fixtureId);
  await scoreEvent(auth, fixtureId, {
    expected_seq: state.last_seq,
    type: "core.abandon",
    payload: { reason: REASON },
  });
}

async function applyUpdate(
  auth: AuthCtx,
  update: FixtureUpdate & { walkoverBy?: string },
  fixture: FixtureRowLite,
  out: WithdrawCascadeOut,
): Promise<void> {
  if (fixture.status === "finalized" || fixture.status === "cancelled") {
    out.skipped_finalized++;
    return;
  }
  if (update.status === "walkover" && update.walkoverTo !== undefined && update.walkoverBy) {
    const state = await getFixtureState(auth, fixture.id);
    await scoreEvent(auth, fixture.id, {
      expected_seq: state.last_seq,
      type: "core.forfeit",
      payload: { by: update.walkoverBy, reason: REASON },
    });
    out.walkovers++;
    return;
  }
  // void — pending fixtures abandon directly; resulted ones expunge first.
  if (SETTLED.has(fixture.status) && fixture.outcome !== null) {
    await voidAndAbandon(auth, fixture.id);
  } else {
    const state = await getFixtureState(auth, fixture.id);
    await scoreEvent(auth, fixture.id, {
      expected_seq: state.last_seq,
      type: "core.abandon",
      payload: { reason: REASON },
    });
  }
  out.voided++;
}

export async function withdrawEntrantCascade(
  auth: AuthCtx,
  entrantId: string,
): Promise<WithdrawCascadeOut> {
  const entrant = await getEntrant(auth, entrantId);
  if (entrant.status === "withdrawn") {
    throw new HttpError(409, "entrant is already withdrawn");
  }
  const division = await getDivision(auth, entrant.division_id);
  const out: WithdrawCascadeOut = {
    entrant_id: entrantId,
    status: "withdrawn",
    policy: "none",
    walkovers: 0,
    voided: 0,
    skipped_finalized: 0,
  };

  // Before the tournament starts there is nothing to settle: fixtures (if
  // generated) are regenerated from the field anyway — plain status flip.
  if (division.status === "active" || division.status === "completed") {
    const [stages, fixtures] = await Promise.all([
      listStages(auth, division.id),
      listDivisionFixtures(auth, division.id),
    ]);
    const byStage = new Map<string, FixtureRowLite[]>();
    for (const f of fixtures as unknown as FixtureRowLite[]) {
      if (f.home_entrant_id !== entrantId && f.away_entrant_id !== entrantId) continue;
      const list = byStage.get(f.stage_id) ?? [];
      list.push(f);
      byStage.set(f.stage_id, list);
    }

    const plan: { update: FixtureUpdate & { walkoverBy?: string }; fixture: FixtureRowLite }[] = [];
    for (const stage of stages) {
      const mine = byStage.get(stage.id) ?? [];
      if (mine.length === 0) continue;
      const byId = new Map(mine.map((f) => [f.id, f]));

      if (TABLE_KINDS.has(stage.kind)) {
        // Engine shapes: played fixtures carry a result naming both sides;
        // the policy only counts involvement, so minimal deltas suffice.
        const zero = (id: string) =>
          ({ entrantId: id, played: 1, won: 0, drawn: 0, lost: 0, points: 0, metrics: {} });
        const played: TableFixture[] = mine
          .filter((f) => SETTLED.has(f.status) && f.outcome !== null)
          .map((f) => ({
            id: f.id,
            status: "decided" as const,
            result: [zero(f.home_entrant_id ?? ""), zero(f.away_entrant_id ?? "")] as const,
          }));
        const pending = mine
          .filter((f) => PENDING.has(f.status))
          .map((f) => ({
            id: f.id,
            opponent: (f.home_entrant_id === entrantId ? f.away_entrant_id : f.home_entrant_id) ?? "",
          }));
        const result = withdrawTableEntrant(
          {
            id: stage.id,
            kind: stage.kind as "league" | "group" | "swiss",
            // The policy only counts involvement — field and cascade are
            // irrelevant to it, but the type carries them for the rankers.
            entrants: [entrantId],
            cascade: [],
          },
          entrantId,
          { played, pending },
        );
        const mode = result.events[0]?.type === "entrant_withdrawn" ? result.events[0].mode : undefined;
        out.policy = mode === "expunge" ? "expunge" : out.policy === "expunge" ? "expunge" : "walkover";
        for (const u of result.updates) {
          const f = byId.get(u.fixtureId);
          if (f) plan.push({ update: { ...u, walkoverBy: entrantId }, fixture: f });
        }
      } else if (BRACKET_KINDS.has(stage.kind)) {
        const bracketFixtures: BracketFixture[] = mine.map((f) => ({
          id: f.id,
          round: f.round_no,
          status: (SETTLED.has(f.status) ? "decided" : PENDING.has(f.status) ? "scheduled" : "void") as
            | "decided"
            | "scheduled"
            | "void",
          home: f.home_entrant_id ?? undefined,
          away: f.away_entrant_id ?? undefined,
        }));
        const result = withdrawBracketEntrant(
          { id: stage.id, kind: stage.kind as "knockout" | "double_elim" | "stepladder" },
          entrantId,
          bracketFixtures,
        );
        if (out.policy === "none") out.policy = "walkover";
        for (const u of result.updates) {
          const f = byId.get(u.fixtureId);
          if (f) plan.push({ update: { ...u, walkoverBy: entrantId }, fixture: f });
        }
      } else {
        // Open formats: remaining games void; earned standings stand.
        for (const f of mine) {
          if (PENDING.has(f.status)) plan.push({ update: { fixtureId: f.id, status: "void" }, fixture: f });
        }
        if (out.policy === "none" && plan.length > 0) out.policy = "walkover";
      }
    }

    for (const step of plan) {
      // A TBD opponent can't receive a walkover — void that slot instead.
      if (step.update.status === "walkover" && !step.update.walkoverTo) {
        step.update = { fixtureId: step.update.fixtureId, status: "void" };
      }
      await applyUpdate(auth, step.update, step.fixture, out);
    }
  }

  await patchEntrant(auth, entrantId, { status: "withdrawn" });
  return out;
}
