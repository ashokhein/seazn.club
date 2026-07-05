import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ApplyScheduleRequest } from "@/server/api-v1/schemas";
import { applySchedule } from "@/server/usecases/schedule";

type Ctx = { params: Promise<{ id: string }> };

/** Persist an assignment set (from auto or the board editor) transactionally;
 *  blocking conflicts → 409 SCHEDULE_CONFLICT (doc 12 §2/§4). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const input = await parseBody(req, ApplyScheduleRequest);
    return applySchedule(auth, id, input);
  });
}
