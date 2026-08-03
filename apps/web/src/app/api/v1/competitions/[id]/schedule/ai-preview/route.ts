import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { AiParsePreviewRequest } from "@/server/api-v1/schemas";
import { previewScheduleAi } from "@/server/usecases/schedule-ai-preview";

type Ctx = { params: Promise<{ id: string }> };

/** POST /competitions/{id}/schedule/ai-preview — W5 (#400): the joint twin of
 *  the division preview.
 *
 *  `division_ids` is REQUIRED here even though the schema leaves it optional
 *  (one body serves both routes): the resolved window depends on which
 *  divisions are in scope, so a preview compiled against a different set is a
 *  preview of a different run. Fewer than two solvable divisions is the same
 *  400 `AI_PLAN_SINGLE_DIVISION` the joint run answers with, raised inside the
 *  usecase.
 *
 *  A THIN ADAPTER — see the division route; every gate lives in
 *  `previewScheduleAi`, including `scheduling.multi_division`. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, AiParsePreviewRequest);
    const auth = await requireResourceAuth(req, "competition", id, "write");
    return previewScheduleAi(auth, { kind: "competition", id }, body);
  });
}
