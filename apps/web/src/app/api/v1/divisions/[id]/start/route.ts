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
 *  every existing key client POST this with none. Same shape as publish. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = StartDivisionRequest.parse(await req.json().catch(() => ({})));
    const auth = await requireResourceAuth(req, "division", id, "write");
    return startDivision(auth, id, body);
  });
}
