import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { StartDivisionRequest } from "@/server/api-v1/schemas";
import { startDivision } from "@/server/usecases/schedule";

type Ctx = { params: Promise<{ id: string }> };

/** The "start tournament" action (doc 12 §1 — both launch modes end here).
 *  Quick-start generates the first stage's fixtures when none exist.
 *
 *  #230 item 2 follow-up: starting PUBLISHES the schedule, under the same
 *  server-side validation publish runs. Blocking conflicts 422
 *  SCHEDULE_BLOCKING_CONFLICTS; warnings 422 SCHEDULE_UNACKNOWLEDGED_WARNINGS
 *  until the caller sends `acknowledge_warnings: true`. Both bodies carry the
 *  full conflict report, so a client renders its panel from the refusal.
 *
 *  The body is OPTIONAL — `parseBody` 400s on an absent one, and the console and
 *  every existing key client POST this with none. Same shape as publish.
 *
 *  AUTHENTICATE FIRST, THEN PARSE (#376). A caller with no write permission must
 *  learn that from the auth door and from nothing else. Parsing first hands an
 *  unauthenticated caller a 400 describing the schema, and quietly turns every
 *  auth-refusal probe that sends a minimal body into a shape-refusal probe — the
 *  assertion still reads "403" while the number now comes from the validator.
 *  Publish was reordered for exactly this and this route, its twin, was left
 *  behind; the pair is now pinned together by
 *  `../publish-schedule/__tests__/route-auth-order.test.ts`. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    const body = StartDivisionRequest.parse(await req.json().catch(() => ({})));
    return startDivision(auth, id, body);
  });
}
