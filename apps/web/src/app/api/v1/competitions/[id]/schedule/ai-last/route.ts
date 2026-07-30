import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { lastCompetitionAiApply } from "@/server/usecases/competition-schedule-ai";

type Ctx = { params: Promise<{ id: string }> };

/** GET /competitions/{id}/schedule/ai-last — the competition's most recent
 *  AI-sourced JOINT schedule apply (#350): the instruction that produced it,
 *  the model's summary and the timestamp, or null — plus how many joint runs
 *  this competition has had.
 *
 *  The joint twin of /divisions/{id}/schedule/ai-last, deliberately field for
 *  field. It recalls the last APPLY, not the last proposal: an AI plan is
 *  propose-only and nothing about it is persisted unless the organiser applies
 *  it. `last` stays null until the joint apply lands (Task 6).
 *
 *  Read-only; all plans — the recall surfaces provenance already in the
 *  ledger. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    return lastCompetitionAiApply(auth, id);
  });
}
