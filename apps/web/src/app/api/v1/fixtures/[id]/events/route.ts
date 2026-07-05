import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireFixtureActor } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { AppendEventRequest } from "@/server/api-v1/schemas";
import { scoreEvent } from "@/server/usecases/scoring";
import { listEvents } from "@/server/usecases/fixtures";

type Ctx = { params: Promise<{ id: string }> };

/** THE scoring endpoint (doc 08 §4): 201 append / 409 seq conflict / 422 invalid. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, AppendEventRequest);
    const auth = await requireFixtureActor(req, id, "score");
    return reply(201, await scoreEvent(auth, id, body));
  });
}

/** Ledger resync: events after ?since_seq= (doc 08 §4 conflict recovery). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireFixtureActor(req, id, "read");
    const raw = new URL(req.url).searchParams.get("since_seq") ?? "0";
    const sinceSeq = Number(raw);
    if (!Number.isInteger(sinceSeq) || sinceSeq < 0) throw new HttpError(400, "Invalid since_seq");
    return listEvents(auth, id, sinceSeq);
  });
}
