import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { publishSchedule } from "@/server/usecases/schedule";

type Ctx = { params: Promise<{ id: string }> };

/** Publish the timetable (doc 12 §1.B step 4): division → scheduled,
 *  schedule_published event, public schedule tab + .ics go live. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    return publishSchedule(auth, id);
  });
}
