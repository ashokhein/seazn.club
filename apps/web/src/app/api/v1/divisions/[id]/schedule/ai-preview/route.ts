import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { AiParsePreviewRequest } from "@/server/api-v1/schemas";
import { previewScheduleAi } from "@/server/usecases/schedule-ai-preview";

type Ctx = { params: Promise<{ id: string }> };

/** POST /divisions/{id}/schedule/ai-preview — W5 (#400): compile the
 *  organiser's instruction and show it, spending nothing.
 *
 *  The parse-only half of the AI schedule run. It makes the stage-1 LLM call
 *  and stops: no credit is reserved, no architect round happens, and declining
 *  what comes back is a client no-op. `POST .../ai-plan` is the second,
 *  deliberate request.
 *
 *  A THIN ADAPTER, on purpose — the same discipline the joint ai-plan route
 *  states. Every gate (kill switch, `scheduling.ai`, frozen board, the run's
 *  own rate-limit bucket, and the affordability refusal that must fire BEFORE
 *  any model call) lives in `previewScheduleAi`, because the ORDER of those
 *  gates is the acceptance criterion for the money path and a second copy here
 *  could only disagree with it.
 *
 *  The v1() wrapper is load-bearing: it propagates HttpError `code`
 *  (FEATURE_DISABLED / SCHEDULE_LOCKED) and the 402's `feature_key`, both of
 *  which the generic lib/http.ts handler drops. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, AiParsePreviewRequest);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return previewScheduleAi(auth, { kind: "division", id }, body);
  });
}
