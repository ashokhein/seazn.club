import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { AiPlanRequest } from "@/server/api-v1/schemas";
import { aiPlanForDivision } from "@/server/usecases/schedule-ai";

type Ctx = { params: Promise<{ id: string }> };

/** POST /divisions/{id}/schedule/ai-plan — the AI Schedule Architect (design/v4).
 *  Propose-only: the model suggests times+courts, the engine verifier is
 *  authoritative, and nothing is written. Gated Pro Plus `scheduling.ai` behind
 *  a staged-rollout kill switch + a per-division rate limit. The v1() wrapper is
 *  load-bearing: it propagates HttpError `code` (AI_PLAN_FAILED / FEATURE_DISABLED)
 *  and `extra.usage` that the generic lib/http.ts handler would drop. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, AiPlanRequest);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return aiPlanForDivision(auth, id, body);
  });
}
