import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { AiOfficialsPlanRequest } from "@/server/api-v1/schemas";
import { officialsAiPlanForDivision } from "@/server/usecases/officials-ai";

type Ctx = { params: Promise<{ id: string }> };

/** POST /divisions/{id}/officials/ai-plan — the AI Officials Architect, Phase B
 *  of design/v4. Propose-only: the model assigns officials to the dry-run (or
 *  current) schedule, the engine referee is authoritative, and nothing is
 *  written. Gated Pro Plus `officials.auto` (+ `officials.roles_multi` when the
 *  policy asks for more than one role) behind the shared `ai-scheduling` kill
 *  switch + a per-division rate limit; uncapped (the V291 run cap is Phase A
 *  only). The v1() wrapper is load-bearing: it propagates HttpError `code`
 *  (AI_PLAN_FAILED / FEATURE_DISABLED / NO_OFFICIALS) and `extra.usage` that the
 *  generic lib/http.ts handler would drop. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, AiOfficialsPlanRequest);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return officialsAiPlanForDivision(auth, id, body);
  });
}
