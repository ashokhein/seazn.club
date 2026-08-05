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
 *  No PER-DIVISION 409 escapes this route, unlike the per-division restore:
 *  every `restoreCheckpoint` failure — SEQ_CONFLICT included — is caught by the
 *  usecase's per-division try/catch and reported in `failed[]` with `ok: false`.
 *  The COMPETITION-scoped 409 is a different animal and does escape: losing the
 *  race for the `joint:` lock means no rewind was attempted at all, so there is
 *  no per-division report to give and the caller is told to retry
 *  (SCHEDULE_APPLY_RESTORE_IN_PROGRESS). The status codes are therefore 404 (no
 *  joint apply on the competition), 422 (the named division set is not the
 *  applied one, or the body is malformed) and that 409 — matching openapi.ts.
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
