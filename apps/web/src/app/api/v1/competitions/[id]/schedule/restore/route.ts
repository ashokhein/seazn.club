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
 *  NO 409 escapes this route, unlike the per-division restore: every
 *  `restoreCheckpoint` failure — SEQ_CONFLICT included — is caught by the
 *  usecase's per-division try/catch and reported in `failed[]` with `ok: false`.
 *  The status codes it really returns are 404 (no joint apply on the
 *  competition) and 422 (the named division set is not the applied one).
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
