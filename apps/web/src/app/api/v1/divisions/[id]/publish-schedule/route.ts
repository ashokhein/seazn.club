import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PublishScheduleRequest } from "@/server/api-v1/schemas";
import { publishSchedule } from "@/server/usecases/schedule";

type Ctx = { params: Promise<{ id: string }> };

/** Publish the timetable (doc 12 §1.B step 4): division → scheduled,
 *  schedule_published event, public schedule tab + .ics go live.
 *
 *  #230 item 2: gated on a final server-side validation. Blocking conflicts 422
 *  SCHEDULE_BLOCKING_CONFLICTS; warnings 422 SCHEDULE_UNACKNOWLEDGED_WARNINGS
 *  until the caller sends `acknowledge_warnings: true`. Both bodies carry the
 *  full conflict report, so a client can render its panel from the refusal.
 *
 *  The body is OPTIONAL — `parseBody` 400s on an absent one, and the console and
 *  every existing key client POST this with none. Same shape as the auto route. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = PublishScheduleRequest.parse(await req.json().catch(() => ({})));
    const auth = await requireResourceAuth(req, "division", id, "write");
    return publishSchedule(auth, id, body);
  });
}
