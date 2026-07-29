import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { lastCompetitionAiPlan } from "@/server/usecases/competition-schedule-ai";

type Ctx = { params: Promise<{ id: string }> };

/** GET /competitions/{id}/schedule/ai-last — recall the competition's most
 *  recent JOINT AI run (#350), or null.
 *
 *  Returns the run's price and usage block as a PARTIAL plan response: the
 *  ledger records what a joint run cost, not the proposal it produced, and a
 *  propose-only plan is never written down unless it is applied. See
 *  `lastCompetitionAiPlan` for exactly which fields survive and why the
 *  per-division breakdown is not among them.
 *
 *  Read-only; all plans — the recall surfaces provenance already in the
 *  ledger. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "read");
    return lastCompetitionAiPlan(auth, id);
  });
}
