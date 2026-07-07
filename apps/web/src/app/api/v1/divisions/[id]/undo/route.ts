import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HistoryStepInput, undoDivision } from "@/server/usecases/history";

type Ctx = { params: Promise<{ id: string }> };

/** Appends the inverse event, moves the watermark back (Jul3/03 §6). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, HistoryStepInput);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return undoDivision(auth, id, body.expected_seq);
  });
}
