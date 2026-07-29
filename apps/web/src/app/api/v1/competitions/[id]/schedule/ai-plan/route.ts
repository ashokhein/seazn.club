import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { AiCompetitionPlanRequest } from "@/server/api-v1/schemas";
import { aiPlanForCompetition } from "@/server/usecases/competition-schedule-ai";

type Ctx = { params: Promise<{ id: string }> };

/** POST /competitions/{id}/schedule/ai-plan — multi-division JOINT AI
 *  scheduling (#350). One model call plans several divisions of one
 *  competition together, so cross-division court and player clashes are solved
 *  rather than discovered afterwards, and the run is priced as one batch.
 *
 *  A THIN ADAPTER, on purpose. Every gate, the 500-fixture cap, the rate limit,
 *  the quote and the credit spend live in `aiPlanForCompetition` — the ORDER of
 *  those gates is the acceptance criterion for the money path, so a second
 *  copy of any of them here could only make the route disagree with the
 *  usecase about what happens before a credit is reserved.
 *
 *  The v1() wrapper is load-bearing: it propagates HttpError `code`
 *  (AI_PLAN_SINGLE_DIVISION / AI_PLAN_TOO_LARGE / AI_PLAN_DIVISION_UNPLANNABLE
 *  / AI_PLAN_SCOPE_CHANGED / AI_PLAN_FAILED / SCHEDULE_LOCKED) and `extra.usage`,
 *  both of which the generic lib/http.ts handler drops.
 *
 *  Body parsing precedes auth, matching the single-division route exactly. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, AiCompetitionPlanRequest);
    const auth = await requireResourceAuth(req, "competition", id, "write");
    return aiPlanForCompetition(auth, id, body);
  });
}
