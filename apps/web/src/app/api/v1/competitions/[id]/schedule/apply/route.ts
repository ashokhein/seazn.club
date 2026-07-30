import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ApplyCompetitionScheduleRequest } from "@/server/api-v1/schemas";
import { applyCompetitionSchedule } from "@/server/usecases/competition-schedule-apply";

type Ctx = { params: Promise<{ id: string }> };

/** POST /competitions/{id}/schedule/apply — persist a multi-division JOINT AI
 *  plan ATOMICALLY (#350, spec §8): one transaction writes every selected
 *  division's board, or none of it.
 *
 *  The per-stage twin (/stages/{id}/schedule/apply) is single-division by
 *  construction — one advisory lock, one seq token, one seq bump — so the board
 *  used to apply a multi-division plan by calling it in a loop, and any failure
 *  part-way through left the organiser with half a schedule. This endpoint takes
 *  every division's lock (in sorted order, the deadlock guard), verifies the
 *  MERGED board so a cross-division court clash is a 409 rather than a silent
 *  double-book, and commits once.
 *
 *  A THIN ADAPTER, like the ai-plan route: every gate, the joint verification
 *  and both ledger writes live in `applyCompetitionSchedule`.
 *
 *  The v1() wrapper is load-bearing: it propagates EngineError SEQ_CONFLICT
 *  (409 + current_seq) and SCHEDULE_CONFLICT (409 + the blocking conflicts),
 *  plus HttpError `code` (SCHEDULE_LOCKED / SCHEDULE_APPLY_UNKNOWN_FIXTURE),
 *  all of which the generic lib/http.ts handler drops.
 *
 *  It charges nothing — the plan run was already priced and paid for.
 *
 *  Body parsing precedes auth, matching the ai-plan route exactly. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, ApplyCompetitionScheduleRequest);
    const auth = await requireResourceAuth(req, "competition", id, "write");
    return applyCompetitionSchedule(auth, id, body);
  });
}
