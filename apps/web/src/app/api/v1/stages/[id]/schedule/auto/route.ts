import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { AutoScheduleRequest } from "@/server/api-v1/schemas";
import { autoSchedule } from "@/server/usecases/schedule";

type Ctx = { params: Promise<{ id: string }> };

/** Run/re-run the pure calendar pass — propose only, nothing persisted
 *  (doc 12 §4). Body optional: { only_unlocked?: boolean }. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    const body = AutoScheduleRequest.parse(await req.json().catch(() => ({})));
    return autoSchedule(auth, id, body.only_unlocked);
  });
}
