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
 *  every existing key client POST this with none. Same shape as the auto route.
 *
 *  AUTHENTICATE FIRST, THEN PARSE (#376). A caller with no write permission must
 *  learn that from the auth door and from nothing else. Parsing first hands an
 *  unauthenticated caller a 400 describing the schema, and quietly turns every
 *  auth-refusal probe that sends a minimal body into a shape-refusal probe — the
 *  assertion still reads "403" while the number now comes from the validator.
 *  The auto route two directories over already has this order; the pair is
 *  pinned by `__tests__/route-auth-order.test.ts`. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    const body = PublishScheduleRequest.parse(await req.json().catch(() => ({})));
    return publishSchedule(auth, id, body);
  });
}
