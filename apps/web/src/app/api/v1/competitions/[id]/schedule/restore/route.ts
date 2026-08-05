import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { RestoreCompetitionScheduleRequest } from "@/server/api-v1/schemas";
import { restoreCompetitionSchedule } from "@/server/usecases/competition-schedule-restore";

type Ctx = { params: Promise<{ id: string }> };

/** POST /competitions/{id}/schedule/restore — undo one joint apply (#386).
 *
 *  The joint apply's counterpart: the console used to undo a multi-division
 *  apply by looping the per-division restore in the browser, so a closed tab
 *  left half the board carrying the AI schedule.
 *
 *  A THIN ADAPTER, like the apply route: the checkpoint anchors, the validation
 *  of the division set against the apply event, the locking and the per-division
 *  reporting all live in `restoreCompetitionSchedule`.
 *
 *  The v1() wrapper is load-bearing: it propagates EngineError codes (a
 *  concurrent edit makes an undo 409 SEQ_CONFLICT) and HttpError `code`, both of
 *  which the generic lib/http.ts handler drops.
 *
 *  Body parsing precedes auth, matching the apply route exactly. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, RestoreCompetitionScheduleRequest);
    const auth = await requireResourceAuth(req, "competition", id, "write");
    return restoreCompetitionSchedule(auth, id, body);
  });
}
